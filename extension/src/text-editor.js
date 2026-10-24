import { styledRuns, textStyle, withTextRuns, replaceText } from './text-format.js';
import { textFontFamily } from './pdf.js';

export function createTextEditor(annotation) {
  const editor = document.createElement('div');
  editor.contentEditable = 'true'; editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true'); editor.dataset.placeholder = 'テキスト';
  let current = annotation, saved = { start: annotation.text.length, end: annotation.text.length };
  let rendering = false;
  const selection = () => window.getSelection();
  function capture() {
    const selected = selection();
    if (!selected?.rangeCount || !editor.contains(selected.anchorNode) || !editor.contains(selected.focusNode)) return saved;
    const range = selected.getRangeAt(0), prefix = range.cloneRange();
    prefix.selectNodeContents(editor); prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    saved = { start, end: start + range.toString().length };
    return saved;
  }
  function restore(start, end) {
    saved = { start, end };
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const nodes = []; let node;
    while ((node = walker.nextNode())) nodes.push(node);
    const point = offset => {
      for (const item of nodes) {
        if (offset <= item.length) return [item, offset];
        offset -= item.length;
      }
      return [editor, editor.childNodes.length];
    };
    const range = document.createRange(); range.setStart(...point(start)); range.setEnd(...point(end));
    const selected = selection(); selected.removeAllRanges(); selected.addRange(range);
  }
  function read() {
    let text = ''; const segments = [];
    const append = (value, style) => {
      const start = text.length; text += value;
      segments.push({ start, end: text.length, style });
    };
    function walk(node, style) {
      if (node.nodeType === Node.TEXT_NODE) { append(node.data, style); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const nextStyle = node.dataset?.textStyle ? JSON.parse(node.dataset.textStyle) : style;
      if (node.tagName === 'BR') { append('\n', nextStyle); return; }
      if (['DIV', 'P'].includes(node.tagName) && text && !text.endsWith('\n')) append('\n', nextStyle);
      for (const child of node.childNodes) walk(child, nextStyle);
    }
    for (const child of editor.childNodes) walk(child, textStyle(current));
    current = withTextRuns({ ...current, text }, segments);
    for (const line of editor.querySelectorAll('[data-text-line]')) {
      const spans = [...line.querySelectorAll('[data-text-style]')].filter(span => span.textContent);
      const size = spans.length ? Math.max(...spans.map(span => JSON.parse(span.dataset.textStyle).fontSize)) : current.fontSize;
      line.style.lineHeight = `${size * 1.3 / current.fontSize}em`;
      line.style.height = `${size * 1.3 / current.fontSize}em`;
    }
    return current;
  }
  function render(value) {
    rendering = true; current = value;
    if (!value.text) { editor.replaceChildren(); rendering = false; return; }
    const fragment = document.createDocumentFragment();
    const lines = [[]];
    for (const run of styledRuns(value)) run.text.split('\n').forEach((text, index) => {
      if (index) lines.push([]);
      if (text) lines.at(-1).push({ text, style: run.style });
    });
    lines.forEach((runs, index) => {
      const line = document.createElement('span'); line.dataset.textLine = 'true';
      const size = runs.length ? Math.max(...runs.map(run => run.style.fontSize)) : value.fontSize;
      Object.assign(line.style, { display: 'inline-block', width: '100%', verticalAlign: 'bottom',
        textAlign: runs[0]?.style.textAlign || value.textAlign || 'left', lineHeight: `${size * 1.3 / value.fontSize}em`, height: `${size * 1.3 / value.fontSize}em` });
      for (const run of runs) {
        const span = document.createElement('span'); span.textContent = run.text;
        span.dataset.textStyle = JSON.stringify(run.style);
        Object.assign(span.style, { fontSize: `${run.style.fontSize / value.fontSize}em`, fontFamily: textFontFamily(run.style.fontFamily),
          fontWeight: run.style.bold ? '700' : '400', fontStyle: run.style.italic ? 'italic' : 'normal',
          textDecoration: run.style.underline ? 'underline' : 'none', color: run.style.color });
        // Relative sizes follow preview zoom without changing the stored PDF points.
        line.append(span);
      }
      fragment.append(line);
      if (index < lines.length - 1) fragment.append(document.createTextNode('\n'));
    });
    editor.replaceChildren(fragment); rendering = false;
  }
  editor.getAnnotation = read;
  editor.setAnnotation = value => { const range = capture(); render(value); restore(range.start, range.end); };
  editor.setSelectionRange = restore;
  editor.setCustomValidity = message => { editor.setAttribute('aria-invalid', String(!!message)); editor.dataset.error = message; };
  Object.defineProperties(editor, {
    value: { get: () => read().text, set: value => render(replaceText(current, value)) },
    selectionStart: { get: () => capture().start }, selectionEnd: { get: () => capture().end },
  });
  function insert(text) {
    const value = read(), range = capture();
    const available = 500 - value.text.length + range.end - range.start;
    text = text.slice(0, Math.max(0, available));
    const inherited = styledRuns(value).find(run => run.start <= range.start && run.end > range.start)?.style || textStyle(value);
    const selected = selection();
    if (!selected?.rangeCount) return;
    const domRange = selected.getRangeAt(0); domRange.deleteContents();
    const span = document.createElement('span'); span.dataset.textStyle = JSON.stringify(inherited);
    span.textContent = text; domRange.insertNode(span); domRange.setStartAfter(span); domRange.collapse(true);
    selected.removeAllRanges(); selected.addRange(domRange);
    current = read(); render(current); restore(range.start + text.length, range.start + text.length);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }
  editor.addEventListener('beforeinput', event => {
    if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
      event.preventDefault(); insert('\n');
    } else if (!event.isComposing && event.data && editor.value.length - (editor.selectionEnd - editor.selectionStart) + event.data.length > 500) {
      event.preventDefault(); insert(event.data);
    }
  });
  editor.addEventListener('paste', event => { event.preventDefault(); insert(event.clipboardData.getData('text/plain').replaceAll('\r\n', '\n')); });
  editor.addEventListener('drop', event => event.preventDefault());
  function changed() {
    if (rendering) return;
    const selected = selection();
    if (selected?.rangeCount && editor.contains(selected.anchorNode) && editor.contains(selected.focusNode)) {
      capture(); editor.onTextSelectionChange?.();
    }
  }
  document.addEventListener('selectionchange', changed);
  const remove = editor.remove.bind(editor);
  editor.remove = () => { document.removeEventListener('selectionchange', changed); remove(); };
  render(annotation);
  return editor;
}
