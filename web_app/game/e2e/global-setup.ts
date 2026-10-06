// Playwright globalSetup: ensure the gitignored click-track WAV exists before e2e runs.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export default function globalSetup(): void {
  const wav = path.resolve(__dirname, "../apps/web/public/audio/click-track.wav");
  if (!existsSync(wav)) {
    execFileSync(process.execPath, ["scripts/gen-audio-fixture.mjs"], {
      cwd: path.resolve(__dirname, "../apps/web"),
      stdio: "inherit",
    });
  }
}
