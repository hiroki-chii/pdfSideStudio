const MiB = 1024 * 1024;

export const PDF_LIMITS = Object.freeze({
  streamBytes: 16 * MiB,
  decodedBytes: 128 * MiB,
  objects: 200_000,
  depth: 64,
  imagePixels: 16 * MiB,
  outputBytes: 150 * MiB,
  overlayBytes: 64 * MiB,
  loadTimeout: 15_000,
  exportTimeout: 60_000,
  rasterSide: 4096,
});

export class PdfLimitError extends Error {
  constructor(detail) {
    super(`PDFの安全上限を超えました（${detail}）。小さなPDFに分けてお試しください。`);
    this.name = 'PdfLimitError';
  }
}
