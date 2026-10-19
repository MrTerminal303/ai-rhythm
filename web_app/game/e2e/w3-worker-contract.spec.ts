// e2e/w3-worker-contract.spec.ts
// W3 T24 (D30): pins the analysis-Worker premise in a REAL engine (brief Step 1,
// cited by `packages/chartgen/src/analysis.worker.ts`):
//   * a real `AudioContext` + `AudioBuffer` exists in the browser;
//   * `structuredClone(audioBuffer)` THROWS with `name === "DataCloneError"` —
//     an AudioBuffer is not structured-cloneable/Transferable, so the analysis
//     Worker never receives one;
//   * the contrast that makes the pin meaningful: a plain `Float32Array` clone
//     DOES succeed — owned sample copies (ArrayBuffers) ARE structured-cloneable,
//     which is exactly what `copySamplesForAnalysis` transfers in bounded chunks.
//
// Driven against a real browser via the committed @playwright/test package
// (workspace e2e script — not an ad-hoc verification script).
import { expect, test } from "@playwright/test";

test("AudioBuffer is not structured-cloneable (DataCloneError) — plain Float32Array is", async ({
  page,
}) => {
  await page.goto("/settings");
  const result = await page.evaluate(() => {
    const ctx = new AudioContext();
    const buf = ctx.createBuffer(1, 16, 44100);
    let bufferClone: string;
    try {
      structuredClone(buf);
      bufferClone = "cloned"; // unreachable in any real engine (pinned below)
    } catch (e) {
      bufferClone = (e as Error).name;
    }
    let pcmClone: string;
    try {
      const pcm = new Float32Array(16);
      structuredClone(pcm);
      pcmClone = "ok";
    } catch (e) {
      pcmClone = `failed: ${(e as Error).name}`;
    }
    void ctx.close();
    return { bufferClone, pcmClone };
  });
  // D30 premise: the playback buffer can NEVER cross the Worker boundary.
  expect(result.bufferClone).toBe("DataCloneError");
  // The contrast: owned Float32Array copies DO cross it — that is the transfer path.
  expect(result.pcmClone).toBe("ok");
});
