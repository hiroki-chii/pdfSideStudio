import { imagePlacement, paintOverlay } from './pdf.js';
import { PDF_LIMITS, PdfLimitError } from './limits.js';

const makeCanvas = viewport => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  return canvas;
};
const png = canvas => new Promise((resolve, reject) => canvas.toBlob(blob =>
  blob ? resolve(blob) : reject(new Error('画像を作成できませんでした。')), 'image/png'));

async function rasterPage(record, source, renderPdf) {
  const page = await source.preview.getPage(record.index + 1);
  const base = page.getViewport({ scale: 1, rotation: record.rotation });
  if (![base.width, base.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('PDFの用紙サイズが不正です。');
  const view = page.getViewport({ scale: Math.min(2, PDF_LIMITS.rasterSide / Math.max(base.width, base.height)), rotation: record.rotation });
  const canvas = makeCanvas(view), overlay = renderPdf ? makeCanvas(view) : canvas;
  try {
    if (renderPdf) await page.render({ canvasContext: canvas.getContext('2d'), viewport: view }).promise;
    paintOverlay(overlay.getContext('2d'), record, view);
    if (renderPdf) canvas.getContext('2d').drawImage(overlay, 0, 0);
    return { blob: await png(canvas), base, view, width: canvas.width, height: canvas.height };
  } finally { canvas.width = canvas.height = overlay.width = overlay.height = 0; }
}

export async function createPageOverlay(record, source) {
  const { blob, view, width, height } = await rasterPage(record, source, false);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), placement: imagePlacement({
    width, height, convertToPdfPoint: (x, y) => view.convertToPdfPoint(x, y),
  }) };
}

export async function createPrintPages(records, sources, progress = () => {}) {
  const pages = []; let size = 0;
  for (const [index, record] of records.entries()) {
    progress(index + 1, records.length);
    const { blob, base } = await rasterPage(record, sources.get(record.sourceId), true);
    size += blob.size;
    if (size > PDF_LIMITS.overlayBytes) throw new PdfLimitError('印刷画像の総量');
    pages.push({ blob, width: base.width, height: base.height });
  }
  return pages;
}
