import './style.css';
import './theme.css';
import { EditorModel, safeFilename, normalizeRotation } from './model.js';
import { paintOverlay, textFontFamily, textLayout, moveText, strokeLayout, moveStroke, scaleStrokes, watermarkLayout, moveWatermark } from './pdf.js';
import { createThemeController } from './theme.js';
import { storePrintJob, deletePrintJob, purgeLegacyPrintJobs } from './print-job.js';
import { createFullscreenPreview } from './fullscreen-preview.js';
import { styledRuns, textStyle, textBackground, formatTextBackground, formatText, replaceText } from './text-format.js';
import { createTextEditor } from './text-editor.js';
import { exportDocument } from './pdf-processor.js';
import { createPageOverlay as createOverlay, createPrintPages } from './raster.js';
import { download } from './download.js';
import { readPdfSource, pdfErrorMessage } from './pdf-source.js';
import { createToolHelp } from './tool-help.js';

const $ = id => document.getElementById(id);
createToolHelp(document);
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
let previewZoom = 1;
const minPreviewZoom = 0.5;
const maxPreviewZoom = 4;
let renderedPageId = null;
let renderTask = null;
let renderVersion = 0;
let stroke = null;
let selectedAnnotationId = null;
const selectedStrokeIds = new Set();
const selectedTextIds = new Set();
let annotationDrag = null;
let textEnabled = false;
let textEdit = null;
let annotationFormatPreview = null;
let strokeFormatSession = null;
let textFormatSession = null;
let thumbQueue = [];
let thumbRunning = false;
let observer = null;
let draggedPageId = null;
let dragPointer = null;
let dragScrollFrame = null;
let pageDrag = null;
const uid = () => crypto.randomUUID();
const previewMenus = ['rotation', 'pen', 'stamp', 'watermark'];
let activePreviewMenu = 'select';
let previewMenuOpen = false;
const toolDescriptions = {
  'open-select': '追加した文字・描画・透かしをクリックして選択。ドラッグで移動、Deleteで削除。Escで選択モードに戻ります。',
  'open-pen': '色・太さ・透明度を設定して紙面をドラッグ。「描画を終了」またはEscで選択モードに戻ります。',
  'open-text': '紙面をクリックしてテキストを1つ追加。「入力を確定」で選択モードに戻ります。配置前のEscで終了。',
  'open-stamp': '紙面をクリックするたびに番号を配置し、次の番号を1つ増やします。Escで選択モードに戻ります。',
  'open-rotation': '対象ページを選び、方向ボタンまたはCtrl＋←／→で左右90度ずつ回転。「元に戻す」で取り消せます。',
  'open-watermark': '文字・色・不透明度・対象を設定し、「適用」で反映。透かし選択中はCtrl＋←／→で不透明度を1%ずつすぐ変更できます。対象ページの追加済み透かしを置き換えます。',
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
    if (['help', 'close-help', 'close-tool-help', 'theme-mode'].includes(element.id) || element.closest('#fullscreen-preview')) return;
    element.disabled = busy;
  });
  $('undo').disabled = busy || !model.past.length;
  $('redo').disabled = busy || !model.future.length;
  const index = model.pages.findIndex(p => p.id === model.activeId);
  $('previous').disabled = busy || index <= 0;
  $('next').disabled = busy || index < 0 || index >= model.pages.length - 1;
  $('zoom-out').disabled = busy || !model.active || previewZoom <= minPreviewZoom;
  $('zoom-in').disabled = busy || !model.active || previewZoom >= maxPreviewZoom;
  $('zoom-fit').disabled = busy || !model.active;
  $('open-fullscreen-preview').disabled = busy || !model.active;
  $('zoom-value').textContent = `${Math.round(previewZoom * 100)}%`;
  $('split').disabled = busy || !model.pages.length;
  $('split-count').textContent = `${model.pages.length}ページ`;
  const rotationCount = $('rotation-scope').value === 'all' ? model.pages.length : Number(!!model.active);
  $('rotate-left').disabled = busy || !rotationCount;
  $('rotate-right').disabled = busy || !rotationCount;
  $('save').disabled = busy || !model.pages.length;
  $('open-save').disabled = busy || !model.pages.length;
  $('print').disabled = busy || !model.pages.length;
  if (!selectedAnnotation()) selectedAnnotationId = null;
  const textSelected = !!(selectedText() || textEdit);
  const strokeSelected = !!selectedStroke();
  const visibleMenu = !previewMenuOpen ? null : selectedStroke() ? 'pen'
    : textEnabled || selectedText() || textEdit ? 'text'
      : selectedAnnotation()?.tool === 'watermark' ? 'watermark' : activePreviewMenu;
  $('open-select').disabled = busy || !model.active;
  $('open-select').setAttribute('aria-pressed', String(!textSelected && !strokeSelected && activePreviewMenu === 'select'));
  $('open-select').setAttribute('aria-controls', 'panel-select');
  $('open-select').setAttribute('aria-expanded', String(visibleMenu === 'select' && !!model.active));
  $('panel-select').hidden = !model.active || visibleMenu !== 'select';
  const textCount = selectedTexts().length;
  $('update-text').disabled = busy || textCount !== 1 || !viewport;
  $('delete-text').disabled = busy || !selectedText();
  $('panel-text').hidden = !model.active || visibleMenu !== 'text';
  $('delete-stroke').disabled = busy || !selectedStroke();
  const strokeCount = selectedStrokes().length;
  $('pen-menu-title').textContent = strokeCount > 1 ? `選択した描画（${strokeCount}件）` : selectedStroke() ? '選択した描画' : 'ペンの設定';
  $('close-pen').textContent = selectedStroke() ? '選択を解除' : '描画を終了';
  $('pen-drawing-settings').hidden = !!selectedStroke();
  $('pen-shape-settings').hidden = strokeSelected;
  $('stroke-selection-actions').hidden = !selectedStroke();
  $('pen-mode-hint').textContent = selectedStroke()
    ? strokeCount > 1 ? '太さ・透明度は各描画の元の値に同じ差分を適用します。スライダーの数値は最後に選んだ描画の値です。色は選択全体に適用します。'
      : '色・太さ・透明度は選択した描画だけにすぐ反映されます。Shift＋クリックで描画を追加選択できます。'
    : '紙面をドラッグして描きます。終了するには「描画を終了」かEsc。';
  $('text-menu-title').textContent = textEdit ? 'テキストを入力中' : textCount > 1 ? `選択したテキスト（${textCount}件）` : selectedText() ? '選択したテキスト' : 'テキストを配置';
  $('text-mode-hint').textContent = textEdit ? '文字書式は選択範囲に、背景はボックス全体に適用します。'
    : textCount > 1 ? `選択した${textCount}件に一括適用。サイズは差を保ち、8〜96ptの最初の境界で全体が止まります。`
      : selectedText() ? '文字・背景をすぐ反映。Shift＋クリックで追加選択・解除できます。'
      : '紙面クリックで入力。文字・背景は新しいボックスに適用します。';
  $('close-text').textContent = textEdit ? '確定して終了' : selectedText() ? '選択を解除' : '配置を終了';
  $('text-selection-actions').hidden = !selectedText() || !!textEdit;
  $('text-edit-actions').hidden = !textEdit;
  $('text-edit-hint').textContent = selectedText() && !textEdit
    ? 'Shift＋クリックで追加選択・解除。複数選択中はドラッグ・方向キーでまとめて移動、Deleteで削除。ダブルクリックで個別編集。Escまたは空白クリックで選択を解除します。'
    : '外側クリック・Ctrl+Enter・Escで入力を確定。「入力を取り消す」で変更を取り消します。書式は上の「テキスト」アイコンから設定できます。';
  $('open-text').hidden = !model.pages.length;
  $('open-text').disabled = busy || !model.active || strokeSelected;
  $('open-text').setAttribute('aria-pressed', String(textSelected || activePreviewMenu === 'text'));
  $('open-text').setAttribute('aria-expanded', String(!$('panel-text').hidden));
  $('open-text').setAttribute('aria-label', textSelected ? 'テキストの書式設定' : 'テキストボックスを配置');
  $('open-text').title = textSelected ? '選択したテキストの書式設定を開く・閉じる' : toolDescriptions['open-text'];
  $('ink-canvas').classList.toggle('inserting-text', textEnabled && !busy);
  $('ink-canvas').classList.toggle('stamping', activePreviewMenu === 'stamp' && !busy);
  $('stamp-number').value = model.nextStampNumber;
  $('stamp-next-hint').textContent = `次に押す番号: ${model.nextStampNumber}`;
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
    $(`open-${name}`).setAttribute('aria-pressed', String(name === 'pen' ? strokeSelected || activePreviewMenu === name : activePreviewMenu === name));
  }
  for (const name of ['select', ...previewMenus]) {
    $(`open-${name}`).disabled ||= textSelected;
    if (name !== 'pen') $(`open-${name}`).disabled ||= strokeSelected;
  }
  $('open-pen').setAttribute('aria-label', strokeSelected ? '描画の書式設定' : 'ペン');
  $('open-pen').title = strokeSelected ? '選択した描画の書式設定を開く・閉じる' : toolDescriptions['open-pen'];
  const selected = selectedAnnotation();
  $('watermark-menu-title').textContent = selected?.tool === 'watermark' ? '選択した透かし' : '透かしの設定';
  $('close-watermark').textContent = selected?.tool === 'watermark' ? '選択を解除' : '選択に戻る';
  $('ink-canvas').classList.toggle('drawing', penEnabled && !busy);
  document.querySelectorAll('.page-button').forEach(button => {
    button.classList.toggle('reorderable', !busy && model.pages.length > 1);
  });
}

function refresh() {
  if (selectedAnnotation()) selectAnnotation(selectedAnnotation(), { preserve: true });
  const hasPages = model.pages.length > 0;
  if (!hasPages) { previewMenuOpen = false; penEnabled = false; textEnabled = false; resetPreviewMenu(); }
  for (const name of previewMenus) $(`open-${name}`).hidden = !hasPages;
  $('page-list-section').hidden = !hasPages;
  $('workspace').hidden = !hasPages && !model.past.length && !model.future.length;
  $('empty-state').hidden = hasPages;
  $('open-save').hidden = !hasPages;
  $('document-actions').hidden = !hasPages;
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
  const wasInsertingText = textEnabled;
  if (!finishTextEdit()) return;
  activePreviewMenu = menu;
  penEnabled = menu === 'pen'; textEnabled = menu === 'text';
  if (textEnabled && !wasInsertingText) resetTextBackgroundSettings();
  selectedAnnotationId = null;
  selectedTextIds.clear(); selectedStrokeIds.clear();
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

function setPreviewZoom(value) {
  if (busy || !model.active || stroke || annotationDrag || pageDrag) return;
  const next = Math.max(minPreviewZoom, Math.min(maxPreviewZoom, value));
  if (next === previewZoom) return;
  const scroll = $('preview-scroll');
  const bounds = scroll.getBoundingClientRect();
  const paper = $('canvas-stack').getBoundingClientRect();
  const anchor = paper.width && paper.height ? {
    x: (bounds.left + scroll.clientWidth / 2 - paper.left) / paper.width,
    y: (bounds.top + scroll.clientHeight / 2 - paper.top) / paper.height,
  } : null;
  previewZoom = next;
  updateControls();
  renderPreview(anchor);
}
$('zoom-out').addEventListener('click', () => setPreviewZoom(previewZoom - 0.25));
$('zoom-in').addEventListener('click', () => setPreviewZoom(previewZoom + 0.25));
$('zoom-fit').addEventListener('click', () => setPreviewZoom(1));
$('preview-area').addEventListener('wheel', event => {
  if (!event.ctrlKey || !event.deltaY || !model.active || event.target.closest('.preview-menu')) return;
  // Keep Ctrl+wheel local to the PDF instead of zooming the entire browser UI.
  event.preventDefault();
  setPreviewZoom(previewZoom + (event.deltaY < 0 ? 0.25 : -0.25));
}, { passive: false });

async function renderPreview(anchor = null) {
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
    const scroll = $('preview-scroll');
    const width = Math.max(1, scroll.clientWidth - 12);
    const fitScale = Math.min(width / base.width, 390 / base.height);
    const cssScale = fitScale * previewZoom;
    scroll.style.height = `${Math.max(140, base.height * fitScale + 34)}px`;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const nextViewport = page.getViewport({ scale: cssScale * ratio, rotation: record.rotation });
    $('canvas-stack').style.width = `${base.width * cssScale}px`;
    $('canvas-stack').style.height = `${base.height * cssScale}px`;
    if (renderedPageId !== record.id) {
      scroll.scrollLeft = 0; scroll.scrollTop = 0;
      renderedPageId = record.id;
    } else if (anchor) {
      const bounds = scroll.getBoundingClientRect();
      const paper = $('canvas-stack').getBoundingClientRect();
      scroll.scrollLeft += paper.left + anchor.x * paper.width - bounds.left - scroll.clientWidth / 2;
      scroll.scrollTop += paper.top + anchor.y * paper.height - bounds.top - scroll.clientHeight / 2;
    }
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
    try {
      const source = await readPdfSource(file, {
        usedBytes: [...sources.values()].reduce((sum, item) => sum + item.size, 0),
        pageCount: model.pages.length + added.length,
      });
      const sourceId = uid();
      sources.set(sourceId, { ...source,
        number: sources.size + 1, color: sourceColors[sources.size % sourceColors.length] });
      source.pages.forEach((page, index) => added.push({ id: uid(), sourceId, index, rotation: page.rotation, strokes: [], watermark: null }));
    } catch (error) {
      errors.push(`${file.name}: ${pdfErrorMessage(error)}`);
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

async function printPdf() {
  if (!model.pages.length) return;
  const pages = await createPrintPages(model.pages, sources,
    (done, total) => status(`印刷を準備中… ${done} / ${total}`));
  const id = uid();
  await storePrintJob(id, { title: safeFilename($('output-name').value), pages });
  try {
    const url = new URL('print.html', document.baseURI); url.searchParams.set('job', id);
    if (globalThis.chrome?.tabs?.create) await chrome.tabs.create({ url: url.href, active: true });
    else if (!window.open(url.href, '_blank')) throw new Error('印刷タブを開けませんでした。ポップアップを許可して再度お試しください。');
    status('印刷タブを開きました。ダイアログが開かない場合は、タブ内の「印刷」を押してください。', 'success');
  } catch (error) { await deletePrintJob(id); throw error; }
}

async function exportPdf() {
  const records = model.pages;
  const bytes = await exportDocument('export', records, sources, createOverlay, $('output-name').value,
    (done, total) => status(`PDFを作成中… ${done} / ${total}`));
  download(bytes, `${safeFilename($('output-name').value)}.pdf`, 'application/pdf');
  status(`${records.length}ページのPDFの保存を開始しました。`, 'success');
}

async function splitPdf() {
  const records = model.pages;
  const base = safeFilename($('output-name').value);
  const bytes = await exportDocument('split', records, sources, createOverlay, base,
    (done, total) => status(`分割しています… ${done} / ${total}`));
  download(bytes, `${base}-pages.zip`, 'application/zip');
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
on('print', printPdf);
on('save', async () => { await exportPdf(); $('save-dialog').close(); });
on('split', async () => { await splitPdf(); $('save-dialog').close(); });
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
  previewMenuOpen = false;
  resetPreviewMenu();
  activate(id);
}

function resetPreviewMenu() {
  activePreviewMenu = 'select';
  $('rotation-scope').value = 'active';
  $('watermark-scope').value = 'all';
}
function enableSelection(showMenu = false) {
  if (busy || stroke || annotationDrag || pageDrag || !finishTextEdit()) return;
  previewMenuOpen = showMenu;
  penEnabled = false; textEnabled = false; selectedAnnotationId = null;
  selectedStrokeIds.clear(); selectedTextIds.clear();
  resetPreviewMenu(); refreshAnnotationHandles(); updateControls();
}
function togglePreviewMenu(name) {
  if (busy || stroke || annotationDrag || pageDrag || !model.active) return;
  if (name !== 'text' && (selectedText() || textEdit)) return;
  if (name !== 'pen' && selectedStroke()) return;
  if (previewMenuOpen && !$(`panel-${name}`).hidden) {
    previewMenuOpen = false; updateControls(); return;
  }
  if (name === 'select') enableSelection(true);
  else if (name === 'pen' && selectedStroke()) { previewMenuOpen = true; updateControls(); }
  else if (name === 'text') enableTextInsertion();
  else openPreviewMenu(name);
}
$('open-select').addEventListener('click', () => togglePreviewMenu('select'));
function openPreviewMenu(name) {
  if (busy || stroke || annotationDrag || pageDrag || !model.active) return;
  if (activePreviewMenu === name && !selectedAnnotationId) {
    previewMenuOpen = true; updateControls(); return;
  }
  if (!finishTextEdit()) return;
  resetPreviewMenu();
  textEnabled = false; selectedAnnotationId = null;
  penEnabled = name === 'pen';
  if (penEnabled) {
    $('pen-width').value = '3'; $('pen-width-value').value = '3';
    $('pen-transparency').value = '0'; $('pen-transparency-value').value = '0%';
  }
  activePreviewMenu = name;
  previewMenuOpen = true;
  refreshAnnotationHandles(); updateControls();
}
for (const name of previewMenus) {
  $(`open-${name}`).addEventListener('click', () => togglePreviewMenu(name));
  $(`close-${name}`)?.addEventListener('click', () => {
    enableSelection();
    $('open-select').focus({ preventScroll: true });
  });
}
$('start-pen').addEventListener('click', () => openPreviewMenu('pen'));
$('watermark-opacity').addEventListener('input', () => { $('watermark-opacity-value').value = `${$('watermark-opacity').value}%`; });

function selectedText() {
  return model.active?.strokes.find(item => item.tool === 'text' && item.id === selectedAnnotationId);
}
function selectedTexts() {
  if (!selectedText()) return [];
  return model.active.strokes.filter(item => item.tool === 'text'
    && (item.id === selectedAnnotationId || selectedTextIds.has(item.id)));
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
function selectAnnotation(annotation, { toggle = false, preserve = false } = {}) {
  const isStroke = !['text', 'watermark'].includes(annotation.tool);
  const isText = annotation.tool === 'text';
  if (toggle && (isStroke || isText)) {
    finishAnnotationFormatting();
    const ids = new Set((isText ? selectedTexts() : selectedStrokes()).map(item => item.id));
    if (ids.has(annotation.id)) ids.delete(annotation.id); else ids.add(annotation.id);
    selectedStrokeIds.clear(); selectedTextIds.clear();
    ids.forEach(id => (isText ? selectedTextIds : selectedStrokeIds).add(id));
    selectedAnnotationId = ids.has(annotation.id) ? annotation.id : [...ids].at(-1) ?? null;
    annotation = model.active.strokes.find(item => item.id === selectedAnnotationId);
    if (!annotation) { refreshAnnotationHandles(); updateControls(); return; }
  } else {
    if (!preserve || !isStroke) selectedStrokeIds.clear();
    if (!preserve || !isText) selectedTextIds.clear();
    if (isStroke) selectedStrokeIds.add(annotation.id);
    if (isText) selectedTextIds.add(annotation.id);
    selectedAnnotationId = annotation.id;
  }
  resetPreviewMenu();
  penEnabled = false; textEnabled = false;
  if (isStroke) {
    previewMenuOpen = false;
    syncPenControls(annotation);
  }
  if (annotation.tool === 'watermark') {
    $('watermark-text').value = annotation.text; $('watermark-color').value = annotation.color;
    $('watermark-opacity').value = annotation.opacity * 100;
    $('watermark-opacity-value').value = `${annotation.opacity * 100}%`;
    $('watermark-scope').value = 'active';
  }
  if (annotation.tool === 'text') {
    $('text-color').value = annotation.color;
    $('text-size').value = annotation.fontSize;
    $('text-font').value = annotation.fontFamily || 'sans-serif';
    $('text-align').value = annotation.textAlign || 'left';
    for (const style of ['bold', 'italic', 'underline']) {
      $(`text-${style}`).setAttribute('aria-pressed', String(!!annotation[style]));
    }
    syncTextFormatControls();
  } else { textEnabled = false; }
  $('text-handles').querySelectorAll('button').forEach(button => {
    const selected = button.dataset.annotationId === selectedAnnotationId
      || (isStroke && selectedStrokeIds.has(button.dataset.annotationId)) || (isText && selectedTextIds.has(button.dataset.annotationId));
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
  });
  updateControls();
}
function selectedStrokes() {
  if (!selectedStroke()) return [];
  return model.active.strokes.filter(item => !['text', 'watermark'].includes(item.tool)
    && (item.id === selectedAnnotationId || selectedStrokeIds.has(item.id)));
}
function syncPenControls(annotation = selectedStroke()) {
  if (!annotation) return;
  $('pen-color').value = annotation.color;
  $('pen-width').value = annotation.width;
  $('pen-width-value').value = $('pen-width').value;
  const transparency = Math.round((1 - (annotation.opacity ?? 1)) * 100);
  $('pen-transparency').value = transparency;
  $('pen-transparency-value').value = `${transparency}%`;
}
function annotationPreview(annotation) {
  return annotationDrag?.currents?.find(item => item.id === annotation.id)
    || strokeFormatSession?.previews.get(annotation.id)
    || textFormatSession?.previews.get(annotation.id)
    || (annotation.id === annotationFormatPreview?.id ? annotationFormatPreview : annotation);
}
function textSettings() {
  const fontSize = Number($('text-size').value);
  if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 96) throw new Error('文字サイズは8〜96ptで指定してください。');
  const background = textBackground({ backgroundColor: $('text-background').value,
    backgroundOpacity: Number($('text-background-opacity').value) / 100 });
  // Undefined defaults preserve annotations made before formatting was added.
  return { fontSize, color: $('text-color').value,
    backgroundColor: background.color === 'none' ? undefined : background.color,
    backgroundOpacity: background.opacity === 1 ? undefined : background.opacity,
    fontFamily: $('text-font').value === 'sans-serif' ? undefined : $('text-font').value,
    textAlign: $('text-align').value === 'left' ? undefined : $('text-align').value,
    ...Object.fromEntries(['bold', 'italic', 'underline'].map(style =>
      [style, $(`text-${style}`).getAttribute('aria-pressed') === 'true' || undefined])) };
}
function fitText(annotation) {
  const ctx = $('ink-canvas').getContext('2d');
  const layout = textLayout(ctx, annotation, viewport);
  if (layout.right - layout.left > viewport.width || layout.bottom - layout.top > viewport.height) {
    throw new Error('文字がページに収まりません。文字サイズを下げるか、改行してください。');
  }
  return moveText(ctx, annotation, viewport, 0, 0);
}
function resetTextBackgroundSettings() {
  $('text-background').value = '#000000';
  $('text-background-opacity').value = '0'; $('text-background-opacity-value').value = '0%';
}
function enableTextInsertion() {
  if (busy || stroke || annotationDrag || pageDrag || !model.active) return;
  if (textEnabled || textEdit || selectedText()) {
    previewMenuOpen = true; activePreviewMenu = 'text'; updateControls(); return;
  }
  if (!finishTextEdit()) return;
  previewMenuOpen = true;
  resetTextBackgroundSettings();
  textEnabled = true; penEnabled = false; selectedAnnotationId = null;
  resetPreviewMenu(); activePreviewMenu = 'text'; refreshAnnotationHandles(); updateControls();
  status('紙面をクリックしてテキストを1つ配置してください。Escで配置を終了します。');
}
$('open-text').addEventListener('click', () => togglePreviewMenu('text'));
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
  if (!busy && selectedTexts().length === 1 && viewport) startTextEdit(selectedText());
});

function paintTextPreview() {
  if (!viewport || !model.active) return;
  const stampDraft = textEdit?.draft.stampPattern && textEdit.draft.stampPattern !== 'plain' ? textEdit.draft : null;
  paintOverlay($('ink-canvas').getContext('2d'), { ...model.active,
    strokes: [...model.active.strokes.filter(item => item.id !== textEdit?.original?.id)
      .map(annotationPreview), ...(stampDraft ? [stampDraft] : [])] }, viewport, { hideTextFor: stampDraft?.id });
}

function positionTextEditor() {
  if (!textEdit || !viewport) return;
  const { editor, draft } = textEdit;
  const layout = textLayout($('ink-canvas').getContext('2d'), draft, viewport);
  const scale = $('ink-canvas').getBoundingClientRect().width / viewport.width;
  const background = textBackground(draft);
  const backgroundFill = background.color === 'none' ? 'transparent'
    : `rgb(${background.color === '#ffffff' ? '255 255 255' : '0 0 0'} / ${background.opacity})`;
  // Match the PDF font and explicit line breaks; never introduce browser wrapping.
  Object.assign(editor.style, { left: `${layout.x * scale}px`, top: `${layout.y * scale}px`,
    width: `${Math.max(layout.contentWidth * scale + 2, draft.text ? 0 : 60)}px`,
    paddingLeft: `${layout.insetLeft * scale}px`, paddingRight: `${layout.insetRight * scale}px`,
    paddingTop: `${(layout.stampInsetTop || 0) * scale}px`, paddingBottom: `${(layout.stampInsetBottom || 0) * scale}px`,
    height: `${(layout.textHeight ?? layout.height) * scale + 2}px`, fontSize: `${layout.size * scale}px`,
    lineHeight: '1.3', color: draft.color, caretColor: draft.color,
    fontFamily: textFontFamily(draft.fontFamily), fontWeight: draft.bold ? '700' : '400',
    fontStyle: draft.italic ? 'italic' : 'normal', textDecoration: draft.underline ? 'underline' : 'none',
    textAlign: draft.textAlign || 'left',
    backgroundImage: `linear-gradient(${backgroundFill}, ${backgroundFill})`,
    backgroundSize: `${layout.width * scale}px ${layout.height * scale}px`, backgroundRepeat: 'no-repeat',
    transform: `rotate(${layout.angle}rad)` });
  editor.dataset.stampInk = layout.stamp?.filled ? layout.stamp.textColor === '#ffffff' ? 'light' : 'dark' : '';
  if (layout.stamp) {
    editor.style.backgroundImage = 'none';
    editor.style.caretColor = layout.stamp.textColor;
    paintTextPreview();
  }
}

function updateTextDraft() {
  if (!textEdit || !viewport) return false;
  try {
    const draft = fitText(readTextDraft());
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

function readTextDraft() {
  const contents = textEdit.editor.getAnnotation?.()
    || replaceText(textEdit.draft, textEdit.editor.value.replaceAll('\r\n', '\n'));
  if (contents.text.length > 500) throw new Error('テキストは500文字以内で入力してください。');
  return { ...contents, points: textEdit.draft.points };
}

function startTextEdit(annotation, isNew = false) {
  if (!viewport || !finishTextEdit()) return;
  previewMenuOpen = false;
  selectAnnotation(annotation); penEnabled = false;
  if (isNew) activePreviewMenu = 'text';
  const editor = createTextEditor(annotation);
  editor.className = 'text-editor'; editor.value = annotation.text;
  editor.spellcheck = false;
  editor.setAttribute('aria-label', 'テキストボックス');
  editor.setAttribute('aria-describedby', 'text-edit-hint');
  editor.setAttribute('aria-keyshortcuts', 'F2 Control+b Control+i Control+u Control+ArrowUp Control+ArrowDown Control+ArrowLeft Control+ArrowRight Escape');
  textEdit = { pageId: model.activeId, original: isNew ? null : annotation, draft: annotation, editor };
  editor.onTextSelectionChange = syncTextFormatControls;
  editor.addEventListener('input', updateTextDraft);
  editor.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (handleTextShortcut(event)) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      // Preserve edits and focus the selection frame for moving the text.
      if (finishTextEdit()) {
        focusSelectedAnnotation();
      }
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault(); event.stopPropagation();
      if (finishTextEdit()) focusSelectedAnnotation();
    } else if (event.key === 'Tab') {
      event.preventDefault(); if (finishTextEdit()) $('open-text').focus({ preventScroll: true });
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopPropagation(); openSaveDialog();
    }
  });
  refreshAnnotationHandles(); paintTextPreview(); updateControls();
  editor.focus({ preventScroll: true });
  if (!isNew) editor.setSelectionRange(editor.value.length, editor.value.length);
}

function finishTextEdit(cancel = false) {
  finishAnnotationFormatting();
  if (!textEdit) return true;
  if (!cancel && !updateTextDraft()) { textEdit.editor.focus({ preventScroll: true }); return false; }
  const { pageId, original, draft, editor } = textEdit;
  textEdit = null; editor.remove();
  textEnabled = false; previewMenuOpen = false; resetPreviewMenu();
  if (!cancel) {
    const empty = !draft.text.trim();
    const changed = original ? JSON.stringify(original) !== JSON.stringify(draft) || empty : !empty;
    if (changed) {
      model.update(new Set([pageId]), p => ({ ...p, strokes: original
        ? p.strokes.flatMap(item => item.id === original.id ? (empty ? [] : [draft]) : [item])
        : [...p.strokes, draft] }));
      refreshThumbnails();
      status(empty ? 'テキストを削除しました。' : 'テキストを確定しました。クリックで再編集、テキストアイコンで書式を変更できます。', 'success');
    }
    selectedAnnotationId = empty ? null : draft.id;
  } else selectedAnnotationId = original?.id ?? null;
  paintTextPreview(); refreshAnnotationHandles(); updateControls();
  return true;
}

// Commit before toolbar/page/export actions so they always see the latest text.
document.addEventListener('pointerdown', event => {
  if (event.target.closest('[data-tool-help], #tool-help-dialog')) return;
  // Blank space outside the paper also clears selection, while controls remain usable.
  if (event.button === 0 && event.isPrimary && !busy && !stroke && !annotationDrag && !pageDrag
    && (selectedAnnotationId || textEdit)
    && !event.target.closest('.canvas-stack, .preview-menu, button, input, select, textarea, a, label, summary, dialog, [contenteditable]')) {
    finishAnnotationFormatting();
    enableSelection();
    // Invalid text must stay editable instead of losing focus on an outside click.
    if (textEdit) { event.preventDefault(); event.stopImmediatePropagation(); }
    return;
  }
  // Dismiss tool settings before the preview can start an editing gesture.
  if (previewMenuOpen && (!$('panel-pen').hidden || !$('panel-text').hidden)
    && event.target.closest('#preview-scroll') && !event.target.closest('.text-editor')
    && event.button === 0 && event.isPrimary) {
    previewMenuOpen = false;
    updateControls();
    event.preventDefault(); event.stopImmediatePropagation();
    return;
  }
  if (!event.target.closest('.text-settings, .pen-style-settings')) finishAnnotationFormatting();
  if (event.target.closest('#confirm-text, #cancel-text, #close-text, #previous, #next, .preview-tool-button, .preview-zoom')) return;
  if (!textEdit || event.target === textEdit.editor || textEdit.editor.contains?.(event.target) || event.target.closest('.text-settings')) return;
  if (!finishTextEdit()) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
// Dismiss menus on other outside clicks after the target handles its action.
document.addEventListener('click', event => {
  if (!previewMenuOpen || event.target.closest('.preview-menu, .preview-tool-button, .text-handle, dialog')) return;
  previewMenuOpen = false;
  updateControls();
});
function textFormatRange() {
  if (!textEdit) return { start: 0, end: selectedText()?.text.length || 0 };
  return { start: textEdit.editor.selectionStart || 0, end: textEdit.editor.selectionEnd || 0 };
}
function syncTextFormatControls() {
  const annotation = textEdit ? textEdit.editor.getAnnotation?.() || textEdit.draft
    : textFormatSession?.previews.get(selectedAnnotationId) || selectedText();
  if (!annotation) return;
  const { start, end } = textFormatRange();
  const anchorRuns = styledRuns(annotation).filter(run => end > start
    ? run.start < end && run.end > start : run.start <= start && run.end >= start);
  const style = anchorRuns[0]?.style || textStyle(annotation);
  const runs = textEdit ? anchorRuns : selectedTexts().flatMap(item => styledRuns(textFormatSession?.previews.get(item.id) || item));
  $('text-size').value = style.fontSize; $('text-color').value = style.color;
  $('text-font').value = style.fontFamily; $('text-align').value = style.textAlign;
  const background = textBackground(annotation);
  $('text-background').value = background.color;
  $('text-background-opacity').value = Math.round(background.opacity * 100);
  $('text-background-opacity-value').value = `${$('text-background-opacity').value}%`;
  for (const key of ['bold', 'italic', 'underline']) {
    const mixed = runs.some(run => run.style[key] !== style[key]);
    $(`text-${key}`).setAttribute('aria-pressed', mixed ? 'mixed' : String(style[key]));
  }
}
function previewTextFormatting(patch = textSettings(), relativeDelta) {
  const backgroundPatch = typeof patch !== 'function' && ('backgroundColor' in patch || 'backgroundOpacity' in patch);
  const relativeBackground = backgroundPatch && relativeDelta !== undefined;
  let backgroundDelta;
  if (relativeBackground) {
    const annotations = textEdit ? [textEdit.editor.getAnnotation?.() || textEdit.draft] : selectedTexts();
    const opacities = annotations.map(textBackground).filter(item => item.color !== 'none').map(item => item.opacity * 100);
    if (!opacities.length) return;
    backgroundDelta = Math.max(-Math.min(...opacities), Math.min(100 - Math.max(...opacities), relativeDelta));
    if (Math.abs(backgroundDelta) < 1e-8) return;
  }
  const applyBackground = annotation => {
    const background = textBackground(annotation);
    if (relativeBackground && background.color === 'none') return annotation;
    return formatTextBackground(annotation, relativeBackground
      ? { backgroundOpacity: Number((background.opacity + backgroundDelta / 100).toFixed(12)) } : patch);
  };
  if (textEdit) {
    const { start, end } = textFormatRange();
    if (start === end && !backgroundPatch) { status('書式を変更する文字を選択してください。'); syncTextFormatControls(); return; }
    try {
      const current = readTextDraft();
      const draft = fitText(backgroundPatch ? applyBackground(current) : formatText(current, start, end, patch));
      textEdit.draft = draft;
      textEdit.editor.setCustomValidity('');
      if (backgroundPatch && textEdit.editor.setBackground) textEdit.editor.setBackground({
        backgroundColor: draft.backgroundColor, backgroundOpacity: draft.backgroundOpacity });
      else if (textEdit.editor.setAnnotation) textEdit.editor.setAnnotation(draft);
      else textEdit.editor.value = draft.text;
      positionTextEditor(); syncTextFormatControls();
    } catch (error) { status(error.message, 'error'); syncTextFormatControls(); }
    return;
  }
  if (!selectedText() || !viewport || busy) return;
  try {
    textFormatSession ||= { originals: selectedTexts(), anchor: selectedText(), previews: new Map() };
    const { originals, anchor, previews } = textFormatSession;
    const relativeSize = !backgroundPatch && (relativeDelta !== undefined || (originals.length > 1 && typeof patch !== 'function' && 'fontSize' in patch));
    let delta;
    if (relativeSize) {
      const anchorSize = styledRuns(anchor)[0]?.style.fontSize ?? textStyle(anchor).fontSize;
      delta = relativeDelta ?? patch.fontSize - anchorSize;
      // Include partial formatting so every character and box stays within the shared limits.
      const sizes = originals.flatMap(item => [textStyle(item).fontSize, ...styledRuns(item).map(run => run.style.fontSize)]);
      delta = Math.max(8 - Math.min(...sizes), Math.min(96 - Math.max(...sizes), delta));
    }
    const candidates = originals.map(original => {
      const current = previews.get(original.id) || original;
      const base = relativeSize ? original : current;
      return fitText(backgroundPatch ? applyBackground(base) : formatText(base, 0, base.text.length,
        relativeSize ? style => ({ fontSize: style.fontSize + delta }) : patch, true));
    });
    // Validate every box before showing any part of the operation.
    textFormatSession.previews = new Map(candidates.map(item => [item.id, item]));
    annotationFormatPreview = textFormatSession.previews.get(selectedAnnotationId);
    syncTextFormatControls();
    paintTextPreview(); refreshAnnotationHandles();
  } catch (error) {
    textFormatSession = null; annotationFormatPreview = null;
    syncTextFormatControls();
    paintTextPreview(); refreshAnnotationHandles(); status(error.message, 'error');
  }
}
function finishAnnotationFormatting() {
  if (textFormatSession) {
    const { originals, previews } = textFormatSession;
    textFormatSession = null; annotationFormatPreview = null;
    const changed = new Map(originals.flatMap(original => {
      const current = previews.get(original.id);
      return current && JSON.stringify(current) !== JSON.stringify(original) ? [[original.id, current]] : [];
    }));
    if (changed.size) {
      model.update(new Set([model.activeId]), p => ({ ...p, strokes: p.strokes.map(item => changed.get(item.id) || item) }));
      refreshThumbnails(); updateControls();
    }
    syncTextFormatControls();
    return;
  }
  if (strokeFormatSession) {
    const { originals, previews } = strokeFormatSession;
    strokeFormatSession = null; annotationFormatPreview = null;
    const changed = new Map(originals.flatMap(original => {
      const current = previews.get(original.id);
      return current && (current.color !== original.color || current.width !== original.width
        || Math.abs((current.opacity ?? 1) - (original.opacity ?? 1)) > 1e-8) ? [[original.id, current]] : [];
    }));
    if (changed.size) {
      model.update(new Set([model.activeId]), p => ({ ...p, strokes: p.strokes.map(item => changed.get(item.id) || item) }));
      refreshThumbnails(); updateControls();
    }
    syncPenControls();
    return;
  }
  if (!annotationFormatPreview) return;
  const annotation = annotationFormatPreview;
  annotationFormatPreview = null;
  const original = selectedAnnotation();
  if (!original || annotation.id !== original.id || JSON.stringify(annotation) === JSON.stringify(original)) return;
  if (original.tool !== 'text' && annotation.color === original.color && annotation.width === original.width
    && (annotation.opacity ?? 1) === (original.opacity ?? 1)) return;
  model.update(new Set([model.activeId]), p => ({ ...p,
    strokes: p.strokes.map(item => item.id === annotation.id ? annotation : item) }));
  refreshThumbnails(); updateControls();
  if (annotation.tool === 'text') syncTextFormatControls();
}
function previewStrokeFormatting(id, relativeDelta) {
  $('pen-width-value').value = $('pen-width').value;
  $('pen-transparency-value').value = `${$('pen-transparency').value}%`;
  if (busy || stroke || annotationDrag || pageDrag || !viewport || !selectedStroke()) return;
  strokeFormatSession ||= { originals: selectedStrokes(), anchor: selectedStroke(), previews: new Map() };
  const { originals, anchor, previews } = strokeFormatSession;
  const property = { 'pen-color': 'color', 'pen-width': 'width', 'pen-transparency': 'opacity' }[id];
  let delta = relativeDelta ?? (Number($(id).value) - (property === 'width' ? anchor.width : Math.round((1 - (anchor.opacity ?? 1)) * 100)));
  // Limit the shared delta, so reaching an edge never changes the balance within the selection.
  if (property !== 'color') {
    const minimum = Math.max(...originals.map(item => property === 'width' ? 1 - item.width : ((item.opacity ?? 1) - 1) * 100));
    const maximum = Math.min(...originals.map(item => property === 'width' ? 40 - item.width : ((item.opacity ?? 1) - 0.05) * 100));
    delta = Math.max(minimum, Math.min(maximum, delta));
    if (Math.abs(delta) < 1e-8) delta = 0;
  }
  for (const original of originals) {
    const current = previews.get(original.id) || original;
    const value = property === 'color' ? $(id).value : property === 'width'
      ? original.width + delta
      : delta === 0 ? original.opacity ?? 1 : Math.max(0.05, Math.min(1, (original.opacity ?? 1) - delta / 100));
    previews.set(original.id, { ...current, [property]: value });
  }
  annotationFormatPreview = previews.get(selectedAnnotationId);
  if (property !== 'color') syncPenControls(annotationFormatPreview);
  strokeFormatSession.control = { id, value: String($(id).value) };
  paintTextPreview(); refreshAnnotationHandles();
}
for (const id of ['pen-color', 'pen-width', 'pen-transparency']) {
  const preview = () => previewStrokeFormatting(id);
  $(id).addEventListener('input', preview);
  $(id).addEventListener('change', () => {
    // Commit the live preview even when a fractional boundary rounds the displayed value.
    if (strokeFormatSession?.control?.id !== id || strokeFormatSession.control.value !== String($(id).value)) preview();
    finishAnnotationFormatting();
  });
  $(id).addEventListener('blur', finishAnnotationFormatting);
}
for (const id of ['text-color', 'text-size', 'text-font', 'text-align', 'text-background', 'text-background-opacity']) {
  const property = { 'text-color': 'color', 'text-size': 'fontSize', 'text-font': 'fontFamily', 'text-align': 'textAlign',
    'text-background': 'backgroundColor', 'text-background-opacity': 'backgroundOpacity' }[id];
  const preview = () => {
    const value = id === 'text-size' ? Number($(id).value)
      : id === 'text-background-opacity' ? Number($(id).value) / 100 : $(id).value;
    if (id === 'text-size' && (!Number.isFinite(value) || value < 8 || value > 96)) {
      status('文字サイズは8〜96ptで指定してください。', 'error'); return;
    }
    if (id === 'text-background-opacity') {
      if (!Number.isFinite(value) || value < 0 || value > 1) return;
      $('text-background-opacity-value').value = `${$(id).value}%`;
    }
    previewTextFormatting({ [property]: value });
    if (textFormatSession) textFormatSession.control = { id, value: String($(id).value) };
  };
  $(id).addEventListener('input', preview);
  $(id).addEventListener('change', () => {
    if (textFormatSession?.control?.id !== id || textFormatSession.control.value !== String($(id).value)) preview();
    finishAnnotationFormatting();
  });
  $(id).addEventListener('blur', finishAnnotationFormatting);
}
for (const style of ['bold', 'italic', 'underline']) {
  const button = $(`text-${style}`);
  button.addEventListener('click', () => {
    toggleTextStyle(style);
  });
}
function selectTextSettingsTab(name) {
  finishAnnotationFormatting();
  for (const tab of ['characters', 'background']) {
    const selected = tab === name;
    $(`text-tab-${tab}`).setAttribute('aria-selected', String(selected));
    $(`text-tab-${tab}`).tabIndex = selected ? 0 : -1;
    $(tab === 'characters' ? 'text-character-settings' : 'text-background-settings').hidden = !selected;
  }
}
for (const name of ['characters', 'background']) {
  $(`text-tab-${name}`).addEventListener('click', () => selectTextSettingsTab(name));
  $(`text-tab-${name}`).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const next = event.key === 'Home' ? 'characters' : event.key === 'End' ? 'background' : name === 'characters' ? 'background' : 'characters';
    selectTextSettingsTab(next); $(`text-tab-${next}`).focus({ preventScroll: true });
  });
}
function toggleTextStyle(style) {
  const annotation = textEdit?.draft || selectedText();
  if (!annotation) {
    const button = $(`text-${style}`);
    button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
    return;
  }
  const current = textEdit?.editor.getAnnotation?.() || textEdit?.draft || annotation, { start, end } = textFormatRange();
  const runs = textEdit ? styledRuns(current).filter(run => run.start < end && run.end > start)
    : selectedTexts().flatMap(item => styledRuns(textFormatSession?.previews.get(item.id) || item));
  const value = !runs.length || !runs.every(run => run.style[style]);
  previewTextFormatting({ [style]: value }); finishAnnotationFormatting();
}
function handleTextShortcut(event) {
  if (busy || stroke || annotationDrag || pageDrag || !viewport || event.defaultPrevented
    || event.isComposing || event.keyCode === 229 || event.altKey
    || $('help-dialog').open || $('tool-help-dialog').open || $('save-dialog').open || $('fullscreen-preview').open) return false;
  if (!selectedText() && !textEdit) return false;
  const editable = event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
  if (editable && (!textEdit || (editable !== textEdit.editor && !textEdit.editor.contains?.(editable)))) return false;
  if (event.key === 'F2' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault(); event.stopPropagation();
    if (textEdit) textEdit.editor.focus({ preventScroll: true });
    else if (selectedTexts().length === 1) startTextEdit(selectedText());
    return true;
  }
  if ((!event.ctrlKey && !event.metaKey) || event.shiftKey) return false;
  const style = { b: 'bold', i: 'italic', u: 'underline' }[event.key.toLowerCase()];
  const step = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
  const opacityStep = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (!style && !step && !opacityStep) return false;
  event.preventDefault(); event.stopPropagation();
  if (style) { if (!event.repeat) toggleTextStyle(style); }
  else {
    finishAnnotationFormatting();
    if (opacityStep) previewTextFormatting({ backgroundOpacity: 0 }, opacityStep);
    else if (textEdit) previewTextFormatting(current => ({ fontSize: Math.max(8, Math.min(96, current.fontSize + step)) }));
    else previewTextFormatting({}, step);
    finishAnnotationFormatting();
  }
  return true;
}
function handlePenShortcut(event) {
  if (busy || stroke || annotationDrag || pageDrag || !viewport || !model.active || event.defaultPrevented
    || event.isComposing || event.keyCode === 229 || event.altKey
    || (!event.ctrlKey && !event.metaKey) || textEdit || selectedText()
    || $('help-dialog').open || $('tool-help-dialog').open || $('save-dialog').open || $('fullscreen-preview').open) return false;
  if (!selectedStroke() && !penEnabled) return false;
  if (event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return false;
  if (event.shiftKey) {
    if (!selectedStroke() || !['ArrowUp', 'ArrowDown'].includes(event.key)) return false;
    event.preventDefault(); event.stopPropagation(); finishAnnotationFormatting();
    const originals = selectedStrokes();
    const resized = scaleStrokes(originals, viewport, event.key === 'ArrowUp' ? 1.1 : 1 / 1.1);
    if (resized !== originals) {
      model.update(new Set([model.activeId]), page => replaceStrokes(page, resized));
      paintTextPreview(); refreshAnnotationHandles(); refreshThumbnails(); updateControls();
    }
    return true;
  }
  const widthStep = { ArrowUp: 1, ArrowDown: -1 }[event.key];
  const transparencyStep = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (!widthStep && !transparencyStep) return false;
  event.preventDefault(); event.stopPropagation();
  finishAnnotationFormatting();
  const current = annotationFormatPreview || selectedStroke();
  const id = widthStep ? 'pen-width' : 'pen-transparency';
  const value = current ? (widthStep ? current.width : Math.round((1 - (current.opacity ?? 1)) * 100)) : Number($(id).value);
  $(id).value = Math.max(widthStep ? 1 : 0, Math.min(widthStep ? 40 : 95, value + (widthStep || transparencyStep)));
  previewStrokeFormatting(id, widthStep || transparencyStep); finishAnnotationFormatting();
  return true;
}
function handlePageToolShortcut(event) {
  if (busy || stroke || annotationDrag || pageDrag || !viewport || !model.active || textEdit
    || event.defaultPrevented || event.isComposing || event.keyCode === 229
    || event.altKey || event.shiftKey || (!event.ctrlKey && !event.metaKey)
    || $('help-dialog').open || $('tool-help-dialog').open || $('save-dialog').open || $('fullscreen-preview').open) return false;
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (!step) return false;
  const annotation = selectedAnnotation();
  if (annotation && annotation.tool !== 'watermark') return false;
  const tool = annotation ? 'watermark' : activePreviewMenu;
  if (!['watermark', 'rotation'].includes(tool)) return false;
  const editable = event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
  const opacity = $('watermark-opacity');
  if (editable && editable !== $(`${tool}-scope`) && (tool !== 'watermark' || editable !== opacity)) return false;
  event.preventDefault(); event.stopPropagation();
  if (tool === 'rotation') run(() => rotate(step * 90));
  else {
    const current = annotation ? Math.round(annotation.opacity * 100) : Number(opacity.value);
    const next = Math.max(Number(opacity.min), Math.min(Number(opacity.max), current + step));
    opacity.value = next;
    opacity.dispatchEvent(new Event('input', { bubbles: true }));
    if (annotation && next / 100 !== annotation.opacity) {
      model.update(new Set([model.activeId]), page => ({ ...page, watermark: { ...page.watermark, opacity: next / 100 } }));
      paintTextPreview(); refreshAnnotationHandles(); refreshThumbnails(); updateControls();
    }
  }
  return true;
}
function deleteSelectedAnnotation() {
  const annotation = selectedAnnotation();
  if (!annotation) return;
  const selection = selectedText() ? selectedTexts() : selectedStrokes();
  const ids = new Set(selection.length ? selection.map(item => item.id) : [annotation.id]);
  model.update(new Set([model.activeId]), p => annotation.tool === 'watermark' ? { ...p, watermark: null }
    : { ...p, strokes: p.strokes.filter(item => !ids.has(item.id)) });
  resetPreviewMenu();
  selectedAnnotationId = null; selectedStrokeIds.clear(); selectedTextIds.clear(); refresh(); status(`選択した${annotation.tool === 'text' ? 'テキスト' : annotation.tool === 'watermark' ? '透かし' : '描画'}${ids.size > 1 ? `（${ids.size}件）` : ''}を削除しました。「元に戻す」で復元できます。`);
}
on('delete-text', deleteSelectedAnnotation);
on('delete-stroke', deleteSelectedAnnotation);
function moveSelectedAnnotation(dx, dy) {
  const original = selectedAnnotation();
  if (!original || !viewport) return;
  const selection = selectedText() ? selectedTexts() : selectedStrokes();
  if (selection.length > 1) {
    const originals = selection, currents = moveStrokesTogether(originals, dx * viewport.scale, dy * viewport.scale);
    if (Math.hypot(currents[0].points[0][0] - originals[0].points[0][0], currents[0].points[0][1] - originals[0].points[0][1]) < 1e-8) return;
    model.update(new Set([model.activeId]), p => replaceStrokes(p, currents));
    paintTextPreview(); refreshAnnotationHandles(); refreshThumbnails(); updateControls(); return;
  }
  const moved = moveAnnotation(original, dx * viewport.scale, dy * viewport.scale);
  // A key pressed against the paper edge must not create history or clear Redo.
  if (Math.hypot(moved.points[0][0] - original.points[0][0], moved.points[0][1] - original.points[0][1]) < 1e-8) return;
  model.update(new Set([model.activeId]), p => replaceAnnotation(p, original, moved));
  paintTextPreview(); refreshAnnotationHandles(); refreshThumbnails(); updateControls();
}
function moveStrokesTogether(originals, dx, dy) {
  const bounds = originals.map(item => item.tool === 'text' ? textLayout($('ink-canvas').getContext('2d'), item, viewport) : strokeLayout(item, viewport));
  dx = Math.max(-Math.min(...bounds.map(b => b.left)), Math.min(viewport.width - Math.max(...bounds.map(b => b.right)), dx));
  dy = Math.max(-Math.min(...bounds.map(b => b.top)), Math.min(viewport.height - Math.max(...bounds.map(b => b.bottom)), dy));
  return originals.map(item => item.tool === 'text' ? moveAnnotation(item, dx, dy) : moveStroke(item, viewport, dx, dy));
}
function replaceStrokes(page, currents) {
  const replacements = new Map(currents.map(item => [item.id, item]));
  return { ...page, strokes: page.strokes.map(item => replacements.get(item.id) || item) };
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
    const selected = annotation.id === selectedAnnotationId || (selectedStroke() && selectedStrokeIds.has(annotation.id))
      || (selectedText() && selectedTextIds.has(annotation.id));
    button.type = 'button'; button.className = `text-handle${isText ? '' : ' stroke-handle'}${selected ? ' selected' : ''}`;
    button.dataset.annotationId = annotation.id;
    if (isText) button.dataset.textId = annotation.id;
    button.setAttribute('aria-label', isText ? `テキストを移動: ${annotation.text}` : annotation.tool === 'watermark' ? `透かしを選択・移動: ${annotation.text}` : '描画を選択・移動');
    button.setAttribute('aria-pressed', String(!!selected));
    button.title = 'クリックまたはF2で内容を編集。Ctrl+B/I/Uで太字・斜体・下線、Ctrl+↑/↓でサイズ変更、Ctrl+←/→で背景の不透明度を変更。ドラッグ・方向キーで移動、Deleteで削除。';
    if (isText) button.title += ' Shift＋クリックで追加選択・解除。複数選択中はダブルクリックで個別編集。';
    if (!isText) button.title = 'クリックで選択。ドラッグで移動。方向キーで1pt、Shift＋方向キーで10pt移動。Deleteで削除。';
    const isStroke = !isText && annotation.tool !== 'watermark';
    if (isStroke) button.title += ' Shift＋クリックで追加選択・解除。Ctrl＋↑／↓で太さ、Ctrl＋←／→で透明度を相対変更。Ctrl＋Shift＋↑／↓で描画を拡大・縮小。';
    if (annotation.tool === 'watermark') button.title += ' Ctrl＋←／→で不透明度を1%ずつ変更し、すぐ反映します。';
    button.setAttribute('aria-keyshortcuts', `${isText ? 'F2 Control+b Control+i Control+u Control+ArrowUp Control+ArrowDown Control+ArrowLeft Control+ArrowRight ' : isStroke ? 'Control+ArrowUp Control+ArrowDown Control+ArrowLeft Control+ArrowRight Control+Shift+ArrowUp Control+Shift+ArrowDown ' : 'Control+ArrowLeft Control+ArrowRight '}Delete ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown`);
    positionAnnotationHandle(button, annotationPreview(annotation));
    if (existing) continue;
    const currentText = () => pageAnnotations().find(item => item.id === button.dataset.annotationId);
    button.addEventListener('dragstart', event => event.preventDefault());
    button.addEventListener('click', event => {
      if (event.detail === 0 && !busy && currentText()) {
        const toggle = (isStroke || isText) && (event.shiftKey || event.ctrlKey || event.metaKey);
        if (isText && !toggle && selectedTexts().length <= 1) startTextEdit(currentText());
        else selectAnnotation(currentText(), { toggle, preserve: isText && selectedTextIds.has(currentText().id) });
      }
    });
    button.addEventListener('dblclick', event => {
      if (isText && !busy && !event.shiftKey && !event.ctrlKey && !event.metaKey && currentText()) startTextEdit(currentText());
    });
    button.addEventListener('pointerdown', event => {
      if (busy || stroke || annotationDrag || !viewport || event.button !== 0 || !event.isPrimary) return;
      const annotation = currentText();
      if (!annotation) return;
      event.preventDefault();
      if (isText) previewMenuOpen = false;
      const toggle = (isStroke || isText) && (event.shiftKey || event.ctrlKey || event.metaKey);
      selectAnnotation(annotation, { toggle, preserve: isText ? selectedTexts().some(item => item.id === annotation.id)
        : isStroke && selectedStrokes().some(item => item.id === annotation.id) });
      button.focus({ preventScroll: true });
      if (toggle) return;
      button.setPointerCapture(event.pointerId);
      annotationDrag = { pageId: model.activeId, pointerId: event.pointerId, original: annotation, current: annotation,
        originals: (isText ? selectedTexts() : selectedStrokes()).length > 1 ? (isText ? selectedTexts() : selectedStrokes()) : null,
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
  if (annotationDrag.originals) {
    annotationDrag.currents = moveStrokesTogether(annotationDrag.originals, point[0] - annotationDrag.start[0], point[1] - annotationDrag.start[1]);
    annotationDrag.current = annotationDrag.currents.find(item => item.id === annotationDrag.original.id);
    refreshAnnotationHandles();
    paintOverlay($('ink-canvas').getContext('2d'), replaceStrokes(model.active, annotationDrag.currents), viewport); return;
  }
  annotationDrag.current = moveAnnotation(annotationDrag.original, point[0] - annotationDrag.start[0], point[1] - annotationDrag.start[1]);
  positionAnnotationHandle(annotationDrag.button, annotationDrag.current);
  paintOverlay($('ink-canvas').getContext('2d'), replaceAnnotation(model.active, annotationDrag.original, annotationDrag.current), viewport);
}
function finishAnnotationDrag(event) {
  if (!annotationDrag || event.pointerId !== annotationDrag.pointerId) return;
  updateAnnotationDrag(event);
  const { pageId, original, current, currents, button, pointerId, moved } = annotationDrag; annotationDrag = null;
  if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
  const [x, y] = original.points[0]; const [nextX, nextY] = current.points[0];
  if (Math.hypot(nextX - x, nextY - y) > 0.01) {
    model.update(new Set([pageId]), p => currents ? replaceStrokes(p, currents) : replaceAnnotation(p, original, current));
    refreshThumbnails(); status(`${original.tool === 'text' ? 'テキスト' : '描画'}を移動しました。「元に戻す」で取り消せます。`, 'success');
    refreshAnnotationHandles();
  }
  // Preserve the DOM target for the browser's second click/dblclick event.
  positionAnnotationHandle(button, current); updateControls();
  // Clicking edits the content; formatting opens only from the text toolbar icon.
  if (!moved && original.tool === 'text' && selectedTexts().length === 1) startTextEdit(current);
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
function placeNumberStamp(event) {
  const number = model.nextStampNumber;
  if (!Number.isSafeInteger(number) || number < 1 || number >= Number.MAX_SAFE_INTEGER) {
    throw new Error('次の番号には1以上の安全な整数を指定してください。');
  }
  const fontSize = Number($('stamp-size').value);
  if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 96) throw new Error('サイズは8〜96ptで指定してください。');
  const ctx = $('ink-canvas').getContext('2d');
  let annotation = { id: uid(), tool: 'text', text: String(number), color: $('stamp-color').value,
    fontSize, fontFamily: 'sans-serif', bold: true, textAlign: 'center',
    stampPattern: ['circle', 'circle-filled', 'square', 'square-filled'].includes($('stamp-pattern').value) ? $('stamp-pattern').value : 'plain',
    rotation: model.active.rotation, points: [pdfPoint(event)] };
  const layout = textLayout(ctx, annotation, viewport);
  if (layout.width > viewport.width || layout.height > viewport.height) throw new Error('番号が紙面に収まりません。サイズを小さくしてください。');
  // Place the center at the click and keep the whole number inside the page.
  annotation = moveText(ctx, annotation, viewport, -layout.width / 2, -layout.height / 2);
  const pageId = model.activeId;
  model.commit(model.pages.map(page => page.id === pageId ? { ...page, strokes: [...page.strokes, annotation] } : page),
    { nextStampNumber: number + 1 });
  paintOverlay(ctx, model.active, viewport);
  refreshThumbnails(); refreshAnnotationHandles(); updateControls();
  status(`番号 ${number} を配置しました。次は ${model.nextStampNumber} です。`, 'success');
}
$('stamp-number').addEventListener('change', () => {
  const number = Number($('stamp-number').value);
  if (!Number.isSafeInteger(number) || number < 1 || number >= Number.MAX_SAFE_INTEGER) {
    $('stamp-number').value = model.nextStampNumber;
    fail(new Error('次の番号には1以上の安全な整数を指定してください。')); return;
  }
  if (number !== model.nextStampNumber) model.commit(model.pages, { nextStampNumber: number });
  updateControls();
});
$('ink-canvas').addEventListener('pointerdown', event => {
  if (event.button !== 0 || !event.isPrimary) return;
  if (activePreviewMenu === 'stamp') {
    if (busy || !viewport || !model.active || renderedPageId !== model.activeId || stroke || annotationDrag || pageDrag) return;
    event.preventDefault();
    try { placeNumberStamp(event); } catch (error) { fail(error); }
    return;
  }
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
createFullscreenPreview({ getPreview(index = model.pages.indexOf(model.active)) {
  if (busy || !model.active || stroke || annotationDrag || pageDrag || !finishTextEdit()) return null;
  const record = model.pages[index];
  if (!record) return null;
  return { record, source: sources.get(record.sourceId), pageIndex: index, pageCount: model.pages.length,
    label: `${sources.get(record.sourceId).name} · ${index + 1} / ${model.pages.length}` };
} });
document.addEventListener('keydown', event => {
  if ($('fullscreen-preview').open) return;
  if (handleTextShortcut(event)) return;
  if (handlePenShortcut(event)) return;
  if (handlePageToolShortcut(event)) return;
  if (event.key === 'Escape' && !event.repeat && !busy && !event.defaultPrevented && !event.isComposing && !$('help-dialog').open && !$('tool-help-dialog').open && !$('save-dialog').open) {
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
  if (event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])') || $('help-dialog').open || $('tool-help-dialog').open || $('save-dialog').open || busy || event.defaultPrevented || event.isComposing) return;
  if (event.target === $('preview-scroll') && $('preview-scroll').scrollWidth > $('preview-scroll').clientWidth && ['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
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
let previewWidth = 0;
new ResizeObserver(entries => {
  const width = entries[0].contentRect.width;
  if (width === previewWidth) return;
  previewWidth = width;
  clearTimeout(resizeTimer); resizeTimer = setTimeout(() => renderPreview(), 120);
}).observe($('preview-area'));
refresh();
purgeLegacyPrintJobs().catch(fail);
