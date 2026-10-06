export interface ZipLimits {
  maxCompressedBytes: number;
  maxTotalUncompressed: number;
  maxEntries: number;
  maxEntryBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxCompressedBytes: 100 * 1024 * 1024,
  maxTotalUncompressed: 300 * 1024 * 1024,
  maxEntries: 1000,
  maxEntryBytes: 50 * 1024 * 1024,
};
