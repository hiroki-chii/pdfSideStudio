const decodedImages = new WeakMap();

export async function prepareOverlayImages({ strokes = [] }) {
  for (const { tool, image } of strokes) {
    if (tool !== 'image') continue;
    let entry = decodedImages.get(image);
    if (!entry) {
      entry = {};
      entry.ready = globalThis.createImageBitmap(image).then(bitmap => { entry.bitmap = bitmap; }).catch(error => {
        decodedImages.delete(image);
        throw error;
      });
      decodedImages.set(image, entry);
    }
    await entry.ready;
  }
}

export function createImageAnnotation(id, { blob, width, height }, viewport) {
  const factor = Math.min(viewport.width / width, viewport.height / height) * 0.4 / viewport.scale;
  return { id, tool: 'image', image: blob, width: width * factor, height: height * factor,
    originalAspectRatio: width / height, rotation: viewport.rotation,
    points: [viewport.convertToPdfPoint(viewport.width / 2, viewport.height / 2)] };
}

export function imageLayout(annotation, viewport) {
  const [cx, cy] = viewport.convertToViewportPoint(...annotation.points[0]);
  const width = annotation.width * viewport.scale, height = annotation.height * viewport.scale;
  const quarterTurns = (viewport.rotation - annotation.rotation) / 90;
  const angle = quarterTurns * Math.PI / 2;
  const cos = Math.round(Math.cos(angle)), sin = Math.round(Math.sin(angle));
  const halfWidth = (quarterTurns % 2 ? height : width) / 2;
  const halfHeight = (quarterTurns % 2 ? width : height) / 2;
  return { cx, cy, width, height, angle,
    x: cx - (width * cos - height * sin) / 2, y: cy - (width * sin + height * cos) / 2,
    left: cx - halfWidth, right: cx + halfWidth, top: cy - halfHeight, bottom: cy + halfHeight };
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function imageDimensionKey(annotation, rotation, dimension) {
  if ((rotation - annotation.rotation) % 180 === 0) return dimension;
  return dimension === 'width' ? 'height' : 'width';
}

export function moveImage(annotation, viewport, dx, dy) {
  const layout = imageLayout(annotation, viewport);
  dx = clamp(dx, -layout.left, viewport.width - layout.right);
  dy = clamp(dy, -layout.top, viewport.height - layout.bottom);
  return { ...annotation, points: [viewport.convertToPdfPoint(layout.cx + dx, layout.cy + dy)] };
}

function resizeImageFromCorner(annotation, viewport, [horizontal, vertical], dx, dy) {
  const { left, right, top, bottom } = imageLayout(annotation, viewport);
  const anchorX = horizontal < 0 ? right : left;
  const anchorY = vertical < 0 ? bottom : top;
  const diagonalX = horizontal * (right - left);
  const diagonalY = vertical * (bottom - top);
  const availableWidth = horizontal < 0 ? anchorX : viewport.width - anchorX;
  const availableHeight = vertical < 0 ? anchorY : viewport.height - anchorY;
  const max = Math.min(availableWidth / Math.abs(diagonalX), availableHeight / Math.abs(diagonalY));
  const min = Math.min(max, 1 / Math.max(annotation.width, annotation.height));
  // Project onto the original diagonal so the opposite corner stays fixed and the aspect ratio is preserved.
  const factor = 1 + (dx * diagonalX + dy * diagonalY) / (diagonalX ** 2 + diagonalY ** 2);
  const scale = clamp(factor, min, max);
  if (Math.abs(scale - 1) < 1e-8) return annotation;
  return { ...annotation, width: annotation.width * scale, height: annotation.height * scale,
    points: [viewport.convertToPdfPoint(anchorX + diagonalX * scale / 2, anchorY + diagonalY * scale / 2)] };
}

export function resizeImageFromHandle(annotation, viewport, direction, dx, dy) {
  const [horizontal, vertical] = direction;
  if (horizontal && vertical) return resizeImageFromCorner(annotation, viewport, direction, dx, dy);

  const { cx, cy, left, right, top, bottom } = imageLayout(annotation, viewport);
  const sign = horizontal || vertical;
  const dimension = horizontal ? 'width' : 'height';
  const start = horizontal ? left : top, end = horizontal ? right : bottom;
  const originalSize = end - start;
  const anchor = sign < 0 ? end : start;
  const max = sign < 0 ? anchor : viewport[dimension] - anchor;
  const min = Math.min(max, viewport.scale, originalSize);
  const size = clamp(originalSize + sign * (horizontal ? dx : dy), min, max);
  if (Math.abs(size - originalSize) < 1e-8 * viewport.scale) return annotation;
  const center = anchor + sign * size / 2;
  const key = imageDimensionKey(annotation, viewport.rotation, dimension);
  return { ...annotation, [key]: size / viewport.scale,
    points: [viewport.convertToPdfPoint(horizontal ? center : cx, horizontal ? cy : center)] };
}

export function restoreImageAspectRatio(annotation) {
  const bitmap = decodedImages.get(annotation.image)?.bitmap;
  const ratio = annotation.originalAspectRatio ?? (bitmap ? bitmap.width / bitmap.height : null);
  if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(annotation.width / annotation.height / ratio - 1) < 1e-8) return annotation;
  // Fit the original proportions inside the existing frame around the same center.
  return { ...annotation, width: Math.min(annotation.width, annotation.height * ratio),
    height: Math.min(annotation.height, annotation.width / ratio) };
}

export function paintImage(ctx, annotation, viewport) {
  const bitmap = decodedImages.get(annotation.image)?.bitmap;
  if (!bitmap) return;
  const layout = imageLayout(annotation, viewport);
  ctx.save();
  ctx.translate(layout.x, layout.y);
  ctx.rotate(layout.angle);
  ctx.globalAlpha = annotation.opacity ?? 1;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, layout.width, layout.height);
  ctx.restore();
}
