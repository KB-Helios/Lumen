import { describe, it, expect } from "vitest";
import { buildCliproxyArgs } from "./stage-clipproxy.js";
describe("stage-clipproxy", () => {
  it("pins loopback config path", () => {
    const args = buildCliproxyArgs("C:\\Lumen\\cliproxy\\config.yaml");
    expect(args).toEqual(["-config", "C:\\Lumen\\cliproxy\\config.yaml"]);
  });
});
