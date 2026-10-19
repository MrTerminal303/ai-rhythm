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
