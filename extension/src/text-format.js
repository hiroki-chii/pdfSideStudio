// Offsets use UTF-16, matching DOM selections and JavaScript strings.
const defaults = { fontSize: 24, color: '#222222', fontFamily: 'sans-serif',
  bold: false, italic: false, underline: false, textAlign: 'left' };
export function textStyle(value = {}) {
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, value[key] ?? fallback]));
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function styledRuns(annotation) {
  const { text } = annotation, base = textStyle(annotation);
  const runs = annotation.runs || [];
  const boundaries = [...new Set([0, text.length, ...runs.flatMap(run => [run.start, run.end])])]
    .filter(index => index >= 0 && index <= text.length).sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    const style = { ...base };
    for (const run of runs) if (run.start <= start && run.end >= end) Object.assign(style, run.style);
    return { start, end, text: text.slice(start, end), style };
  });
}

export function withTextRuns(annotation, segments) {
  const base = textStyle(annotation), runs = [];
  for (const segment of segments) {
    if (segment.end <= segment.start) continue;
    const style = Object.fromEntries(Object.keys(defaults).filter(key => segment.style[key] !== base[key])
      .map(key => [key, segment.style[key]]));
    if (!Object.keys(style).length) continue;
    const last = runs.at(-1);
    if (last?.end === segment.start && equal(last.style, style)) last.end = segment.end;
    else runs.push({ start: segment.start, end: segment.end, style });
  }
  const result = { ...annotation };
  if (runs.length) result.runs = runs; else delete result.runs;
  return result;
}

export function formatText(annotation, start, end, patch, wholeBox = false) {
  start = Math.max(0, Math.min(annotation.text.length, start));
  end = Math.max(start, Math.min(annotation.text.length, end));
  if (!wholeBox && start === end) return annotation;
  // Alignment is a paragraph property: affect the selected lines.
  if (typeof patch !== 'function' && 'textAlign' in patch && !wholeBox) {
    start = start === 0 ? 0 : annotation.text.lastIndexOf('\n', start - 1) + 1;
    const next = annotation.text.indexOf('\n', Math.max(start, end - 1));
    end = next < 0 ? annotation.text.length : next + 1;
  }
  const transform = style => textStyle({ ...style, ...(typeof patch === 'function' ? patch(style) : patch) });
  const base = { ...annotation };
  if (wholeBox) for (const [key, value] of Object.entries(transform(textStyle(annotation)))) {
    if (!['fontSize', 'color'].includes(key) && value === defaults[key]) delete base[key];
    else base[key] = value;
  }
  const segments = [];
  for (const run of styledRuns(annotation)) {
    const cuts = [...new Set([run.start, run.end, Math.max(run.start, start), Math.min(run.end, end)])]
      .filter(index => index >= run.start && index <= run.end).sort((a, b) => a - b);
    for (let index = 0; index < cuts.length - 1; index++) {
      const from = cuts[index], to = cuts[index + 1];
      segments.push({ start: from, end: to, style: from >= start && to <= end ? transform(run.style) : run.style });
    }
  }
  return withTextRuns(base, segments);
}

// Preserve styles on either side of a plain-text edit; inserted text inherits at the caret.
export function replaceText(annotation, text) {
  if (annotation.text === text) return annotation;
  let start = 0, suffix = 0;
  while (start < annotation.text.length && start < text.length && annotation.text[start] === text[start]) start++;
  while (suffix < annotation.text.length - start && suffix < text.length - start
    && annotation.text.at(-suffix - 1) === text.at(-suffix - 1)) suffix++;
  const oldEnd = annotation.text.length - suffix, newEnd = text.length - suffix;
  const runs = styledRuns(annotation), segments = [];
  const inherited = runs.find(run => run.start <= Math.max(0, start - 1) && run.end > Math.max(0, start - 1))?.style || textStyle(annotation);
  for (const run of runs) {
    if (run.start < start) segments.push({ start: run.start, end: Math.min(start, run.end), style: run.style });
  }
  if (newEnd > start) segments.push({ start, end: newEnd, style: inherited });
  for (const run of runs) {
    if (run.end > oldEnd) segments.push({ start: Math.max(oldEnd, run.start) + newEnd - oldEnd,
      end: run.end + newEnd - oldEnd, style: run.style });
  }
  return withTextRuns({ ...annotation, text }, segments);
}
