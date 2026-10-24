import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { styledRuns, formatText, replaceText } from '../src/text-format.js';
import { textLayout, textFont, paintOverlay } from '../src/pdf.js';

const original = { tool: 'text', text: '日本語\nPDF', fontSize: 24, color: '#222222', points: [[10, 20]], rotation: 0 };
const styles = annotation => styledRuns(annotation).flatMap(run => Array.from({ length: run.text.length }, () => run.style));

test('overlapping character formats preserve all unselected text, newlines and independent properties', () => {
  let value = formatText(original, 1, 3, { bold: true, fontSize: 30 });
  value = formatText(value, 2, 6, { italic: true, color: '#ff0000' });
  const result = styles(value);
  assert.equal(result[0].bold, false); assert.equal(result[0].fontSize, 24);
  assert.equal(result[1].bold, true); assert.equal(result[1].italic, false);
  assert.equal(result[2].bold, true); assert.equal(result[2].italic, true); assert.equal(result[2].fontSize, 30);
  assert.equal(result[5].bold, false); assert.equal(result[5].italic, true);
  assert.equal(result[6].italic, false); assert.equal(value.text, original.text);
  assert.equal(original.runs, undefined);
  assert.equal(formatText(value, 2, 2, { bold: false }), value);
});

test('whole-box formatting overrides mixed styles only for the changed property', () => {
  let value = formatText(original, 1, 3, { bold: true, color: '#ff0000', fontSize: 36 });
  value = formatText(value, 0, value.text.length, { underline: true }, true);
  assert.ok(styles(value).every(style => style.underline));
  assert.equal(styles(value)[1].color, '#ff0000'); assert.equal(styles(value)[0].color, '#222222');
  value = formatText(value, 0, value.text.length, { bold: true }, true);
  value = formatText(value, 1, 2, { bold: false });
  assert.equal(styles(value)[1].bold, false); assert.equal(styles(value)[2].bold, true);
  value = formatText(value, 0, value.text.length, { fontSize: 18 }, true);
  assert.ok(styles(value).every(style => style.fontSize === 18));
  assert.equal(styles(value)[1].color, '#ff0000');
});

test('plain insertions, deletion and replacement retain adjacent character styles', () => {
  const value = formatText({ ...original, text: 'abcde' }, 1, 4, { bold: true });
  const inserted = replaceText(value, 'abXXcde');
  assert.deepEqual(styles(inserted).map(style => style.bold), [false, true, true, true, true, true, false]);
  const removed = replaceText(value, 'ae');
  assert.deepEqual(styles(removed).map(style => style.bold), [false, false]);
  const replacement = replaceText(value, 'ab語de');
  assert.deepEqual(styles(replacement).map(style => style.bold), [false, true, true, true, false]);
});

test('paragraph alignment expands to selected lines and leaves other lines unchanged', () => {
  const value = formatText(original, 1, 2, { textAlign: 'right' });
  assert.ok(styles(value).slice(0, 4).every(style => style.textAlign === 'right'));
  assert.ok(styles(value).slice(4).every(style => style.textAlign === 'left'));
  const leadingBlank = formatText({ ...original, text: '\nPDF' }, 0, 1, { textAlign: 'center' });
  assert.equal(styles(leadingBlank)[0].textAlign, 'center');
  assert.equal(styles(leadingBlank)[1].textAlign, 'left');
});

test('mixed-size layout measures each run, positions subsequent lines and paints partial underlines', () => {
  const canvas = createCanvas(400, 400), ctx = canvas.getContext('2d');
  const viewport = { scale: 1, rotation: 0, width: 400, height: 400, convertToViewportPoint: (x, y) => [x, y] };
  const value = formatText({ ...original, text: 'ab\ncd' }, 1, 2, { fontSize: 48, underline: true });
  const layout = textLayout(ctx, value, viewport);
  ctx.font = textFont(24, value); const a = ctx.measureText('a').width;
  ctx.font = textFont(48, value); const b = ctx.measureText('b').width;
  assert.ok(Math.abs(layout.lineWidths[0] - a - b) < 0.01);
  assert.equal(layout.height, (48 + 24) * 1.3);
  assert.equal(layout.lineRuns[1][0].y, 48 * 1.3);
  paintOverlay(ctx, { strokes: [value] }, viewport);
  const underline = layout.lineRuns[0][1];
  const alpha = (x, y) => ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3];
  assert.ok(alpha(layout.x + underline.x + b / 2, layout.y + underline.y + 48 * 1.05) > 0);
  assert.equal(alpha(layout.x + a / 2, layout.y + 48 * 1.05), 0);
});
