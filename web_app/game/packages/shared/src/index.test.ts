import { describe, expect, it } from "vitest";
import { SHARED_PACKAGE_READY } from "./index.js";

describe("workspace boot", () => {
  it("loads shared package", () => {
    expect(SHARED_PACKAGE_READY).toBe(true);
  });
});
