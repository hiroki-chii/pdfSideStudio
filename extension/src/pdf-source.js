import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { runPdfJob } from './pdf-processor.js';
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_PAGES } from './model.js';
import { PDF_LIMITS, PdfLimitError } from './limits.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export async function readPdfSource(file, { usedBytes, pageCount }) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error('PDFファイルを選択してください。');
  if (file.size > MAX_FILE_BYTES) throw new Error('1ファイル50MiBまでです。');
  if (usedBytes + file.size > MAX_TOTAL_BYTES) throw new Error('読み込み総量150MiBを超えます。保存後にパネルを開き直してください。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pages = await runPdfJob({ type: 'load', bytes });
  if (pageCount + pages.length > MAX_PAGES) throw new Error(`${MAX_PAGES}ページを超えます。`);
  const loading = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false,
    cMapUrl: new URL('cmaps/', document.baseURI).href, cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', document.baseURI).href,
    wasmUrl: new URL('wasm/', document.baseURI).href,
    useWasm: false, useWorkerFetch: false, enableXfa: false,
    maxImageSize: PDF_LIMITS.imagePixels, canvasMaxAreaInBytes: PDF_LIMITS.imagePixels * 4 });
  loading.onPassword = () => { loading.destroy().catch(() => {}); };
  let timer;
  try {
    const preview = await Promise.race([loading.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new PdfLimitError('プレビュー読み込み時間')), PDF_LIMITS.loadTimeout);
    })]);
    if (preview.numPages !== pages.length) throw new Error('PDFのページ構造を確認できません。');
    return { bytes, preview, pages, name: file.name, size: file.size };
  } catch (error) { loading.destroy().catch(() => {}); throw error; }
  finally { clearTimeout(timer); }
}

export function pdfErrorMessage(error) {
  if (/encrypt|password/i.test(error.message)) return 'パスワード保護PDFには対応していません。';
  if (/parse|invalid|header|structure/i.test(error.message)) return 'PDFを読み込めません。ファイルが破損していないか確認してください。';
  return error.message || 'PDFの処理に失敗しました。';
}
