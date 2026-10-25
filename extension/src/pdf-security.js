// Adapter for the pinned pdf-lib 1.17.1 parser. All overrides are per instance;
// no library prototypes or installed dependency files are modified.
import { PDFDocument, PDFParser, PDFObjectStreamParser, PDFXRefStreamParser, PDFRawStream, PDFDict, PDFArray, PDFName, PDFNumber, decodePDFRawStream } from 'pdf-lib';
import { PDF_LIMITS, PdfLimitError } from './limits.js';
import { MAX_FILE_BYTES, MAX_PAGES } from './model.js';

const name = (dict, key) => dict.lookup(PDFName.of(key));
const number = (dict, key) => { const value = name(dict, key); return value instanceof PDFNumber ? value.asNumber() : NaN; };
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const structural = new Set(['ObjStm', 'XRef']);
const imageFilters = new Set(['DCTDecode', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode']);

export function createPdfBudget(limits = PDF_LIMITS) {
  return { limits, objects: 0, allocated: 0, depth: 0, error: null, inspected: new WeakSet(), started: performance.now() };
}

function reject(budget, reason) {
  budget.error ||= new PdfLimitError(reason);
  throw budget.error;
}

function checkTime(budget) {
  if (performance.now() - budget.started > budget.limits.exportTimeout) reject(budget, '処理時間');
}

function decodeBounded(raw, budget) {
  const decoder = decodePDFRawStream(raw);
  const seen = new Set();
  // Guard every filter in a chain, including intermediate decompression buffers.
  for (let part = decoder; part && !seen.has(part); part = part.stream) {
    seen.add(part);
    if (typeof part.ensureBuffer !== 'function') continue;
    const allocate = part.ensureBuffer.bind(part), read = part.readBlock.bind(part);
    part.ensureBuffer = requested => {
      if (!integer(requested, budget.limits.streamBytes)) reject(budget, 'ストリーム展開量');
      let size = part.buffer.byteLength || part.minBufferLength;
      while (size < requested) size *= 2;
      const growth = Math.max(0, size - part.buffer.byteLength);
      if (size > budget.limits.streamBytes || budget.allocated + growth > budget.limits.decodedBytes) reject(budget, '累計展開量');
      budget.allocated += growth;
      return allocate(requested);
    };
    part.readBlock = () => { checkTime(budget); return read(); };
  }
  const bytes = decoder.decode();
  if (bytes.length > budget.limits.streamBytes) reject(budget, 'ストリームサイズ');
  return bytes;
}

function inspectStream(raw, budget) {
  if (budget.inspected.has(raw)) return;
  const dict = raw.dict, type = name(dict, 'Type')?.decodeText?.();
  const filter = name(dict, 'Filter');
  const filters = filter instanceof PDFArray ? filter.asArray().map(value => dict.context.lookup(value)) : filter ? [filter] : [];
  if (filters.length > 4 || filters.some(value => !(value instanceof PDFName))) reject(budget, 'フィルター数・形式');
  const image = name(dict, 'Subtype') === PDFName.of('Image');
  if (image) {
    const width = number(dict, 'Width'), height = number(dict, 'Height');
    if (!integer(width, budget.limits.imagePixels) || !integer(height, budget.limits.imagePixels)
      || width < 1 || height < 1 || width * height > budget.limits.imagePixels) reject(budget, '画像ピクセル数');
    if (dict.has(PDFName.of('BitsPerComponent')) && ![1, 2, 4, 8, 16].includes(number(dict, 'BitsPerComponent'))) reject(budget, '画像のビット数');
  }
  const encodedImage = filters.some(value => imageFilters.has(value.decodeText()));
  if (encodedImage && (!image || filters.length !== 1)) reject(budget, '画像フィルターの組み合わせ');
  if (raw.contents.length > budget.limits.streamBytes) reject(budget, 'ストリームサイズ');
  // Decode one filter at a time. Constructing an entire filter chain first can
  // trigger an inner decoder before its allocation guard has been installed.
  let decoded = raw.contents;
  const parameters = name(dict, 'DecodeParms');
  for (const [index, filterName] of filters.entries()) {
    const step = dict.clone(dict.context);
    step.set(PDFName.of('Filter'), filterName);
    const params = parameters instanceof PDFArray ? parameters.lookup(index) : parameters;
    step.delete(PDFName.of('DecodeParms'));
    if (params instanceof PDFDict) {
      step.set(PDFName.of('DecodeParms'), params);
      const dimension = (key, fallback) => params.has(PDFName.of(key)) ? number(params, key) : fallback;
      const columns = dimension('Columns', 1), colors = dimension('Colors', 1), bits = dimension('BitsPerComponent', 8);
      const rows = dimension('Rows', 0);
      if (!integer(columns, budget.limits.imagePixels) || columns < 1 || !integer(colors, 32) || colors < 1
        || !integer(rows, budget.limits.imagePixels) || rows * columns > budget.limits.imagePixels
        || ![1, 2, 4, 8, 16].includes(bits) || columns * colors * bits / 8 > budget.limits.streamBytes) reject(budget, '予測フィルターのサイズ');
    } else if (params && params.toString() !== 'null') reject(budget, 'フィルターパラメーター');
    if (!encodedImage) decoded = decodeBounded(PDFRawStream.of(step, decoded), budget);
  }
  if (structural.has(type)) {
    // The library's internal structural parsers must receive already-bounded data.
    raw.contents = decoded;
    dict.delete(PDFName.of('Filter')); dict.delete(PDFName.of('DecodeParms'));
  }
  budget.inspected.add(raw);
}

function guardParser(parser, budget) {
  const parse = parser.parseObject.bind(parser);
  parser.parseObject = () => {
    checkTime(budget);
    if (++budget.objects > budget.limits.objects || ++budget.depth > budget.limits.depth) reject(budget, 'オブジェクト数・深さ');
    try {
      const object = parse();
      if (object instanceof PDFRawStream && structural.has(name(object.dict, 'Type')?.decodeText?.())) inspectStream(object, budget);
      return object;
    } finally { budget.depth--; }
  };
  return parser;
}

function validateTree(context, budget) {
  const catalog = context.lookup(context.trailerInfo.Root);
  if (!(catalog instanceof PDFDict)) throw new Error('PDFのページ構造が不正です。');
  const stack = [[name(catalog, 'Pages'), 0, undefined]], seen = new Set();
  let pages = 0;
  while (stack.length) {
    const [node, depth, parent] = stack.pop();
    if (!(node instanceof PDFDict) || seen.has(node) || depth > budget.limits.depth) reject(budget, 'ページ構造');
    seen.add(node);
    if (name(node, 'Parent') !== parent) reject(budget, '親ページ参照');
    if (name(node, 'Type') === PDFName.of('Page')) {
      if (++pages > MAX_PAGES) reject(budget, 'ページ数');
    } else {
      if (name(node, 'Type') !== PDFName.of('Pages')) reject(budget, 'ページ種別');
      const kids = name(node, 'Kids');
      if (!(kids instanceof PDFArray) || kids.size() > budget.limits.objects || seen.size > budget.limits.objects) reject(budget, 'ページ構造');
      for (const kid of kids.asArray()) stack.push([context.lookup(kid), depth + 1, node]);
    }
  }
  if (!pages) throw new Error('ページが含まれていません。');
}

export async function loadLimitedPdf(bytes, budget = createPdfBudget()) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_FILE_BYTES) reject(budget, 'ファイルサイズ');
  const parser = guardParser(PDFParser.forBytesWithOptions(bytes, 100, true), budget);
  // Intercept the structural parser factories locally by handling those two
  // stream kinds here; all other PDF syntax stays with pdf-lib's parser.
  parser.parseIndirectObject = async () => {
    const ref = parser.parseIndirectObjectHeader();
    const object = parser.parseObject();
    const type = object instanceof PDFRawStream && name(object.dict, 'Type');
    if (type === PDFName.of('ObjStm')) {
      if (!integer(number(object.dict, 'N'), budget.limits.objects) || !integer(number(object.dict, 'First'), object.contents.length)) reject(budget, '圧縮オブジェクト数・位置');
      await guardParser(PDFObjectStreamParser.forStream(object, parser.shouldWaitForTick), budget).parseIntoContext();
    } else if (type === PDFName.of('XRef')) {
      const size = number(object.dict, 'Size'), widths = name(object.dict, 'W'), ranges = name(object.dict, 'Index');
      if (!integer(size, budget.limits.objects) || !(widths instanceof PDFArray) || widths.size() !== 3
        || widths.asArray().some(value => !(value instanceof PDFNumber) || !integer(value.asNumber(), 8))) reject(budget, '相互参照表');
      if (ranges) {
        if (!(ranges instanceof PDFArray) || ranges.size() % 2 || ranges.size() > budget.limits.objects) reject(budget, '相互参照表');
        let count = 0;
        for (let i = 0; i < ranges.size(); i++) {
          const value = ranges.lookup(i);
          if (!(value instanceof PDFNumber) || !integer(value.asNumber(), budget.limits.objects)) reject(budget, '相互参照表');
          if (i % 2) count += value.asNumber();
        }
        if (count > budget.limits.objects) reject(budget, '相互参照表');
      }
      PDFXRefStreamParser.forStream(object).parseIntoContext();
    } else {
      // Already inspected; assigning directly avoids parsing/decoding twice.
      parser.context.assign(ref, object);
    }
    parser.skipWhitespaceAndComments();
    parser.matchKeyword(new Uint8Array([101, 110, 100, 111, 98, 106])); // endobj
    return ref;
  };
  // A failed limit must never be recovered as an opaque "invalid object".
  parser.tryToParseInvalidIndirectObject = () => { throw budget.error || new Error('PDFの構造を安全に読み込めません。'); };
  try {
    const context = await parser.parseDocument();
    if (context.trailerInfo.Encrypt) throw new Error('パスワード保護PDFには対応していません。');
    // Resolve forward/indirect Filter, DecodeParms and image dimensions before
    // checking ordinary streams. Structural streams are checked before parsing.
    for (const [, object] of context.enumerateIndirectObjects()) {
      checkTime(budget);
      if (object instanceof PDFRawStream) inspectStream(object, budget);
    }
    validateTree(context, budget);
    return new PDFDocument(context, false, false);
  } catch (error) { throw budget.error || error; }
}
