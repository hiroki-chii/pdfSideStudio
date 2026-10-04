import './style.css';
import './theme.css';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { PDFDocument } from 'pdf-lib';
import { zipSync } from 'fflate';
import { EditorModel, safeFilename, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_PAGES, normalizeRotation } from './model.js';
import { buildPdf, imagePlacement, paintOverlay, textLayout, moveText, strokeLayout, moveStroke, watermarkLayout, moveWatermark } from './pdf.js';
import { createThemeController } from './theme.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const $ = id => document.getElementById(id);
let themeStorage;
try { themeStorage = window.localStorage; } catch { /* Theme still works without storage. */ }
createThemeController({ root: document.documentElement, button: $('theme-mode'),
  colorScheme: window.matchMedia('(prefers-color-scheme: dark)'), storage: themeStorage });
const model = new EditorModel();
const sources = new Map();
const sourceColors = ['#d97757', '#398ba0', '#8a68c4', '#5c9a64', '#c28730', '#c45f88', '#5d7ec8', '#8d8b43'];
const thumbnails = new WeakMap();
let busy = false;
let penEnabled = false;
let viewport = null;
let renderTask = null;
let renderVersion = 0;
let stroke = null;
let selectedAnnotationId = null;
let annotationDrag = null;
let textEnabled = false;
let textEdit = null;
let textFormatPreview = null;
let thumbQueue = [];
let thumbRunning = false;
let observer = null;
let draggedPageId = null;
let dragPointer = null;
let dragScrollFrame = null;
let pageDrag = null;
const uid = () => crypto.randomUUID();
const previewMenus = ['rotation', 'pen', 'watermark'];
let activePreviewMenu = 'select';
const toolDescriptions = {
  'open-select': '追加した文字・描画・透かしをクリックして選択。ドラッグで移動、Deleteで削除。Escで選択モードに戻ります。',
  'open-pen': '色・太さ・透明度を設定して紙面をドラッグ。「描画を終了」またはEscで選択モードに戻ります。',
  'open-text': '紙面をクリックしてテキストを1つ追加。「入力を確定」で選択モードに戻ります。配置前のEscで終了。',
  'open-rotation': '対象ページを選び、方向ボタンで左右90度ずつ回転。「元に戻す」で取り消せます。',
  'open-watermark': '文字・色・濃さ・対象を設定し、「適用」で反映。対象ページの追加済み透かしを置き換えます。',
};
for (const [id, description] of Object.entries(toolDescriptions)) {
  const button = $(id);
  button.title = description;
  button.setAttribute('aria-description', description);
}

function status(message, kind = '') {
  $('status').textContent = message; $('status').className = `status ${kind}`;
  if ($('save-dialog').open) {
    $('save-status').hidden = false;
    $('save-status').textContent = message; $('save-status').className = `status ${kind}`;
  }
}
function fail(error) { console.error(error); status(error.message || '処理に失敗しました。別のPDFでお試しください。', 'error'); }
function setBusy(value) { busy = value; updateControls(); }
async function run(action) {
  if (busy || stroke || annotationDrag) return;
  if (!finishTextEdit()) return;
  setBusy(true);
  try { await action(); } catch (error) { fail(error); } finally { setBusy(false); }
}
function activeRequired() {
  if (!model.active) throw new Error('表示中のページがありません。');
  return model.active;
}

function updateControls() {
  document.querySelectorAll('button, input, select, textarea').forEach(element => {
    if (['help', 'close-help', 'theme-mode'].includes(element.id)) return;
    element.disabled = busy;
  });
  $('undo').disabled = busy || !model.past.length;
  $('redo').disabled = busy || !model.future.length;
  const index = model.pages.findIndex(p => p.id === model.activeId);
  $('previous').disabled = busy || index <= 0;
  $('next').disabled = busy || index < 0 || index >= model.pages.length - 1;
  $('split').disabled = busy || !model.pages.length;
  $('split-count').textContent = `${model.pages.length}ページ`;
  const rotationCount = $('rotation-scope').value === 'all' ? model.pages.length : Number(!!model.active);
  $('rotate-left').disabled = busy || !rotationCount;
  $('rotate-right').disabled = busy || !rotationCount;
  $('save').disabled = busy || !model.pages.length;
  $('open-save').disabled = busy || !model.pages.length;
  $('clear-ink').disabled = busy || !model.active?.strokes.some(item => item.tool !== 'text');
  if (!selectedAnnotation()) selectedAnnotationId = null;
  const visibleMenu = selectedStroke() ? 'pen'
    : textEnabled || selectedText() || textEdit ? 'text'
      : selectedAnnotation()?.tool === 'watermark' ? 'watermark' : activePreviewMenu;
  $('open-select').disabled = busy || !model.active;
  $('open-select').setAttribute('aria-pressed', String(activePreviewMenu === 'select'));
  $('open-select').setAttribute('aria-controls', 'panel-select');
  $('open-select').setAttribute('aria-expanded', String(visibleMenu === 'select' && !!model.active));
  $('panel-select').hidden = !model.active || visibleMenu !== 'select';
  $('update-text').disabled = busy || !selectedText() || !viewport;
  $('delete-text').disabled = busy || !selectedText();
  $('panel-text').hidden = !model.active || visibleMenu !== 'text';
  $('delete-stroke').disabled = busy || !selectedStroke();
  $('pen-menu-title').textContent = selectedStroke() ? '選択した描画' : 'ペンの設定';
  $('close-pen').textContent = selectedStroke() ? '選択を解除' : '描画を終了';
  $('pen-drawing-settings').hidden = !!selectedStroke();
  $('stroke-selection-actions').hidden = !selectedStroke();
  $('pen-mode-hint').textContent = selectedStroke()
    ? '選択した描画だけを移動・削除できます。'
    : '紙面をドラッグして描きます。終了するには「描画を終了」かEsc。';
  $('text-menu-title').textContent = textEdit ? 'テキストを入力中' : selectedText() ? '選択したテキスト' : 'テキストを配置';
  $('text-mode-hint').textContent = textEdit ? '色・サイズは入力中の文字に反映されます。'
    : selectedText() ? '色・サイズは選択した文字にすぐ反映されます。ドラッグで移動できます。'
      : '紙面を1回クリックして入力します。色・サイズは新しい文字に適用されます。';
  $('close-text').textContent = textEdit ? '確定して終了' : selectedText() ? '選択を解除' : '配置を終了';
  $('text-selection-actions').hidden = !selectedText() || !!textEdit;
  $('text-edit-actions').hidden = !textEdit;
  $('text-edit-hint').textContent = selectedText() && !textEdit
    ? '方向キーで1pt、Shift＋方向キーで10pt移動。Deleteで削除。ダブルクリックまたは「内容を編集」で再編集できます。続けて追加するには上の「テキスト」を押します。'
    : '外側クリック・Ctrl+Enterで確定。新規入力中のEscは確定、再編集中のEscは変更を取り消します。配置後は選択モードに戻ります。続けて追加するには上の「テキスト」を押します。';
  $('open-text').hidden = !model.pages.length;
  $('open-text').disabled = busy || !model.active;
  $('open-text').setAttribute('aria-pressed', String(activePreviewMenu === 'text'));
  $('open-text').setAttribute('aria-expanded', String(!$('panel-text').hidden));
  $('ink-canvas').classList.toggle('inserting-text', textEnabled && !busy);
  const watermarkPages = $('watermark-scope').value === 'all' ? model.pages : model.active ? [model.active] : [];
  const watermarkCount = watermarkPages.filter(page => page.watermark).length;
  $('apply-watermark').disabled = busy || !watermarkPages.length || !$('watermark-text').value.trim();
  $('remove-watermark').disabled = busy || !watermarkCount;
  for (const name of ['rotation', 'watermark']) {
    const all = $(`${name}-scope`).value === 'all';
    const target = all ? `全${model.pages.length}ページ` : `表示中の${index + 1}ページ目`;
    $(`${name}-target-hint`).textContent = name === 'rotation'
      ? `${target}を回転します。` : `対象: ${all ? `全${model.pages.length}ページ` : `${index + 1}ページ目`}（透かし${watermarkCount}件）`;
    $(`${name}-target-hint`).dataset.all = String(all);
    if (name === 'rotation') {
      $('rotate-left').textContent = all ? `全${model.pages.length}ページを左90°` : '↶ 左に90°';
      $('rotate-right').textContent = all ? `全${model.pages.length}ページを右90°` : '↷ 右に90°';
    } else {
      $('apply-watermark').textContent = all ? `全${model.pages.length}ページに適用` : 'このページに適用';
      $('remove-watermark').textContent = all ? `全${model.pages.length}ページで削除` : 'このページで削除';
    }
  }
  for (const name of previewMenus) {
    const open = visibleMenu === name && !!model.active;
    $(`panel-${name}`).hidden = !open;
    $(`open-${name}`).disabled = busy || !model.pages.length;
    $(`open-${name}`).setAttribute('aria-expanded', String(open));
    $(`open-${name}`).setAttribute('aria-pressed', String(activePreviewMenu === name));
  }
  const selected = selectedAnnotation();
  $('watermark-menu-title').textContent = selected?.tool === 'watermark' ? '選択した透かし' : '透かしの設定';
  $('close-watermark').textContent = selected?.tool === 'watermark' ? '選択を解除' : '選択に戻る';
  $('ink-canvas').classList.toggle('drawing', penEnabled && !busy);
  document.querySelectorAll('.page-button').forEach(button => {
    button.classList.toggle('reorderable', !busy && model.pages.length > 1);
  });
}

function refresh() {
  if (selectedText()) selectAnnotation(selectedText());
  const hasPages = model.pages.length > 0;
  if (!hasPages) { penEnabled = false; textEnabled = false; resetPreviewMenu(); }
  for (const name of previewMenus) $(`open-${name}`).hidden = !hasPages;
  $('page-list-section').hidden = !hasPages;
  $('workspace').hidden = !hasPages && !model.past.length && !model.future.length;
  $('empty-state').hidden = hasPages;
  $('open-save').hidden = !hasPages;
  if (!hasPages && $('save-dialog').open) $('save-dialog').close();
  // Keep history controls available when deleting or undoing the last page.
  document.querySelector('.preview-section').hidden = !hasPages && !model.past.length && !model.future.length;
  document.querySelector('.preview-heading').hidden = !hasPages;
  $('preview-area').hidden = !hasPages;
  document.querySelector('.preview-footer').hidden = !hasPages;
  $('page-count').textContent = model.pages.length;
  $('save-count').textContent = `${model.pages.length}ページ`;
  refreshThumbnails();
  updateControls();
  renderPreview();
}

function refreshThumbnails() {
  observer?.disconnect();
  thumbQueue = [];
  $('page-list').replaceChildren();
  const visibleSources = new Set(model.pages.map(page => page.sourceId));
  $('source-legend').replaceChildren(...[...sources.entries()].filter(([id]) => visibleSources.has(id)).map(([, source]) => {
    const item = document.createElement('span');
    item.className = 'source-legend-item';
    item.style.setProperty('--source-color', source.color);
    item.textContent = `PDF ${source.number}: ${source.name}`;
    item.title = source.name;
    return item;
  }));
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      observer.unobserve(entry.target);
      const record = model.pages.find(p => p.id === entry.target.dataset.id);
      if (record) thumbQueue.push({ record, button: entry.target });
    }
    pumpThumbnails();
  }, { root: $('page-list'), rootMargin: '100px' });
  model.pages.forEach((page, index) => {
    const source = sources.get(page.sourceId);
    const card = document.createElement('div');
    card.className = `page-card${page.id === model.activeId ? ' active' : ''}`;
    card.style.setProperty('--source-color', source.color);
    const button = document.createElement('button');
    button.className = 'page-button'; button.dataset.id = page.id;
    button.title = `${index + 1}: PDF ${source.number}・${source.name} / 元ページ ${page.index + 1}（ドラッグで並べ替え）`;
    button.setAttribute('aria-label', `${index + 1}ページを表示。PDF ${source.number}、${source.name}の元ページ${page.index + 1}`);
    button.setAttribute('aria-current', page.id === model.activeId ? 'page' : 'false');
    const placeholder = document.createElement('span'); placeholder.className = 'thumb-placeholder'; placeholder.textContent = '▤';
    const label = document.createElement('span'); label.textContent = index + 1;
    const sourceLabel = document.createElement('span'); sourceLabel.className = 'page-source-label'; sourceLabel.textContent = `PDF ${source.number}`;
    button.append(placeholder, label, sourceLabel);
    let suppressClick = false;
    button.addEventListener('click', event => {
      if (event.detail !== 0 && suppressClick) { suppressClick = false; return; }
      selectPage(page.id);
    });
    button.addEventListener('dragstart', event => event.preventDefault());
    button.addEventListener('pointerdown', event => {
      if (busy || event.button !== 0 || !event.isPrimary || pageDrag) return;
      suppressClick = false;
      pageDrag = { id: page.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, button };
      button.setPointerCapture(event.pointerId);
    });
    button.addEventListener('pointermove', updatePageDrag);
    button.addEventListener('pointerup', event => {
      const rect = button.getBoundingClientRect();
      suppressClick = !!draggedPageId || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
      dropPage(event);
    });
    button.addEventListener('pointercancel', finishPageDrag);
    button.addEventListener('lostpointercapture', finishPageDrag);
    card.append(button);
    const actions = document.createElement('div');
    actions.className = 'page-card-actions';
    for (const [name, title, icon, action] of [
      ['duplicate', 'コピー', '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>', duplicatePage],
      ['delete', '削除', '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>', deletePage],
    ]) {
      const actionButton = document.createElement('button');
      actionButton.type = 'button';
      actionButton.className = `page-card-action${name === 'delete' ? ' danger' : ''}`;
      actionButton.title = title;
      actionButton.setAttribute('aria-label', `${index + 1}ページを${title}`);
      actionButton.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
      actionButton.addEventListener('click', async event => {
        if (pageDrag) return;
        await run(() => action(page.id));
        if (event.detail === 0) {
          ($('page-list').querySelector('.page-card.active .page-button') ?? $('undo')).focus({ preventScroll: true });
        }
      });
      actions.append(actionButton);
    }
    card.append(actions);
    if (page.strokes.length || page.watermark) {
      const badge = document.createElement('span'); badge.className = 'page-edited'; badge.textContent = '●'; badge.title = '書き込み・透かしあり'; card.append(badge);
    }
    $('page-list').append(card);
    observer.observe(button);
  });
}

function clearDropMarker() {
  $('page-list').querySelectorAll('.drop-before, .drop-after').forEach(card => card.classList.remove('drop-before', 'drop-after'));
}

function insertionPoint(clientX) {
  const cards = [...$('page-list').querySelectorAll('.page-card')];
  const before = cards.find(card => {
    const rect = card.getBoundingClientRect();
    return clientX < rect.left + rect.width / 2;
  });
  return { card: before || cards.at(-1), beforeId: before?.querySelector('button').dataset.id ?? null };
}

function showDropMarker(clientX) {
  clearDropMarker();
  const { card, beforeId } = insertionPoint(clientX);
  card?.classList.add(beforeId === null ? 'drop-after' : 'drop-before');
}

function scrollWhileDragging() {
  if (!draggedPageId) return;
  if (dragPointer) {
    const list = $('page-list');
    const rect = list.getBoundingClientRect();
    const edge = 32;
    const x = dragPointer.x;
    if (x >= rect.left && x <= rect.right && dragPointer.y >= rect.top && dragPointer.y <= rect.bottom) {
      const speed = x < rect.left + edge ? -Math.ceil((rect.left + edge - x) / 3)
        : x > rect.right - edge ? Math.ceil((x - rect.right + edge) / 3) : 0;
      if (speed) { list.scrollLeft += speed; showDropMarker(x); }
    }
  }
  dragScrollFrame = requestAnimationFrame(scrollWhileDragging);
}

function finishPageDrag() {
  const previousDrag = pageDrag;
  pageDrag = null;
  if (previousDrag?.button.hasPointerCapture(previousDrag.pointerId)) previousDrag.button.releasePointerCapture(previousDrag.pointerId);
  cancelAnimationFrame(dragScrollFrame);
  dragScrollFrame = null; draggedPageId = null; dragPointer = null;
  document.body.classList.remove('reordering-page');
  clearDropMarker();
  $('page-list').querySelectorAll('.page-dragging').forEach(card => card.classList.remove('page-dragging'));
}

function updatePageDrag(event) {
  if (!pageDrag || event.pointerId !== pageDrag.pointerId || busy) return;
  if (!draggedPageId) {
    if (model.pages.length < 2 || Math.hypot(event.clientX - pageDrag.x, event.clientY - pageDrag.y) < 6) return;
    draggedPageId = pageDrag.id;
    pageDrag.button.closest('.page-card').classList.add('page-dragging');
    document.body.classList.add('reordering-page');
    dragScrollFrame = requestAnimationFrame(scrollWhileDragging);
  }
  dragPointer = { x: event.clientX, y: event.clientY };
  if (insidePageList(event)) showDropMarker(event.clientX); else clearDropMarker();
}

function insidePageList(event) {
  const rect = $('page-list').getBoundingClientRect();
  return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
}

function dropPage(event) {
  if (!pageDrag || event.pointerId !== pageDrag.pointerId) return;
  const { id } = pageDrag;
  const wasDragging = !!draggedPageId;
  const validDrop = insidePageList(event);
  const { beforeId } = insertionPoint(event.clientX);
  finishPageDrag();
  if (!wasDragging) return;
  if (!validDrop) return;
  run(() => {
    if (!model.moveBefore(id, beforeId)) return;
    refresh();
    [...$('page-list').querySelectorAll('.page-button')].find(button => button.dataset.id === id)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    status('ページの順序を変更しました。「元に戻す」で取り消せます。', 'success');
  });
}

async function pumpThumbnails() {
  if (thumbRunning) return;
  thumbRunning = true;
  try {
    while (thumbQueue.length) {
      const { record, button } = thumbQueue.shift();
      if (!button.isConnected) continue;
      try {
        let cached = thumbnails.get(record);
        if (!cached) {
          const page = await sources.get(record.sourceId).preview.getPage(record.index + 1);
          const initial = page.getViewport({ scale: 1, rotation: record.rotation });
          const view = page.getViewport({ scale: Math.min(104 / initial.width, 130 / initial.height), rotation: record.rotation });
          const canvas = document.createElement('canvas'); canvas.width = Math.ceil(view.width); canvas.height = Math.ceil(view.height);
          const ctx = canvas.getContext('2d');
          await page.render({ canvasContext: ctx, viewport: view }).promise;
          const overlay = document.createElement('canvas'); overlay.width = canvas.width; overlay.height = canvas.height;
          paintOverlay(overlay.getContext('2d'), record, view);
          ctx.drawImage(overlay, 0, 0);
          cached = canvas; thumbnails.set(record, cached);
        }
        if (button.isConnected) {
          const canvas = document.createElement('canvas'); canvas.width = cached.width; canvas.height = cached.height;
          canvas.getContext('2d').drawImage(cached, 0, 0);
          button.firstChild.replaceWith(canvas);
        }
      } catch (error) { console.warn('Thumbnail unavailable', error); }
    }
  } finally { thumbRunning = false; }
}

function activate(id) {
  if (annotationDrag || stroke) return;
  // Committing text ends insertion, so restore the tool after changing pages.
  const menu = activePreviewMenu;
  if (!finishTextEdit()) return;
  activePreviewMenu = menu;
  penEnabled = menu === 'pen'; textEnabled = menu === 'text';
  selectedAnnotationId = null;
  model.activeId = id;
  document.querySelectorAll('.page-card').forEach(card => {
    const button = card.querySelector('button'); const active = button.dataset.id === id;
    card.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  updateControls(); renderPreview();
}

function navigatePage(offset) {
  if (busy || stroke || annotationDrag || pageDrag) return;
  const index = model.pages.findIndex(page => page.id === model.activeId);
  const page = index >= 0 ? model.pages[index + offset] : null;
  if (!page) return;
  activate(page.id);
  // Keep the active thumbnail visible without scrolling away from the preview.
  const list = $('page-list');
  const card = list.querySelector('.page-card.active');
  const rect = card.getBoundingClientRect();
  const bounds = list.getBoundingClientRect();
  if (rect.left < bounds.left) list.scrollLeft += rect.left - bounds.left - 2;
  else if (rect.right > bounds.right) list.scrollLeft += rect.right - bounds.right + 2;
}

async function renderPreview() {
  const version = ++renderVersion;
  renderTask?.cancel(); viewport = null; stroke = null; annotationDrag = null;
  $('text-handles').querySelectorAll('.text-handle').forEach(button => button.remove());
  const record = model.active;
  if (!record) return;
  $('render-status').hidden = false;
  $('render-status').textContent = '読み込み中…';
  const source = sources.get(record.sourceId);
  $('preview-title').textContent = source.name;
  $('page-position').textContent = `${model.pages.indexOf(record) + 1} / ${model.pages.length}`;
  try {
    const page = await source.preview.getPage(record.index + 1);
    if (version !== renderVersion) return;
    const base = page.getViewport({ scale: 1, rotation: record.rotation });
    const width = Math.max(80, $('preview-area').clientWidth - 88);
    const cssScale = Math.min(width / base.width, 390 / base.height);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const nextViewport = page.getViewport({ scale: cssScale * ratio, rotation: record.rotation });
    $('canvas-stack').style.width = `${base.width * cssScale}px`;
    $('canvas-stack').style.height = `${base.height * cssScale}px`;
    const canvas = $('pdf-canvas');
    canvas.width = Math.ceil(nextViewport.width); canvas.height = Math.ceil(nextViewport.height);
    $('ink-canvas').width = canvas.width; $('ink-canvas').height = canvas.height;
    renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: nextViewport });
    await renderTask.promise;
    if (version !== renderVersion) return;
    viewport = nextViewport;
    paintTextPreview();
    refreshAnnotationHandles(); updateControls();
    $('preview-size').textContent = `${Math.round(base.width)} × ${Math.round(base.height)} pt`;
    $('render-status').hidden = true;
  } catch (error) {
    if (version !== renderVersion || error.name === 'RenderingCancelledException') return;
    $('render-status').textContent = 'プレビューを表示できません'; fail(error);
  }
}

async function addFiles(files) {
  const added = [];
  const errors = [];
  for (const file of files) {
    status(`${file.name} を読み込んでいます…`);
    let preview = null;
    let loading = null;
    try {
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error('PDFファイルを選択してください。');
      if (file.size > MAX_FILE_BYTES) throw new Error('1ファイル50MBまでです。');
      if ([...sources.values()].reduce((sum, s) => sum + s.size, 0) + file.size > MAX_TOTAL_BYTES) throw new Error('読み込み総量150MBを超えます。保存後にパネルを開き直してください。');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const doc = await PDFDocument.load(bytes);
      if (!doc.getPageCount()) throw new Error('ページが含まれていません。');
      if (model.pages.length + added.length + doc.getPageCount() > MAX_PAGES) throw new Error(`${MAX_PAGES}ページを超えます。`);
      loading = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false,
        cMapUrl: new URL('cmaps/', document.baseURI).href, cMapPacked: true,
        standardFontDataUrl: new URL('standard_fonts/', document.baseURI).href,
        wasmUrl: new URL('wasm/', document.baseURI).href,
        useWasm: false, useWorkerFetch: false });
      loading.onPassword = () => { loading.destroy(); };
      preview = await loading.promise;
      const sourceId = uid();
      sources.set(sourceId, { document: doc, preview, name: file.name, size: file.size,
        number: sources.size + 1, color: sourceColors[sources.size % sourceColors.length] });
      doc.getPages().forEach((page, index) => added.push({ id: uid(), sourceId, index, rotation: normalizeRotation(page.getRotation().angle), strokes: [], watermark: null }));
    } catch (error) {
      await loading?.destroy().catch(() => {});
      const message = /encrypt|password/i.test(error.message)
        ? 'パスワード保護PDFには対応していません。'
        : /parse|invalid|header|structure/i.test(error.message)
          ? 'PDFを読み込めません。ファイルが破損していないか確認してください。'
          : error.message;
      errors.push(`${file.name}: ${message}`);
    }
  }
  if (added.length) {
    if (!model.pages.length) $('output-name').value = safeFilename(files[0].name);
    model.commit([...model.pages, ...added], { activeId: added[0].id });
    refresh();
  }
  status(errors.length ? `${added.length}ページ追加。${errors.join(' / ')}` : `${added.length}ページを追加しました。追加順に結合して保存できます。`, errors.length ? 'error' : 'success');
}

function rotate(angle) {
  const all = $('rotation-scope').value === 'all';
  const ids = new Set((all ? model.pages : [activeRequired()]).map(p => p.id));
  model.update(ids, p => ({ ...p, rotation: normalizeRotation(p.rotation + angle) }));
  refresh(); status(all ? `${ids.size}ページを回転しました。` : '表示中のページを回転しました。', 'success');
}

async function createOverlay(record, source) {
  const page = await source.preview.getPage(record.index + 1);
  const base = page.getViewport({ scale: 1, rotation: record.rotation });
  // Bound raster size for oversized engineering sheets. Original content stays vector.
  const scale = Math.min(2, 4096 / Math.max(base.width, base.height));
  const view = page.getViewport({ scale, rotation: record.rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(view.width); canvas.height = Math.ceil(view.height);
  paintOverlay(canvas.getContext('2d'), record, view);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('書き込み画像を作成できませんでした。');
  // Account for the rounding of physical canvas dimensions at its top/right edges.
  const exact = { ...view, width: canvas.width, height: canvas.height,
    convertToPdfPoint: (x, y) => view.convertToPdfPoint(x, y) };
  return { bytes: new Uint8Array(await blob.arrayBuffer()), placement: imagePlacement(exact) };
}

function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function exportPdf() {
  const records = model.pages;
  const bytes = await buildPdf(records, sources, createOverlay, (done, total) => status(`PDFを作成中… ${done} / ${total}`));
  download(bytes, `${safeFilename($('output-name').value)}.pdf`, 'application/pdf');
  status(`${records.length}ページのPDFの保存を開始しました。`, 'success');
}

async function splitPdf() {
  const records = model.pages;
  const files = {};
  const base = safeFilename($('output-name').value);
  for (const [index, record] of records.entries()) {
    status(`分割しています… ${index + 1} / ${records.length}`);
    files[`${base}-${String(model.pages.indexOf(record) + 1).padStart(3, '0')}.pdf`] = await buildPdf([record], sources, createOverlay);
    // Yield so progress paints even for small, unannotated PDFs.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  download(zipSync(files, { level: 0 }), `${base}-pages.zip`, 'application/zip');
  status(`${records.length}個のPDFを含むZIPの保存を開始しました。`, 'success');
}

function on(id, action) { $(id).addEventListener('click', () => run(action)); }
$('add-files').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', event => {
  const files = [...event.target.files]; event.target.value = '';
  if (files.length) run(() => addFiles(files));
});
// Prevent dropped files from navigating the extension page.
document.addEventListener('dragover', event => {
  event.preventDefault();
  if (!draggedPageId && !busy && [...event.dataTransfer.types].includes('Files')) $('drop-zone').classList.add('dragging');
});
document.addEventListener('dragleave', event => { if (!event.relatedTarget) $('drop-zone').classList.remove('dragging'); });
document.addEventListener('drop', event => {
  event.preventDefault(); $('drop-zone').classList.remove('dragging');
  if (draggedPageId) { finishPageDrag(); return; }
  const files = [...event.dataTransfer.files]; if (files.length) run(() => addFiles(files));
});
on('rotate-left', () => rotate(-90)); on('rotate-right', () => rotate(90));
$('rotation-scope').addEventListener('change', updateControls);
$('watermark-scope').addEventListener('change', updateControls);
$('watermark-text').addEventListener('input', updateControls);
function duplicatePage(id) {
  const active = pageActionRequired(id); textEnabled = false; penEnabled = false; resetPreviewMenu();
  const copy = { ...active, id: uid() };
  const pages = model.pages.flatMap(page => page.id === active.id ? [page, copy] : [page]);
  model.commit(pages, { activeId: copy.id }); refresh(); status('ページをコピーしました。', 'success');
}
function deletePage(id) {
  const active = pageActionRequired(id); textEnabled = false; penEnabled = false; resetPreviewMenu();
  const index = model.pages.findIndex(page => page.id === active.id);
  const pages = model.pages.filter(page => page.id !== active.id);
  model.commit(pages, { activeId: pages[Math.min(index, pages.length - 1)]?.id ?? null });
  refresh(); status('ページを削除しました。「元に戻す」で復元できます。', 'success');
}
on('undo', () => { model.undo(); refresh(); status('ひとつ前の状態に戻しました。'); });
on('redo', () => { model.redo(); refresh(); status('操作をやり直しました。'); });
$('previous').addEventListener('click', () => navigatePage(-1));
$('next').addEventListener('click', () => navigatePage(1));
function openSaveDialog() {
  if (busy || !model.pages.length || stroke || annotationDrag || pageDrag || $('save-dialog').open) return;
  if (!finishTextEdit()) return;
  $('save-status').hidden = true;
  $('save-status').textContent = '';
  $('save-dialog').showModal();
}
$('open-save').addEventListener('click', openSaveDialog);
$('close-save').addEventListener('click', () => $('save-dialog').close());
$('save-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
on('save', async () => { await exportPdf(); $('save-dialog').close(); });
on('split', async () => { await splitPdf(); $('save-dialog').close(); });
on('clear-ink', () => {
  if (!model.active) return;
  model.update(new Set([model.activeId]), p => ({ ...p, strokes: p.strokes.filter(item => item.tool === 'text') }));
  refresh(); status('表示中のページの描画を消去しました。');
});
function watermarkTargets() { return $('watermark-scope').value === 'all' ? new Set(model.pages.map(p => p.id)) : new Set([activeRequired().id]); }
on('apply-watermark', () => {
  const text = $('watermark-text').value.trim();
  if (!text) throw new Error('透かしのテキストを入力してください。');
  const watermark = { text, color: $('watermark-color').value, opacity: Number($('watermark-opacity').value) / 100 };
  const ids = watermarkTargets();
  model.update(ids, p => ({ ...p, watermark: { ...watermark, ...(p.watermark?.points ? { points: p.watermark.points } : {}) } }));
  refresh(); status(`${ids.size}ページに透かしを適用しました。`, 'success');
});
on('remove-watermark', () => {
  const ids = watermarkTargets();
  const count = model.pages.filter(page => ids.has(page.id) && page.watermark).length;
  if (!count) return;
  model.update(ids, p => ({ ...p, watermark: null }));
  refresh(); status(`${count}ページから追加した透かしを削除しました。「元に戻す」で復元できます。`);
});
function pageActionRequired(id) {
  const page = model.pages.find(page => page.id === id);
  if (!page) throw new Error('ページ一覧から操作するページを選んでください。');
  return page;
}

function selectPage(id) {
  if (busy || stroke || annotationDrag || pageDrag || !model.pages.some(page => page.id === id)) return;
  if (!finishTextEdit()) return;
  textEnabled = false;
  penEnabled = false;
  resetPreviewMenu();
  activate(id);
}

function resetPreviewMenu() {
  activePreviewMenu = 'select';
  $('rotation-scope').value = 'active';
  $('watermark-scope').value = 'all';
  document.querySelectorAll('.bulk-actions').forEach(details => { details.open = false; });
}
function enableSelection() {
  if (busy || stroke || annotationDrag || pageDrag || !finishTextEdit()) return;
  penEnabled = false; textEnabled = false; selectedAnnotationId = null;
  resetPreviewMenu(); refreshAnnotationHandles(); updateControls();
}
$('open-select').addEventListener('click', enableSelection);
function openPreviewMenu(name) {
  if (busy || stroke || annotationDrag || pageDrag || !model.active) return;
  if (activePreviewMenu === name && !selectedAnnotationId) return;
  if (!finishTextEdit()) return;
  resetPreviewMenu();
  textEnabled = false; selectedAnnotationId = null;
  penEnabled = name === 'pen';
  activePreviewMenu = name;
  refreshAnnotationHandles(); updateControls();
}
for (const name of previewMenus) {
  $(`open-${name}`).addEventListener('click', () => openPreviewMenu(name));
  $(`close-${name}`)?.addEventListener('click', () => {
    enableSelection();
    $('open-select').focus({ preventScroll: true });
  });
}
$('start-pen').addEventListener('click', () => openPreviewMenu('pen'));
$('pen-width').addEventListener('input', () => { $('pen-width-value').value = $('pen-width').value; });
$('pen-transparency').addEventListener('input', () => { $('pen-transparency-value').value = `${$('pen-transparency').value}%`; });
$('watermark-opacity').addEventListener('input', () => { $('watermark-opacity-value').value = `${$('watermark-opacity').value}%`; });

function selectedText() {
  return model.active?.strokes.find(item => item.tool === 'text' && item.id === selectedAnnotationId);
}
function selectedAnnotation() {
  return selectedAnnotationId ? pageAnnotations().find(item => item.id === selectedAnnotationId) : null;
}
function pageAnnotations() {
  if (!model.active) return [];
  const watermark = model.active.watermark;
  return watermark && viewport ? [{ ...watermark, id: 'watermark', tool: 'watermark',
    points: watermark.points || [viewport.convertToPdfPoint(viewport.width / 2, viewport.height / 2)] }, ...model.active.strokes] : model.active.strokes;
}
function replaceAnnotation(page, original, current) {
  if (original.tool === 'watermark') return { ...page, watermark: current };
  return { ...page, strokes: page.strokes.map(item => item.id === original.id ? current : item) };
}
function selectedStroke() {
  const annotation = selectedAnnotation();
  return annotation && !['text', 'watermark'].includes(annotation.tool) ? annotation : null;
}
function moveAnnotation(annotation, dx, dy) {
  if (annotation.tool === 'watermark') return moveWatermark($('ink-canvas').getContext('2d'), annotation, viewport, dx, dy);
  return annotation.tool === 'text'
    ? moveText($('ink-canvas').getContext('2d'), annotation, viewport, dx, dy)
    : moveStroke(annotation, viewport, dx, dy);
}
function selectAnnotation(annotation) {
  resetPreviewMenu();
  penEnabled = false; textEnabled = false;
  selectedAnnotationId = annotation.id;
  if (annotation.tool === 'watermark') {
    $('watermark-text').value = annotation.text; $('watermark-color').value = annotation.color;
    $('watermark-opacity').value = annotation.opacity * 100;
    $('watermark-opacity-value').value = `${annotation.opacity * 100}%`;
    $('watermark-scope').value = 'active';
  }
  if (annotation.tool === 'text') {
    $('text-color').value = annotation.color;
    $('text-size').value = annotation.fontSize;
  } else { textEnabled = false; }
  $('text-handles').querySelectorAll('button').forEach(button => {
    const selected = button.dataset.annotationId === selectedAnnotationId;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
  });
  updateControls();
}
function textSettings() {
  const fontSize = Number($('text-size').value);
  if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 96) throw new Error('文字サイズは8〜96ptで指定してください。');
  return { fontSize, color: $('text-color').value };
}
function fitText(annotation) {
  const ctx = $('ink-canvas').getContext('2d');
  const layout = textLayout(ctx, annotation, viewport);
  if (layout.right - layout.left > viewport.width || layout.bottom - layout.top > viewport.height) {
    throw new Error('文字がページに収まりません。文字サイズを下げるか、改行してください。');
  }
  return moveText(ctx, annotation, viewport, 0, 0);
}
function enableTextInsertion() {
  if (busy || stroke || annotationDrag || pageDrag || !model.active || textEnabled || textEdit || !finishTextEdit()) return;
  textEnabled = true; penEnabled = false; selectedAnnotationId = null;
  resetPreviewMenu(); activePreviewMenu = 'text'; refreshAnnotationHandles(); updateControls();
  status('紙面をクリックしてテキストを1つ配置してください。Escで配置を終了します。');
}
$('open-text').addEventListener('click', enableTextInsertion);
$('close-text').addEventListener('click', () => {
  enableSelection();
  $('open-select').focus({ preventScroll: true });
});
$('confirm-text').addEventListener('click', () => {
  if (finishTextEdit()) focusSelectedAnnotation();
});
$('cancel-text').addEventListener('click', () => {
  if (finishTextEdit(true)) focusSelectedAnnotation();
});
function focusSelectedAnnotation() {
  const handle = [...$('text-handles').querySelectorAll('button')].find(button => button.dataset.annotationId === selectedAnnotationId);
  (handle || $('open-select')).focus({ preventScroll: true });
}
$('update-text').addEventListener('click', () => {
  if (!busy && selectedText() && viewport) startTextEdit(selectedText());
});

function paintTextPreview() {
  if (!viewport || !model.active) return;
  paintOverlay($('ink-canvas').getContext('2d'), { ...model.active,
    strokes: model.active.strokes.filter(item => item.id !== textEdit?.original?.id)
      .map(item => item.id === textFormatPreview?.id ? textFormatPreview : item) }, viewport);
}

function positionTextEditor() {
  if (!textEdit || !viewport) return;
  const { editor, draft } = textEdit;
  const layout = textLayout($('ink-canvas').getContext('2d'), draft, viewport);
  const scale = $('ink-canvas').getBoundingClientRect().width / viewport.width;
  // Match the PDF font and explicit line breaks; never introduce browser wrapping.
  Object.assign(editor.style, { left: `${layout.x * scale}px`, top: `${layout.y * scale}px`,
    width: `${Math.max(layout.width * scale + 2, draft.text ? 0 : 60)}px`,
    height: `${layout.height * scale + 2}px`, fontSize: `${layout.size * scale}px`,
    lineHeight: `${layout.size * scale * 1.3}px`, color: draft.color,
    transform: `rotate(${layout.angle}rad)` });
}

function updateTextDraft() {
  if (!textEdit || !viewport) return false;
  try {
    const draft = fitText({ ...textEdit.draft, ...textSettings(), text: textEdit.editor.value.replaceAll('\r\n', '\n') });
    textEdit.draft = draft;
    textEdit.editor.setCustomValidity('');
    positionTextEditor();
    return true;
  } catch (error) {
    textEdit.editor.setCustomValidity(error.message);
    status(error.message, 'error');
    return false;
  }
}

function startTextEdit(annotation, isNew = false) {
  if (!viewport || !finishTextEdit()) return;
  selectAnnotation(annotation); penEnabled = false;
  if (isNew) activePreviewMenu = 'text';
  const editor = document.createElement('textarea');
  editor.className = 'text-editor'; editor.value = annotation.text;
  editor.maxLength = 500; editor.wrap = 'off'; editor.spellcheck = false;
  editor.placeholder = 'テキスト'; editor.setAttribute('aria-label', 'テキストボックス');
  editor.setAttribute('aria-describedby', 'text-edit-hint');
  textEdit = { pageId: model.activeId, original: isNew ? null : annotation, draft: annotation, editor };
  editor.addEventListener('input', updateTextDraft);
  editor.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      // Keep newly entered text and focus its selection frame for keyboard actions.
      if (finishTextEdit(!isNew)) {
        focusSelectedAnnotation();
      }
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault(); event.stopPropagation();
      if (finishTextEdit()) focusSelectedAnnotation();
    } else if (event.key === 'Tab') {
      event.preventDefault(); if (finishTextEdit()) $('text-color').focus({ preventScroll: true });
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopPropagation(); openSaveDialog();
    }
  });
  refreshAnnotationHandles(); paintTextPreview(); updateControls();
  editor.focus({ preventScroll: true });
  if (!isNew) editor.setSelectionRange(editor.value.length, editor.value.length);
}

function finishTextEdit(cancel = false) {
  if (!textEdit) return true;
  if (!cancel && !updateTextDraft()) { textEdit.editor.focus({ preventScroll: true }); return false; }
  const { pageId, original, draft, editor } = textEdit;
  textEdit = null; editor.remove();
  textEnabled = false; resetPreviewMenu();
  if (!cancel) {
    const empty = !draft.text.trim();
    const changed = original ? JSON.stringify(original) !== JSON.stringify(draft) || empty : !empty;
    if (changed) {
      model.update(new Set([pageId]), p => ({ ...p, strokes: original
        ? p.strokes.flatMap(item => item.id === original.id ? (empty ? [] : [draft]) : [item])
        : [...p.strokes, draft] }));
      refreshThumbnails();
      status(empty ? 'テキストを削除しました。' : 'テキストを確定しました。ドラッグで移動、ダブルクリックで再編集できます。', 'success');
    }
    selectedAnnotationId = empty ? null : draft.id;
  } else selectedAnnotationId = original?.id ?? null;
  paintTextPreview(); refreshAnnotationHandles(); updateControls();
  return true;
}

// Commit before toolbar/page/export actions so they always see the latest text.
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.text-settings')) finishTextFormatting();
  if (event.target.closest('#confirm-text, #cancel-text, #close-text, #previous, #next, .preview-tool-button')) return;
  if (!textEdit || event.target === textEdit.editor || event.target.closest('.text-settings')) return;
  if (!finishTextEdit()) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
function previewTextFormatting() {
  if (textEdit) { updateTextDraft(); return; }
  if (!selectedText() || !viewport || busy) return;
  try {
    textFormatPreview = fitText({ ...selectedText(), ...textSettings() });
    paintTextPreview(); refreshAnnotationHandles();
  } catch (error) {
    textFormatPreview = null;
    paintTextPreview(); refreshAnnotationHandles(); status(error.message, 'error');
  }
}
function finishTextFormatting() {
  if (!textFormatPreview) return;
  const annotation = textFormatPreview;
  textFormatPreview = null;
  const original = selectedText();
  if (!original || annotation.id !== original.id || JSON.stringify(annotation) === JSON.stringify(original)) return;
  model.update(new Set([model.activeId]), p => ({ ...p,
    strokes: p.strokes.map(item => item.id === annotation.id ? annotation : item) }));
  refreshThumbnails(); updateControls();
}
for (const id of ['text-color', 'text-size']) {
  $(id).addEventListener('input', previewTextFormatting);
  $(id).addEventListener('change', () => { previewTextFormatting(); finishTextFormatting(); });
  $(id).addEventListener('blur', finishTextFormatting);
}
function deleteSelectedAnnotation() {
  const annotation = selectedAnnotation();
  if (!annotation) return;
  model.update(new Set([model.activeId]), p => annotation.tool === 'watermark' ? { ...p, watermark: null }
    : { ...p, strokes: p.strokes.filter(item => item.id !== annotation.id) });
  resetPreviewMenu();
  selectedAnnotationId = null; refresh(); status(`選択した${annotation.tool === 'text' ? 'テキスト' : annotation.tool === 'watermark' ? '透かし' : '描画'}を削除しました。「元に戻す」で復元できます。`);
}
on('delete-text', deleteSelectedAnnotation);
on('delete-stroke', deleteSelectedAnnotation);
function moveSelectedAnnotation(dx, dy) {
  const original = selectedAnnotation();
  if (!original || !viewport) return;
  const moved = moveAnnotation(original, dx * viewport.scale, dy * viewport.scale);
  // A key pressed against the paper edge must not create history or clear Redo.
  if (Math.hypot(moved.points[0][0] - original.points[0][0], moved.points[0][1] - original.points[0][1]) < 1e-8) return;
  model.update(new Set([model.activeId]), p => replaceAnnotation(p, original, moved));
  paintTextPreview(); refreshAnnotationHandles(); refreshThumbnails(); updateControls();
}
function positionAnnotationHandle(button, annotation) {
  const layout = annotation.tool === 'text'
    ? textLayout($('ink-canvas').getContext('2d'), annotation, viewport)
    : annotation.tool === 'watermark' ? watermarkLayout($('ink-canvas').getContext('2d'), annotation, viewport) : strokeLayout(annotation, viewport);
  const scale = $('ink-canvas').getBoundingClientRect().width / viewport.width;
  const padding = annotation.tool === 'text' ? 0 : Math.max(0, (8 - Math.min(layout.width, layout.height) * scale) / 2);
  Object.assign(button.style, { left: `${layout.x * scale - padding}px`, top: `${layout.y * scale - padding}px`,
    width: `${layout.width * scale + padding * 2}px`, height: `${layout.height * scale + padding * 2}px`, transform: `rotate(${layout.angle}rad)` });
}
function refreshAnnotationHandles() {
  if (!model.active || !viewport) return;
  const handles = new Map([...$('text-handles').querySelectorAll('.text-handle')].map(button => [button.dataset.annotationId, button]));
  for (const annotation of pageAnnotations()) {
    if (!annotation.id || !annotation.points.length) continue;
    if (annotation.id === textEdit?.original?.id) continue;
    const existing = handles.get(annotation.id);
    const button = existing || document.createElement('button');
    handles.delete(annotation.id);
    const isText = annotation.tool === 'text';
    button.type = 'button'; button.className = `text-handle${isText ? '' : ' stroke-handle'}${annotation.id === selectedAnnotationId ? ' selected' : ''}`;
    button.dataset.annotationId = annotation.id;
    if (isText) button.dataset.textId = annotation.id;
    button.setAttribute('aria-label', isText ? `テキストを移動: ${annotation.text}` : annotation.tool === 'watermark' ? `透かしを選択・移動: ${annotation.text}` : '描画を選択・移動');
    button.setAttribute('aria-pressed', String(annotation.id === selectedAnnotationId));
    button.title = 'クリックで選択して書式変更。方向キーで1pt、Shift＋方向キーで10pt移動。Deleteで削除。ドラッグで移動、ダブルクリックまたはEnterで編集。';
    if (!isText) button.title = 'クリックで選択。ドラッグで移動。方向キーで1pt、Shift＋方向キーで10pt移動。Deleteで削除。';
    button.setAttribute('aria-keyshortcuts', 'Delete ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown');
    positionAnnotationHandle(button, annotation.id === textFormatPreview?.id ? textFormatPreview : annotation);
    if (existing) continue;
    const currentText = () => pageAnnotations().find(item => item.id === button.dataset.annotationId);
    button.addEventListener('dragstart', event => event.preventDefault());
    button.addEventListener('click', event => {
      if (event.detail === 0 && !busy && currentText()) {
        if (isText) startTextEdit(currentText()); else selectAnnotation(currentText());
      }
    });
    button.addEventListener('dblclick', () => { if (isText && !busy && currentText()) startTextEdit(currentText()); });
    button.addEventListener('pointerdown', event => {
      if (busy || stroke || annotationDrag || !viewport || event.button !== 0 || !event.isPrimary) return;
      const annotation = currentText();
      if (!annotation) return;
      event.preventDefault(); selectAnnotation(annotation); button.focus({ preventScroll: true });
      button.setPointerCapture(event.pointerId);
      annotationDrag = { pageId: model.activeId, pointerId: event.pointerId, original: annotation, current: annotation,
        start: canvasPoint(event), button };
    });
    button.addEventListener('pointermove', updateAnnotationDrag);
    button.addEventListener('pointerup', finishAnnotationDrag);
    button.addEventListener('pointercancel', cancelAnnotationDrag);
    button.addEventListener('lostpointercapture', cancelAnnotationDrag);
    $('text-handles').append(button);
  }
  for (const button of handles.values()) button.remove();
  if (textEdit) {
    if (!textEdit.editor.isConnected) $('text-handles').append(textEdit.editor);
    positionTextEditor();
  }
}
function canvasPoint(event) {
  const rect = $('ink-canvas').getBoundingClientRect();
  return [(event.clientX - rect.left) / rect.width * viewport.width, (event.clientY - rect.top) / rect.height * viewport.height];
}
function updateAnnotationDrag(event) {
  if (!annotationDrag || !viewport || event.pointerId !== annotationDrag.pointerId) return;
  const point = canvasPoint(event);
  const scale = $('ink-canvas').getBoundingClientRect().width / viewport.width;
  if (!annotationDrag.moved && Math.hypot(point[0] - annotationDrag.start[0], point[1] - annotationDrag.start[1]) * scale < 4) return;
  annotationDrag.moved = true;
  annotationDrag.current = moveAnnotation(annotationDrag.original, point[0] - annotationDrag.start[0], point[1] - annotationDrag.start[1]);
  positionAnnotationHandle(annotationDrag.button, annotationDrag.current);
  paintOverlay($('ink-canvas').getContext('2d'), replaceAnnotation(model.active, annotationDrag.original, annotationDrag.current), viewport);
}
function finishAnnotationDrag(event) {
  if (!annotationDrag || event.pointerId !== annotationDrag.pointerId) return;
  updateAnnotationDrag(event);
  const { pageId, original, current, button, pointerId } = annotationDrag; annotationDrag = null;
  if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
  const [x, y] = original.points[0]; const [nextX, nextY] = current.points[0];
  if (Math.hypot(nextX - x, nextY - y) > 0.01) {
    model.update(new Set([pageId]), p => replaceAnnotation(p, original, current));
    refreshThumbnails(); status(`${original.tool === 'text' ? 'テキスト' : '描画'}を移動しました。「元に戻す」で取り消せます。`, 'success');
    refreshAnnotationHandles();
  }
  // Preserve the DOM target for the browser's second click/dblclick event.
  positionAnnotationHandle(button, current); updateControls();
}
function cancelAnnotationDrag() {
  if (!annotationDrag) return;
  const { button, pointerId } = annotationDrag; annotationDrag = null;
  if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
  if (viewport && model.active) paintOverlay($('ink-canvas').getContext('2d'), model.active, viewport);
  refreshAnnotationHandles(); updateControls();
}
function pdfPoint(event) {
  const rect = $('ink-canvas').getBoundingClientRect();
  const x = Math.max(0, Math.min(viewport.width, (event.clientX - rect.left) / rect.width * viewport.width));
  const y = Math.max(0, Math.min(viewport.height, (event.clientY - rect.top) / rect.height * viewport.height));
  return viewport.convertToPdfPoint(x, y);
}
$('ink-canvas').addEventListener('pointerdown', event => {
  if (event.button !== 0 || !event.isPrimary) return;
  if (!textEnabled && !penEnabled && !busy && !annotationDrag && !stroke) {
    if (activePreviewMenu === 'select' || selectedAnnotationId) enableSelection();
    return;
  }
  if (textEnabled && !busy && viewport && model.active && event.button === 0 && event.isPrimary && !annotationDrag) {
    event.preventDefault();
    try {
      startTextEdit({ id: uid(), tool: 'text', text: '', ...textSettings(), rotation: model.active.rotation,
        points: [pdfPoint(event)] }, true);
    } catch (error) { fail(error); }
    return;
  }
  if (!penEnabled || busy || !viewport || !model.active || event.button !== 0 || stroke || annotationDrag) return;
  selectedAnnotationId = null; refreshAnnotationHandles(); updateControls();
  event.preventDefault(); $('ink-canvas').setPointerCapture(event.pointerId);
  stroke = { id: uid(), tool: $('pen-tool').value, color: $('pen-color').value, width: Number($('pen-width').value),
    opacity: 1 - Number($('pen-transparency').value) / 100, points: [pdfPoint(event)], pointerId: event.pointerId };
  paintOverlay($('ink-canvas').getContext('2d'), { ...model.active, strokes: [...model.active.strokes, stroke] }, viewport);
});
function updateStroke(event) {
  if (stroke.tool === 'pen') {
    const events = event.getCoalescedEvents?.();
    for (const item of events?.length ? events : [event]) stroke.points.push(pdfPoint(item));
  } else {
    let point = pdfPoint(event);
    if (['ellipse', 'rectangle'].includes(stroke.tool) && event.shiftKey) {
      const [x, y] = stroke.points[0];
      // Stay within the dragged rectangle, including at the edge of the paper.
      const size = Math.min(Math.abs(point[0] - x), Math.abs(point[1] - y));
      point = [x + Math.sign(point[0] - x) * size, y + Math.sign(point[1] - y) * size];
    }
    stroke.points = [stroke.points[0], point];
  }
  paintOverlay($('ink-canvas').getContext('2d'), { ...model.active, strokes: [...model.active.strokes, stroke] }, viewport);
}
$('ink-canvas').addEventListener('pointermove', event => {
  if (!stroke || !viewport || event.pointerId !== stroke.pointerId) return;
  updateStroke(event);
});
function finishStroke(event) {
  if (!stroke || event.pointerId !== stroke.pointerId) return;
  if (event.type === 'pointerup' && viewport) updateStroke(event);
  const { pointerId, ...saved } = stroke; stroke = null;
  model.update(new Set([model.activeId]), p => ({ ...p, strokes: [...p.strokes, saved] }));
  refreshThumbnails(); refreshAnnotationHandles(); updateControls(); status('書き込みを追加しました。', 'success');
}
$('ink-canvas').addEventListener('pointerup', finishStroke);
$('ink-canvas').addEventListener('pointercancel', event => {
  if (stroke?.pointerId !== event.pointerId) return;
  stroke = null; if (viewport && model.active) paintOverlay($('ink-canvas').getContext('2d'), model.active, viewport);
});
$('ink-canvas').addEventListener('lostpointercapture', finishStroke);
$('help').addEventListener('click', () => $('help-dialog').showModal());
$('close-help').addEventListener('click', () => $('help-dialog').close());
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.repeat && !busy && !event.defaultPrevented && !event.isComposing && !$('help-dialog').open && !$('save-dialog').open) {
    event.preventDefault();
    cancelAnnotationDrag(); finishPageDrag();
    if (stroke) {
      const pointerId = stroke.pointerId; stroke = null;
      if ($('ink-canvas').hasPointerCapture(pointerId)) $('ink-canvas').releasePointerCapture(pointerId);
      paintTextPreview();
    }
    enableSelection();
    $('open-select').focus({ preventScroll: true });
    return;
  }
  if (event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])') || $('help-dialog').open || $('save-dialog').open || busy || event.defaultPrevented || event.isComposing) return;
  if (event.key === 'Delete' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && selectedAnnotation() && !textEdit && !stroke && !annotationDrag && !pageDrag) {
    event.preventDefault(); run(deleteSelectedAnnotation); return;
  }
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (direction && !event.ctrlKey && !event.metaKey && !event.altKey && selectedAnnotation() && !textEdit && !stroke && !annotationDrag && !pageDrag) {
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    moveSelectedAnnotation(direction[0] * step, direction[1] * step); return;
  }
  if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && model.active && !stroke && !annotationDrag && !pageDrag) {
    event.preventDefault(); navigatePage(event.key === 'ArrowLeft' ? -1 : 1); return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); openSaveDialog(); }
});
let resizeTimer;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderPreview, 120); }).observe($('preview-area'));
refresh();
