import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import type { ToolContext } from "../packages/core/types.ts";
import type { ResearchClient } from "../plugins/ops-research/client.ts";
import provider, { appendBib } from "../plugins/ops-research/provider.ts";
import {
  abstractFromIndex,
  citeKey,
  dedupe,
  escapeBib,
  mergeBib,
  parseId,
  toBibtex,
  type Work,
  worksFromArxiv,
} from "../plugins/ops-research/records.ts";
import { getWork, relatedWorks, searchWorks } from "../plugins/ops-research/search.ts";

const attention: Work = {
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani", "Noam Shazeer"],
  year: 2017,
  venue: "NeurIPS",
  doi: "10.5555/3295222.3295349",
  openAlex: "W2626778328",
  url: "https://doi.org/10.5555/3295222.3295349",
  abstract: "Hello world",
  citations: 9,
};

const ARXIV = `<?xml version="1.0"?>
<feed>
  <entry>
    <id>https://arxiv.org/abs/1706.03762v7</id>
    <title>Attention Is All You Need</title>
    <published>2017-06-12T00:00:00Z</published>
    <summary>The dominant sequence &amp; transduction models.</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <doi>10.5555/3295222.3295349</doi>
    <link title="pdf" href="https://arxiv.org/pdf/1706.03762"/>
  </entry>
  <entry>
    <id>https://arxiv.org/abs/1409.0473v1</id>
    <title>Neural Machine Translation</title>
    <published>2014-09-01T00:00:00Z</published>
    <summary>Jointly learning to align and translate.</summary>
    <author><name>Dzmitry Bahdanau</name></author>
  </entry>
</feed>`;

function context(roots: string[]): ToolContext {
  return {
    tier: "write",
    cfg: {} as ToolContext["cfg"],
    provider: {
      allowPrivileged: false,
      credentials: { read: { env: {}, args: [] }, write: { env: {}, args: [] } },
      scope: { allowedRoots: roots },
    },
    cli: (async () => "") as unknown as ToolContext["cli"],
  };
}

function fakeClient(
  json: (url: string) => unknown,
  text: (url: string) => string | undefined = () => undefined,
): ResearchClient {
  return {
    async json<T>(url: string): Promise<T | undefined> {
      return json(url) as T | undefined;
    },
    async text(url: string): Promise<string | undefined> {
      return text(url);
    },
  };
}

const save = provider.tools.find((tool) => tool.name === "research_save");
if (!save?.scope || !save.run) throw new Error("research_save missing");

describe("identifiers and dedupe", () => {
  it("parses DOI, arXiv, OpenAlex and Semantic Scholar ids", () => {
    assert.deepEqual(parseId("https://doi.org/10.5555/3295222.3295349"), {
      kind: "doi",
      value: "10.5555/3295222.3295349",
    });
    assert.deepEqual(parseId("https://arxiv.org/pdf/1706.03762v7.pdf"), {
      kind: "arxiv",
      value: "1706.03762",
    });
    assert.deepEqual(parseId("cs/0001001"), { kind: "arxiv", value: "cs/0001001" });
    assert.deepEqual(parseId("https://openalex.org/W2626778328"), {
      kind: "openalex",
      value: "W2626778328",
    });
    assert.equal(parseId("a".repeat(40))?.kind, "s2");
    assert.equal(parseId("Attention Is All You Need"), undefined);
  });

  it("keeps the first record when a later one shares a DOI or a title", () => {
    const later: Work = { ...attention, title: "A different title", abstract: "dropped" };
    const sameTitle: Work = { title: attention.title, authors: ["Someone Else"], year: 1999 };
    const kept = dedupe([attention, later, sameTitle]);
    assert.deepEqual(kept, [attention]);
  });
});

describe("records from each index", () => {
  it("rebuilds an inverted abstract and drops a non-https PDF", async () => {
    assert.equal(abstractFromIndex({ world: [1], Hello: [0] }), "Hello world");
    const client = fakeClient((url) => {
      assert.match(url, /api\.openalex\.org\/works\?/);
      assert.match(url, /publication_year%3A%3E2016/);
      return {
        results: [
          {
            id: "https://openalex.org/W2626778328",
            display_name: attention.title,
            publication_year: 2017,
            doi: "https://doi.org/10.5555/3295222.3295349",
            authorships: [{ author: { display_name: "Ashish Vaswani" } }],
            primary_location: { source: { display_name: "NeurIPS" } },
            open_access: { oa_url: "http://example.test/paper.pdf" },
            abstract_inverted_index: { Hello: [0], world: [1] },
            cited_by_count: 9,
          },
        ],
      };
    });
    const found = await searchWorks("attention", ["openalex"], 8, 2017, client);
    assert.equal(found.works[0]?.pdf, undefined);
    assert.equal(found.works[0]?.doi, attention.doi);
    assert.equal(found.works[0]?.abstract, "Hello world");
    assert.equal(found.warnings.length, 0);
  });

  it("parses arXiv Atom and applies the year on this side", async () => {
    const parsed = worksFromArxiv(ARXIV);
    assert.equal(parsed[0]?.arxiv, "1706.03762");
    assert.equal(parsed[0]?.pdf, "https://arxiv.org/pdf/1706.03762");
    assert.match(parsed[0]?.abstract ?? "", /sequence & transduction/);
    const client = fakeClient(
      () => undefined,
      (url) => {
        assert.match(url, /search_query=all%3A%22attention%22/);
        return ARXIV;
      },
    );
    const found = await searchWorks("attention", ["arxiv"], 8, 2016, client);
    assert.deepEqual(
      found.works.map((work) => work.arxiv),
      ["1706.03762"],
    );
  });

  it("reports a source failure and still returns the others", async () => {
    const client = fakeClient(
      (url) => {
        if (url.includes("semanticscholar"))
          throw new Error("api.semanticscholar.org returned 429");
        return { results: [] };
      },
      () => ARXIV,
    );
    const found = await searchWorks(
      "attention",
      ["openalex", "arxiv", "semanticscholar"],
      8,
      undefined,
      client,
    );
    assert.equal(found.works.length, 2);
    assert.match(found.warnings.join(" "), /semanticscholar/);
  });

  it("resolves a DOI from the first index that has it", async () => {
    const client = fakeClient(
      (url) => {
        assert.match(url, /openalex\.org\/works\/doi:10\.5555/);
        return {
          id: "https://openalex.org/W2626778328",
          display_name: attention.title,
          publication_year: 2017,
          doi: "https://doi.org/10.5555/3295222.3295349",
          authorships: [],
        };
      },
      () => {
        throw new Error("arXiv should not be called for a DOI");
      },
    );
    const work = await getWork("10.5555/3295222.3295349", client);
    assert.equal(work.openAlex, "W2626778328");
  });

  it("follows OpenAlex reference and citation filters", async () => {
    const urls: string[] = [];
    const client = fakeClient((url) => {
      urls.push(url);
      if (url.includes("/works/doi:")) {
        return {
          id: "https://openalex.org/W1000000001",
          display_name: "Seed",
          doi: "https://doi.org/10.1000/seed",
          authorships: [],
        };
      }
      return {
        results: [
          {
            id: "https://openalex.org/W1000000002",
            display_name: url.includes("cited_by%3A") ? "A reference" : "A citation",
            authorships: [],
          },
        ],
      };
    });
    const related = await relatedWorks("10.1000/seed", 5, "both", client);
    assert.equal(related.references[0]?.title, "A reference");
    assert.equal(related.citations[0]?.title, "A citation");
    assert.ok(urls.some((url) => url.includes("filter=cited_by%3AW1000000001")));
    assert.ok(urls.some((url) => url.includes("filter=cites%3AW1000000001")));
  });
});

describe("BibTeX", () => {
  it("escapes specials and builds a stable key", () => {
    const work: Work = {
      title: "On the loss_of a 100% match",
      authors: ["Ada Lovelace"],
      year: 1843,
      arxiv: "1843.00001",
    };
    assert.equal(escapeBib("100% of a_b & c"), "100\\% of a\\_b \\& c");
    assert.equal(citeKey(work), "lovelace1843loss");
    const bib = toBibtex(work, citeKey(work));
    assert.match(bib, /^@misc\{lovelace1843loss,/);
    assert.match(bib, /archiveprefix = \{arXiv\}/);
    assert.match(bib, /title = \{On the loss\\_of a 100\\% match\}/);
  });

  it("skips a DOI or cite key already in the file and appends the rest", () => {
    const existing = toBibtex(attention, citeKey(attention));
    const preprint: Work = {
      title: "A fresh preprint on routing",
      authors: ["Grace Hopper"],
      year: 2024,
      arxiv: "2401.00001",
    };
    const merged = mergeBib(existing, [attention, preprint]);
    assert.equal(merged.added.length, 1);
    assert.equal(merged.skipped[0]?.reason.includes(attention.doi ?? ""), true);
    assert.match(merged.text, /@misc\{hopper2024fresh,/);
    assert.equal(merged.text.match(/vaswani2017attention/g)?.length, 1);
  });

  it("appends to a .bib file without dropping what was already there", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-research-"));
    const file = join(dir, "refs.bib");
    writeFileSync(file, toBibtex(attention, citeKey(attention)));
    const preprint: Work = {
      title: "A fresh preprint on routing",
      authors: ["Grace Hopper"],
      year: 2024,
      arxiv: "2401.00001",
    };
    const written = appendBib(file, [attention, preprint]);
    assert.equal(written.added.length, 1);
    const text = readFileSync(file, "utf8");
    assert.match(text, /vaswani2017attention/);
    assert.match(text, /hopper2024fresh/);
  });
});

describe("research_save paths", () => {
  const args = { file: "", ids: ["10.5555/3295222.3295349"] };

  it("refuses a relative path", () => {
    const reason = save.scope?.({ ...args, file: "refs.bib" }, context([]).provider, context([]));
    assert.match(String(reason), /absolute|invalid format|outside/);
  });

  it("refuses a path outside the allowed roots", () => {
    const root = join(tmpdir(), "ops-research-root");
    const outside = join(tmpdir(), "ops-research-other", "refs.bib");
    const reason = save.scope?.(
      { ...args, file: outside },
      context([root]).provider,
      context([root]),
    );
    assert.match(String(reason), /allowedRoots/);
  });

  it("refuses to create a missing parent directory", async () => {
    const missing = join(tmpdir(), "ops-research-missing-parent", "refs.bib");
    await assert.rejects(async () => {
      await save.run({ ...args, file: missing }, context([]));
    }, /does not exist/);
  });
});
