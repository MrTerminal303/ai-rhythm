# AIRhythm web_app — architecture diagram set

Mermaid sources rendered via the gstack `diagram` skill. Each diagram has:
`<name>.mmd` (source, single source of truth) · `<name>.svg` / `<name>.png` (render) · `<name>.excalidraw` (editable at excalidraw.com).

Boxes/arrows verified against `web_app/game/` code at HEAD `74f6d0a` (specs `2026-10-03-web-app-week-1-design.md` / `2026-10-06-web-app-week-2-design.md` predate implementation where they disagree).

## Diagrams

## monorepo-layers

Workspace root, the five packages, and who-imports-whom (workspace deps vs the deliberate relative dynamic import).

```mermaid
graph TD
    ROOT["pnpm workspace root (airhythm-game)"] --> R1["root scripts: typecheck · test · build:atlas · check:assets"]
    ROOT --> W["packages/* + apps/*"]

    WEB["@airhythm/web — apps/web (Next 16 App Router)"]
    SHARED["@airhythm/shared — zod schema, canonicalize, judgement"]
    BFM["@airhythm/beatmap-formats — .osu/.osz/.dbm.json (fflate)"]
    ASSETS["@airhythm/assets — build-atlas (pngjs)"]
    ATLAS["apps/web/public/atlas — sprites.png + atlas.json + frames/"]
    WRK["@airhythm/worker — apps/worker (wrangler)"]
    DO["COUNTER Durable Object (SQLite)"]

    WEB -->|"workspace:* dependency"| SHARED
    BFM -->|"workspace:* dependency"| SHARED
    WEB -.->|"dynamic relative import (src/index.js)"| BFM
    WEB -.->|"fetch /atlas/* at runtime (initAtlas)"| ATLAS
    ASSETS -->|"pnpm build:atlas (400KB budget)"| ATLAS
    WRK -.->|"no workspace deps — independent"| DO
```

## routes-pages

The four routes and the sessionStorage hand-off between `/import` and `/play`.

```mermaid
graph LR
    HOME["/ landing (server component)"] -->|"Play solo"| PLAY["/play (client)"]
    HOME -->|"Import"| IMPORT["/import (client)"]
    HOME -->|"Calibrate"| CAL["/calibrate (client)"]

    IMPORT -->|"setItem w2-import = canonicalJson"| SS[("sessionStorage: w2-import")]
    IMPORT -->|"router.push /play?import=1"| PLAY
    PLAY -->|"?import=1: getItem, size ≤ 10MB chars, parseBeatmap"| SS
    PLAY -->|"missing/invalid → import-error + link /import"| IMPORT

    PLAY -->|"default"| FIX["fixtures/w1-chart.json"]
    PLAY -->|"?chart=benchmark"| BENCH["fixtures/w1-benchmark-chart.json"]
```

## play-phase-state-machine

`/play` phase transitions from click-to-start through countdown, pause/resume, and engine freeze (freeze keeps the `playing` phase).

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> loading: click-to-start (startGame, AudioContext resume)
    loading --> countdown: decode ok · clock.load(buffer, audioOffsetMs)
    loading --> idle: error → retry
    countdown --> playing: 3-2-1 ticks done · clock.start(0) · attach keys + rAF
    playing --> paused: blur / visibility hidden → flush held-lane releases FIRST → clock.pause + record pausedAt
    paused --> countdown: resume click → runCountdown → clock.start(pausedAt)
    countdown --> playing: (same resume countdown completes)

    state playing {
        [*] --> running
        running --> frozenChart: all targets resolved or chartTime past endTimeMs
        frozenChart: engine frozen — phase stays "playing"
    }
```

## timing-domains

The three time domains (perf ↔ AudioContext ↔ chart) and the "audioOffsetMs applied EXACTLY ONCE" rule, plus the calibrated judgeDt.

```mermaid
graph LR
    TS["event.timeStamp — performance clock origin"] -->|"audioClockSeconds(ts, pair): pair.contextTime + (ts − pair.performanceTime)/1000"| CTX["AudioContext seconds"]
    PAIR["ClockPair — getOutputTimestamp | fallback, maxAge 1000ms"] -.-> CTX

    CTX -->|"inputChartTimeMs = audioSourceOffsetMs + (ctx − sourceStartCtxTime)×1000 + audioOffsetMs"| ICH["inputChartTimeMs — chart domain (input path)"]

    BUF["rawBufferPosition — playbackPositionMs / audioSourceOffsetMs"] -->|"+ audioOffsetMs — EXACTLY ONCE"| CT["chartTimeMs — chart domain (render + miss sweep)"]
    CT -->|"- audioOffsetMs — EXACTLY ONCE (source.start offset in AudioClock.start)"| BUF

    ICH -->|"judgeDt = inputChartTimeMs − deviceCalibrationOffsetMs − note.t  (+ = late)"| DT["judgeDt — calibrated input domain"]
    CAL["deviceCalibrationOffsetMs — localStorage median (judgement only, never render)"] -.->|"subtracted exactly once, inside judgeDt + sweep precompute"| DT
    DT --> W["windows: 35 / 70 / 110 (tail 150)"]
```

## judgement-pipeline

Keydow path from event.timeStamp through the dual-domain expiry sweep, calibrated candidate selection, grading, and the HUD snapshot.

```mermaid
graph TD
    K["keydown D/F/J/K (phase must be playing)"] --> G1{"repeat · wrong key · frozen engine?"}
    G1 -->|"reject"| IGN["ignore (accepted key still preventDefault)"]
    G1 -->|"ok"| ICH["inputChartTime(event.timeStamp) — never clock.chartTimeMs()"]

    ICH --> SW["markExpiredPendingNotes FIRST — dual-domain: chartTime past expiry AND calibrated past expiry"]
    SW -->|"expired target"| MIS["state missed · combo = 0 · emit miss"]

    SW --> SEL["candidate select: same lane · pending · kind tap|head"]
    SEL --> DT["dt = judgeDt (calibrated) · reject |dt| over 110 · nearest |dt|, tie → lower noteId"]
    DT -->|"found"| GR["grade(dt): 35/70/110 → perfect/great/good"]
    DT -->|"none"| NOP["nothing marked — update() expiry owns it"]
    GR --> SC["hit: combo+1 · maxCombo · sumWeights += SCORE_WEIGHTS · score floor(1e6×w/total × comboBonus)"]
    SC --> EM["emit hit event → HUD snapshot"]
    MIS --> EM

    UPD["rAF update(): sweep(render chartTime + calibrated) → render → freeze check"] --> SW
```

## hold-lifecycle

Hold notes as head+tail targets: keyup grading, early/late rules, auto-miss independence from head outcome, and the blur flush-before-pause ordering.

```mermaid
graph TD
    H["hold note → targets: head(t) + tail(t+d) · totalTargets = taps + 2×holds"]
    H --> KD["keydown → judge head/tap at inputChartTime · ±110 windows"]
    KD --> HS{"head judged"}
    HS -->|"hit"| HELD["lane held (heldLanes add)"]
    HS -->|"missed by sweep"| TKEEP["tail stays pending — head miss never touches tail (own deadline t+d+150)"]
    TKEEP --> KU

    HELD --> KU["keyup → engine.release(lane, inputChartTime)"]
    KU --> DTR["dt = judgeDt vs tail t+d (one calibrated domain)"]
    DTR -->|"dt below −150"| EARLY["early release → tail Miss · head stays hit · combo = 0"]
    DTR -->|"−150 ≤ dt ≤ 150"| GR["gradeTail 35/70/150 → tail hit · combo+1 (full-combo hold = totalTargets)"]
    DTR -->|"dt over 150"| IGN["ignore — deadline passed, sweep owns it"]

    NONE["no keyup"] -->|"update() sweep past t+d+150"| AUTO["tail auto-miss (independent of head outcome)"]

    BLUR["window blur / hidden"] --> FL["flushHeldLanesBeforePause: release over COPY of heldLanes @ input-domain time → clear set → pause()"]
    FL --> KU
```

## import-pipeline

File input through size gates, extension dispatch, songKey hashing, canonicalization, sessionStorage, and consumption on `/play`.

```mermaid
graph TD
    FILE["file input accept=.osu,.osz,.dbm.json"] --> GATE{"size gate (before read)"}
    GATE -->|"non-.osz exceeds 10MB"| ERR["import-error"]
    GATE -->|".osz exceeds 100MB"| ERR
    GATE --> EXT{"extension dispatch"}

    EXT -->|.dbm.json| DBM["JSON.parse → canonicalizeBeatmap"]
    EXT -->|.osz| OSZ["extractOsz → listOsuDifficulties (dynamic import)"]
    EXT -->|.osu| OSU["parseOsu (Mode=3 mania, CircleSize=4) → warnings"]
    EXT -->|other| ERR

    OSZ -->|"1 difficulty"| OSU
    OSZ -->|"2+ difficulties"| PICK["difficulty select"]
    OSZ -->|"0 difficulties"| ERR
    PICK --> OSU

    OSU --> KEY["songKey = file:sha256(audio) | file:missing-audio"]
    KEY --> CANON["canonicalizeBeatmap (sort, re-id, canonical JSON)"]
    CANON --> HASH["SHA-256 of canonical bytes"]
    HASH --> SS["sessionStorage.setItem w2-import"]
    SS --> NAV["router.push /play?import=1"]
    NAV --> PLAY["play mount: parseBeatmap → GameEngine"]
```

## osz-extraction-phases

Two-phase zip extraction: central-directory pre-scan before any inflation, then mid-stream actual-byte accounting with 64 KiB feed slices.

```mermaid
graph TD
    IN["zip bytes — maxCompressedBytes 100MB"] --> P1["Phase 1: readCentralDirectory (EOCD sig 0x504b0506)"]
    P1 --> G1{"pre-inflation checks: entries ≤ 1000 · safe names (no .. / abs / drive) · entry ≤ 50MB · declared total ≤ 300MB"}
    G1 -->|"fail"| A1["throw — nothing inflated"]
    G1 -->|"ok"| P2["Phase 2: fflate Unzip, push 64KiB slices (FEED_SLICE)"]
    P2 --> CNT["ondata counts ACTUAL decompressed bytes"]
    CNT --> G2{"mid-stream: actual ≤ 300MB · entry ≤ 50MB · seen ≤ 1000 (CD can lie)"}
    G2 -->|"fail"| A2["abort mid-push — slice-feed overshoot ≤ 64KiB"]
    G2 -->|"ok"| OUT["entries → listOsuDifficulties → parseOsu"]
```

## renderer-atlas-path

Atlas build budget, synchronous renderer construction behind the B6 `webglReady` contract, and the never-rejecting opportunistic atlas load with permanent code-drawn fallback.

```mermaid
graph TD
    SRC["assets/src/{ui,particles,patterns}/*.png"] -->|"pnpm build:atlas — combined ≤400KB (sprites.png+atlas.json), frame ≤32KB"| OUT["apps/web/public/atlas/ (sprites.png, atlas.json, frames/)"]

    CTOR["new WebGLRenderer(canvas, chart) — sync (builds programs+buffers)"] --> READY["canvas.dataset.webglReady = true (B6 contract)"]
    READY --> INIT["initAtlas() fire-and-forget — .catch(() => {}), idempotent"]
    INIT --> LOAD["fetch /atlas/atlas.json then /atlas/sprites.png"]
    OUT -.-> LOAD
    LOAD --> NEED{"required frames present: TAP ui/button_rectangle_flat, HOLD ui/slide_horizontal_grey_section_wide, meta.size"}
    NEED -->|"yes"| TEX["atlasMode: 9-slice textured (texturedSlice, margins 25%)"]
    NEED -->|"fetch/parse fail"| FALL["permanent code-drawn fallback — resolves false, never rejects"]
    TEX -->|"rect < 3px"| FALL
```

## calibration-flow

Calibration loop: metronome taps through pairing and median to localStorage, then consumption at engine construction inside judgeDt.

```mermaid
graph TD
    START["click Start on /calibrate"] --> CTX["own AudioContext + ClockPairKeeper"]
    CTX --> BEAT["schedule 20 clicks · 500ms interval · 1s lead-in"]
    BEAT --> TAP["keydown d/f/j/k (no repeat) → audioClockSeconds(e.timeStamp, pair)"]
    TAP --> ASSOC["associateTaps (nearest unconsumed beat, window 250ms)"]
    ASSOC --> Q{"pairs ≥ 16 (TARGET_PAIRS)?"}
    Q -->|"no"| RETAKE["retake prompt"]
    Q -->|"yes"| MED["computeCalibration — median(inputMs − beatMs)"]
    MED --> SAVE["saveCalibration → localStorage deviceCalibrationOffsetMs (valid ±500ms)"]
    SAVE --> LOAD["play mount: loadCalibration(outputLatency) — stored wins, else latency, else 0"]
    LOAD --> ENG["new GameEngine({ deviceCalibrationOffsetMs }) → judgeDt = inputChartTime − offset − note.t"]
```

## worker-endpoints

Worker routes with the 60 s health cache, same-origin gate on stateful endpoints, and the deterministic `smoke` Durable Object counter.

```mermaid
graph TD
    REQ["request → airhythm-worker (apps/worker/src/index.ts)"] --> H["/health"]
    REQ --> E["/echo"]
    REQ --> WS["/ws"]
    REQ --> N["anything else → 404 JSON not found"]

    H --> HC{"healthCache fresh (60s)?"}
    HC -->|"yes"| H1["{ok:true, cached:true}"]
    HC -->|"?db=1"| H2["COUNTER DO /health-db → SELECT 1"]
    HC -->|"expired"| H1

    E --> OG["sameHostOrigin guard → 403 origin not allowed"]
    OG --> M{"msg param?"}
    M -->|"missing"| M4["400 msg required"]
    M -->|"ok"| M2["{msg} · Content-Type application/json; charset=utf-8"]

    WS --> OG2["sameHostOrigin guard → 403"]
    OG2 --> DO["COUNTER DO idFromName(smoke) — welcome {count}, ping→pong"]
    DO --> SQL["CounterDO SQLite: counter table, value+1 on connect"]
```

## ci-gate-chain

CI jobs on `web_app/game/**` pushes: parallel `check` (typecheck → test → atlas → license gate) and `e2e` (Playwright + artifact upload).

```mermaid
graph TD
    PUSH["push / PR (web_app/game/**)"] --> C0["job: check"]
    PUSH --> E0["job: e2e (parallel)"]

    C0 --> S1["checkout + pnpm + node 22"]
    S1 --> S2["pnpm install --frozen-lockfile"]
    S2 --> S3["pnpm -r typecheck"]
    S3 --> S4["pnpm -r test (unit)"]
    S4 --> S5["pnpm build:atlas (400KB budget)"]
    S5 --> S6["node scripts/check-assets.mjs (license gate)"]

    E0 --> E1["playwright install chromium"]
    E1 --> E2["pnpm --filter @airhythm/web e2e"]
    E2 --> E3["upload w1-highway.png artifact"]
```

## Notes

- Edit any diagram by changing its `.mmd`, then re-render (mermaid is the source of truth). The `.excalidraw` files open at excalidraw.com (File → Open) for manual layout edits.
- Keep diagrams ≤ ~20 nodes; split rather than clutter.
- Embedded copies of all 12 sources also live in `../WEB-APP-ARCHITECTURE.md` at their topical sections — keep the two in sync when editing a `.mmd`.
