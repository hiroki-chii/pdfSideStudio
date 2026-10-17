import { paintOverlay } from './pdf.js';

export function createFullscreenPreview({ root = document, getPreview,
  pixelRatio = () => window.devicePixelRatio || 1,
  observe = callback => new ResizeObserver(callback), paint = paintOverlay }) {
  const $ = id => root.getElementById(`fullscreen-${id}`);
  const opener = root.getElementById('open-fullscreen-preview');
  const dialog = $('preview'), scroll = $('scroll'), paper = $('paper');
  const pdf = $('pdf'), ink = $('ink');
  let snapshot = null, zoom = 1, version = 0, task = null, size = '';
  let pageStyle = null;
  let resizeFrame = null;

  function updateControls() {
    $('label').textContent = snapshot.label;
    $('page-position').textContent = `${snapshot.pageIndex + 1} / ${snapshot.pageCount}`;
    $('previous').disabled = snapshot.pageIndex <= 0;
    $('next').disabled = snapshot.pageIndex >= snapshot.pageCount - 1;
    $('zoom-value').textContent = `${Math.round(zoom * 100)}%`;
    $('zoom-out').disabled = zoom <= 0.5;
    $('zoom-in').disabled = zoom >= 4;
  }

  async function render(anchor = null) {
    const currentVersion = ++version;
    const previousTask = task;
    previousTask?.cancel();
    if (!dialog.open || !snapshot) return;
    const current = snapshot;
    size = `${scroll.clientWidth}:${scroll.clientHeight}`;
    $('status').hidden = false;
    $('status').textContent = '読み込み中…';
    paper.style.visibility = 'hidden';
    try {
      // Wait for cancellation before reusing the same canvas on rapid wheel input.
      await previousTask?.promise.catch(() => {});
      const page = await current.source.preview.getPage(current.record.index + 1);
      if (currentVersion !== version || !dialog.open) return;
      const base = page.getViewport({ scale: 1, rotation: current.record.rotation });
      const fit = Math.min(Math.max(1, scroll.clientWidth - 32) / base.width,
        Math.max(1, scroll.clientHeight - 32) / base.height);
      const width = base.width * fit * zoom, height = base.height * fit * zoom;
      const ratio = Math.min(pixelRatio(), 2, 4096 / Math.max(width, height));
      const viewport = page.getViewport({ scale: fit * zoom * ratio, rotation: current.record.rotation });
      paper.style.width = `${width}px`; paper.style.height = `${height}px`;
      pdf.width = ink.width = Math.ceil(viewport.width);
      pdf.height = ink.height = Math.ceil(viewport.height);
      task = page.render({ canvasContext: pdf.getContext('2d'), viewport });
      await task.promise;
      if (currentVersion !== version || !dialog.open) return;
      paint(ink.getContext('2d'), current.record, viewport);
      paper.style.visibility = 'visible';
      if (anchor) {
        const bounds = scroll.getBoundingClientRect(), next = paper.getBoundingClientRect();
        scroll.scrollLeft += next.left + anchor.x * next.width - bounds.left - scroll.clientWidth / 2;
        scroll.scrollTop += next.top + anchor.y * next.height - bounds.top - scroll.clientHeight / 2;
      }
      $('status').hidden = true;
    } catch (error) {
      if (currentVersion !== version || !dialog.open || error.name === 'RenderingCancelledException') return;
      $('status').textContent = 'プレビューを表示できません。閉じてから再度お試しください。';
    }
  }

  function setZoom(value) {
    const next = Math.max(0.5, Math.min(4, value));
    if (!dialog.open || next === zoom) return;
    const bounds = scroll.getBoundingClientRect(), previous = paper.getBoundingClientRect();
    const anchor = previous.width && previous.height ? {
      x: (bounds.left + scroll.clientWidth / 2 - previous.left) / previous.width,
      y: (bounds.top + scroll.clientHeight / 2 - previous.top) / previous.height,
    } : null;
    zoom = next; updateControls();
    return render(anchor);
  }

  function open() {
    if (dialog.open) return;
    const next = getPreview();
    if (!next) return;
    snapshot = next; zoom = 1;
    const html = root.documentElement;
    pageStyle = { overflow: html.style.overflow, paddingRight: root.body.style.paddingRight,
      scrollTop: root.scrollingElement.scrollTop, scrollLeft: root.scrollingElement.scrollLeft };
    // Keep the editor width stable while disabling background scrolling.
    const gutter = Math.max(0, root.defaultView.innerWidth - html.clientWidth);
    const padding = root.defaultView.getComputedStyle(root.body).paddingRight;
    root.body.style.paddingRight = `calc(${padding} + ${gutter}px)`;
    html.style.overflow = 'hidden';
    updateControls(); dialog.showModal();
    scroll.scrollLeft = 0; scroll.scrollTop = 0;
    return render();
  }
  function navigate(offset) {
    if (!dialog.open || !snapshot) return;
    const index = snapshot.pageIndex + offset;
    if (index < 0 || index >= snapshot.pageCount) return;
    const next = getPreview(index);
    if (!next) return;
    snapshot = next;
    updateControls();
    scroll.scrollLeft = 0; scroll.scrollTop = 0;
    return render();
  }
  opener.addEventListener('click', open);
  $('previous').addEventListener('click', () => navigate(-1));
  $('next').addEventListener('click', () => navigate(1));
  dialog.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.target === scroll && scroll.scrollWidth > scroll.clientWidth) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); return navigate(event.key === 'ArrowLeft' ? -1 : 1);
  });
  $('close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
  dialog.addEventListener('close', async () => {
    const closedVersion = ++version;
    snapshot = null; task?.cancel();
    if (resizeFrame !== null) root.defaultView.cancelAnimationFrame(resizeFrame);
    resizeFrame = null;
    root.documentElement.style.overflow = pageStyle.overflow;
    root.body.style.paddingRight = pageStyle.paddingRight;
    opener.focus({ preventScroll: true });
    root.scrollingElement.scrollTop = pageStyle.scrollTop;
    root.scrollingElement.scrollLeft = pageStyle.scrollLeft; pageStyle = null;
    await task?.promise.catch(() => {});
    if (closedVersion !== version || dialog.open) return;
    pdf.width = pdf.height = ink.width = ink.height = 0;
  });
  $('zoom-out').addEventListener('click', () => setZoom(zoom - 0.25));
  $('zoom-in').addEventListener('click', () => setZoom(zoom + 0.25));
  $('zoom-fit').addEventListener('click', () => setZoom(1));
  scroll.addEventListener('wheel', event => {
    if (!event.ctrlKey || !event.deltaY || !dialog.open) return;
    event.preventDefault(); setZoom(zoom + (event.deltaY < 0 ? 0.25 : -0.25));
  }, { passive: false });
  const observer = observe(() => {
    if (!dialog.open || size === `${scroll.clientWidth}:${scroll.clientHeight}`) return;
    if (resizeFrame !== null) root.defaultView.cancelAnimationFrame(resizeFrame);
    // Defer layout changes until the next frame to avoid ResizeObserver delivery loops.
    resizeFrame = root.defaultView.requestAnimationFrame(() => {
      resizeFrame = null;
      if (dialog.open && size !== `${scroll.clientWidth}:${scroll.clientHeight}`) render();
    });
  });
  observer.observe(scroll);
  return { open };
}
