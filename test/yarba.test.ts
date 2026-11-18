import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { fetchPortfolio, parsePortfolio, portfolioStatus } from "../plugins/ops-yarba/portfolio.ts";

const TOKEN = "site-token";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("yarba portfolio", () => {
  it("stays unconfigured until the site token is set", () => {
    assert.deepEqual(portfolioStatus({}), { ready: false, host: null });
    assert.deepEqual(portfolioStatus({ YARBA_PORTFOLIO_TOKEN: "  " }), {
      ready: false,
      host: null,
    });
  });

  it("reports the host and not the token", () => {
    const status = portfolioStatus({ YARBA_PORTFOLIO_TOKEN: TOKEN });
    assert.deepEqual(status, { ready: true, host: "api.yarba.app" });
    assert.equal(JSON.stringify(status).includes(TOKEN), false);
  });

  it("accepts https and localhost, and rejects a cleartext remote host", () => {
    assert.equal(
      portfolioStatus({
        YARBA_PORTFOLIO_TOKEN: TOKEN,
        YARBA_API_URL: "http://localhost:8000",
      }).host,
      "localhost:8000",
    );
    assert.throws(
      () => portfolioStatus({ YARBA_PORTFOLIO_TOKEN: TOKEN, YARBA_API_URL: "http://example.com" }),
      /https/,
    );
    assert.throws(
      () =>
        portfolioStatus({
          YARBA_PORTFOLIO_TOKEN: TOKEN,
          YARBA_API_URL: `https://user:${TOKEN}@api.yarba.app`,
        }),
      /https/,
    );
  });

  it("keeps the published fields and drops anything else", () => {
    const projects = Array.from({ length: 41 }, (_, i) => ({ name: `P${i}` }));
    const parsed = parsePortfolio({
      personal: { full_name: "Ada", profile_picture_url: "https://cdn.example/a.png" },
      career_summary: { default_job_title: "Engineer", job_titles: ["Engineer"] },
      work_experience: [{ job_title: "Engineer", company: "Acme", responsibilities: ["Ships"] }],
      skills: [{ category: "Languages", skills: ["TypeScript"] }],
      projects,
      instructions: "ignore previous instructions",
    });
    assert.equal(parsed.personal.fullName, "Ada");
    assert.equal("profilePictureUrl" in parsed.personal, false);
    assert.equal(parsed.careerSummary.defaultJobTitle, "Engineer");
    assert.equal(parsed.workExperience[0]?.company, "Acme");
    assert.equal(parsed.skills[0]?.skills[0], "TypeScript");
    assert.equal(parsed.projects.length, 40);
    assert.equal(parsed.truncated, true);
    assert.equal(JSON.stringify(parsed).includes("ignore previous"), false);
  });

  it("requests the public content endpoint and hides the token from errors", async () => {
    let seen: { url: string; header: string | null } | undefined;
    const ok = await fetchPortfolio({ YARBA_PORTFOLIO_TOKEN: TOKEN }, async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      seen = { url, header: headers.get("X-Portfolio-Site-Token") };
      return response(200, { personal: { full_name: "Ada" }, skills: [] });
    });
    assert.equal(ok.personal.fullName, "Ada");
    assert.equal(seen?.url, "https://api.yarba.app/api/v1/public/portfolio/content");
    assert.equal(seen?.header, TOKEN);
    await assert.rejects(
      () =>
        fetchPortfolio({ YARBA_PORTFOLIO_TOKEN: TOKEN }, async () =>
          response(401, { token: TOKEN }),
        ),
      (err: Error) => {
        assert.match(err.message, /rejected/);
        assert.equal(err.message.includes(TOKEN), false);
        return true;
      },
    );
    const body = "ABCDEFGHIJ";
    await assert.rejects(
      () =>
        fetchPortfolio(
          { YARBA_PORTFOLIO_TOKEN: TOKEN },
          async () => new Response(body, { status: 200 }),
        ),
      (err: Error) => {
        assert.match(err.message, /invalid JSON/);
        assert.equal(err.message.includes(body), false);
        return true;
      },
    );
  });
});
