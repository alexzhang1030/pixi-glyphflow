export { DEFAULT_OUTLINE_PREPARE_LIMITS, prepareOutlineGlyph } from "./prepare";
export { createOutlineComputeRasterizer, inspectOutlineComputeCapability } from "./compute";
export {
  SPARSE_STRIP_COMPUTE_LAYOUT,
  createSparseStripComputeRasterizer,
  inspectSparseStripComputeCapability,
  packSparseStripComputeBatch,
  preflightSparseStripComputePacking,
} from "./sparseStripCompute";
export {
  OUTLINE_ANALYTIC_WGSL,
  OUTLINE_COMPUTE_WGSL,
  OUTLINE_FRAGMENT_WGSL,
} from "./outlineCompute.wgsl";
export { SPARSE_STRIP_COMPUTE_WGSL } from "./sparseStrip.wgsl";
export { rasterizeOutlineCpu, sampleOutlineCoverage } from "./reference";
export { createOutlineRendering } from "./rendering";
export { resolveOutlineRoute } from "./routing";
export {
  SPARSE_STRIP_LAYOUT,
  SPARSE_STRIP_SCHEMA_VERSION,
  SPARSE_STRIP_TILE_SIZE,
  SparseGlyphStripCache,
  colorizeSparseStripGlyph,
  createSparseGlyphStripKey,
  decodeSparseStripCoverage,
  encodeSparseStripGlyph,
  sparseGlyphStripPixelBucket,
  validateSparseStripGlyph,
} from "./sparseStrips";
export type {
  PackedSparseStripComputeBatch,
  SparseStripAtlasPlacement,
  SparseStripComputeBatch,
  SparseStripComputeDispatch,
  SparseStripComputeLayout,
  SparseStripComputePackingCounts,
  SparseStripComputePackingPreflight,
  SparseStripComputePackingStats,
  SparseStripComputeRasterizer,
  SparseStripComputeRequest,
} from "./sparseStripCompute";
export type {
  SparseGlyphStripCacheOptions,
  SparseGlyphStripIdentity,
  SparseStripAaMode,
  SparseStripEncodeOptions,
  SparseStripGlyph,
  SparseStripLayout,
} from "./sparseStrips";
export type {
  OutlineColor,
  OutlineColorAtlas,
  OutlineColorAtlasEntry,
  OutlineComputeCapability,
  OutlineComputeRasterizer,
  OutlineComputeRasterRequest,
  OutlineComputeRasterResult,
  OutlineComputeUnsupportedReason,
  OutlineCpuBitmap,
  OutlineGlyphExtents,
  OutlineExternalColorRaster,
  OutlineExternalColorSource,
  OutlinePackedGlyphRequest,
  OutlinePackedGlyphSource,
  OutlinePreparationResult,
  OutlinePrepareOptions,
  OutlineQuadMetadata,
  OutlineRasterOptions,
  OutlineRasterMetrics,
  OutlineRenderingFailureReason,
  OutlineRenderingFallbackReason,
  OutlineRenderingOptions,
  OutlineRenderingPlugin,
  OutlineRenderingRasterRequest,
  OutlineRenderingResult,
  OutlineRoute,
  OutlineRouteInput,
  PackedOutlineGlyphInput,
  PreparedOutlineGlyph,
} from "./types";
