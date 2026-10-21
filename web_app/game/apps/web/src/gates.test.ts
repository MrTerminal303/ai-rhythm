import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("A8 licence gate fails on missing roots (no vacuous walk)", () => {
  it("missing assets root → exit 1 with 'missing required root'", () => {
    // assets/ deliberately absent — the ONE hard root (check-assets.mjs:72-73 walks public/ and
    // apps/web/public/ only when present, so their absence is legitimate, not a gate failure)
    const dir = mkdtempSync(join(tmpdir(), "assets-gate-"));
    let out = "";
    try {
      // script path resolved relative to this test file; cwd pinned for determinism
      const scriptPath = join(__dirname, "..", "..", "..", "scripts", "check-assets.mjs");
      out = execFileSync(process.execPath, [scriptPath, "--root", dir], { encoding: "utf8", cwd: join(__dirname, "..", "..") });
    } catch (e) {
      const err = e as { stdout?: string | null; stderr?: string | null };
      out = err.stdout || err.stderr || "";
    }
    expect(out).toContain("missing required root");
  });
});
