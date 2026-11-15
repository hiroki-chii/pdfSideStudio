import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const slice = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));
const dragScript = slice('function clearDropMarker(', 'function finishPageDrag(')
  + slice('function insidePageList(', 'function dropPage(');

test('page drop positions and edge scrolling follow the list orientation', () => {
  for (const editorTab of [false, true]) {
    const markers = new Map();
    const cards = [0, 1].map(index => ({
      querySelector: () => ({ dataset: { id: `page-${index}` } }),
      classList: { add: name => markers.set(index, name), remove: () => markers.delete(index) },
      getBoundingClientRect: () => ({ left: editorTab ? 0 : index * 100, top: editorTab ? index * 100 : 0, width: 100, height: 100 }),
    }));
    const list = {
      scrollTop: 0, scrollLeft: 0,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 200 }),
      querySelectorAll: () => cards,
    };
    const context = vm.createContext({ editorTab, $: () => list, draggedPageId: 'page-0',
      dragPointer: editorTab ? { x: 80, y: 190 } : { x: 190, y: 80 }, requestAnimationFrame: () => 1,
      dragScrollFrame: null });
    vm.runInContext(dragScript, context);
    const [x, y] = editorTab ? [80, 120] : [120, 80];
    assert.equal(context.insertionPoint(x, y).beforeId, 'page-1');
    context.showDropMarker(x, y);
    assert.equal(markers.get(1), 'drop-before');
    context.scrollWhileDragging();
    assert.equal(markers.get(1), 'drop-after');
    assert.ok(list[editorTab ? 'scrollTop' : 'scrollLeft'] > 0);
    assert.equal(list[editorTab ? 'scrollLeft' : 'scrollTop'], 0);
  }
});
