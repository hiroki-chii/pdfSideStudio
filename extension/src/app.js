import './style.css';
import './theme.css';
import './editor-tab.css';
import { EditorModel, MAX_FILE_BYTES, safeFilename, normalizeRotation, sourceAppearance } from './model.js';
import { paintOverlay, textFontFamily, textLayout, moveText, moveTextTail, strokeLayout, moveStroke, scaleStrokes, DEFAULT_WATERMARK_FONT_SIZE } from './pdf.js';
import { createThemeController } from './theme.js';
import { storePrintJob, deletePrintJob, purgeLegacyPrintJobs } from './print-job.js';
import { createDocumentJobBroker } from './document-job.js';
import { connectEditorSync, sharePdfSource } from './editor-sync.js';
import { createFullscreenPreview } from './fullscreen-preview.js';
import { styledRuns, textStyle, textBackground, formatTextBackground, formatText, replaceText } from './text-format.js';
import { createTextEditor } from './text-editor.js';
import { exportDocument, runPdfJob } from './pdf-processor.js';
import { createPageOverlay as createOverlay, createPrintPages } from './raster.js';
import { download } from './download.js';
import { openPdfPreview, readPdfSource, pdfErrorMessage } from './pdf-source.js';
import { createToolHelp } from './tool-help.js';
import { createImageAnnotation, imageLayout, moveImage, prepareOverlayImages, resizeImageFromHandle, restoreImageAspectRatio } from './image-overlay.js';
import { orderedStrokes, moveAnnotationLayers } from './annotation-layers.js';

const $ = id => document.getElementById(id);
const editorUrl = new URL(location.href);
const editorTab = editorUrl.searchParams.get('mode') === 'editor';
const collapsedEditorSidebars = new Set();
const editorSessionTimeout = '編集データの受信期限が切れました。元の画面から新規タブを開き直してください。';
const editorSessions = createDocumentJobBroker('pdf-side-studio-editor', editorSessionTimeout);
window.addEventListener('pagehide', event => {
  editorSessions.close();
  if (!editorSync) return;
  stopEditorSync();
  if (event.persisted) status('画面間の同期を終了しました。この画面の編集は保存できます。');
});

if (editorTab) {
  document.documentElement.classList.add('editor-tab');
  document.title = '全画面編集 | PDF Side Studio';
  $('open-fullscreen-preview').title = '全画面でプレビュー';
  $('help').before($('theme-mode'));
  const sidebar = $('editor-sidebar');
  const history = document.querySelector('.preview-history');
  for (const button of history.querySelectorAll('button')) button.replaceChildren(button.querySelector('svg'));
  $('editor-file-actions').append($('document-actions'), history);
  document.querySelector('.preview-topbar').remove();
  sidebar.append(document.querySelector('.preview-toolbar'), document.querySelector('.preview-menu-layer'));
  document.querySelector('.app-header').after(sidebar);
  document.querySelector('.app').append($('page-list-section'));
  for (const button of document.querySelectorAll('[data-close-preview-menu], #close-stamp')) button.remove();
  for (const button of document.querySelectorAll('.editor-sidebar-toggle')) {
    button.addEventListener('click', () => {
      if (busy || stroke || annotationDrag || pageDrag) return;
      const panel = button.getAttribute('aria-controls');
      if (panel === 'editor-sidebar' && textEdit && !enableSelection()) return;
      if (!collapsedEditorSidebars.delete(panel)) collapsedEditorSidebars.add(panel);
      updateEditorSidebarLayout(model.pages.length > 0, model.past.length > 0 || model.future.length > 0);
      if (panel === 'page-list-section') revealActiveThumbnail();
    });
  }
} else {
  document.documentElement.classList.add('side-panel');
  $('open-editor-tab').hidden = false;
  $('full-features-notice').hidden = false;
  $('close-full-features-notice').addEventListener('click', () => {
    $('full-features-notice').hidden = true;
    $('open-editor-tab').focus({ preventScroll: true });
  });
  // Keep the compact rotation controls separate from the full tool-menu layer.
  $('preview-area').append($('panel-rotation'));
  $('rotation-scope').options[0].textContent = 'このページを回転';
  $('rotation-scope').options[1].textContent = '全ページ回転';
  $('rotation-scope').setAttribute('aria-label', '回転するページ');
}

for (const option of $('text-font').options) {
  option.style.fontFamily = textFontFamily(option.value);
}
createToolHelp(document);
let themeStorage;
try { themeStorage = window.localStorage; } catch { /* Theme still works without storage. */ }
createThemeController({ root: document.documentElement, button: $('theme-mode'),
  colorScheme: window.matchMedia('(prefers-color-scheme: dark)'), storage: themeStorage });
const model = new EditorModel();
const sources = new Map();
let editorSync;
let sidePanelSyncName;
let localEditorTab;
let syncUpdateTimer;
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
let textInsertionColor = $('text-color').value;
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
const previewMenus = ['rotation', 'pen', 'stamp', 'watermark', 'image'];
let activePreviewMenu = editorTab ? 'select' : 'rotation';
let previewMenuOpen = false;
const toolDescriptions = {
  'open-pen': '色・太さ・透明度を設定して紙面をドラッグ。クリックまたはEscで選択モードに戻ります。',
  'open-text': '紙面をクリックしてテキストを1つ追加。配置前は紙面の外の空白またはEscで終了できます。',
  'open-image': '画像を追加するメニューを開きます。選択した画像の透明度も調整できます。',
  'open-stamp': '紙面をクリックするたびに番号を配置します。紙面の外の空白またはEscで選択モードに戻ります。',
  'open-rotation': '対象ページを選び、方向ボタンまたはCtrl＋←／→で左右90度ずつ回転。「元に戻す」で取り消せます。',
  'open-watermark': 'テキスト・色・文字サイズ・位置を選んで、全ページの最前面に透かしを適用します。',
};
for (const [id, description] of Object.entries(toolDescriptions)) {
  const button = $(id);
  button.title = description;
  button.setAttribute('aria-description', description);
}

function status(message, kind = '') {
  const statusNode = $('status');
  const showStatus = kind === 'error' || (editorTab && $('editor-file-actions').hidden);
  statusNode.textContent = showStatus ? message : '';
  statusNode.className = `status ${kind}`;
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
    if (['help', 'close-help', 'close-tool-help', 'theme-mode', 'close-full-features-notice'].includes(element.id) || element.closest('#fullscreen-preview')) return;
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
  const selected = selectedAnnotation();
  if (!selected) selectedAnnotationId = null;
  updateLayerControls(selected);
  const textSelected = !!(selectedText() || textEdit);
  const strokeSelected = !!selectedStroke();
  const selectedMenu = strokeSelected ? 'pen' : textEnabled || textSelected ? 'text'
    : selected?.tool === 'image' ? 'image' : activePreviewMenu;
  const visibleMenu = previewMenuOpen ? selectedMenu : null;
  const selectedImage = selected?.tool === 'image' ? annotationPreview(selected) : null;
  $('add-overlay-image').disabled = busy || !viewport || !model.active;
  $('image-selection-settings').hidden = !selectedImage;
  $('image-transparency').disabled = busy || !selectedImage;
  $('restore-image-aspect').disabled = busy || !viewport || !selectedImage || restoreImageAspectRatio(selectedImage) === selectedImage;
  $('delete-image').disabled = busy || !selectedImage;
  if (selectedImage) {
    const transparency = Math.round((1 - (selectedImage.opacity ?? 1)) * 100);
    $('image-transparency').value = transparency;
    $('image-transparency-value').value = `${transparency}%`;
  }
  const imageHandles = $('image-resize-handles');
  imageHandles.hidden = !editorTab || busy || !viewport || !selectedImage;
  if (!imageHandles.hidden) positionImageResizeHandles(selectedImage);
  const textCount = selectedTexts().length;
  positionTextTailHandle();
  $('update-text').disabled = busy || textCount !== 1 || !viewport;
  $('delete-text').disabled = busy || !selectedText();
  $('panel-text').hidden = !model.active || visibleMenu !== 'text';
  $('text-box-shape-field').hidden = !textEnabled || textSelected;
  $('delete-stroke').disabled = busy || !selectedStroke();
  const strokeCount = selectedStrokes().length;
  $('pen-menu-title').textContent = strokeCount > 1 ? `選択した描画（${strokeCount}件）` : selectedStroke() ? '選択した描画' : 'ペンの設定';
  $('close-pen').hidden = editorTab && !strokeSelected;
  $('close-pen').textContent = selectedStroke() ? '選択を解除' : '描画を終了';
  $('pen-drawing-settings').hidden = !!selectedStroke();
  $('pen-shape-settings').hidden = strokeSelected;
  $('stroke-selection-actions').hidden = !selectedStroke();
  $('pen-mode-hint').textContent = selectedStroke()
    ? strokeCount > 1 ? '太さ・透明度は各描画の元の値に同じ差分を適用します。スライダーの数値は最後に選んだ描画の値です。色は選択全体に適用します。'
      : '色・太さ・透明度は選択した描画だけにすぐ反映されます。Shift＋クリックで描画を追加選択できます。'
    : '紙面をドラッグして描きます。クリックまたはEscで選択モードに戻ります。';
  $('text-menu-title').textContent = textEdit ? 'テキストを入力中' : textCount > 1 ? `選択したテキスト（${textCount}件）` : selectedText() ? '選択したテキスト' : 'テキストを配置';
  $('text-mode-hint').textContent = textEdit ? '文字書式は選択範囲に、背景はボックス全体に適用します。'
    : textCount > 1 ? `選択した${textCount}件に一括適用。サイズは差を保ち、8〜96ptの最初の境界で全体が止まります。`
      : selectedText() ? '文字・背景をすぐ反映。Shift＋クリックで追加選択・解除できます。'
      : 'ボックスの形を選び、紙面をクリックして入力します。';
  $('close-text').hidden = editorTab && (!selectedText() || !!textEdit);
  $('close-text').textContent = textEdit ? '確定して終了' : selectedText() ? '選択を解除' : '配置を終了';
  $('text-selection-actions').hidden = !selectedText() || !!textEdit;
  $('text-edit-actions').hidden = !textEdit;
  $('text-edit-hint').textContent = selectedText() && !textEdit
    ? 'Shift＋クリックで追加選択・解除。複数選択中はドラッグ・方向キーでまとめて移動、Deleteで削除。ダブルクリックで個別編集。Escまたは空白クリックで選択を解除します。'
    : '外側クリック・Ctrl+Enter・Escで入力を確定。「入力を取り消す」で変更を取り消します。書式は「テキスト」ツールから設定できます。';
  $('open-text').hidden = !model.pages.length;
  $('open-text').disabled = busy || !model.active || strokeSelected;
  $('open-text').setAttribute('aria-pressed', String(selectedMenu === 'text'));
  $('open-text').setAttribute('aria-expanded', String(!$('panel-text').hidden));
  $('open-text').setAttribute('aria-label', textSelected ? 'テキストの書式設定' : 'テキストボックスを配置');
  $('open-text').title = textSelected ? '選択したテキストの書式設定を開く・閉じる' : toolDescriptions['open-text'];
  $('ink-canvas').classList.toggle('inserting-text', textEnabled && !busy);
  $('ink-canvas').classList.toggle('stamping', activePreviewMenu === 'stamp' && !busy);
  $('stamp-number').value = model.nextStampNumber;
  $('stamp-next-hint').textContent = `次に押す番号: ${model.nextStampNumber}`;
  $('apply-watermark').disabled = busy || !model.pages.length || !$('watermark-text').value.trim();
  $('remove-watermark').disabled = busy || !model.pages.some(page => page.watermark);
  const rotateAll = $('rotation-scope').value === 'all';
  const target = rotateAll ? `全${model.pages.length}ページ` : `表示中の${index + 1}ページ目`;
  $('rotation-target-hint').textContent = `${target}を回転します。`;
  $('rotation-target-hint').dataset.all = String(rotateAll);
  $('rotate-left').textContent = editorTab ? rotateAll ? `全${model.pages.length}ページを左90°` : '↶ 左に90°' : '↶';
  $('rotate-right').textContent = editorTab ? rotateAll ? `全${model.pages.length}ページを右90°` : '↷ 右に90°' : '↷';
  $('rotate-left').setAttribute('aria-label', `${target}を左に90度回転`);
  $('rotate-right').setAttribute('aria-label', `${target}を右に90度回転`);
  for (const name of previewMenus) {
    const open = visibleMenu === name && !!model.active;
    $(`panel-${name}`).hidden = !open;
    $(`open-${name}`).disabled = busy || !model.pages.length || textSelected || (name !== 'pen' && strokeSelected);
    $(`open-${name}`).setAttribute('aria-expanded', String(open));
    $(`open-${name}`).setAttribute('aria-pressed', String(selectedMenu === name));
  }
  $('open-pen').setAttribute('aria-label', strokeSelected ? '描画の書式設定' : 'ペン');
  $('open-pen').title = strokeSelected ? '選択した描画の書式設定を開く・閉じる' : toolDescriptions['open-pen'];
  $('ink-canvas').classList.toggle('drawing', penEnabled && !busy);
  document.querySelectorAll('.page-button').forEach(button => {
    button.classList.toggle('reorderable', !busy && model.pages.length > 1);
  });
  if (!editorTab) {
    for (const name of ['pen', 'text', 'stamp', 'watermark', 'image']) {
      $(`open-${name}`).hidden = true;
      $(`open-${name}`).disabled = true;
      $(`panel-${name}`).hidden = true;
      for (const control of $(`panel-${name}`).querySelectorAll('button, input, select, textarea')) control.disabled = true;
    }
    $('open-rotation').hidden = true;
    $('panel-rotation').hidden = !model.pages.length;
    $('close-rotation').hidden = true;
    $('split').hidden = true;
    $('split').disabled = true;
    $('print').hidden = true;
    $('print').disabled = true;
  }
}

function updateLayerControls(selected) {
  const controls = $('layer-actions');
  controls.hidden = !editorTab || !selected;
  if (controls.hidden) return;
  const selection = selectedLayerIds(selected);
  const annotations = orderedStrokes(model.active);
  const firstSelected = annotations.findIndex(item => selection.has(item.id));
  const lastSelected = annotations.findLastIndex(item => selection.has(item.id));
  const firstOther = annotations.findIndex(item => !selection.has(item.id));
  const lastOther = annotations.findLastIndex(item => !selection.has(item.id));
  const unavailable = busy || !viewport || stroke || annotationDrag || pageDrag;
  for (const button of controls.querySelectorAll('[data-layer-direction]')) {
    const towardFront = ['front', 'forward'].includes(button.dataset.layerDirection);
    const canMove = towardFront ? firstSelected < lastOther : firstOther >= 0 && firstOther < lastSelected;
    button.disabled = !!unavailable || !canMove;
  }
}

function refresh() {
  const annotation = selectedAnnotation();
  if (annotation) selectAnnotation(annotation, { preserve: true, openMenu: false });
  else if (editorTab && selectedAnnotationId && !textEdit) previewMenuOpen = false;
  const hasPages = model.pages.length > 0;
  const hasHistory = model.past.length > 0 || model.future.length > 0;
  if (!hasPages) { previewMenuOpen = false; penEnabled = false; textEnabled = false; resetPreviewMenu(); }
  for (const name of previewMenus) $(`open-${name}`).hidden = !hasPages;
  if (editorTab) {
    updateEditorSidebarLayout(hasPages, hasHistory);
    document.querySelector('.preview-toolbar').hidden = !hasPages;
  } else {
    $('page-list-section').hidden = !hasPages;
    document.querySelector('.preview-toolbar').hidden = !hasPages;
  }
  // The side panel still needs its preview row for history after the last page is removed.
  $('workspace').hidden = !hasPages && (editorTab || !hasHistory);
  $('empty-state').hidden = hasPages;
  $('open-save').hidden = !hasPages;
  $('document-actions').hidden = !hasPages;
  if (!hasPages && $('save-dialog').open) $('save-dialog').close();
  if (!editorTab) document.querySelector('.preview-heading').hidden = !hasPages;
  $('preview-area').hidden = !hasPages;
  document.querySelector('.preview-footer').hidden = !hasPages;
  $('page-count').textContent = model.pages.length;
  $('save-count').textContent = `${model.pages.length}ページ`;
  refreshThumbnails();
  if (editorTab && hasPages) revealActiveThumbnail();
  updateControls();
  renderPreview();
}

function updateEditorSidebarLayout(hasPages, hasHistory) {
  const starting = !hasPages && !hasHistory;
  for (const [id, available] of [['editor-sidebar', !starting], ['page-list-section', hasPages]]) {
    const button = $(`toggle-${id}`);
    const expanded = available && !collapsedEditorSidebars.has(id);
    $(id).hidden = !expanded;
    button.hidden = !available;
    button.setAttribute('aria-expanded', String(expanded));
    button.title = `${button.dataset.sidebarLabel}を${expanded ? '閉じる' : '開く'}`;
    button.setAttribute('aria-label', button.title);
  }

  const upload = $('add-action');
  const statusNode = $('status');
  const fileActions = $('editor-file-actions');
  fileActions.hidden = starting;
  if (starting) {
    const emptyState = $('empty-state');
    if (upload.parentElement !== emptyState) {
      $('add-files').querySelector('strong').textContent = 'ページを追加';
      emptyState.querySelector('.empty-state-heading').after(upload);
      emptyState.querySelector('.empty-state-details').append(statusNode);
    }
    return;
  }

  if (upload.parentElement !== fileActions) {
    $('add-files').querySelector('strong').textContent = '追加';
    fileActions.prepend(upload);
  }
  const header = fileActions.parentElement;
  if (statusNode.parentElement !== header) {
    if (!statusNode.classList.contains('error')) statusNode.textContent = '';
    header.append(statusNode);
  }
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
    const label = document.createElement('span'); label.className = 'page-number'; label.textContent = index + 1;
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
      ['rotate-left', '左に90°回転', '<path d="M4 10a8 8 0 1 1 2 8M4 4v6h6"/>', id => rotatePage(id, -90)],
      ['rotate-right', '右に90°回転', '<path d="M20 10a8 8 0 1 0-2 8M20 4v6h-6"/>', id => rotatePage(id, 90)],
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
          const focusId = name.startsWith('rotate-') ? page.id : model.activeId;
          ([...$('page-list').querySelectorAll('.page-button')].find(button => button.dataset.id === focusId) ?? $('undo')).focus({ preventScroll: true });
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

function insertionPoint(x, y) {
  const cards = [...$('page-list').querySelectorAll('.page-card')];
  const before = cards.find(card => {
    const rect = card.getBoundingClientRect();
    return editorTab ? y < rect.top + rect.height / 2 : x < rect.left + rect.width / 2;
  });
  return { card: before || cards.at(-1), beforeId: before?.querySelector('button').dataset.id ?? null };
}

function showDropMarker(x, y) {
  clearDropMarker();
  const { card, beforeId } = insertionPoint(x, y);
  card?.classList.add(beforeId === null ? 'drop-after' : 'drop-before');
}

function scrollWhileDragging() {
  if (!draggedPageId) return;
  if (dragPointer && insidePageList(dragPointer.x, dragPointer.y)) {
    const list = $('page-list');
    const rect = list.getBoundingClientRect();
    const { x, y } = dragPointer;
    const [point, start, end, scroll] = editorTab ? [y, rect.top, rect.bottom, 'scrollTop']
      : [x, rect.left, rect.right, 'scrollLeft'];
    const edge = Math.min(32, (end - start) / 2);
    const speed = point < start + edge ? -Math.ceil((start + edge - point) / 3)
      : point > end - edge ? Math.ceil((point - end + edge) / 3) : 0;
    if (speed) {
      list[scroll] += speed;
      showDropMarker(x, y);
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
  if (insidePageList(event.clientX, event.clientY)) showDropMarker(event.clientX, event.clientY); else clearDropMarker();
}

function insidePageList(x, y) {
  const rect = $('page-list').getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function dropPage(event) {
  if (!pageDrag || event.pointerId !== pageDrag.pointerId) return;
  const { id } = pageDrag;
  const wasDragging = !!draggedPageId;
  const validDrop = insidePageList(event.clientX, event.clientY);
  const { beforeId } = insertionPoint(event.clientX, event.clientY);
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
  const maxThumbnailWidth = editorTab ? 160 : 104;
  try {
    while (thumbQueue.length) {
      const { record, button } = thumbQueue.shift();
      if (!button.isConnected) continue;
      try {
        let cached = thumbnails.get(record);
        if (!cached) {
          const page = await sources.get(record.sourceId).preview.getPage(record.index + 1);
          const initial = page.getViewport({ scale: 1, rotation: record.rotation });
          const view = page.getViewport({ scale: Math.min(maxThumbnailWidth / initial.width, 130 / initial.height), rotation: record.rotation });
          const canvas = document.createElement('canvas'); canvas.width = Math.ceil(view.width); canvas.height = Math.ceil(view.height);
          const ctx = canvas.getContext('2d');
          await page.render({ canvasContext: ctx, viewport: view }).promise;
          await prepareOverlayImages(record);
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
  if (editorTab && selectedAnnotationId) previewMenuOpen = false;
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
  revealActiveThumbnail();
}

function revealActiveThumbnail() {
  // Keep the active thumbnail visible without scrolling away from the preview.
  if ($('page-list-section').hidden) return;
  const list = $('page-list');
  const card = list.querySelector('.page-card.active');
  if (!card) return;
  const rect = card.getBoundingClientRect();
  const bounds = list.getBoundingClientRect();
  const [start, end, scroll] = editorTab ? ['top', 'bottom', 'scrollTop'] : ['left', 'right', 'scrollLeft'];
  if (rect[start] < bounds[start]) list[scroll] += rect[start] - bounds[start] - 2;
  else if (rect[end] > bounds[end]) list[scroll] += rect[end] - bounds[end] + 2;
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
  renderTask?.cancel(); viewport = null; stroke = null;
  if (annotationDrag?.resizeDirection) cancelAnnotationDrag();
  annotationDrag = null;
  $('text-tail-handle').hidden = true;
  $('image-resize-handles').hidden = true;
  $('text-handles').querySelectorAll('.text-handle').forEach(button => button.remove());
  const record = model.active;
  if (!record) return;
  $('render-status').hidden = false;
  $('render-status').textContent = '読み込み中…';
  const source = sources.get(record.sourceId);
  if (!editorTab) $('preview-title').textContent = source.name;
  $('page-position').textContent = `${model.pages.indexOf(record) + 1} / ${model.pages.length}`;
  try {
    const page = await source.preview.getPage(record.index + 1);
    if (version !== renderVersion) return;
    const base = page.getViewport({ scale: 1, rotation: record.rotation });
    const scroll = $('preview-scroll');
    const width = Math.max(1, scroll.clientWidth - 12);
    const fitHeight = editorTab ? Math.max(1, scroll.clientHeight - 34) : 390;
    const fitScale = Math.min(width / base.width, fitHeight / base.height);
    const cssScale = fitScale * previewZoom;
    if (!editorTab) scroll.style.height = `${Math.max(140, base.height * fitScale + 34)}px`;
    const ratioLimit = editorTab ? 4096 / (Math.max(base.width, base.height) * cssScale) : 2;
    const ratio = Math.min(window.devicePixelRatio || 1, 2, ratioLimit);
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
    await prepareOverlayImages(record);
    if (version !== renderVersion) return;
    viewport = nextViewport;
    paintTextPreview();
    refreshAnnotationHandles(); updateControls();
    const dimensions = `${Math.round(base.width)} × ${Math.round(base.height)} pt`;
    if (editorTab) $('page-position').title = `${source.name} · ${dimensions}`;
    else $('preview-size').textContent = dimensions;
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
      sources.set(sourceId, { ...source, ...sourceAppearance(sources.size + 1) });
      source.pages.forEach((page, index) => added.push({ id: uid(), sourceId, index, rotation: page.rotation, strokes: [], watermark: null }));
    } catch (error) {
      errors.push(`${file.name}: ${pdfErrorMessage(error)}`);
    }
  }
  if (added.length) {
    if (!model.pages.length) $('output-name').value = safeFilename(sources.get(added[0].sourceId).outputName);
    model.commit([...model.pages, ...added], { activeId: added[0].id });
    refresh();
  }
  status(errors.length ? `${added.length}ページ追加。${errors.join(' / ')}` : `${added.length}ページを追加しました。追加順に結合して保存できます。`, errors.length ? 'error' : 'success');
}

const capturedTabFilename = 'タブのキャプチャ.png';

async function verifyActiveTab(tab) {
  const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (active?.id !== tab.id || (tab.url && active.url !== tab.url)) {
    throw new Error('取り込み中に表示中のタブが変わりました。もう一度お試しください。');
  }
  return active;
}

async function captureCurrentTab() {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) throw new Error('取り込めるタブが見つかりません。');
  let dataUrl;
  const temporaryAccessHint = '対象タブでツールバーの PDF Side Studio アイコンを押してから、もう一度お試しください。';
  for (let attempt = 0; attempt < 2; attempt++) {
    tab = await verifyActiveTab(tab);
    status('表示中のタブを取り込んでいます…');
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      break;
    } catch (error) {
      if (/activeTab|<all_urls>/i.test(error.message)) {
        if (attempt > 0) throw new Error(temporaryAccessHint);
        status('Chrome の確認画面で、タブを取り込むためのサイトアクセスを許可してください。');
        if (!await chrome.permissions.request({ origins: ['<all_urls>'] })) {
          status(temporaryAccessHint, 'error');
          return;
        }
      } else if (attempt > 0 || !/image readback failed|view is invisible/i.test(error.message)) {
        throw new Error('表示中のタブを取り込めませんでした。もう一度お試しください。', { cause: error });
      }
      // The tab may still be repainting after the panel or permission dialog opens.
      await new Promise(resolve => setTimeout(resolve, 350));
    }
  }
  await verifyActiveTab(tab);
  const prefix = 'data:image/png;base64,';
  if (!dataUrl?.startsWith(prefix)) throw new Error('タブの画像を取得できませんでした。');
  const bytes = Uint8Array.from(globalThis.atob(dataUrl.slice(prefix.length)), char => char.charCodeAt(0));
  await addFiles([new globalThis.File([bytes], capturedTabFilename, { type: 'image/png' })]);
}

async function captureSelectedTab() {
  if (!await chrome.permissions.request({ permissions: ['desktopCapture'] })) {
    status('タブを取り込むには、Chrome の確認画面で画面取り込みを許可してください。', 'error');
    return;
  }

  const originalTab = editorTab ? await chrome.tabs.getCurrent()
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  status('取り込むタブを選んでください。');
  const streamId = await new Promise((resolve, reject) => {
    chrome.desktopCapture.chooseDesktopMedia(['tab'], null, { selfBrowserSurface: 'exclude' }, id => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(id);
    });
  });
  if (!streamId) { status(''); return; }

  status('選んだタブを取り込んでいます…');
  const canvas = document.createElement('canvas');
  try {
    const stream = await globalThis.navigator.mediaDevices.getUserMedia({
      audio: false,
      // Request refresh frames even when the selected tab's contents stay still.
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId, minFrameRate: 5 } },
    });
    const [track] = stream.getVideoTracks();
    let capture;
    try {
      capture = new globalThis.ImageCapture(track);
      const frame = await capture.grabFrame();
      try {
        canvas.width = frame.width;
        canvas.height = frame.height;
        canvas.getContext('2d').drawImage(frame, 0, 0);
      } finally { frame.close(); }
    } finally {
      // Retain the ImageCapture instance until the pending grabFrame finishes.
      (capture?.track ?? track)?.stop();
    }
  } catch (error) {
    throw new Error('選んだタブの表示範囲を取り込めませんでした。もう一度お試しください。', { cause: error });
  } finally {
    // Chrome activates the selected tab, so restore the originating tab after capture.
    try {
      if (originalTab?.id != null) {
        const tab = await chrome.tabs.update(originalTab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch (error) { console.error(error); }
  }

  const image = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!image) throw new Error('タブの画像を取得できませんでした。');
  await addFiles([new globalThis.File([image], capturedTabFilename, { type: 'image/png' })]);
}

function rotate(angle) {
  const all = $('rotation-scope').value === 'all';
  const ids = new Set((all ? model.pages : [activeRequired()]).map(p => p.id));
  model.update(ids, p => ({ ...p, rotation: normalizeRotation(p.rotation + angle) }));
  refresh(); status(all ? `${ids.size}ページを回転しました。` : '表示中のページを回転しました。', 'success');
}

async function printPdf() {
  await syncBeforeOutput();
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

async function openEditorTab() {
  if (pageDrag) return;
  if (await focusEditorTab()) {
    status('編集中のタブを表示しました。', 'success');
    return;
  }
  const url = new URL('index.html', document.baseURI);
  url.searchParams.set('mode', 'editor');
  const started = !editorSync;
  if (started) {
    const initial = {
      ...model.sessionSnapshot(), sources: [...sources].map(([id, source]) => [id, sharePdfSource(source)]),
    };
    await startEditorSync(sidePanelSyncName ?? uid(), { initial });
  }
  const id = uid();
  editorSessions.store(id, {
    syncName: editorSync.name, sessionId: editorSync.sessionId,
    activeId: model.activeId, outputName: $('output-name').value, zoom: previewZoom,
  });
  url.hash = id;
  try {
    if (globalThis.chrome?.tabs?.create) {
      const tab = await chrome.tabs.create({ url: url.href, active: true });
      await editorSync.rememberEditorTab(tab.id);
    } else {
      localEditorTab = window.open(url.href, '_blank');
      if (!localEditorTab) throw new Error('編集タブを開けませんでした。ポップアップを許可して再度お試しください。');
    }
    status('新規タブでエディタを開きました。', 'success');
  } catch (error) {
    editorSessions.remove(id);
    if (started) stopEditorSync();
    throw error;
  }
}

async function focusEditorTab() {
  if (localEditorTab && !localEditorTab.closed) {
    localEditorTab.focus();
    return true;
  }
  if (!editorSync || !globalThis.chrome?.tabs?.update) return false;
  const tabId = await editorSync.getEditorTab();
  if (tabId === null) return false;
  const active = await chrome.tabs.update(tabId, { active: true }).catch(async error => {
    if (await chrome.tabs.get(tabId).catch(() => null)) throw error;
    return null;
  });
  if (!active) return false;
  await chrome.windows.update(active.windowId, { focused: true });
  return true;
}

async function restoreEditorSession(id) {
  status('元の編集画面に接続しています…');
  const invitation = await editorSessions.read(id);
  if (!invitation) throw new Error(editorSessionTimeout);
  const tab = await globalThis.chrome?.tabs?.getCurrent?.();
  const sync = await startEditorSync(invitation.syncName, { sessionId: invitation.sessionId, tabId: tab?.id });
  await displayJoinedSession(sync, '元の編集画面と同期しています。', invitation);
}

async function reconnectSidePanel() {
  if (await chrome.tabs.getCurrent()) return;
  const { id } = await chrome.windows.getCurrent();
  if (!Number.isInteger(id) || id < 0) return;
  sidePanelSyncName = `pdf-side-studio-window-${id}`;
  const sync = await startEditorSync(sidePanelSyncName, { allowMissing: true });
  if (sync) await displayJoinedSession(sync, '編集中のタブと再同期しました。');
}

async function displayJoinedSession(sync, message, view) {
  try {
    const session = sync.snapshot();
    await displayEditorSession(session, view);
    sync.markDisplayed(session.revision);
    status(message, 'success');
  } catch (error) { stopEditorSync(); throw error; }
}

async function startEditorSync(name, options) {
  const sync = await connectEditorSync(name, {
    ...options, onUpdate: queueEditorSync, onError(error) { stopEditorSync(); fail(error); },
  });
  if (!sync) return null;
  editorSync = sync;
  model.onChange = change => sync.submit(change, sources);
  return sync;
}

function stopEditorSync() {
  editorSync?.close();
  editorSync = null;
  model.onChange = null;
  clearTimeout(syncUpdateTimer);
  syncUpdateTimer = null;
}

async function displayEditorSession({ state, past, future, sources: sharedSources }, view = {}) {
  const restored = new Map(), opened = [];
  try {
    for (const [sourceId, { blob, ...source }] of sharedSources) {
      const local = sources.get(sourceId);
      if (local) {
        restored.set(sourceId, { ...local, number: source.number, color: source.color });
        continue;
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const preview = await openPdfPreview(bytes, source.pages.length);
      opened.push(preview);
      restored.set(sourceId, { ...source, bytes, preview });
    }
  } catch (error) {
    await Promise.allSettled(opened.map(preview => preview.loadingTask.destroy()));
    throw error;
  }
  const activeId = view.activeId ?? model.activeId;
  const oldIndex = model.pages.findIndex(page => page.id === activeId);
  const fallback = state.pages[Math.min(oldIndex, state.pages.length - 1)]?.id;
  const nextId = state.pages.some(page => page.id === activeId) ? activeId : fallback ?? state.activeId;
  const wasEmpty = !model.pages.length;
  for (const [id, { preview }] of sources) {
    if (!restored.has(id)) preview.loadingTask.destroy().catch(console.error);
  }
  sources.clear();
  for (const [sourceId, source] of restored) sources.set(sourceId, source);
  const previousWatermark = model.documentWatermark;
  model.restoreSession({ state: { ...state, activeId: nextId }, past, future });
  if (previousWatermark !== model.documentWatermark) syncWatermarkControls();
  if (view.outputName !== undefined) $('output-name').value = view.outputName;
  if (wasEmpty && model.active && $('output-name').value === 'edited') {
    $('output-name').value = safeFilename(sources.get(model.active.sourceId).outputName);
  }
  if (view.zoom !== undefined) previewZoom = view.zoom;
  refresh();
}

async function applyEditorSyncUpdate() {
  const sync = editorSync;
  if (!sync?.needsUpdate) return;
  const session = sync.snapshot();
  await displayEditorSession(session);
  sync.markDisplayed(session.revision);
  return session.conflict;
}

function queueEditorSync(delay = 0) {
  if (syncUpdateTimer || !editorSync?.needsUpdate) return;
  syncUpdateTimer = setTimeout(async () => {
    syncUpdateTimer = null;
    if (!editorSync?.needsUpdate) return;
    if (busy || stroke || annotationDrag || pageDrag || textEdit || textFormatSession || strokeFormatSession || annotationFormatPreview) {
      queueEditorSync(80);
      return;
    }
    setBusy(true);
    try {
      const conflict = await applyEditorSyncUpdate();
      if (conflict) status(conflict, 'error');
    } catch (error) { fail(error); }
    finally { setBusy(false); }
  }, delay);
}

async function syncBeforeOutput() {
  if (!editorSync) return;
  await editorSync.barrier();
  const conflict = await applyEditorSyncUpdate();
  if (conflict) throw new Error(conflict);
}

async function exportPdf() {
  await syncBeforeOutput();
  const records = model.pages;
  if (!records.length) return;
  const bytes = await exportDocument('export', records, sources, createOverlay, $('output-name').value,
    (done, total) => status(`PDFを作成中… ${done} / ${total}`));
  download(bytes, `${safeFilename($('output-name').value)}.pdf`, 'application/pdf');
  status(`${records.length}ページのPDFの保存を開始しました。`, 'success');
}

async function splitPdf() {
  await syncBeforeOutput();
  const records = model.pages;
  if (!records.length) return;
  const base = safeFilename($('output-name').value);
  const bytes = await exportDocument('split', records, sources, createOverlay, base,
    (done, total) => status(`分割しています… ${done} / ${total}`));
  download(bytes, `${base}-pages.zip`, 'application/zip');
  status(`${records.length}個のPDFを含むZIPの保存を開始しました。`, 'success');
}

function on(id, action) {
  $(id).addEventListener('click', () => {
    if (!editorTab && ['print', 'split', 'apply-watermark', 'remove-watermark'].includes(id)) return;
    run(action);
  });
}
on('open-editor-tab', openEditorTab);
const canCaptureCurrentTab = !editorTab && globalThis.chrome?.tabs?.captureVisibleTab;
const canCaptureSelectedTab = globalThis.chrome?.permissions?.request && globalThis.navigator?.mediaDevices?.getUserMedia && globalThis.ImageCapture;
if (canCaptureCurrentTab || canCaptureSelectedTab) {
  const dialog = $('add-source-dialog');
  const addButton = $('add-files');
  addButton.setAttribute('aria-haspopup', 'dialog');
  addButton.setAttribute('aria-controls', dialog.id);
  addButton.addEventListener('click', () => dialog.showModal());
  $('browse-files').addEventListener('click', () => {
    dialog.close();
    $('file-input').click();
  });
  const startCapture = action => () => {
    dialog.close();
    return run(action);
  };
  $('capture-current-tab').hidden = !canCaptureCurrentTab;
  $('capture-current-tab').addEventListener('click', startCapture(captureCurrentTab));
  $('capture-selected-tab').hidden = !canCaptureSelectedTab;
  $('capture-selected-tab').addEventListener('click', startCapture(captureSelectedTab));
} else {
  $('add-files').addEventListener('click', () => $('file-input').click());
}
$('file-input').addEventListener('change', event => {
  const files = [...event.target.files]; event.target.value = '';
  if (files.length) run(() => addFiles(files));
});
function canPasteImage() {
  return editorTab && !busy && viewport && model.active && !stroke && !annotationDrag && !pageDrag && !textEdit;
}
async function insertImage(file) {
  let annotation;
  await run(async () => {
    const pageId = model.activeId, view = viewport;
    if (file.size > MAX_FILE_BYTES) throw new Error('貼り付ける画像は50 MiB以下にしてください。');
    status('貼り付ける画像を読み込んでいます…');
    const image = await runPdfJob({ type: 'image-overlay', bytes: new Uint8Array(await file.arrayBuffer()) });
    const inserted = createImageAnnotation(uid(), image, view);
    await prepareOverlayImages({ strokes: [inserted] });
    model.update(new Set([pageId]), page => ({ ...page, strokes: [...page.strokes, inserted] }));
    annotation = inserted;
    selectAnnotation(annotation);
    paintTextPreview(); refreshAnnotationHandles(); refreshThumbnails();
    status('画像を貼り付けました。ドラッグで位置を調整できます。', 'success');
  });
  if (annotation && selectedAnnotationId === annotation.id) focusSelectedAnnotation();
}
$('add-overlay-image').addEventListener('click', () => {
  if (canPasteImage()) $('overlay-image-input').click();
});
$('overlay-image-input').addEventListener('change', event => {
  const [file] = event.target.files; event.target.value = '';
  if (file && canPasteImage()) insertImage(file);
});
document.addEventListener('paste', event => {
  if (!canPasteImage() || event.defaultPrevented || document.querySelector('dialog[open]')
    || event.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
  const image = [...(event.clipboardData?.files ?? [])].find(file => ['image/jpeg', 'image/png', 'image/webp'].includes(file.type));
  if (!image) return;
  event.preventDefault();
  insertImage(image);
});
// Prevent dropped files from navigating the extension page.
const dropHighlight = document.documentElement;
const clearDropHighlight = () => dropHighlight.classList.remove('dragging');
document.addEventListener('dragover', event => {
  event.preventDefault();
  const acceptsFiles = !draggedPageId && !busy && event.dataTransfer.types.includes('Files');
  event.dataTransfer.dropEffect = acceptsFiles ? 'copy' : 'none';
  dropHighlight.classList.toggle('dragging', acceptsFiles);
}, true);
document.addEventListener('dragleave', event => { if (!event.relatedTarget) clearDropHighlight(); });
document.addEventListener('drop', event => {
  event.preventDefault();
  clearDropHighlight();
  if (draggedPageId) { finishPageDrag(); return; }
  const files = [...event.dataTransfer.files];
  if (files.length) {
    $('add-source-dialog').close();
    run(() => addFiles(files));
  }
}, true);
on('rotate-left', () => rotate(-90)); on('rotate-right', () => rotate(90));
$('rotation-scope').addEventListener('change', updateControls);
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
function rotatePage(id, angle) {
  pageActionRequired(id);
  model.update(new Set([id]), page => ({ ...page, rotation: normalizeRotation(page.rotation + angle) }));
  refresh(); status('ページを回転しました。「元に戻す」で復元できます。', 'success');
}
on('undo', () => { model.undo(); syncWatermarkControls(); refresh(); status('ひとつ前の状態に戻しました。'); });
on('redo', () => { model.redo(); syncWatermarkControls(); refresh(); status('操作をやり直しました。'); });
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
function syncWatermarkControls() {
  const watermark = model.documentWatermark ?? model.pages.find(page => page.watermark)?.watermark;
  if (!watermark) return;
  $('watermark-text').value = watermark.text;
  $('watermark-color').value = watermark.color;
  $('watermark-size').value = watermark.fontSize ?? DEFAULT_WATERMARK_FONT_SIZE;
  $('watermark-position').value = watermark.position ?? 'center';
}
function watermarkFontSize() {
  const { valueAsNumber: size, min, max } = $('watermark-size');
  return Number.isInteger(size) && size >= Number(min) && size <= Number(max) ? size : null;
}
function applyWatermark() {
  const text = $('watermark-text').value.trim();
  if (!text) throw new Error('透かしのテキストを入力してください。');
  if (!model.pages.length) return;
  const fontSize = watermarkFontSize();
  if (fontSize === null) {
    const { min, max } = $('watermark-size');
    throw new Error(`透かしの文字サイズは${min}〜${max} ptの整数を指定してください。`);
  }
  const watermark = { text, color: $('watermark-color').value, position: $('watermark-position').value, fontSize };
  const current = model.documentWatermark;
  if (current?.text === text && current.color === watermark.color && current.position === watermark.position
    && (current.fontSize ?? DEFAULT_WATERMARK_FONT_SIZE) === fontSize) return;
  model.commit(model.pages, { documentWatermark: watermark });
  refresh();
  status(current ? '全ページの透かしを更新しました。' : `全${model.pages.length}ページに透かしを適用しました。`, 'success');
}
function updateAppliedWatermark() {
  if (!editorTab || busy || stroke || annotationDrag || pageDrag || !model.documentWatermark || !model.pages.length) return;
  const input = $('watermark-text');
  if (!input.value.trim()) {
    input.value = model.documentWatermark.text;
    updateControls();
  }
  if (watermarkFontSize() === null) $('watermark-size').value = model.documentWatermark.fontSize ?? DEFAULT_WATERMARK_FONT_SIZE;
  applyWatermark();
}
for (const id of ['watermark-text', 'watermark-color', 'watermark-position', 'watermark-size']) {
  $(id).addEventListener('change', updateAppliedWatermark);
}
for (const id of ['watermark-text', 'watermark-size']) {
  $(id).addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || !model.documentWatermark) return;
    event.preventDefault();
    updateAppliedWatermark();
  });
}
on('apply-watermark', applyWatermark);
on('remove-watermark', () => {
  if (!model.pages.some(page => page.watermark)) return;
  model.commit(model.pages, { documentWatermark: null });
  refresh(); status('全ページから透かしを削除しました。「元に戻す」で復元できます。');
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
  activePreviewMenu = editorTab ? 'select' : 'rotation';
  $('rotation-scope').value = 'active';
}
function enableSelection() {
  if (busy || stroke || annotationDrag || pageDrag || !finishTextEdit()) return false;
  previewMenuOpen = false;
  penEnabled = false; textEnabled = false; selectedAnnotationId = null;
  selectedStrokeIds.clear(); selectedTextIds.clear();
  resetPreviewMenu(); refreshAnnotationHandles(); updateControls();
  return true;
}
function togglePreviewMenu(name) {
  if (!editorTab) return;
  if (busy || stroke || annotationDrag || pageDrag || !model.active) return;
  if (name !== 'text' && (selectedText() || textEdit)) return;
  if (name !== 'pen' && selectedStroke()) return;
  if (previewMenuOpen && !$(`panel-${name}`).hidden) {
    previewMenuOpen = false; updateControls(); return;
  }
  if ((name === 'pen' && selectedStroke()) || (name === 'image' && selectedAnnotation()?.tool === 'image')) {
    previewMenuOpen = true; updateControls();
  }
  else if (name === 'text') enableTextInsertion();
  else openPreviewMenu(name);
}
function openPreviewMenu(name) {
  if (!editorTab) return;
  if (busy || stroke || annotationDrag || pageDrag || !model.active) return;
  if (activePreviewMenu === name && !selectedAnnotationId) {
    previewMenuOpen = true; updateControls(); return;
  }
  if (!finishTextEdit()) return;
  if (name === 'watermark') syncWatermarkControls();
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
    if (enableSelection()) $('preview-scroll').focus({ preventScroll: true });
  });
}
for (const button of document.querySelectorAll('[data-close-preview-menu]')) {
  button.addEventListener('click', () => {
    const name = button.dataset.closePreviewMenu;
    if (!previewMenuOpen || $(`panel-${name}`).hidden) return;
    togglePreviewMenu(name);
    if (!previewMenuOpen) $(`open-${name}`).focus({ preventScroll: true });
  });
}
$('start-pen').addEventListener('click', () => openPreviewMenu('pen'));

function selectedText() {
  return model.active?.strokes.find(item => item.tool === 'text' && item.id === selectedAnnotationId);
}
function selectedTexts() {
  if (!selectedText()) return [];
  return model.active.strokes.filter(item => item.tool === 'text'
    && (item.id === selectedAnnotationId || selectedTextIds.has(item.id)));
}
function selectedAnnotation() {
  return selectedAnnotationId ? model.active?.strokes.find(item => item.id === selectedAnnotationId) : null;
}
function pageAnnotations() {
  return model.active ? orderedStrokes(model.active) : [];
}
function selectedLayerIds(selected) {
  const ids = selected.tool === 'text' ? selectedTextIds : selectedStrokeIds;
  return selected.tool === 'image' ? new Set([selected.id]) : new Set([selected.id, ...ids]);
}
function moveSelectedAnnotationLayers(direction) {
  if (!editorTab || busy || !viewport || stroke || annotationDrag || pageDrag || !selectedAnnotation() || !finishTextEdit()) return;
  const selected = selectedAnnotation();
  if (!selected) return;
  const annotations = orderedStrokes(model.active);
  const reordered = moveAnnotationLayers(annotations, selectedLayerIds(selected), direction);
  if (reordered.every((item, index) => item === annotations[index])) return;
  model.update(new Set([model.activeId]), page => ({ ...page, layerOrder: reordered.map(item => item.id) }));
  paintTextPreview(); refreshAnnotationHandles(); refreshThumbnails(); updateControls();
  status('重なり順を変更しました。', 'success');
}
for (const button of $('layer-actions').querySelectorAll('[data-layer-direction]')) {
  button.addEventListener('click', () => moveSelectedAnnotationLayers(button.dataset.layerDirection));
}
function replaceAnnotation(page, original, current) {
  return { ...page, strokes: page.strokes.map(item => item.id === original.id ? current : item) };
}
function selectedStroke() {
  const annotation = selectedAnnotation();
  return annotation && !['text', 'image'].includes(annotation.tool) ? annotation : null;
}
function moveAnnotation(annotation, dx, dy) {
  if (annotation.tool === 'image') return moveImage(annotation, viewport, dx, dy);
  return annotation.tool === 'text'
    ? moveText($('ink-canvas').getContext('2d'), annotation, viewport, dx, dy)
    : moveStroke(annotation, viewport, dx, dy);
}
function selectAnnotation(annotation, { toggle = false, preserve = false, openMenu = true } = {}) {
  const isStroke = !['text', 'image'].includes(annotation.tool);
  const isText = annotation.tool === 'text';
  if (toggle && (isStroke || isText)) {
    finishAnnotationFormatting();
    const ids = new Set((isText ? selectedTexts() : selectedStrokes()).map(item => item.id));
    if (ids.has(annotation.id)) ids.delete(annotation.id); else ids.add(annotation.id);
    selectedStrokeIds.clear(); selectedTextIds.clear();
    ids.forEach(id => (isText ? selectedTextIds : selectedStrokeIds).add(id));
    selectedAnnotationId = ids.has(annotation.id) ? annotation.id : [...ids].at(-1) ?? null;
    annotation = model.active.strokes.find(item => item.id === selectedAnnotationId);
    if (!annotation) {
      if (editorTab) previewMenuOpen = false;
      refreshAnnotationHandles(); updateControls(); return;
    }
  } else {
    if (!preserve || !isStroke) selectedStrokeIds.clear();
    if (!preserve || !isText) selectedTextIds.clear();
    if (isStroke) selectedStrokeIds.add(annotation.id);
    if (isText) selectedTextIds.add(annotation.id);
    selectedAnnotationId = annotation.id;
  }
  resetPreviewMenu();
  penEnabled = false; textEnabled = false;
  if (editorTab && openMenu) previewMenuOpen = true;
  if (isStroke) {
    if (!editorTab) previewMenuOpen = false;
    syncPenControls(annotation);
  }
  if (annotation.tool === 'text') {
    $('text-size').value = annotation.fontSize;
    $('text-font').value = annotation.fontFamily || 'sans-serif';
    $('text-align').value = annotation.textAlign || 'left';
    for (const style of ['bold', 'italic', 'underline']) {
      $(`text-${style}`).setAttribute('aria-pressed', String(!!annotation[style]));
    }
    syncTextFormatControls();
  } else { textEnabled = false; }
  $('text-handles').querySelectorAll('.text-handle').forEach(button => {
    const selected = button.dataset.annotationId === selectedAnnotationId
      || (isStroke && selectedStrokeIds.has(button.dataset.annotationId)) || (isText && selectedTextIds.has(button.dataset.annotationId));
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
  });
  updateControls();
}
function selectedStrokes() {
  if (!selectedStroke()) return [];
  return model.active.strokes.filter(item => !['text', 'image'].includes(item.tool)
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
    || (annotation.id === annotationDrag?.current?.id ? annotationDrag.current : null)
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
    boxShape: $('text-box-shape').value === 'bubble' ? 'bubble' : undefined,
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
  const bubble = $('text-box-shape').value === 'bubble';
  $('text-background').value = bubble ? '#ffffff' : '#000000';
  const opacity = bubble ? '100' : '0';
  $('text-background-opacity').value = opacity; $('text-background-opacity-value').value = `${opacity}%`;
}
function enableTextInsertion() {
  if (busy || stroke || annotationDrag || pageDrag || !model.active) return;
  if (textEnabled || textEdit || selectedText()) {
    previewMenuOpen = true; activePreviewMenu = 'text'; updateControls(); return;
  }
  if (!finishTextEdit()) return;
  previewMenuOpen = true;
  $('text-color').value = textInsertionColor;
  resetTextBackgroundSettings();
  textEnabled = true; penEnabled = false; selectedAnnotationId = null;
  resetPreviewMenu(); activePreviewMenu = 'text'; refreshAnnotationHandles(); updateControls();
  if (!editorTab) status('紙面をクリックしてテキストを1つ配置してください。Escで配置を終了します。');
}
$('open-text').addEventListener('click', () => togglePreviewMenu('text'));
$('close-text').addEventListener('click', () => {
  if (enableSelection()) $('preview-scroll').focus({ preventScroll: true });
});
$('confirm-text').addEventListener('click', () => {
  if (finishTextEdit()) focusSelectedAnnotation();
});
$('cancel-text').addEventListener('click', () => {
  if (finishTextEdit(true)) focusSelectedAnnotation();
});
function focusSelectedAnnotation() {
  const handle = [...$('text-handles').querySelectorAll('button')].find(button => button.dataset.annotationId === selectedAnnotationId);
  (handle || $('preview-scroll')).focus({ preventScroll: true });
}
$('update-text').addEventListener('click', () => {
  if (!busy && selectedTexts().length === 1 && viewport) startTextEdit(selectedText());
});

function paintTextPreview() {
  if (!viewport || !model.active) return;
  const draft = textEdit?.draft;
  const framedDraft = draft?.boxShape === 'bubble' || (draft?.stampPattern && draft.stampPattern !== 'plain') ? draft : null;
  const originalId = textEdit?.original?.id;
  const strokes = model.active.strokes.flatMap(item => originalId && item.id === originalId
    ? (framedDraft ? [framedDraft] : []) : [annotationPreview(item)]);
  if (framedDraft && !originalId) strokes.push(framedDraft);
  const ink = $('ink-canvas');
  const watermark = model.active.watermark;
  const draftWatermark = $('text-edit-watermark');
  // A live text editor sits above the ink canvas, so paint its watermark above it.
  if (textEdit && watermark) {
    if (draftWatermark.width !== ink.width || draftWatermark.height !== ink.height) {
      draftWatermark.width = ink.width; draftWatermark.height = ink.height;
    }
    paintOverlay(draftWatermark.getContext('2d'), { strokes: [], watermark }, viewport);
    draftWatermark.hidden = false;
  } else if (!draftWatermark.hidden) {
    draftWatermark.hidden = true;
    draftWatermark.width = draftWatermark.height = 0;
  }
  paintOverlay(ink.getContext('2d'), { ...model.active, strokes, watermark: draftWatermark.hidden ? watermark : null },
    viewport, { hideTextFor: framedDraft?.id });
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
    width: `${Math.max(layout.contentWidth * scale + 2, draft.text || layout.bubble ? 0 : 60)}px`,
    paddingLeft: `${layout.insetLeft * scale}px`, paddingRight: `${layout.insetRight * scale}px`,
    paddingTop: `${(layout.bubble?.padding ?? layout.stampInsetTop) * scale}px`,
    paddingBottom: `${(layout.bubble?.padding ?? layout.stampInsetBottom) * scale}px`,
    height: `${(layout.textHeight ?? layout.height) * scale + 2}px`, fontSize: `${layout.size * scale}px`,
    lineHeight: '1.3', color: draft.color, caretColor: draft.color,
    fontFamily: textFontFamily(draft.fontFamily), fontWeight: draft.bold ? '700' : '400',
    fontStyle: draft.italic ? 'italic' : 'normal', textDecoration: draft.underline ? 'underline' : 'none',
    textAlign: draft.textAlign || 'left',
    backgroundImage: layout.stamp || layout.bubble ? 'none' : `linear-gradient(${backgroundFill}, ${backgroundFill})`,
    backgroundSize: `${layout.width * scale}px ${layout.height * scale}px`, backgroundRepeat: 'no-repeat',
    transform: `rotate(${layout.angle}rad)` });
  editor.dataset.stampInk = layout.stamp?.filled ? layout.stamp.textColor === '#ffffff' ? 'light' : 'dark' : '';
  if (layout.stamp) editor.style.caretColor = layout.stamp.textColor;
  if (layout.stamp || layout.bubble) paintTextPreview();
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
  if (!editorTab) previewMenuOpen = false;
  selectAnnotation(annotation); penEnabled = false;
  if (isNew) activePreviewMenu = 'text';
  const editor = createTextEditor(annotation);
  editor.className = 'text-editor'; editor.value = annotation.text;
  editor.spellcheck = false;
  if (annotation.boxShape === 'bubble') editor.dataset.placeholder = '入力';
  editor.setAttribute('aria-label', annotation.boxShape === 'bubble' ? '吹き出しテキストボックス' : 'テキストボックス');
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
  textEnabled = false; resetPreviewMenu();
  if (!cancel) {
    const empty = !draft.text.trim();
    const changed = original ? JSON.stringify(original) !== JSON.stringify(draft) || empty : !empty;
    if (changed) {
      model.update(new Set([pageId]), p => ({ ...p, strokes: original
        ? p.strokes.flatMap(item => item.id === original.id ? (empty ? [] : [draft]) : [item])
        : [...p.strokes, draft] }));
      refreshThumbnails();
      if (empty) status('テキストを削除しました。', 'success');
      else if (draft.boxShape === 'bubble') status('吹き出しを確定しました。本体をクリックして再編集、しっぽをドラッグして先端を移動できます。', 'success');
      else status('');
    }
    selectedAnnotationId = empty ? null : draft.id;
  } else selectedAnnotationId = original?.id ?? null;
  previewMenuOpen = editorTab && !!selectedAnnotationId && previewMenuOpen;
  paintTextPreview(); refreshAnnotationHandles(); updateControls();
  return true;
}

// Commit before toolbar/page/export actions so they always see the latest text.
document.addEventListener('pointerdown', event => {
  if (event.target.closest('[data-tool-help], #tool-help-dialog')) return;
  // Blank editor space outside the paper also ends click-to-place tools.
  if (event.button === 0 && event.isPrimary && !busy && !stroke && !annotationDrag && !pageDrag
    && (selectedAnnotationId || textEdit || (editorTab && activePreviewMenu !== 'select'))
    && !event.target.closest('.canvas-stack, .preview-menu, button, input, select, textarea, a, label, summary, dialog, [contenteditable]')) {
    finishAnnotationFormatting();
    enableSelection();
    // Invalid text must stay editable instead of losing focus on an outside click.
    if (textEdit) { event.preventDefault(); event.stopImmediatePropagation(); }
    return;
  }
  // Dismiss tool settings before the preview can start an editing gesture.
  if (!editorTab && previewMenuOpen && (!$('panel-pen').hidden || !$('panel-text').hidden || !$('panel-stamp').hidden)
    && event.target.closest('#preview-scroll') && !event.target.closest('.text-editor')
    && event.button === 0 && event.isPrimary) {
    previewMenuOpen = false;
    updateControls();
    event.preventDefault(); event.stopImmediatePropagation();
    return;
  }
  if (!event.target.closest('.text-settings, .pen-style-settings')) finishAnnotationFormatting();
  if (event.target.closest('#confirm-text, #cancel-text, #close-text, #previous, #next, .preview-tool-button, .preview-zoom, .editor-sidebar-toggle, [data-close-preview-menu]')) return;
  if (!textEdit || event.target === textEdit.editor || textEdit.editor.contains?.(event.target) || event.target.closest('.text-settings')) return;
  if (!finishTextEdit()) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
// Dismiss menus on other outside clicks after the target handles its action.
document.addEventListener('click', event => {
  if (editorTab || !previewMenuOpen || event.target.closest('.preview-menu, .preview-tool-button, .text-handle, dialog')) return;
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
  // Numbers use the text editor, but must not replace the next text box's color.
  if (!annotation.stampPattern) textInsertionColor = style.color;
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
  const preview = annotationFormatPreview;
  annotationFormatPreview = null;
  const original = selectedAnnotation();
  if (original?.tool !== 'image' || preview.id !== original.id || preview.opacity === (original.opacity ?? 1)) return;
  model.update(new Set([model.activeId]), page => replaceAnnotation(page, original, preview));
  refreshThumbnails(); updateControls();
}
function previewImageTransparency() {
  const original = selectedAnnotation();
  if (busy || stroke || annotationDrag || pageDrag || original?.tool !== 'image') return;
  const transparency = Number($('image-transparency').value);
  annotationFormatPreview = { ...original, opacity: (100 - transparency) / 100 };
  $('image-transparency-value').value = `${transparency}%`;
  paintTextPreview();
}
$('image-transparency').addEventListener('input', previewImageTransparency);
$('image-transparency').addEventListener('change', () => {
  previewImageTransparency(); finishAnnotationFormatting();
});
$('image-transparency').addEventListener('blur', finishAnnotationFormatting);
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
$('text-box-shape').addEventListener('change', () => resetTextBackgroundSettings());
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
    if (id === 'text-color' && !(textEdit?.draft || selectedText())?.stampPattern) textInsertionColor = value;
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
    || $('help-dialog').open || $('tool-help-dialog').open || $('save-dialog').open || $('fullscreen-preview').open
    || activePreviewMenu !== 'rotation' || selectedAnnotation()) return false;
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (!step) return false;
  const editable = event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
  if (editable && editable !== $('rotation-scope')) return false;
  event.preventDefault(); event.stopPropagation();
  run(() => rotate(step * 90));
  return true;
}
function deleteSelectedAnnotation() {
  const annotation = selectedAnnotation();
  if (!annotation) return;
  const selection = selectedText() ? selectedTexts() : selectedStrokes();
  const ids = new Set(selection.length ? selection.map(item => item.id) : [annotation.id]);
  model.update(new Set([model.activeId]), p => ({ ...p, strokes: p.strokes.filter(item => !ids.has(item.id)) }));
  resetPreviewMenu();
  if (editorTab) previewMenuOpen = false;
  selectedAnnotationId = null; selectedStrokeIds.clear(); selectedTextIds.clear(); refresh();
  const label = { text: 'テキスト', image: '画像' }[annotation.tool] ?? '描画';
  status(`選択した${label}${ids.size > 1 ? `（${ids.size}件）` : ''}を削除しました。「元に戻す」で復元できます。`);
}
on('delete-text', deleteSelectedAnnotation);
on('delete-stroke', deleteSelectedAnnotation);
on('delete-image', deleteSelectedAnnotation);
on('restore-image-aspect', () => {
  const original = selectedAnnotation();
  if (original?.tool !== 'image') return;
  commitImageResize(model.activeId, original, restoreImageAspectRatio(original), '元の縦横比に戻しました。「元に戻す」で取り消せます。');
});
function commitImageResize(pageId, original, resized, message = '画像のサイズを変更しました。「元に戻す」で取り消せます。') {
  if (resized === original) return;
  model.update(new Set([pageId]), page => replaceAnnotation(page, original, resized));
  paintTextPreview(); refreshAnnotationHandles(); refreshThumbnails(); updateControls();
  status(message, 'success');
}
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
    : annotation.tool === 'image' ? imageLayout(annotation, viewport) : strokeLayout(annotation, viewport);
  const scale = $('ink-canvas').getBoundingClientRect().width / viewport.width;
  const padding = annotation.tool === 'text' ? 0 : Math.max(0, (8 - Math.min(layout.width, layout.height) * scale) / 2);
  Object.assign(button.style, { left: `${layout.x * scale - padding}px`, top: `${layout.y * scale - padding}px`,
    width: `${layout.width * scale + padding * 2}px`, height: `${layout.height * scale + padding * 2}px`, transform: `rotate(${layout.angle}rad)` });
  if (layout.bubble) {
    let tail = button.querySelector('.text-tail-hit-area polygon');
    if (!tail) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('text-tail-hit-area'); svg.setAttribute('aria-hidden', 'true');
      tail = document.createElementNS(svg.namespaceURI, 'polygon');
      svg.append(tail); button.append(svg);
    }
    tail.setAttribute('points', layout.bubble.tail.map(([x, y]) => `${x * scale},${y * scale}`).join(' '));
  }
}
function positionTextTailHandle() {
  const handle = $('text-tail-handle');
  const annotation = !busy && viewport && !textEdit && selectedTexts().length === 1 ? selectedText() : null;
  handle.hidden = annotation?.boxShape !== 'bubble';
  if (handle.hidden) return;
  const current = annotationDrag?.current?.id === annotation.id ? annotationDrag.current : annotationPreview(annotation);
  const canvas = $('ink-canvas');
  const { bubble } = textLayout(canvas.getContext('2d'), current, viewport);
  const scale = canvas.getBoundingClientRect().width / viewport.width;
  const [x, y] = bubble.tip;
  handle.style.left = `${x * scale}px`;
  handle.style.top = `${y * scale}px`;
}
function positionImageResizeHandles(annotation) {
  const { cx, cy, left, right, top, bottom } = imageLayout(annotation, viewport);
  const scale = $('ink-canvas').getBoundingClientRect().width / viewport.width;
  // Leave room for the 24 px hit targets at each end and the midpoint of every edge.
  const width = Math.max(48, (right - left) * scale), height = Math.max(48, (bottom - top) * scale);
  Object.assign($('image-resize-handles').style, { left: `${cx * scale - width / 2}px`, top: `${cy * scale - height / 2}px`,
    width: `${width}px`, height: `${height}px` });
}
function refreshAnnotationHandles() {
  if (!editorTab) {
    for (const handle of $('text-handles').querySelectorAll('.text-handle')) handle.remove();
    return;
  }
  if (!model.active || !viewport) return;
  const handles = new Map([...$('text-handles').querySelectorAll('.text-handle')].map(button => [button.dataset.annotationId, button]));
  const annotations = pageAnnotations();
  const selected = selectedAnnotation();
  const selectedIds = selected ? selectedLayerIds(selected) : new Set();
  for (const [index, annotation] of annotations.entries()) {
    if (!annotation.id || !annotation.points.length) continue;
    if (annotation.id === textEdit?.original?.id) continue;
    const existing = handles.get(annotation.id);
    const button = existing || document.createElement('button');
    handles.delete(annotation.id);
    const isText = annotation.tool === 'text', isImage = annotation.tool === 'image';
    const isSelected = selectedIds.has(annotation.id);
    button.type = 'button'; button.className = `text-handle${isText || isImage ? '' : ' stroke-handle'}${isSelected ? ' selected' : ''}`;
    // Keep hit targets in paint order, behind the active editor and resize handles.
    button.style.zIndex = index - annotations.length;
    button.dataset.annotationId = annotation.id;
    if (isText) button.dataset.textId = annotation.id;
    const textAction = annotation.boxShape === 'bubble' ? '吹き出しを選択・移動' : 'テキストを移動';
    button.setAttribute('aria-label', isText ? `${textAction}: ${annotation.text}` : isImage ? '画像を選択・移動' : '描画を選択・移動');
    button.setAttribute('aria-pressed', String(isSelected));
    button.title = 'クリックまたはF2で内容を編集。Ctrl+B/I/Uで太字・斜体・下線、Ctrl+↑/↓でサイズ変更、Ctrl+←/→で背景の不透明度を変更。ドラッグ・方向キーで移動、Deleteで削除。';
    if (annotation.boxShape === 'bubble') button.title = 'クリックで吹き出しを選択。選択後に本体をクリックするかF2で内容を編集。しっぽはドラッグで移動できます。';
    if (isText) button.title += ' Shift＋クリックで追加選択・解除。複数選択中はダブルクリックで個別編集。';
    if (!isText) button.title = 'クリックで選択。ドラッグで移動。方向キーで1pt、Shift＋方向キーで10pt移動。Deleteで削除。';
    if (isImage) button.title += ' 選択後は辺の中央をドラッグして幅・高さを調整、四隅をドラッグして縦横比を保ったまま拡大・縮小。';
    const isStroke = !isText && !isImage;
    if (isStroke) button.title += ' Shift＋クリックで追加選択・解除。Ctrl＋↑／↓で太さ、Ctrl＋←／→で透明度を相対変更。Ctrl＋Shift＋↑／↓で描画を拡大・縮小。';
    button.setAttribute('aria-keyshortcuts', `${isText ? 'F2 Control+b Control+i Control+u Control+ArrowUp Control+ArrowDown Control+ArrowLeft Control+ArrowRight ' : isStroke ? 'Control+ArrowUp Control+ArrowDown Control+ArrowLeft Control+ArrowRight Control+Shift+ArrowUp Control+Shift+ArrowDown ' : ''}Delete ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown`);
    positionAnnotationHandle(button, annotationPreview(annotation));
    if (existing) continue;
    const currentText = () => pageAnnotations().find(item => item.id === button.dataset.annotationId);
    button.addEventListener('dragstart', event => event.preventDefault());
    button.addEventListener('click', event => {
      const annotation = currentText();
      if (event.detail === 0 && !busy && annotation) {
        const toggle = (isStroke || isText) && (event.shiftKey || event.ctrlKey || event.metaKey);
        if (isText && !toggle && selectedTexts().length <= 1
          && (annotation.boxShape !== 'bubble' || selectedAnnotationId === annotation.id)) startTextEdit(annotation);
        else selectAnnotation(annotation, { toggle, preserve: isText && selectedTextIds.has(annotation.id) });
      }
    });
    button.addEventListener('dblclick', event => {
      if (isText && !busy && !event.shiftKey && !event.ctrlKey && !event.metaKey
        && !event.target?.closest('.text-tail-hit-area') && currentText()) startTextEdit(currentText());
    });
    button.addEventListener('pointerdown', event => {
      if (busy || stroke || annotationDrag || !viewport || event.button !== 0 || !event.isPrimary) return;
      const annotation = currentText();
      if (!annotation) return;
      event.preventDefault();
      if (isText && !editorTab) previewMenuOpen = false;
      const toggle = (isStroke || isText) && (event.shiftKey || event.ctrlKey || event.metaKey);
      const fromTail = !!event.target?.closest('.text-tail-hit-area');
      const selectOnly = annotation.boxShape === 'bubble' && selectedAnnotationId !== annotation.id;
      selectAnnotation(annotation, { toggle, preserve: isText ? !fromTail && selectedTexts().some(item => item.id === annotation.id)
        : isStroke && selectedStrokes().some(item => item.id === annotation.id) });
      button.focus({ preventScroll: true });
      if (toggle) return;
      if (fromTail) { startTextTailDrag(event, annotation, event.target); return; }
      button.setPointerCapture(event.pointerId);
      annotationDrag = { pageId: model.activeId, pointerId: event.pointerId, original: annotation, current: annotation,
        originals: (isText ? selectedTexts() : selectedStrokes()).length > 1 ? (isText ? selectedTexts() : selectedStrokes()) : null,
        start: canvasPoint(event), button, selectOnly };
    });
    button.addEventListener('pointermove', updateAnnotationDrag);
    button.addEventListener('pointerup', finishAnnotationDrag);
    button.addEventListener('pointercancel', cancelAnnotationDrag);
    button.addEventListener('lostpointercapture', cancelAnnotationDrag);
    $('text-handles').append(button);
  }
  for (const button of handles.values()) button.remove();
  positionTextTailHandle();
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
  const dx = point[0] - annotationDrag.start[0], dy = point[1] - annotationDrag.start[1];
  const scale = $('ink-canvas').getBoundingClientRect().width / viewport.width;
  if (!annotationDrag.moved && Math.hypot(dx, dy) * scale < 4) return;
  annotationDrag.moved = true;
  if (annotationDrag.tailTip) {
    const [x, y] = annotationDrag.tailTip;
    const ctx = $('ink-canvas').getContext('2d');
    annotationDrag.current = Math.hypot(dx, dy) < 0.01 * viewport.scale ? annotationDrag.original
      : moveTextTail(ctx, annotationDrag.current, viewport, x + dx, y + dy);
    paintTextPreview(); positionTextTailHandle(); return;
  }
  if (annotationDrag.originals) {
    annotationDrag.currents = moveStrokesTogether(annotationDrag.originals, dx, dy);
    annotationDrag.current = annotationDrag.currents.find(item => item.id === annotationDrag.original.id);
    refreshAnnotationHandles();
    paintOverlay($('ink-canvas').getContext('2d'), replaceStrokes(model.active, annotationDrag.currents), viewport); return;
  }
  const { original, resizeDirection, imageButton, button } = annotationDrag;
  annotationDrag.current = resizeDirection ? resizeImageFromHandle(original, viewport, resizeDirection, dx, dy) : moveAnnotation(original, dx, dy);
  positionAnnotationHandle(imageButton ?? button, annotationDrag.current);
  if (original.tool === 'image') positionImageResizeHandles(annotationDrag.current);
  positionTextTailHandle();
  paintOverlay($('ink-canvas').getContext('2d'), replaceAnnotation(model.active, annotationDrag.original, annotationDrag.current), viewport);
}
function finishAnnotationDrag(event) {
  if (!annotationDrag || event.pointerId !== annotationDrag.pointerId) return;
  updateAnnotationDrag(event);
  const { pageId, original, current, currents, button, pointerId, moved, tailTip, selectOnly, resizeDirection } = annotationDrag; annotationDrag = null;
  if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
  if (tailTip) { commitTextTail(pageId, original, current); return; }
  if (resizeDirection) { commitImageResize(pageId, original, current); return; }
  const [x, y] = original.points[0]; const [nextX, nextY] = current.points[0];
  if (Math.hypot(nextX - x, nextY - y) > 0.01) {
    model.update(new Set([pageId]), p => currents ? replaceStrokes(p, currents) : replaceAnnotation(p, original, current));
    const label = { text: 'テキスト', image: '画像' }[original.tool] ?? '描画';
    refreshThumbnails(); status(`${label}を移動しました。「元に戻す」で取り消せます。`, 'success');
    refreshAnnotationHandles();
  }
  // Preserve the DOM target for the browser's second click/dblclick event.
  positionAnnotationHandle(button, current); updateControls();
  // A stationary click can enter text editing after the selection is set.
  if (!moved && !selectOnly && original.tool === 'text' && selectedTexts().length === 1) startTextEdit(current);
}
function cancelAnnotationDrag(event) {
  if (!annotationDrag || (event && event.pointerId !== annotationDrag.pointerId)) return;
  const { button, pointerId } = annotationDrag; annotationDrag = null;
  if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
  if (viewport && model.active) paintOverlay($('ink-canvas').getContext('2d'), model.active, viewport);
  refreshAnnotationHandles(); updateControls();
}
function commitTextTail(pageId, original, current) {
  if (original === current) return;
  model.update(new Set([pageId]), page => replaceAnnotation(page, original, current));
  paintTextPreview(); refreshAnnotationHandles(); refreshThumbnails(); updateControls();
  status('吹き出しのしっぽを移動しました。', 'success');
}
function startTextTailDrag(event, original, button) {
  const { bubble } = textLayout($('ink-canvas').getContext('2d'), original, viewport);
  button.setPointerCapture(event.pointerId);
  annotationDrag = { pageId: model.activeId, pointerId: event.pointerId, original, current: original,
    tailTip: bubble.tip, start: canvasPoint(event), button };
}
const textTailHandle = $('text-tail-handle');
textTailHandle.addEventListener('pointerdown', event => {
  if (textTailHandle.hidden || busy || stroke || annotationDrag || pageDrag || !viewport || event.button !== 0 || !event.isPrimary) return;
  event.preventDefault(); textTailHandle.focus({ preventScroll: true });
  startTextTailDrag(event, selectedText(), textTailHandle);
});
textTailHandle.addEventListener('pointermove', updateAnnotationDrag);
textTailHandle.addEventListener('pointerup', finishAnnotationDrag);
textTailHandle.addEventListener('pointercancel', cancelAnnotationDrag);
textTailHandle.addEventListener('lostpointercapture', cancelAnnotationDrag);
const imageResizeHandles = $('image-resize-handles');
imageResizeHandles.addEventListener('pointerdown', event => {
  if (imageResizeHandles.hidden || busy || stroke || annotationDrag || pageDrag || !viewport || event.button !== 0 || !event.isPrimary) return;
  const button = event.target;
  const { resizeX, resizeY } = button.dataset;
  if (resizeX === undefined || resizeY === undefined) return;
  const original = selectedAnnotation();
  const imageButton = $('text-handles').querySelector('.text-handle.selected');
  if (original?.tool !== 'image' || !imageButton) return;
  event.preventDefault(); imageButton.focus({ preventScroll: true });
  button.setPointerCapture(event.pointerId);
  annotationDrag = { pageId: model.activeId, pointerId: event.pointerId, original, current: original,
    resizeDirection: [Number(resizeX), Number(resizeY)], start: canvasPoint(event), button, imageButton };
});
imageResizeHandles.addEventListener('pointermove', updateAnnotationDrag);
imageResizeHandles.addEventListener('pointerup', finishAnnotationDrag);
imageResizeHandles.addEventListener('pointercancel', cancelAnnotationDrag);
imageResizeHandles.addEventListener('lostpointercapture', cancelAnnotationDrag);
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
  if (!editorTab) return;
  if (event.button !== 0 || !event.isPrimary) return;
  if (activePreviewMenu === 'stamp') {
    if (busy || !viewport || !model.active || renderedPageId !== model.activeId || stroke || annotationDrag || pageDrag) return;
    event.preventDefault();
    try { placeNumberStamp(event); } catch (error) { fail(error); }
    return;
  }
  if (!textEnabled && !penEnabled) {
    enableSelection();
    return;
  }
  if (textEnabled && !busy && viewport && model.active && event.button === 0 && event.isPrimary && !annotationDrag) {
    event.preventDefault();
    try {
      const annotation = { id: uid(), tool: 'text', text: '', ...textSettings(), rotation: model.active.rotation,
        points: [pdfPoint(event)] };
      startTextEdit(annotation.boxShape === 'bubble' ? fitText(annotation) : annotation, true);
    } catch (error) { fail(error); }
    return;
  }
  if (!penEnabled || busy || !viewport || !model.active || event.button !== 0 || stroke || annotationDrag) return;
  selectedAnnotationId = null; refreshAnnotationHandles(); updateControls();
  event.preventDefault(); $('ink-canvas').setPointerCapture(event.pointerId);
  stroke = { id: uid(), tool: $('pen-tool').value, color: $('pen-color').value, width: Number($('pen-width').value),
    opacity: 1 - Number($('pen-transparency').value) / 100, points: [pdfPoint(event)], pointerId: event.pointerId,
    startX: event.clientX, startY: event.clientY, moved: false };
});
function updateStroke(event) {
  if (!stroke.moved && Math.hypot(event.clientX - stroke.startX, event.clientY - stroke.startY) < 4) return;
  stroke.moved = true;
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
  const { pointerId, startX, startY, moved, ...saved } = stroke; stroke = null;
  if (!moved) {
    if (event.type === 'pointerup') enableSelection();
    return;
  }
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
  if ($('fullscreen-preview').open || $('add-source-dialog').open) return;
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
    if (enableSelection()) $('preview-scroll').focus({ preventScroll: true });
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
    if (event.target === $('text-tail-handle') && !$('text-tail-handle').hidden && viewport) {
      const original = selectedText(), ctx = $('ink-canvas').getContext('2d');
      const [x, y] = textLayout(ctx, original, viewport).bubble.tip;
      const distance = step * viewport.scale;
      commitTextTail(model.activeId, original, moveTextTail(ctx, original, viewport, x + direction[0] * distance, y + direction[1] * distance));
      return;
    }
    moveSelectedAnnotation(direction[0] * step, direction[1] * step); return;
  }
  if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && model.active && !stroke && !annotationDrag && !pageDrag) {
    event.preventDefault(); navigatePage(event.key === 'ArrowLeft' ? -1 : 1); return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); openSaveDialog(); }
});
let resizeTimer;
let previewSize = '';
new ResizeObserver(entries => {
  const { width, height } = entries[0].contentRect;
  const size = editorTab ? `${width}:${height}` : String(width);
  if (size === previewSize) return;
  previewSize = size;
  clearTimeout(resizeTimer); resizeTimer = setTimeout(() => renderPreview(), 120);
}).observe($('preview-area'));
refresh();
if (editorTab && /^#[\da-f-]{36}$/.test(editorUrl.hash)) {
  const id = editorUrl.hash.slice(1);
  editorUrl.hash = '';
  window.history.replaceState(null, '', editorUrl);
  run(() => restoreEditorSession(id));
} else if (!editorTab && globalThis.chrome?.windows?.getCurrent && globalThis.chrome?.tabs?.getCurrent) run(reconnectSidePanel);
purgeLegacyPrintJobs().catch(fail);
