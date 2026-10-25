import { PDFDocument, PDFPage, PDFPageLeaf, PDFDict, PDFArray, PDFRef, PDFName, PDFStream, PDFInvalidObject, degrees } from 'pdf-lib';
import { normalizeRotation } from './model.js';
import { PDF_LIMITS, PdfLimitError } from './limits.js';

const pageKeys = ['Resources', 'Contents', 'MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox', 'UserUnit', 'Group'];
const blockedTypes = new Set(['Page', 'Pages', 'Catalog', 'Annot', 'Action', 'Filespec', 'EmbeddedFile']);
const actionTypes = new Set(['JavaScript', 'Launch', 'URI', 'GoTo', 'GoToR', 'GoToE', 'SubmitForm', 'ImportData', 'Rendition']);
const nameOf = value => value instanceof PDFName ? value.decodeText() : '';

// Copy only the selected page's content graph. Never mutate the source document,
// and never let annotations or page-tree references pull excluded pages in.
export function copyPageContent(source, index, output) {
  const sourcePage = source.getPage(index);
  const context = output.context, copied = new Map();
  let count = 0;
  function copy(value, depth = 0) {
    if (value === undefined) return undefined;
    if (depth > PDF_LIMITS.depth || ++count > PDF_LIMITS.objects) throw new PdfLimitError('出力オブジェクト数・深さ');
    if (copied.has(value)) return copied.get(value);
    if (value instanceof PDFRef) {
      const target = source.context.lookup(value);
      if (!target || blocked(target)) return undefined;
      const ref = context.nextRef(); copied.set(value, ref);
      const result = copy(target, depth + 1);
      if (result !== undefined) context.assign(ref, result);
      return result === undefined ? undefined : ref;
    }
    if (blocked(value)) return undefined;
    if (value instanceof PDFInvalidObject) throw new Error('破損したPDFは保存できません。');
    if (value instanceof PDFArray) {
      const result = PDFArray.withContext(context); copied.set(value, result);
      for (let i = 0; i < value.size(); i++) {
        const item = copy(value.get(i), depth + 1);
        // Preserve array indices when a prohibited reference is removed.
        result.push(item ?? context.obj(null));
      }
      return result;
    }
    if (value instanceof PDFDict || value instanceof PDFStream) {
      const result = value instanceof PDFStream ? value.clone(context) : PDFDict.withContext(context);
      copied.set(value, result);
      const from = value instanceof PDFStream ? value.dict : value;
      const to = result instanceof PDFStream ? result.dict : result;
      for (const [key] of to.entries()) to.delete(key);
      for (const [key, item] of from.entries()) {
        const next = copy(item, depth + 1);
        if (next !== undefined) to.set(key, next);
      }
      return result;
    }
    return value.clone();
  }
  function blocked(value) {
    const dict = value instanceof PDFStream ? value.dict : value;
    return dict instanceof PDFDict && (blockedTypes.has(nameOf(dict.lookup(PDFName.of('Type'))))
      || actionTypes.has(nameOf(dict.lookup(PDFName.of('S')))));
  }
  const parent = output.catalog.get(PDFName.of('Pages'));
  const node = PDFPageLeaf.withContextAndParent(context, parent);
  for (const key of pageKeys) {
    const name = PDFName.of(key);
    const value = copy(sourcePage.node.getInheritableAttribute(name));
    if (value !== undefined) node.set(name, value);
  }
  const page = PDFPage.of(node, context.register(node), output);
  output.addPage(page);
  return page;
}

export async function buildPdf(records, sources, createOverlay, progress = () => {}) {
  if (!records.length) throw new Error('保存するページがありません。');
  const output = await PDFDocument.create();
  const flushed = new Set();
  output.setProducer('PDF Side Studio'); output.setCreator('PDF Side Studio');
  for (const [index, record] of records.entries()) {
    const source = sources.get(record.sourceId);
    if (!source) throw new Error('元のPDFが見つかりません。再度追加してください。');
    if (!flushed.has(source.document)) {
      await source.document.flush(); flushed.add(source.document);
    }
    const page = copyPageContent(source.document, record.index, output);
    page.setRotation(degrees(normalizeRotation(record.rotation)));
    if (record.strokes.length || record.watermark) {
      const { bytes, placement } = await createOverlay(record, source);
      const image = await output.embedPng(bytes);
      const { angle, ...position } = placement;
      page.drawImage(image, { ...position, rotate: degrees(angle) });
    }
    progress(index + 1, records.length);
  }
  const bytes = await output.save();
  if (bytes.length > PDF_LIMITS.outputBytes) throw new PdfLimitError('出力サイズ');
  return bytes;
}
