import { greeting } from "./greeting";

describe("greeting", () => {
  it("greets by name", () => {
    expect(greeting(" Ada ")).toBe("Hello, Ada!");
  });

  it("rejects blank names", () => {
    expect(() => greeting("  ")).toThrow("blank");
  });
});
