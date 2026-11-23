// Watermarks have a fixed position outside the editable layer order.
export function orderedStrokes({ strokes, layerOrder }) {
  if (!layerOrder?.length) return strokes;

  const byId = new Map(strokes.map(item => [item.id, item]));
  const ordered = [];
  for (const id of layerOrder) {
    if (!byId.has(id)) continue;
    ordered.push(byId.get(id));
    byId.delete(id);
  }
  // Objects added since the last reorder go in front of the existing strokes.
  for (const stroke of strokes) if (byId.has(stroke.id)) ordered.push(stroke);
  return ordered;
}

export function moveAnnotationLayers(annotations, selection, direction) {
  const isSelected = item => selection.has(item.id);
  if (direction === 'front' || direction === 'back') {
    const selected = annotations.filter(isSelected);
    const others = annotations.filter(item => !isSelected(item));
    return direction === 'front' ? [...others, ...selected] : [...selected, ...others];
  }
  const reordered = [...annotations];
  const step = direction === 'forward' ? 1 : -1;
  // Walk inward from the destination so each selected item crosses at most one neighbour.
  for (let i = step === 1 ? reordered.length - 2 : 1; i >= 0 && i < reordered.length; i -= step) {
    const next = i + step;
    if (isSelected(reordered[i]) && !isSelected(reordered[next])) {
      [reordered[i], reordered[next]] = [reordered[next], reordered[i]];
    }
  }
  return reordered;
}
