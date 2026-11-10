import { PDFDocument } from 'pdf-lib';
import { PDF_LIMITS } from './limits.js';

const signatures = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/webp': [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
};

export async function imageToPdf(bytes) {
  const type = Object.keys(signatures).find(key =>
    signatures[key].every((value, index) => value === null || bytes[index] === value));
  const unreadable = '画像を読み込めません。JPEG・PNG・WebP形式か、ファイルが破損していないか確認してください。';
  if (!type) throw new Error(unreadable);
  const bitmap = await globalThis.createImageBitmap(new Blob([bytes], { type })).catch(() => { throw new Error(unreadable); });
  const jpeg = type === 'image/jpeg';
  // RGB and alpha streams from lossless images must fit the PDF parser's limits.
  const maxPixels = jpeg ? PDF_LIMITS.imagePixels : PDF_LIMITS.streamBytes / 4;
  const scale = Math.min(1, PDF_LIMITS.rasterSide / Math.max(bitmap.width, bitmap.height),
    Math.sqrt(maxPixels / (bitmap.width * bitmap.height)));
  const width = Math.max(1, Math.floor(bitmap.width * scale));
  const height = Math.max(1, Math.floor(bitmap.height * scale));
  const pageWidth = bitmap.width * scale * 0.75;
  const pageHeight = bitmap.height * scale * 0.75;
  let canvas, imageBytes;
  try {
    canvas = new globalThis.OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: jpeg ? 'image/jpeg' : 'image/png', quality: 0.95 });
    imageBytes = await blob.arrayBuffer();
  } finally {
    bitmap.close();
    if (canvas) canvas.width = canvas.height = 0;
  }
  const pdf = await PDFDocument.create();
  const image = await (jpeg ? pdf.embedJpg(imageBytes) : pdf.embedPng(imageBytes));
  pdf.addPage([pageWidth, pageHeight]).drawImage(image, { x: 0, y: 0, width: pageWidth, height: pageHeight });
  return pdf.save();
}
