export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
export const MAX_PAGES = 300;
export const normalizeRotation = angle => ((angle % 360) + 360) % 360;

export function safeFilename(value) {
  return value.replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 100) || 'edited';
}

// Page records are immutable. History shares the original PDF bytes, not copies.
export class EditorModel {
  pages = [];
  activeId = null;
  past = [];
  future = [];

  snapshot() { return { pages: this.pages, activeId: this.activeId }; }
  restore(state) { this.pages = state.pages; this.activeId = state.activeId; }
  commit(pages, { activeId = this.activeId } = {}) {
    if (pages.length > MAX_PAGES) throw new Error(`一度に編集できるのは${MAX_PAGES}ページまでです。`);
    this.past.push(this.snapshot());
    if (this.past.length > 30) this.past.shift();
    this.future = [];
    this.pages = pages;
    this.activeId = pages.some(p => p.id === activeId) ? activeId : (pages[0]?.id ?? null);
  }
  update(ids, transform) { this.commit(this.pages.map(p => ids.has(p.id) ? transform(p) : p)); }
  moveBefore(id, beforeId = null) {
    const page = this.pages.find(p => p.id === id);
    if (!page || id === beforeId || (beforeId !== null && !this.pages.some(p => p.id === beforeId))) return false;
    const pages = this.pages.filter(p => p.id !== id);
    const index = beforeId === null ? pages.length : pages.findIndex(p => p.id === beforeId);
    pages.splice(index, 0, page);
    if (pages.every((p, i) => p === this.pages[i])) return false;
    this.commit(pages);
    return true;
  }
  undo() { if (!this.past.length) return; this.future.push(this.snapshot()); this.restore(this.past.pop()); }
  redo() { if (!this.future.length) return; this.past.push(this.snapshot()); this.restore(this.future.pop()); }
  get active() { return this.pages.find(p => p.id === this.activeId); }
}
