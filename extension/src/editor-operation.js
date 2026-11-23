function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
const ids = items => items.map(item => item.id);
const byId = items => new Map(items.map(item => [item.id, item]));
const sameDocument = (a, b) => !!a && !!b && a.nextStampNumber === b.nextStampNumber
  && equal(a.documentWatermark, b.documentWatermark) && equal(a.pages, b.pages);

function conflict() {
  throw new Error('別の画面で同じ内容が変更されました。最新の状態で操作をやり直してください。');
}

function diffList(before, after) {
  const originals = byId(before), updated = byId(after);
  const edits = before.flatMap(item => updated.get(item.id) === item ? [] : [[item, updated.get(item.id)]]);
  for (const item of after) if (!originals.has(item.id)) edits.push([undefined, item]);
  const previous = ids(before), next = ids(after);
  return { edits, order: equal(previous, next) ? null : { previous, next } };
}

// Compare only fields the user changed. Independent edits on the same page can
// be applied even when both screens calculated them from an earlier state.
function mergeRecord(current, before, after, mergeField = null) {
  const result = { ...current };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const hadKey = Object.hasOwn(before, key), hasKey = Object.hasOwn(after, key);
    if (hadKey === hasKey && equal(before[key], after[key])) continue;
    if (mergeField && key === 'strokes') {
      result.strokes = mergeField(current.strokes, before.strokes, after.strokes);
    } else {
      if (Object.hasOwn(current, key) !== hadKey || !equal(current[key], before[key])) conflict();
      if (hasKey) result[key] = after[key];
      else delete result[key];
    }
  }
  return result;
}

function mergeList(current, { edits, order }, merge = mergeRecord) {
  if (!edits.length && !order) return current;
  const items = byId(current);
  for (const [before, after] of edits) {
    const id = (before ?? after).id;
    const existing = items.get(id);
    if (before && after) {
      if (!existing) conflict();
      items.set(id, merge(existing, before, after));
    } else {
      if (!equal(existing, before)) conflict();
      if (after) items.set(id, after);
      else items.delete(id);
    }
  }
  if (!order) return [...items.values()];

  const previous = new Set(order.previous), next = new Set(order.next);
  const survivingBefore = order.previous.filter(id => next.has(id));
  const survivingAfter = order.next.filter(id => previous.has(id));
  if (!equal(survivingBefore, survivingAfter)) {
    if (!equal(ids(current), order.previous)) conflict();
    return order.next.map(id => items.get(id));
  }
  // Insert new items before their next surviving neighbour; keep additions
  // from another edit in their existing relative order.
  const result = ids(current).filter(id => items.has(id));
  let anchor = null;
  for (const id of order.next.toReversed()) {
    if (!items.has(id)) continue;
    if (!previous.has(id)) result.splice(anchor === null ? result.length : result.indexOf(anchor), 0, id);
    anchor = id;
  }
  return result.map(id => items.get(id));
}

function mergePage(current, before, after) {
  return mergeRecord(current, before, after,
    (strokes, previous, next) => mergeList(strokes, diffList(previous, next)));
}

export function createEditorOperation({ type, before, after }) {
  if (type !== 'commit') return { type, before, after };
  return { type, pages: diffList(before.pages, after.pages), activeId: after.activeId,
    stamp: before.nextStampNumber === after.nextStampNumber ? null : [before.nextStampNumber, after.nextStampNumber],
    watermark: equal(before.documentWatermark, after.documentWatermark) ? null : [before.documentWatermark, after.documentWatermark] };
}

export function applyEditorOperation(model, operation, checkSources = () => {}) {
  const { type } = operation;
  if (type === 'commit') {
    const { pages, activeId, stamp, watermark } = operation;
    if (stamp && model.nextStampNumber !== stamp[0]) conflict();
    if (watermark && !equal(model.documentWatermark, watermark[0])) conflict();
    const updated = mergeList(model.pages, pages, mergePage);
    checkSources(updated);
    model.commit(updated, { activeId, nextStampNumber: stamp?.[1] ?? model.nextStampNumber,
      documentWatermark: watermark ? watermark[1] : model.documentWatermark });
  } else if (type === 'undo' || type === 'redo') {
    const history = type === 'undo' ? model.past : model.future;
    if (operation.before && (!sameDocument(model.snapshot(), operation.before)
      || !sameDocument(history.at(-1), operation.after))) conflict();
    if (type === 'undo') model.undo();
    else model.redo();
  } else throw new Error('この編集操作は同期できません。');
}
