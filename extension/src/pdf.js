import { PDFDocument, degrees } from 'pdf-lib';
import { normalizeRotation } from './model.js';
import { styledRuns, textStyle } from './text-format.js';

export function imagePlacement(viewport) {
  const [x, y] = viewport.convertToPdfPoint(0, viewport.height);
  const [rightX, rightY] = viewport.convertToPdfPoint(viewport.width, viewport.height);
  const [topX, topY] = viewport.convertToPdfPoint(0, 0);
  return { x, y, width: Math.hypot(rightX - x, rightY - y), height: Math.hypot(topX - x, topY - y),
    angle: Math.atan2(rightY - y, rightX - x) * 180 / Math.PI };
}

export function watermarkLayout(ctx, watermark, viewport) {
  let size = Math.min(viewport.width, viewport.height) * 0.13;
  ctx.save();
  ctx.font = `600 ${size}px "Noto Sans JP", "Yu Gothic", "Meiryo", sans-serif`;
  const measured = ctx.measureText(watermark.text).width;
  const limit = Math.min(viewport.width, viewport.height) * 0.94;
  if (measured > limit) size *= limit / measured;
  ctx.font = `600 ${size}px "Noto Sans JP", "Yu Gothic", "Meiryo", sans-serif`;
  const width = ctx.measureText(watermark.text).width, height = size * 1.3;
  ctx.restore();
  const [cx, cy] = watermark.points ? viewport.convertToViewportPoint(...watermark.points[0]) : [viewport.width / 2, viewport.height / 2];
  const angle = -Math.PI / 6;
  const x = cx - width / 2 * Math.cos(angle) + height / 2 * Math.sin(angle);
  const y = cy - width / 2 * Math.sin(angle) - height / 2 * Math.cos(angle);
  const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([dx, dy]) =>
    [x + dx * Math.cos(angle) - dy * Math.sin(angle), y + dx * Math.sin(angle) + dy * Math.cos(angle)]);
  return { x, y, cx, cy, size, width, height, angle,
    left: Math.min(...corners.map(p => p[0])), right: Math.max(...corners.map(p => p[0])),
    top: Math.min(...corners.map(p => p[1])), bottom: Math.max(...corners.map(p => p[1])) };
}

export function moveWatermark(ctx, watermark, viewport, dx, dy) {
  const layout = watermarkLayout(ctx, watermark, viewport);
  const clamp = (delta, min, max) => min <= max ? Math.max(min, Math.min(max, delta)) : (min + max) / 2;
  dx = clamp(dx, -layout.left, viewport.width - layout.right);
  dy = clamp(dy, -layout.top, viewport.height - layout.bottom);
  return { ...watermark, points: [viewport.convertToPdfPoint(layout.cx + dx, layout.cy + dy)] };
}

export function paintOverlay(ctx, record, viewport) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (record.watermark) {
    const { text, color, opacity } = record.watermark;
    const layout = watermarkLayout(ctx, record.watermark, viewport);
    ctx.save();
    ctx.translate(layout.cx, layout.cy);
    ctx.rotate(layout.angle);
    ctx.font = `600 ${layout.size}px "Noto Sans JP", "Yu Gothic", "Meiryo", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.globalAlpha = opacity;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
  for (const stroke of record.strokes) {
    if (stroke.tool === 'text') paintText(ctx, stroke, viewport);
    else paintStroke(ctx, stroke, viewport);
  }
}

const textFonts = {
  'sans-serif': '"Noto Sans JP", "Yu Gothic", "Meiryo", sans-serif',
  serif: '"Noto Serif JP", "Yu Mincho", "MS PMincho", serif',
  monospace: '"BIZ UDGothic", "MS Gothic", monospace',
};
export const textFontFamily = family => textFonts[family] || textFonts['sans-serif'];
export const textFont = (size, annotation = {}) => `${annotation.italic ? 'italic ' : ''}${annotation.bold ? 700 : 400} ${size}px ${textFontFamily(annotation.fontFamily)}`;

export function textLayout(ctx, annotation, viewport) {
  const [x, y] = viewport.convertToViewportPoint(...annotation.points[0]);
  const size = annotation.fontSize * viewport.scale;
  const lines = annotation.text.split('\n'), lineRuns = [[]];
  for (const run of styledRuns(annotation)) {
    run.text.split('\n').forEach((text, index) => {
      if (index) lineRuns.push([]);
      if (text) lineRuns.at(-1).push({ text, style: run.style });
    });
  }
  ctx.save();
  const metrics = [], lineSizes = [], lineStyles = [];
  for (const runs of lineRuns) {
    let width = 0, left = 0, right = 0;
    const maxSize = runs.length ? Math.max(...runs.map(run => run.style.fontSize * viewport.scale)) : size;
    for (const run of runs) {
      run.size = run.style.fontSize * viewport.scale;
      ctx.font = textFont(run.size, run.style);
      const measured = ctx.measureText(run.text);
      run.x = width; run.width = measured.width;
      run.y = maxSize - run.size;
      left = Math.max(left, (measured.actualBoundingBoxLeft || 0) - width);
      right = Math.max(right, width + (measured.actualBoundingBoxRight || 0));
      width += measured.width;
    }
    metrics.push({ width, actualBoundingBoxLeft: left, actualBoundingBoxRight: right });
    lineSizes.push(maxSize); lineStyles.push(runs[0]?.style || textStyle(annotation));
  }
  const lineWidths = metrics.map(metric => metric.width);
  const contentWidth = Math.max(size * 0.2, ...lineWidths);
  // Include glyph overhang (especially italics) in selection and page-edge checks.
  const insetLeft = Math.max(0, ...metrics.map(metric => metric.actualBoundingBoxLeft || 0));
  const insetRight = Math.max(0, ...metrics.map(metric => (metric.actualBoundingBoxRight || 0) - metric.width));
  const width = contentWidth + insetLeft + insetRight;
  const lineOffsets = lineWidths.map((lineWidth, index) => insetLeft + (contentWidth - lineWidth)
    * (lineStyles[index].textAlign === 'center' ? 0.5 : lineStyles[index].textAlign === 'right' ? 1 : 0));
  ctx.restore();
  let height = 0;
  lineRuns.forEach((runs, index) => {
    runs.forEach(run => { run.x += lineOffsets[index]; run.y += height; });
    height += lineSizes[index] * 1.3;
  });
  const angle = ((viewport.rotation ?? 0) - annotation.rotation) * Math.PI / 180;
  const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([dx, dy]) =>
    [x + dx * Math.cos(angle) - dy * Math.sin(angle), y + dx * Math.sin(angle) + dy * Math.cos(angle)]);
  return { x, y, size, width, height, contentWidth, insetLeft, insetRight, lines, lineWidths, lineOffsets, lineRuns, angle,
    left: Math.min(...corners.map(p => p[0])), right: Math.max(...corners.map(p => p[0])),
    top: Math.min(...corners.map(p => p[1])), bottom: Math.max(...corners.map(p => p[1])) };
}

export function moveText(ctx, annotation, viewport, dx, dy) {
  const layout = textLayout(ctx, annotation, viewport);
  // Keep the entire text on the paper, including after a page rotation.
  const clamp = (delta, min, max) => min <= max ? Math.max(min, Math.min(max, delta)) : (min + max) / 2;
  dx = clamp(dx, -layout.left, viewport.width - layout.right);
  dy = clamp(dy, -layout.top, viewport.height - layout.bottom);
  return { ...annotation, points: [viewport.convertToPdfPoint(layout.x + dx, layout.y + dy)] };
}

export function strokeLayout(stroke, viewport) {
  const points = stroke.points.map(point => viewport.convertToViewportPoint(...point));
  const visiblePoints = ['line', 'ellipse', 'rectangle'].includes(stroke.tool) ? [points[0], points.at(-1)] : points;
  const radius = stroke.width * viewport.scale / 2;
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const [x, y] of visiblePoints) {
    left = Math.min(left, x - radius); right = Math.max(right, x + radius);
    top = Math.min(top, y - radius); bottom = Math.max(bottom, y + radius);
  }
  return { x: left, y: top, left, right, top, bottom, width: right - left, height: bottom - top, angle: 0 };
}

export function moveStroke(stroke, viewport, dx, dy) {
  const bounds = strokeLayout(stroke, viewport);
  const clamp = (delta, min, max) => min <= max ? Math.max(min, Math.min(max, delta)) : (min + max) / 2;
  dx = clamp(dx, -bounds.left, viewport.width - bounds.right);
  dy = clamp(dy, -bounds.top, viewport.height - bounds.bottom);
  // Translate every point by the same PDF delta, preserving the shape at any rotation/zoom.
  const origin = viewport.convertToPdfPoint(0, 0);
  const offset = viewport.convertToPdfPoint(dx, dy);
  return { ...stroke, points: stroke.points.map(([x, y]) => [x + offset[0] - origin[0], y + offset[1] - origin[1]]) };
}

export function scaleStrokes(strokes, viewport, factor) {
  if (!strokes.length || !Number.isFinite(factor) || factor <= 0) return strokes;
  const bounds = strokes.map(stroke => {
    const layout = strokeLayout(stroke, viewport), radius = stroke.width * viewport.scale / 2;
    return { left: layout.left + radius, right: layout.right - radius,
      top: layout.top + radius, bottom: layout.bottom - radius, radius };
  });
  const left = Math.min(...bounds.map(b => b.left)), right = Math.max(...bounds.map(b => b.right));
  const top = Math.min(...bounds.map(b => b.top)), bottom = Math.max(...bounds.map(b => b.bottom));
  const extent = Math.max(right - left, bottom - top);
  if (extent < 1e-8) return strokes;
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  let maximum = Infinity;
  for (const b of bounds) {
    for (const [value, center, size] of [[b.left, cx, viewport.width], [b.right, cx, viewport.width],
      [b.top, cy, viewport.height], [b.bottom, cy, viewport.height]]) {
      const distance = value - center;
      if (distance > 1e-8) maximum = Math.min(maximum, (size - b.radius - center) / distance);
      else if (distance < -1e-8) maximum = Math.min(maximum, (b.radius - center) / distance);
    }
  }
  // Keep the entire selection on the paper and its longest side at least 1 PDF point.
  factor = Math.max(Math.min(1, viewport.scale / extent), Math.min(factor, Math.max(1, maximum)));
  if (Math.abs(factor - 1) < 1e-8) return strokes;
  return strokes.map(stroke => ({ ...stroke, points: stroke.points.map(point => {
    const [x, y] = viewport.convertToViewportPoint(...point);
    return viewport.convertToPdfPoint(cx + (x - cx) * factor, cy + (y - cy) * factor);
  }) }));
}

function paintText(ctx, annotation, viewport) {
  const layout = textLayout(ctx, annotation, viewport);
  ctx.save();
  ctx.translate(layout.x, layout.y); ctx.rotate(layout.angle);
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  layout.lineRuns.flat().forEach(run => {
    const { x, y, size, style } = run;
    ctx.font = textFont(size, style); ctx.fillStyle = style.color; ctx.strokeStyle = style.color;
    ctx.fillText(run.text, x, y);
    if (style.underline && run.width > 0) {
      ctx.lineWidth = size / 16;
      ctx.beginPath(); ctx.moveTo(x, y + size * 1.05);
      ctx.lineTo(x + run.width, y + size * 1.05); ctx.stroke();
    }
  });
  ctx.restore();
}

export function paintStroke(ctx, stroke, viewport) {
  if (!stroke.points.length) return;
  ctx.save();
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.globalAlpha = Math.max(0, Math.min(1, stroke.opacity ?? 1));
  ctx.lineWidth = stroke.width * viewport.scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const points = stroke.points.map(p => viewport.convertToViewportPoint(...p));
  const first = points[0];
  const last = points.at(-1);
  if (stroke.tool === 'rectangle' && first[0] !== last[0] && first[1] !== last[1]) {
    ctx.strokeRect(Math.min(first[0], last[0]), Math.min(first[1], last[1]),
      Math.abs(last[0] - first[0]), Math.abs(last[1] - first[1]));
  } else if (stroke.tool === 'ellipse' && first[0] !== last[0] && first[1] !== last[1]) {
    ctx.beginPath();
    ctx.ellipse((first[0] + last[0]) / 2, (first[1] + last[1]) / 2,
      Math.abs(last[0] - first[0]) / 2, Math.abs(last[1] - first[1]) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (points.length === 1) {
    ctx.beginPath(); ctx.arc(...points[0], ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.beginPath(); ctx.moveTo(...points[0]);
    if (['line', 'ellipse', 'rectangle'].includes(stroke.tool)) ctx.lineTo(...last);
    else for (const point of points.slice(1)) ctx.lineTo(...point);
    ctx.stroke();
  }
  ctx.restore();
}

export async function buildPdf(records, sources, createOverlay, progress = () => {}) {
  if (!records.length) throw new Error('保存するページがありません。');
  const output = await PDFDocument.create();
  output.setProducer('PDF Side Studio');
  output.setCreator('PDF Side Studio');
  for (const [index, record] of records.entries()) {
    const source = sources.get(record.sourceId);
    if (!source) throw new Error('元のPDFが見つかりません。再度追加してください。');
    const [page] = await output.copyPages(source.document, [record.index]);
    page.setRotation(degrees(normalizeRotation(record.rotation)));
    output.addPage(page);
    if (record.strokes.length || record.watermark) {
      const { bytes, placement } = await createOverlay(record, source);
      const image = await output.embedPng(bytes);
      const { angle, ...position } = placement;
      page.drawImage(image, { ...position, rotate: degrees(angle) });
    }
    progress(index + 1, records.length);
  }
  return output.save();
}
