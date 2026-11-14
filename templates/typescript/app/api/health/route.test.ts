// @vitest-environment node
import { GET } from "./route";

describe("GET /api/health", () => {
  it("reports ok", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
