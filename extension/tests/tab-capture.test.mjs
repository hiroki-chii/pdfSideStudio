import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const captureCode = app.slice(app.indexOf('const capturedTabFilename'), app.indexOf('function rotate('));
const captureControls = app.slice(app.indexOf('const canCaptureCurrentTab'),
  app.indexOf("$('file-input').addEventListener"));

function setup(editorTab = false, canCapture = true) {
  const nodes = new Map(), actions = new Map(), events = [], files = [];
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, {
      id, open: false,
      setAttribute(name, value) { this[name] = value; },
      addEventListener(type, action) { actions.set(id, action); },
      showModal() { this.open = true; },
      close() { this.open = false; },
    });
    return nodes.get(id);
  };
  $('file-input').click = () => events.push(['browse files', $('add-source-dialog').open]);
  const state = {
    desktopAccess: true, streamId: 'selected-tab',
    grabFrame: async () => ({ width: 320, height: 480, close: () => events.push(['close frame']) }),
    currentTab: { id: 1, windowId: 8, url: 'https://example.test/' },
    siteAccess: false, visibleImage: 'data:image/png;base64,iVBORw0KGgo=',
    captureVisible: async () => state.visibleImage,
  };
  const chrome = {
    permissions: {
      request: async ({ permissions, origins }) => {
        assert.equal($('add-source-dialog').open, false);
        if (origins) {
          events.push(['request sites', ...origins]);
          return state.siteAccess;
        }
        events.push(['request', ...permissions]);
        return state.desktopAccess;
      },
    },
    tabs: {
      query: async ({ active, currentWindow, windowId }) => {
        assert.ok(active && (currentWindow || windowId === 8));
        return [state.currentTab];
      },
      captureVisibleTab: canCapture ? async (windowId, { format }) => {
        assert.equal($('add-source-dialog').open, false);
        events.push(['capture current', windowId, format]);
        return state.captureVisible();
      } : undefined,
      getCurrent: async () => ({ id: 5, windowId: 8 }),
      update: async (id, { active }) => {
        events.push(['activate', id, active]);
        return { windowId: 8 };
      },
    },
    windows: { update: async (id, { focused }) => events.push(['focus', id, focused]) },
    runtime: {},
    desktopCapture: {
      chooseDesktopMedia(sources, targetTab, options, callback) {
        events.push(['choose', ...sources, targetTab, options.selfBrowserSurface]);
        callback(state.streamId);
      },
    },
  };
  const track = { stop: () => events.push(['stop track']) };
  const navigator = { mediaDevices: { getUserMedia: async ({ audio, video }) => {
    const { chromeMediaSource, chromeMediaSourceId, minFrameRate } = video.mandatory;
    events.push(['get media', audio, chromeMediaSource, chromeMediaSourceId, minFrameRate]);
    return { getVideoTracks: () => [track] };
  } } };
  const canvas = {
    getContext: () => ({ drawImage: () => events.push(['draw frame', canvas.width, canvas.height]) }),
    toBlob(callback, type) { events.push(['encode', type]); callback(new Blob(['png'], { type })); },
  };
  vm.runInNewContext(captureCode + captureControls, {
    chrome, $, File, atob, console, editorTab, navigator, setTimeout: callback => callback(),
    ImageCapture: canCapture ? class {
      constructor(track) { this.track = track; }
      grabFrame() { return state.grabFrame(); }
    } : undefined,
    document: { createElement: () => canvas },
    run: action => action(), status() {},
    addFiles: async added => files.push(...added),
  });
  return { $, state, events, files, captureSelected: actions.get('capture-selected-tab'),
    captureCurrent: actions.get('capture-current-tab'), openAdd: actions.get('add-files'), browseFiles: actions.get('browse-files') };
}

test('add opens the file picker directly when tab capture is unavailable', () => {
  const { openAdd, browseFiles, events } = setup(false, false);
  assert.equal(browseFiles, undefined);
  openAdd();
  assert.deepEqual(events, [['browse files', false]]);
});

for (const [view, editorTab, originalTabId] of [['side panel', false, 1], ['editor tab', true, 5]]) {
  test(`${view} add opens a choice, and browsing closes it before opening the file picker`, () => {
    const { $, openAdd, browseFiles, events } = setup(editorTab);
    assert.equal($('add-files')['aria-haspopup'], 'dialog');
    assert.equal($('capture-current-tab').hidden, editorTab);
    openAdd();
    assert.equal($('add-source-dialog').open, true);
    assert.deepEqual(events, []);
    browseFiles();
    assert.deepEqual(events, [['browse files', false]]);
  });

  test(`${view} captures the chosen tab as one PNG and restores the original tab`, async () => {
    const { captureSelected, openAdd, events, files } = setup(editorTab);
    openAdd();
    await captureSelected();
    assert.deepEqual(events, [
      ['request', 'desktopCapture'], ['choose', 'tab', null, 'exclude'], ['get media', false, 'desktop', 'selected-tab', 5],
      ['draw frame', 320, 480], ['close frame'], ['stop track'], ['activate', originalTabId, true], ['focus', 8, true], ['encode', 'image/png'],
    ]);
    assert.equal(files.length, 1);
    assert.equal(files[0].type, 'image/png');
    assert.equal(files[0].name, 'タブのキャプチャ.png');
  });
}

test('tab editor skips import after declining permission or cancelling the picker', async () => {
  const { state, captureSelected, events, files } = setup(true);
  state.desktopAccess = false;
  await captureSelected();
  assert.deepEqual(events, [['request', 'desktopCapture']]);
  state.desktopAccess = true;
  state.streamId = '';
  await captureSelected();
  assert.deepEqual(events.slice(1), [['request', 'desktopCapture'], ['choose', 'tab', null, 'exclude']]);
  assert.equal(files.length, 0);
});

test('tab editor stops the stream if the selected tab cannot provide a frame', async () => {
  const { state, captureSelected, events, files } = setup(true);
  state.grabFrame = async () => { throw new Error('Stream ended'); };
  await assert.rejects(captureSelected(), /選んだタブの表示範囲を取り込めませんでした/);
  assert.deepEqual(events.slice(-3), [['stop track'], ['activate', 5, true], ['focus', 8, true]]);
  assert.equal(files.length, 0);
});

test('side panel captures the active tab in its own window with temporary access', async () => {
  const { captureCurrent, openAdd, events, files } = setup();
  openAdd();
  await captureCurrent();
  assert.deepEqual(events, [['capture current', 8, 'png']]);
  assert.equal(files.length, 1);
  assert.equal(files[0].type, 'image/png');
  assert.equal(files[0].name, 'タブのキャプチャ.png');
});

test('direct capture asks for optional access only after a permission error and retries after approval', async () => {
  const { captureCurrent, state, events, files } = setup();
  state.captureVisible = async () => {
    if (!state.siteAccess) throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
    return state.visibleImage;
  };
  await captureCurrent();
  assert.deepEqual(events, [['capture current', 8, 'png'], ['request sites', '<all_urls>']]);
  assert.equal(files.length, 0);

  state.siteAccess = true;
  state.captureVisible = async () => {
    state.captureVisible = async () => state.visibleImage;
    throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
  };
  await captureCurrent();
  assert.deepEqual(events.slice(2), [['capture current', 8, 'png'], ['request sites', '<all_urls>'], ['capture current', 8, 'png']]);
  assert.equal(files.length, 1);
});

test('direct capture discards the image if the active page changes', async () => {
  const { captureCurrent, state, events, files } = setup();
  state.captureVisible = async () => {
    state.currentTab = { ...state.currentTab, url: 'https://other.example.test/' };
    return state.visibleImage;
  };
  await assert.rejects(captureCurrent(), /表示中のタブが変わりました/);
  assert.deepEqual(events, [['capture current', 8, 'png']]);
  assert.equal(files.length, 0);
});

test('direct capture retries one transient compositor failure without requesting site access', async () => {
  const { captureCurrent, state, events, files } = setup();
  state.captureVisible = async () => {
    state.captureVisible = async () => state.visibleImage;
    throw new Error('Failed to capture tab: image readback failed');
  };
  await captureCurrent();
  assert.deepEqual(events, [['capture current', 8, 'png'], ['capture current', 8, 'png']]);
  assert.equal(files.length, 1);
});
