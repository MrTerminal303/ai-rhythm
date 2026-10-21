"use client";
import { useEffect, useState } from "react";

// A4 coverage route: proves the production CSP permits the Worker + WASM execution
// path (spec §3 A4). Deliberately independent of the B7 spike.
export default function SpikeProbePage() {
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const run = async () => {
      try {
        // 8-byte empty wasm module — compiles via the WebAssembly API
        const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
        const workerSrc = `self.onmessage = async () => {
          const mod = await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]));
          postMessage(WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0])));
        };`;
        const url = URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }));
        const w = new Worker(url);
        try {
          const result = await new Promise<boolean>((resolve, reject) => {
            w.onmessage = (e) => resolve(e.data === true);
            w.onerror = (e) => reject(new Error(e.message));
            w.postMessage("go");
          });
          // main-thread compile exercised too
          await WebAssembly.compile(wasm);
          setOk(result);
        } finally {
          URL.revokeObjectURL(url);
          w.terminate();
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    };
    void run();
  }, []);
  return (
    <main>
      {ok && <span data-testid="probe-ok">worker+wasm ok</span>}
      {err && <span role="alert" data-testid="probe-err">{err}</span>}
    </main>
  );
}
