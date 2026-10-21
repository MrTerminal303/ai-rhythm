export {
  computeLogMel,
  frameCount,
  melFrameCount,
  parsePreproc,
  toAnalysisPcm,
  toMelTensor,
  toMono,
  fftInPlace,
  MEL_FEATURE_TOL,
  MODEL_OUTPUT_TOL,
  type PreprocParams,
} from "./mel.js";

export {
  copySamplesForAnalysis,
  clampMaxSeconds,
  type AnalysisSampleChunk,
  type CopySamplesOptions,
  type CopySamplesSource,
} from "./audio-samples.js";

export {
  FluxChunker,
  streamChunks,
  type FluxFrameBatch,
  type ChunkPort,
  type ChunkIterableItem,
  type StreamCallbacks,
  type StreamResult,
} from "./chunking.js";

export {
  computeFlux,
  fluxRows,
  flattenFluxRows,
  hannWindow,
  createFluxWindowState,
  chunkFrame,
  type FluxWindowState,
} from "./flux.js";

export {
  analyzeWhole,
  CHUNK_FEATURE_TOL,
  melRows,
  type WholeReference,
} from "./reference.js";

export {
  createAnalysisWorkerHandler,
  workerTransferables,
  type AnalysisWorkerInMessage,
  type AnalysisWorkerOutMessage,
  type AnalysisWorkerHandler,
} from "./analysis.worker.js";

// R9 (T24): `ChartGenerator` + `BeatmapCandidate` are defined HERE and exported —
// T25's brief claims they come from "PLAN §13.3", but that section defines no
// TypeScript interface. T24 is the source of truth; T25 builds against these.
export type { ChartGenerator, BeatmapCandidate } from "./types.js";

// T25 (B8b): the flux-v1 fallback generator — onsets → density → lane assignment →
// beat tracking → a schema-valid candidate, behind the shared candidate pipeline.
export {
  fluxV1,
  generateWithPort,
  createFluxV1Generator,
  createFluxV1WorkerPort,
  generateCandidate,
  generateCandidateFromFlux,
  detectOnsets,
  detectBeat,
  onsetsFromFlux,
  normalizeEnvelope,
  validateFluxChannels,
  peakPick,
  frameToMs,
  PINNED_PREPROC,
  ONSET_PRE_MAX,
  ONSET_POST_MAX,
  ONSET_PRE_AVG,
  ONSET_POST_AVG,
  ONSET_DELTA,
  ONSET_WAIT,
  ENVELOPE_TINY,
  BEAT_MIN_BPM,
  BEAT_MAX_BPM,
  BEAT_CONFIDENCE_MIN,
  BEAT_FALLBACK_BPM,
  FLUX_GENERATION_TIMEOUT_MS,
  DEFAULT_TARGET_NPS,
  HOLD_PROBABILITY,
  HOLD_DURATION_MS,
  CHORD_PROBABILITY,
  FLUX_ONSET_TOL_MS,
  FluxGenerateError,
  type Onset,
  type GenerateOptions,
  type GenerateProgress,
  type ResolvedGenerateOptions,
  type FluxGenerateErrorCode,
  type FluxWorkerErrorCode,
  type GenerateProbe,
  type FluxWorkerPort,
  type FluxV1InMessage,
  type FluxV1OutMessage,
  type BeatInfo,
  type AudioMetaForGeneration,
} from "./flux-v1.js";

export {
  assignLanes,
  selectDensity,
  enforceNoteDensity,
  computeLaneSeed,
  laneSeedInput,
  mulberry32,
  MIN_HOLD_MS,
  type NoteDraft,
  type AssignOptions,
} from "./lane-assign.js";
