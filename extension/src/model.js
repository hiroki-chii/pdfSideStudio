export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
export const MAX_PAGES = 300;
export const normalizeRotation = angle => ((angle % 360) + 360) % 360;
const sourceColors = ['#d97757', '#398ba0', '#8a68c4', '#5c9a64', '#c28730', '#c45f88', '#5d7ec8', '#8d8b43'];
export const sourceAppearance = number => ({ number, color: sourceColors[(number - 1) % sourceColors.length] });

export function safeFilename(value) {
  return value.replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 100) || 'edited';
}

// Page records are immutable. History shares the original PDF bytes, not copies.
export class EditorModel {
  pages = [];
  activeId = null;
  past = [];
  future = [];
  nextStampNumber = 1;
  documentWatermark = undefined;

  snapshot() { return { pages: this.pages, activeId: this.activeId, nextStampNumber: this.nextStampNumber, documentWatermark: this.documentWatermark }; }
  sessionSnapshot() { return { state: this.snapshot(), past: [...this.past], future: [...this.future] }; }
  restoreSession({ state, past, future }) { this.restore(state); this.past = past; this.future = future; }
  restore(state) {
    this.pages = state.pages; this.activeId = state.activeId; this.nextStampNumber = state.nextStampNumber;
    this.documentWatermark = state.documentWatermark;
  }
  commit(pages, { activeId = this.activeId, nextStampNumber = this.nextStampNumber, documentWatermark = this.documentWatermark } = {}) {
    if (pages.length > MAX_PAGES) throw new Error(`一度に編集できるのは${MAX_PAGES}ページまでです。`);
    const before = this.snapshot();
    this.past.push(before);
    if (this.past.length > 30) this.past.shift();
    this.future = [];
    // Undefined also covers older sessions with per-page watermarks.
    this.pages = documentWatermark === undefined ? pages
      : pages.map(page => page.watermark === documentWatermark ? page : { ...page, watermark: documentWatermark });
    this.documentWatermark = documentWatermark;
    this.nextStampNumber = nextStampNumber;
    this.activeId = pages.some(p => p.id === activeId) ? activeId : (pages[0]?.id ?? null);
    this.onChange?.({ type: 'commit', before, after: this.snapshot() });
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
  undo() {
    if (!this.past.length) return;
    const before = this.snapshot();
    this.future.push(before); this.restore(this.past.pop());
    this.onChange?.({ type: 'undo', before, after: this.snapshot() });
  }
  redo() {
    if (!this.future.length) return;
    const before = this.snapshot();
    this.past.push(before); this.restore(this.future.pop());
    this.onChange?.({ type: 'redo', before, after: this.snapshot() });
  }
  get active() { return this.pages.find(p => p.id === this.activeId); }
}
