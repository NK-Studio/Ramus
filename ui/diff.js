// 가운데 칸의 diff 보기. 원본 Elements/GitDiffPanel.cs 를 옮겼다. 변경 목록·커밋 파일을 누르면 그래프 대신 열린다. Esc·✕ 로 그래프로 돌아간다.
//
// 막대: [이 파일 편집] · [파일 보기 | Diff 보기] · [Blame | 히스토리] · [↑ | ↓] · [Hunk | Inline | Split] · [공백] [줄바꿈].
// Hunk 는 바뀐 곳과 문맥 n줄(설정), Inline·Split 은 파일 전체. 줄은 보이는 것만 그린다(가상화) — 10만 줄도 바로 열린다.
// 줄 고르기: 거터·줄 번호를 끌어 범위, Shift+클릭 늘리기, ⌘/Ctrl 하나씩. 고른 줄은 Rust 의 DiffDocument.lines 인덱스 그대로이고,
// diff 지문(fingerprint)과 함께 보낸다 — 그 사이 파일이 바뀌면 Rust 가 거절한다.

import { el, isComposing } from './util.js';
import { icon } from './icons.js';
import { showMenu } from './dialogs.js';
import { fileIcon, STATE_LABEL } from './files.js';

const ROW = 20;
const OVERSCAN = 30;
const FULL_CONTEXT = 1000000;
const WRAP_LIMIT = 20000;

const isChange = (line) => line?.kind === 'added' || line?.kind === 'removed';

/** 원본 Icons/Diff*.png 를 테마 글자색으로 물들인 아이콘 버튼. */
function pngButton(name, tip, onClick, on = false, extraClass = '') {
  return el('button', { class: `dbar-btn${on ? ' on' : ''} ${extraClass}`, 'data-tip': tip, onclick: onClick }, el('span', { class: 'png-icon', style: { '--png': `url(icons/${name}.png)` } }));
}

function segment(buttons) {
  return el('div', { class: 'dbar-seg' }, buttons);
}

function formatSize(bytes) {
  if (bytes == null) return '없음';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return u ? `${n.toFixed(n < 10 ? 1 : 0)} ${units[u]} (${bytes.toLocaleString('ko-KR')} B)` : `${bytes} B`;
}

/** 글자 단위(코드 포인트)로 [start, start+len) 을 강조한다. 공백 보이기면 공백·탭을 · → 로. */
function lineText(text, start, len, showWs) {
  const chars = Array.from(text);
  const render = (part) => {
    if (!showWs) return part;
    return part.replace(/ /g, '·').replace(/\t/g, '→\t');
  };
  const wrap = (part, cls) => (cls ? el('span', { class: cls, text: render(part) }) : render(part));
  if (!len) return [wrap(text, showWs && /[ \t]/.test(text) ? 'ws' : '')];
  return [wrap(chars.slice(0, start).join('')), el('span', { class: 'chg', text: render(chars.slice(start, start + len).join('')) }), wrap(chars.slice(start + len).join(''))];
}

/**
 * diff 보기를 만든다. `api` 는 app.js 가 주는 함수들:
 * load(target, options), applyLines(action, target, fingerprint, lines, context), stageFile, unstageFile, discardFile, close, prefs,
 * edit(target), blame(target), history(target), openEditor(target, line), lfsPull(target), imageDiff(target, container) → bool
 */
export function createDiffView(container) {
  let state = null;
  let body = null;
  let sizer = null;
  let rowsHost = null;
  let rows = []; // 그릴 줄: {type:'hunk', hunk, index} | {type:'line', index} | {type:'split', left, right} | {type:'meta', index}
  let changeBlocks = []; // 바뀐 덩어리의 첫 행 번호
  let lineToRow = new Map(); // 문서 줄 → 행
  let hunkRows = new Map(); // hunk → [첫 행, 끝 행]
  let hoverHunk = -1;
  let dragging = null;
  let slowTimer = 0;

  const prefs = () => state.api.prefs;
  const viewMode = () => state.view;
  const contextFor = () => (state.view === 'hunk' && !state.fileView ? (prefs().get('diff.context') ?? 3) : FULL_CONTEXT);
  const canPick = () => (state.mode === 'unstaged' || state.mode === 'staged') && !state.ignoreWs;

  function open(options) {
    const p = options.api.prefs;
    state = {
      ...options,
      doc: null,
      selected: new Set(),
      anchor: null,
      error: null,
      view: p.get('diff.view') ?? (options.layout === 'split' ? 'split' : 'hunk'),
      fileView: false,
      showWs: !!p.get('diff.whitespace'),
      wrap: !!p.get('diff.wrap'),
      ignoreWs: !!p.get('diff.ignoreWhitespace'),
      loading: true,
    };
    // 이미지 diff 에서 [글로 보기] 를 누르면 텍스트 diff 로.
    state.showText = () => {
      state.forceText = true;
      state.image = false;
      state.doc = null;
      render();
      reload();
    };
    render();
    reload();
  }

  async function reload() {
    if (!state) return;
    const current = state;
    clearTimeout(slowTimer);
    // 늦을 때만(200ms 넘으면) 내용 위에 "불러오는 중" 을 겹친다 — 본문을 갈아 끼워 깜빡이지 않게.
    slowTimer = setTimeout(() => container.querySelector('.diff-loading')?.removeAttribute('hidden'), 200);
    try {
      if (state.api.imageDiff && /\.(png|jpe?g|gif|bmp|webp|tga|psd)$/i.test(state.target.path) && !state.forceText) {
        const handled = await state.api.imageDiff(state.target, container, state);
        if (handled && state === current) {
          clearTimeout(slowTimer);
          current.image = true;
          return;
        }
      }
      const doc = await current.api.load(current.target, { context: contextFor(), ignoreWhitespace: current.ignoreWs });
      if (state !== current) return;
      clearTimeout(slowTimer);
      // 같은 diff 면 다시 그리지 않는다(고른 줄·스크롤·누르던 버튼이 그대로 남게).
      if (current.doc && !current.error && current.doc.fingerprint === doc.fingerprint && current.doc.lines.length === doc.lines.length) {
        container.querySelector('.diff-loading')?.setAttribute('hidden', '');
        return;
      }
      current.selected = new Set();
      current.doc = doc;
      current.error = null;
    } catch (error) {
      if (state !== current) return;
      clearTimeout(slowTimer);
      current.error = error?.message ?? String(error);
    }
    current.loading = false;
    render();
  }

  function close() {
    clearTimeout(slowTimer);
    state = null;
    container.replaceChildren();
  }

  // ── 행 만들기 ──

  function buildRows() {
    const lines = state.doc.lines;
    rows = [];
    changeBlocks = [];
    lineToRow = new Map();
    hunkRows = new Map();
    const pushRow = (row, indexes) => {
      for (const i of indexes) if (i != null) lineToRow.set(i, rows.length);
      if (row.hunk != null) {
        const range = hunkRows.get(row.hunk) ?? [rows.length, rows.length];
        range[1] = rows.length;
        hunkRows.set(row.hunk, range);
      }
      rows.push(row);
    };
    let prevChange = false;
    const markBlock = (changed) => {
      if (changed && !prevChange) changeBlocks.push(rows.length);
      prevChange = changed;
    };
    if (state.fileView) {
      // 파일 보기: 바뀐 뒤 파일 전체(더한 줄 초록). 지운 파일은 옛 판 전체.
      const deletedFile = lines.every((l) => l.kind !== 'added' && l.kind !== 'context');
      lines.forEach((line, i) => {
        if (line.kind === 'hunk' || line.kind === 'noNewline') return;
        if (!deletedFile && line.kind === 'removed') return;
        markBlock(line.kind === 'added');
        pushRow({ type: 'line', index: i, hunk: line.hunk }, [i]);
      });
      return;
    }
    if (state.view === 'split') {
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.kind === 'hunk') {
          markBlock(false);
          if (state.view === 'hunk' || contextFor() !== FULL_CONTEXT) pushRow({ type: 'hunk', index: i, hunk: line.hunk }, [i]);
          else hunkRows.set(line.hunk, [rows.length, rows.length]);
          i++;
          continue;
        }
        if (line.kind === 'context' || line.kind === 'noNewline') {
          markBlock(false);
          pushRow({ type: 'split', left: i, right: i, hunk: line.hunk }, [i]);
          i++;
          continue;
        }
        const removed = [];
        while (i < lines.length && lines[i].kind === 'removed') removed.push(i++);
        const added = [];
        while (i < lines.length && lines[i].kind === 'added') added.push(i++);
        for (let k = 0; k < Math.max(removed.length, added.length); k++) {
          markBlock(true);
          pushRow({ type: 'split', left: removed[k] ?? null, right: added[k] ?? null, hunk: lines[removed[k] ?? added[k]].hunk }, [removed[k], added[k]]);
        }
      }
      return;
    }
    lines.forEach((line, i) => {
      if (line.kind === 'hunk') {
        markBlock(false);
        // Inline(파일 전체)은 hunk 머리를 보이지 않는다(덩어리가 하나뿐이다).
        if (contextFor() !== FULL_CONTEXT) pushRow({ type: 'hunk', index: i, hunk: line.hunk }, [i]);
        else hunkRows.set(line.hunk, [rows.length, rows.length]);
        return;
      }
      markBlock(isChange(line));
      pushRow({ type: line.kind === 'noNewline' ? 'meta' : 'line', index: i, hunk: line.hunk }, [i]);
    });
  }

  // ── 그리기 ──

  function numberWidth() {
    const lines = state.doc.lines;
    let max = 1;
    for (const l of lines) max = Math.max(max, l.old || 0, l.new || 0);
    return `${String(max).length * 7.6 + 14}px`;
  }

  function lineCells(i, side) {
    const line = state.doc.lines[i];
    const mark = { added: '+', removed: '-', context: ' ' }[line.kind] ?? '';
    const picked = state.selected.has(i);
    const gutter = el('span', { class: 'gut', 'data-i': isChange(line) ? i : null },
      canPick() && isChange(line) ? el('button', { class: 'gut-btn', 'data-tip': state.mode === 'staged' ? '이 줄 Unstage' : '이 줄 Stage', 'data-line': i }, icon(state.mode === 'staged' ? 'minus' : 'plus', 11)) : null);
    const cells = [];
    if (side !== 'right') cells.push(el('span', { class: 'ln ln-old', 'data-i': isChange(line) ? i : null, text: side === 'left' || !side ? (line.old || '') : '' }));
    if (side !== 'left') cells.push(el('span', { class: 'ln ln-new', 'data-i': isChange(line) ? i : null, text: line.new || '' }));
    return [gutter, ...cells, el('span', { class: 'mk', text: side ? '' : mark }),
      el('span', { class: `tx${picked ? ' picked' : ''}`, 'data-i': isChange(line) ? i : null, 'data-cr': line.cr ? '1' : null }, lineText(line.text, line.changeStart, line.changeLen, state.showWs))];
  }

  function rowElement(row, r) {
    const lines = state.doc.lines;
    if (row.type === 'hunk') {
      const line = lines[row.index];
      return el('div', { class: 'dr dr-hunk', 'data-row': r, 'data-hunk': row.hunk }, el('span', { class: 'hunk-text', text: line.text }), el('span', { class: 'hunk-actions' }, hunkButtons(row.hunk)));
    }
    if (row.type === 'meta') {
      return el('div', { class: 'dr dr-meta', 'data-row': r }, el('span', { class: 'tx', text: lines[row.index].text }));
    }
    if (row.type === 'split') {
      const half = (i, side) => {
        if (i == null) return el('div', { class: 'half empty' });
        const line = lines[i];
        const kind = line.kind === 'context' ? 'context' : line.kind;
        return el('div', { class: `half k-${kind}${state.selected.has(i) ? ' picked' : ''}`, 'data-side': side }, lineCells(i, side));
      };
      return el('div', { class: 'dr dr-split', 'data-row': r, 'data-hunk': row.hunk }, half(row.left, 'left'), half(row.right, 'right'));
    }
    const line = lines[row.index];
    return el('div', { class: `dr k-${line.kind}${state.selected.has(row.index) ? ' picked' : ''}`, 'data-row': r, 'data-hunk': row.hunk }, lineCells(row.index, state.fileView ? 'right' : null));
  }

  let lastRange = '';

  function paint(force = false) {
    if (!body || !state?.doc) return;
    const wrap = state.wrap && rows.length <= WRAP_LIMIT;
    const top = body.scrollTop;
    const first = wrap ? 0 : Math.max(0, Math.floor(top / ROW) - OVERSCAN);
    const last = wrap ? rows.length - 1 : Math.min(rows.length - 1, Math.ceil((top + body.clientHeight) / ROW) + OVERSCAN);
    const key = `${first}:${last}`;
    if (!force && key === lastRange) return;
    lastRange = key;
    const fragment = document.createDocumentFragment();
    for (let r = first; r <= last; r++) {
      const node = rowElement(rows[r], r);
      if (!wrap) node.style.top = `${r * ROW}px`;
      fragment.append(node);
    }
    rowsHost.replaceChildren(fragment);
    placeHoverBand();
  }

  function hunkButtons(hunk) {
    if (state.mode === 'unstaged' && !state.ignoreWs) {
      return [
        el('button', { class: 'btn tiny success', text: 'Stage Hunk', onclick: () => run('stage', hunkLines(hunk)) }),
        state.target.untracked ? null : el('button', { class: 'btn tiny danger', text: 'Discard Hunk', onclick: () => run('discard', hunkLines(hunk)) }),
      ];
    }
    if (state.mode === 'staged' && !state.ignoreWs) return [el('button', { class: 'btn tiny danger', text: 'Unstage Hunk', onclick: () => run('unstage', hunkLines(hunk)) })];
    return [];
  }

  function hunkLines(hunk) {
    return state.doc.lines.map((l, i) => (l.hunk === hunk && isChange(l) ? i : -1)).filter((i) => i >= 0);
  }

  // ── Fork 식 hover 띠: 덩어리(위아래 2줄 포함)를 파란 테두리로 감싸고 [Stage | 되돌리기…] 를 붙인다 ──

  const band = el('div', { class: 'hunk-band', hidden: true });

  function changeRange(row) {
    // 마우스가 있는 행이 든 바뀐 덩어리(연속된 바뀐 행)의 [첫 행, 끝 행].
    const changed = (r) => {
      const x = rows[r];
      if (!x) return false;
      if (x.type === 'split') return isChange(state.doc.lines[x.left]) || isChange(state.doc.lines[x.right]);
      return x.type === 'line' && isChange(state.doc.lines[x.index]);
    };
    if (!changed(row)) return null;
    let a = row;
    let b = row;
    while (changed(a - 1)) a--;
    while (changed(b + 1)) b++;
    return [a, b];
  }

  function rowLines(a, b) {
    const out = [];
    for (let r = a; r <= b; r++) {
      const x = rows[r];
      if (x.type === 'split') [x.left, x.right].forEach((i) => i != null && isChange(state.doc.lines[i]) && out.push(i));
      else if (x.index != null && isChange(state.doc.lines[x.index])) out.push(x.index);
    }
    return out;
  }

  function placeHoverBand() {
    if (hoverHunk < 0 || !canPick() || state.selected.size || state.fileView) {
      band.hidden = true;
      return;
    }
    const range = changeRange(hoverHunk);
    if (!range) {
      band.hidden = true;
      return;
    }
    const [a, b] = [Math.max(0, range[0] - 2), Math.min(rows.length - 1, range[1] + 2)];
    const lines = rowLines(range[0], range[1]);
    band.hidden = false;
    band.style.top = `${a * ROW - body.scrollTop + body.offsetTop}px`;
    band.style.height = `${(b - a + 1) * ROW}px`;
    band.replaceChildren(el('div', { class: 'band-actions' },
      state.mode === 'staged'
        ? el('button', { class: 'btn tiny danger', text: 'Unstage', onclick: () => run('unstage', lines) })
        : [el('button', { class: 'btn tiny success', text: 'Stage', onclick: () => run('stage', lines) }),
          state.target.untracked ? null : el('button', { class: 'btn tiny', text: '되돌리기…', onclick: () => run('discard', lines) })]));
  }

  // ── 고르기 ──

  function selectLines(indexes, event, extend) {
    if (!indexes.length) return;
    if (event?.metaKey || event?.ctrlKey) {
      for (const i of indexes) {
        if (state.selected.has(i)) state.selected.delete(i);
        else state.selected.add(i);
      }
    } else if (!extend) {
      state.selected = new Set(indexes);
    } else {
      for (const i of indexes) state.selected.add(i);
    }
    // Split 에서 한쪽을 고르면 같은 행 반대쪽 바뀐 줄도 더한다.
    if (state.view === 'split') {
      for (const i of [...state.selected]) {
        const r = rows[lineToRow.get(i)];
        if (r?.type === 'split') [r.left, r.right].forEach((j) => j != null && isChange(state.doc.lines[j]) && state.selected.add(j));
      }
    }
    updateSelection();
  }

  function rangeRows(a, b) {
    const out = [];
    for (let r = Math.min(a, b); r <= Math.max(a, b); r++) out.push(...rowLines(r, r));
    return out;
  }

  function updateSelection() {
    paint(true);
    renderSelectionPopup();
  }

  const selectionPopup = el('div', { class: 'selection-pop', hidden: true });

  function renderSelectionPopup() {
    const lines = [...state.selected].sort((a, b) => a - b);
    if (!lines.length || !canPick()) {
      selectionPopup.hidden = true;
      return;
    }
    const lastRow = Math.max(...lines.map((i) => lineToRow.get(i) ?? 0));
    selectionPopup.hidden = false;
    selectionPopup.style.top = `${(lastRow + 1) * ROW - body.scrollTop + body.offsetTop + 2}px`;
    selectionPopup.replaceChildren(...(state.mode === 'staged'
      ? [el('button', { class: 'btn tiny danger', text: `Unstage (${lines.length})`, onclick: () => run('unstage', lines) })]
      : [el('button', { class: 'btn tiny success', text: `Stage (${lines.length})`, onclick: () => run('stage', lines) }),
        state.target.untracked ? null : el('button', { class: 'btn tiny', text: '되돌리기…', onclick: () => run('discard', lines) })]));
  }

  async function run(action, lines) {
    if (!lines.length) return;
    const done = await state.api.applyLines(action, state.target, state.doc.fingerprint, lines, contextFor());
    if (done !== false && state) {
      state.selected = new Set();
      await reload();
    }
  }

  // ── 이동 ──

  function jump(delta) {
    if (!changeBlocks.length || !body) return;
    const current = Math.floor(body.scrollTop / ROW) + 2;
    let target;
    if (delta > 0) target = changeBlocks.find((r) => r > current) ?? changeBlocks[0];
    else target = [...changeBlocks].reverse().find((r) => r < current) ?? changeBlocks[changeBlocks.length - 1];
    // 간 줄을 화면 위에서 2줄 아래에.
    body.scrollTop = Math.max(0, (target - 2) * ROW);
  }

  // ── 복사: +/−·줄 번호를 빼고 원래 탭·CRLF 를 지킨다 ──

  function copySelection(event) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !body.contains(selection.anchorNode)) return;
    const range = selection.getRangeAt(0);
    const texts = [...rowsHost.querySelectorAll('.tx')].filter((node) => range.intersectsNode(node));
    if (!texts.length) return;
    const parts = texts.map((node) => {
      let text = node.textContent;
      if (node.contains(range.startContainer)) text = text.slice(offsetIn(node, range.startContainer, range.startOffset));
      if (node.contains(range.endContainer)) text = text.slice(0, offsetIn(node, range.endContainer, range.endOffset) - (node.contains(range.startContainer) ? offsetIn(node, range.startContainer, range.startOffset) : 0));
      if (state.showWs) text = text.replace(/→\t/g, '\t').replace(/·/g, ' ');
      return { text, cr: node.dataset.cr === '1' };
    });
    const out = parts.map((p, k) => p.text + (k < parts.length - 1 ? (p.cr ? '\r\n' : '\n') : '')).join('');
    event.clipboardData.setData('text/plain', out);
    event.preventDefault();
  }

  function offsetIn(root, node, offset) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let total = 0;
    while (walker.nextNode()) {
      if (walker.currentNode === node) return total + offset;
      total += walker.currentNode.textContent.length;
    }
    return total;
  }

  // ── 막대·본문 ──

  function twoSides() {
    const { target } = state;
    if (target.kind === 'commit') return `${target.hash.slice(0, 7)} 의 부모 ↔ ${target.hash.slice(0, 7)}`;
    if (target.kind === 'range') return `${target.range ? `${target.from}...` : target.from} ↔ ${target.to ?? '작업 사본'}`;
    if (target.kind === 'staged') return 'HEAD ↔ Staged(인덱스)';
    if (target.untracked) return '새 파일 (git 이 아직 모름)';
    return state.hasStaged ? 'Staged(인덱스) ↔ 작업 사본' : 'HEAD ↔ 작업 사본';
  }

  function setView(view) {
    const before = contextFor();
    state.view = view;
    prefs().set('diff.view', view);
    state.api.setLayout?.(view === 'split' ? 'split' : 'inline');
    if (before !== contextFor()) {
      state.doc = null;
      reload();
    }
    render();
  }

  function setFileView(on) {
    const before = contextFor();
    state.fileView = on;
    if (before !== contextFor()) {
      state.doc = null;
      reload();
    }
    render();
  }

  function toggle(key, pref) {
    state[key] = !state[key];
    prefs().set(pref, state[key]);
    if (key === 'ignoreWs') {
      state.doc = null;
      reload();
    }
    render();
  }

  function bar() {
    const { doc, mode, title, target } = state;
    const fileButtons = [];
    if (mode === 'unstaged') {
      fileButtons.push(el('button', { class: 'btn small success', text: 'Stage File', onclick: () => state.api.stageFile(target) }));
      fileButtons.push(el('button', { class: 'btn small', 'data-tip': '이 파일의 변경을 버립니다', onclick: () => state.api.discardFile(target) }, icon('undo', 14)));
    } else if (mode === 'staged') {
      fileButtons.push(el('button', { class: 'btn small danger', text: 'Unstage File', onclick: () => state.api.unstageFile(target) }));
    }
    const canEdit = mode !== 'commit' && target.kind !== 'commit' && target.kind !== 'range' && state.entryState !== 'deleted';
    return el('div', { class: 'diff-bar' },
      el('div', { class: 'dbar-left' },
        state.api.edit && canEdit ? el('button', { class: 'btn small', onclick: () => state.api.edit(target) }, el('span', { class: 'png-icon', style: { '--png': 'url(icons/DiffEdit.png)' } }), '이 파일 편집') : null,
        el('div', { class: 'diff-title' },
          fileIcon(target.path),
          el('span', { class: 'diff-path', 'data-tip': title, text: title }),
          doc && !doc.binary ? el('span', { class: 'diff-count' }, el('span', { class: 'plus', text: `+${doc.added}` }), el('span', { class: 'minus', text: ` −${doc.removed}` })) : null)),
      el('div', { class: 'dbar-center' },
        segment([
          el('button', { class: `dbar-text${state.fileView ? ' on' : ''}`, text: '파일 보기', onclick: () => setFileView(true) }),
          el('button', { class: `dbar-text${state.fileView ? '' : ' on'}`, text: 'Diff 보기', onclick: () => setFileView(false) }),
        ])),
      el('div', { class: 'dbar-right' },
        state.api.blame || state.api.history ? segment([
          el('button', { class: 'dbar-text', text: 'Blame', disabled: !state.api.blame || target.untracked, onclick: () => state.api.blame?.(target) }),
          el('button', { class: 'dbar-text', text: '히스토리', disabled: !state.api.history, onclick: () => state.api.history?.(target) }),
        ]) : null,
        segment([pngButton('DiffUp', '이전 변경', () => jump(-1)), pngButton('DiffDown', '다음 변경', () => jump(1))]),
        segment([
          pngButton('DiffViewHunk', 'Hunk — 바뀐 곳과 앞뒤 몇 줄만', () => setView('hunk'), state.view === 'hunk' && !state.fileView),
          pngButton('DiffViewInline', 'Inline — 파일 전체를 한 칸에', () => setView('inline'), state.view === 'inline' && !state.fileView),
          pngButton('DiffViewSplit', 'Split — 파일 전체를 나란히', () => setView('split'), state.view === 'split' && !state.fileView),
        ]),
        pngButton('DiffWhitespace', '공백 문자 보이기 (· →)', () => toggle('showWs', 'diff.whitespace'), state.showWs),
        pngButton('DiffWrap', '긴 줄 접기', () => toggle('wrap', 'diff.wrap'), state.wrap),
        el('button', {
          class: 'dbar-btn', 'data-tip': '더 보기',
          onclick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showMenu(r.left, r.bottom + 4, [
              { label: '공백 바뀜 무시', checked: state.ignoreWs, hint: '켜면 줄 단위 Stage 를 끈다', action: () => toggle('ignoreWs', 'diff.ignoreWhitespace') },
              { label: '외부 편집기로 이 줄 열기', disabled: !state.api.openEditor || target.kind === 'commit', action: () => state.api.openEditor?.(target, currentLine()) },
              { label: '경로 복사', action: () => navigator.clipboard?.writeText(target.path) },
            ]);
          },
        }, icon('moreVert', 16)),
        el('span', { class: 'dbar-gap' }),
        fileButtons,
        el('button', { class: 'dbar-btn', 'data-tip': '닫기 (Esc)', onclick: () => state.api.close() }, icon('close', 14))));
  }

  /** 지금 보고 있는 변경 줄(외부 편집기를 그 줄로 연다). */
  function currentLine() {
    const top = Math.floor((body?.scrollTop ?? 0) / ROW) + 2;
    for (let r = top; r < rows.length; r++) {
      const x = rows[r];
      const i = x?.type === 'split' ? (x.right ?? x.left) : x?.index;
      const line = state.doc?.lines[i];
      if (line?.new) return line.new;
    }
    return 1;
  }

  function binaryCard() {
    const { doc, target } = state;
    const sizes = doc.sizes ?? {};
    const status = STATE_LABEL[state.entryState] ?? (sizes.old == null ? '추가' : sizes.new == null ? '삭제' : '수정');
    return el('div', { class: 'binary-card' },
      el('div', { class: 'binary-icon' }, fileIcon(target.path)),
      el('div', { class: 'binary-name', text: target.path.split('/').pop() }),
      el('div', { class: 'muted', text: `바이너리 파일 · ${status}` }),
      el('div', { class: 'binary-sizes' },
        sizes.old != null && sizes.new != null ? [el('span', { text: formatSize(sizes.old) }), icon('chevronRight', 14), el('span', { text: formatSize(sizes.new) })]
          : el('span', { text: formatSize(sizes.new ?? sizes.old) })));
  }

  function lfsBanner() {
    return el('div', { class: 'lfs-banner' }, icon('info', 16),
      el('span', { text: '이 파일은 Git LFS 로 관리됩니다. 원본을 아직 받지 않아 포인터 글만 보입니다.' }),
      state.api.lfsPull ? el('button', { class: 'btn small primary', text: '이 파일 원본 받기', onclick: () => state.api.lfsPull(state.target).then(() => { state.doc = null; reload(); }) }) : null);
  }

  function render() {
    if (!state || state.image) return;
    const { doc } = state;
    const loading = el('div', { class: 'diff-loading', hidden: true }, el('span', { class: 'spinner' }), '불러오는 중…');
    const sides = el('div', { class: 'diff-sides muted small' }, el('span', { text: twoSides() }),
      state.ignoreWs ? el('span', { class: 'warning-text', text: ' · 공백 무시 중(줄 단위 Stage 꺼짐)' }) : null,
      canPick() ? el('span', { class: 'muted', text: ' · 거터를 끌어 줄을 고르세요' }) : null);
    let content;
    if (state.error) content = el('div', { class: 'diff-empty error-text', text: state.error });
    else if (!doc) content = el('div', { class: 'diff-empty muted', text: '불러오는 중…' });
    else if (doc.binary) content = binaryCard();
    else if (!doc.lines.length) content = el('div', { class: 'diff-empty muted', text: '바뀐 내용이 없습니다(파일 모드·이름만 바뀌었거나 이미 모두 Stage 됨).' });
    else {
      buildRows();
      const old = state.doc.lines.some((l) => l.old);
      const neu = state.doc.lines.some((l) => l.new);
      const wrap = state.wrap && rows.length <= WRAP_LIMIT;
      body = el('div', {
        class: `diff-body view-${state.fileView ? 'file' : state.view}${wrap ? ' wrap' : ''}${old ? '' : ' no-old'}${neu ? '' : ' no-new'}${canPick() ? ' pickable' : ''}`,
        style: { '--ln': numberWidth() },
        tabindex: '0',
      });
      sizer = el('div', { class: 'diff-sizer', style: wrap ? null : { height: `${rows.length * ROW}px` } });
      rowsHost = el('div', { class: `diff-rows${wrap ? ' flow' : ''}` });
      sizer.append(rowsHost);
      body.append(sizer);
      content = body;
      wireBody();
    }
    const prevScroll = container.querySelector('.diff-body')?.scrollTop ?? 0;
    container.replaceChildren(...[bar(), sides, doc?.lfsPointer ? lfsBanner() : null, content, band, selectionPopup, loading].filter(Boolean));
    if (content === body) {
      body.scrollTop = prevScroll;
      lastRange = '';
      paint(true);
      if (!prevScroll && changeBlocks.length && state.view !== 'hunk') body.scrollTop = Math.max(0, (changeBlocks[0] - 2) * ROW);
      paint(true);
    } else {
      body = null;
      band.hidden = true;
      selectionPopup.hidden = true;
    }
  }

  function wireBody() {
    body.addEventListener('scroll', () => {
      requestAnimationFrame(() => paint());
      placeHoverBand();
      renderSelectionPopup();
    });
    body.addEventListener('copy', copySelection);
    body.addEventListener('mousemove', (event) => {
      const rowNode = event.target.closest('[data-row]');
      const r = rowNode ? Number(rowNode.dataset.row) : -1;
      if (r !== hoverHunk) {
        hoverHunk = r;
        placeHoverBand();
      }
    });
    body.addEventListener('mouseleave', (event) => {
      if (band.contains(event.relatedTarget)) return;
      hoverHunk = -1;
      band.hidden = true;
    });
    // 거터 [+]: 그 줄 하나.
    body.addEventListener('click', (event) => {
      const button = event.target.closest('.gut-btn');
      if (button) {
        event.stopPropagation();
        run(state.mode === 'staged' ? 'unstage' : 'stage', [Number(button.dataset.line)]);
      }
    });
    // 거터·줄 번호를 끌어 범위, Shift+클릭으로 늘리기, ⌘/Ctrl 로 하나씩.
    body.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !canPick()) return;
      const cell = event.target.closest('.gut, .ln');
      if (!cell || event.target.closest('.gut-btn')) return;
      const rowNode = cell.closest('[data-row]');
      if (!rowNode) return;
      event.preventDefault();
      const r = Number(rowNode.dataset.row);
      if (event.shiftKey && state.anchor != null) {
        selectLines(rangeRows(state.anchor, r), event, false);
        return;
      }
      state.anchor = r;
      selectLines(rowLines(r, r), event, false);
      dragging = { start: r, meta: event.metaKey || event.ctrlKey };
      body.setPointerCapture(event.pointerId);
    });
    body.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const rect = body.getBoundingClientRect();
      const r = Math.max(0, Math.min(rows.length - 1, Math.floor((event.clientY - rect.top + body.scrollTop) / ROW)));
      if (!dragging.meta) state.selected = new Set();
      selectLines(rangeRows(dragging.start, r), null, true);
    });
    body.addEventListener('pointerup', () => { dragging = null; });
    // Split 에서는 한쪽 글만 고른다.
    body.addEventListener('mousedown', (event) => {
      const half = event.target.closest('.half');
      body.classList.toggle('select-left', half?.dataset.side === 'left');
      body.classList.toggle('select-right', half?.dataset.side === 'right');
    });
    body.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showMenu(event.clientX, event.clientY, [
        { label: '복사', hint: '⌘C', disabled: window.getSelection()?.isCollapsed, action: () => document.execCommand('copy') },
        { label: '모두 선택', hint: '⌘A', action: () => selectAllText() },
        ...(state.selected.size && canPick() ? ['-', state.mode === 'staged'
          ? { label: `고른 줄 Unstage (${state.selected.size})`, action: () => run('unstage', [...state.selected]) }
          : { label: `고른 줄 Stage (${state.selected.size})`, action: () => run('stage', [...state.selected]) }] : []),
      ]);
    });
    body.addEventListener('keydown', (event) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectAllText();
      } else if (event.key === 'Escape' && (state.selected.size || !window.getSelection()?.isCollapsed)) {
        event.stopPropagation();
        state.selected = new Set();
        window.getSelection()?.removeAllRanges();
        updateSelection();
      } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.altKey && !isComposing(event)) {
        event.preventDefault();
        jump(event.key === 'ArrowDown' ? 1 : -1);
      }
    });
  }

  function selectAllText() {
    const range = document.createRange();
    range.selectNodeContents(rowsHost);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  return {
    open,
    reload,
    close,
    get isOpen() { return state != null; },
    get target() { return state?.target; },
  };
}
