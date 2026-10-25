import { zipSync } from 'fflate';
import { loadLimitedPdf, createPdfBudget } from './pdf-security.js';
import { buildPdf } from './pdf-export.js';
import { MAX_TOTAL_BYTES, MAX_PAGES, safeFilename, normalizeRotation } from './model.js';
import { PDF_LIMITS, PdfLimitError } from './limits.js';

// Pure job dispatcher shared by the browser Worker and integration tests.
export async function processPdfJob({ type, bytes, sources: inputs, records, title }, progress = () => {}) {
  const budget = createPdfBudget();
  if (type === 'load') {
    const document = await loadLimitedPdf(bytes, budget);
    return document.getPages().map(page => ({ rotation: normalizeRotation(page.getRotation().angle) }));
  }
  if (!['export', 'split'].includes(type) || !records?.length || records.length > MAX_PAGES) throw new Error('PDF処理の指定が不正です。');
  const sources = new Map(); let total = 0, overlays = 0;
  for (const input of inputs) {
    total += input.bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new PdfLimitError('読み込み総量');
    sources.set(input.id, { document: await loadLimitedPdf(input.bytes, budget) });
  }
  for (const record of records) {
    overlays += record.overlay?.bytes.length || 0;
    if (overlays > PDF_LIMITS.overlayBytes) throw new PdfLimitError('書き込み画像の総量');
  }
  const overlay = record => {
    if (!record.overlay) throw new Error('書き込み画像が見つかりません。');
    return record.overlay;
  };
  if (type === 'export') return buildPdf(records, sources, overlay, progress);
  const files = {}; let outputSize = 0;
  for (const [index, record] of records.entries()) {
    const part = await buildPdf([record], sources, overlay);
    outputSize += part.length;
    if (outputSize > PDF_LIMITS.outputBytes) throw new PdfLimitError('分割出力の総量');
    files[`${safeFilename(title)}-${String(index + 1).padStart(3, '0')}.pdf`] = part;
    progress(index + 1, records.length);
  }
  return zipSync(files, { level: 0 });
}
