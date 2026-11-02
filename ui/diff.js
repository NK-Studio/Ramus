// 가운데 칸의 diff 보기. 변경 목록·커밋 파일을 누르면 그래프 대신 열린다(GitKraken 처럼). Esc·✕ 로 그래프로 돌아간다.
//
// 줄 고르기: 바뀐 줄('+'·'-')을 누르면 고르고, ⌘/Ctrl+클릭은 더하기·빼기, Shift+클릭은 범위. 고른 줄로 Stage·Unstage·버리기를 한다.
// 고른 줄 번호는 Rust 의 DiffDocument.lines 인덱스 그대로이고, diff 지문(fingerprint)과 함께 보낸다 — 그 사이 파일이 바뀌면 Rust 가 거절한다.

import { el } from './util.js';

const MAX_RENDERED_LINES = 4000;

/** 글자 단위(코드 포인트)로 [start, start+len) 을 강조한다. Rust 쪽도 char 단위로 센다. */
function textWithChange(text, start, len) {
  if (!len) return [text];
  const chars = Array.from(text);
  return [chars.slice(0, start).join(''), el('span', { class: 'chg', text: chars.slice(start, start + len).join('') }), chars.slice(start + len).join('')];
}

const isChange = (line) => line.kind === 'added' || line.kind === 'removed';

/**
 * diff 보기를 만든다. `api` 는 app.js 가 주는 함수들: load(target), applyLines(action, lines), stageFile, unstageFile, discardFile, close, setLayout.
 */
export function createDiffView(container) {
  let state = null; // {target, mode, title, doc, layout, selected:Set, anchor}

  function open(options) {
    state = { ...options, doc: null, selected: new Set(), anchor: null, error: null };
    render();
    reload();
  }

  async function reload() {
    if (!state) return;
    const current = state;
    try {
      const doc = await current.api.load(current.target);
      if (state !== current) return;
      // 같은 diff 면 다시 그리지 않는다(고른 줄·스크롤·누르던 버튼이 그대로 남게).
      if (current.doc && !current.error && current.doc.fingerprint === doc.fingerprint) return;
      current.selected = new Set();
      current.doc = doc;
      current.error = null;
    } catch (error) {
      if (state !== current) return;
      current.error = error?.message ?? String(error);
    }
    render();
  }

  function close() {
    state = null;
    container.replaceChildren();
  }

  function selectLine(index, event) {
    const lines = state.doc.lines;
    if (!isChange(lines[index])) return;
    if (event.shiftKey && state.anchor != null) {
      const [a, b] = [Math.min(state.anchor, index), Math.max(state.anchor, index)];
      if (!(event.metaKey || event.ctrlKey)) state.selected = new Set();
      for (let i = a; i <= b; i++) if (isChange(lines[i])) state.selected.add(i);
    } else if (event.metaKey || event.ctrlKey) {
      if (state.selected.has(index)) state.selected.delete(index);
      else state.selected.add(index);
      state.anchor = index;
    } else {
      state.selected = state.selected.size === 1 && state.selected.has(index) ? new Set() : new Set([index]);
      state.anchor = index;
    }
    updateSelection();
  }

  function updateSelection() {
    for (const node of container.querySelectorAll('[data-i]')) node.classList.toggle('picked', state.selected.has(Number(node.dataset.i)));
    const bar = container.querySelector('.diff-selection');
    if (bar) renderSelectionBar(bar);
  }

  function renderSelectionBar(bar) {
    const count = state.selected.size;
    const lines = [...state.selected].sort((a, b) => a - b);
    const buttons = [];
    if (count && state.mode === 'unstaged') {
      buttons.push(el('button', { class: 'btn small success', text: `선택한 줄 Stage (${count})`, onclick: () => run('stage', lines) }));
      if (!state.target.untracked) buttons.push(el('button', { class: 'btn small danger', text: `선택한 줄 버리기 (${count})`, onclick: () => run('discard', lines) }));
    } else if (count && state.mode === 'staged') {
      buttons.push(el('button', { class: 'btn small danger', text: `선택한 줄 Unstage (${count})`, onclick: () => run('unstage', lines) }));
    }
    bar.replaceChildren(...(buttons.length ? buttons : [el('span', { class: 'muted small', text: state.mode === 'commit' ? '' : '바뀐 줄을 눌러 고르면 그 줄만 Stage 할 수 있습니다 (⌘/Ctrl·Shift 로 여러 줄)' })]));
  }

  async function run(action, lines) {
    const done = await state.api.applyLines(action, state.target, state.doc.fingerprint, lines);
    if (done !== false) {
      state.selected = new Set();
      await reload();
    }
  }

  function hunkLines(hunk) {
    return state.doc.lines.map((l, i) => (l.hunk === hunk && isChange(l) ? i : -1)).filter((i) => i >= 0);
  }

  function hunkButtons(hunk) {
    if (state.mode === 'unstaged') {
      return [
        el('button', { class: 'btn tiny success', text: 'Stage Hunk', onclick: () => run('stage', hunkLines(hunk)) }),
        state.target.untracked ? null : el('button', { class: 'btn tiny danger', text: 'Discard Hunk', onclick: () => run('discard', hunkLines(hunk)) }),
      ];
    }
    if (state.mode === 'staged') return [el('button', { class: 'btn tiny danger', text: 'Unstage Hunk', onclick: () => run('unstage', hunkLines(hunk)) })];
    return [];
  }

  function inlineRows(lines) {
    return lines.map((line, i) => {
      if (line.kind === 'hunk') return el('div', { class: 'dl dl-hunk' }, el('span', { class: 'hunk-text', text: line.text }), el('span', { class: 'hunk-actions' }, hunkButtons(line.hunk)));
      if (line.kind === 'noNewline') return el('div', { class: 'dl dl-meta' }, el('span', { class: 'ln' }), el('span', { class: 'ln' }), el('span', { class: 'mk' }), el('span', { class: 'tx', text: line.text }));
      const mark = { added: '+', removed: '-', context: ' ' }[line.kind];
      return el('div', { class: `dl dl-${line.kind}`, 'data-i': isChange(line) ? i : null },
        el('span', { class: 'ln', text: line.old || '' }),
        el('span', { class: 'ln', text: line.new || '' }),
        el('span', { class: 'mk', text: mark }),
        el('span', { class: 'tx' }, textWithChange(line.text, line.changeStart, line.changeLen)));
    });
  }

  /** 나란히 보기: 문맥 줄은 양쪽에, 지운·더한 묶음은 같은 순번끼리 한 줄에. */
  function splitRows(lines) {
    const rows = [];
    const cell = (line, i, side) => {
      if (!line) return [el('span', { class: 'ln' }), el('span', { class: 'tx sx-empty' })];
      const number = side === 'left' ? line.old : line.new;
      return [
        el('span', { class: `ln ${isChange(line) ? `dl-${line.kind}` : ''}`, text: number || '' }),
        el('span', { class: `tx ${isChange(line) ? `dl-${line.kind}` : ''}`, 'data-i': isChange(line) ? i : null }, textWithChange(line.text, line.changeStart, line.changeLen)),
      ];
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.kind === 'hunk') {
        rows.push(el('div', { class: 'sl dl-hunk' }, el('span', { class: 'hunk-text', text: line.text }), el('span', { class: 'hunk-actions' }, hunkButtons(line.hunk))));
        i++;
        continue;
      }
      if (line.kind === 'context' || line.kind === 'noNewline') {
        rows.push(el('div', { class: 'sl' }, cell(line, i, 'left'), cell(line, i, 'right')));
        i++;
        continue;
      }
      const removed = [];
      while (i < lines.length && lines[i].kind === 'removed') removed.push(i++);
      const added = [];
      while (i < lines.length && lines[i].kind === 'added') added.push(i++);
      for (let k = 0; k < Math.max(removed.length, added.length); k++) {
        const l = removed[k];
        const r = added[k];
        rows.push(el('div', { class: 'sl' }, cell(l != null ? lines[l] : null, l, 'left'), cell(r != null ? lines[r] : null, r, 'right')));
      }
    }
    return rows;
  }

  function render() {
    if (!state) return;
    const { doc, layout, mode, title } = state;
    const layoutToggle = el('div', { class: 'seg' },
      el('button', { class: layout === 'inline' ? 'on' : '', text: 'Inline', onclick: () => setLayout('inline') }),
      el('button', { class: layout === 'split' ? 'on' : '', text: 'Split', onclick: () => setLayout('split') }));
    const fileButtons = [];
    if (mode === 'unstaged') {
      fileButtons.push(el('button', { class: 'btn small success', text: 'Stage File', onclick: () => state.api.stageFile(state.target) }));
      fileButtons.push(el('button', { class: 'btn small danger', text: '파일 버리기', onclick: () => state.api.discardFile(state.target) }));
    } else if (mode === 'staged') {
      fileButtons.push(el('button', { class: 'btn small danger', text: 'Unstage File', onclick: () => state.api.unstageFile(state.target) }));
    }
    const header = el('div', { class: 'diff-header' },
      el('div', { class: 'diff-title' },
        el('span', { class: `diff-mode mode-${mode}`, text: { unstaged: 'Unstaged', staged: 'Staged', commit: 'Commit' }[mode] }),
        el('span', { class: 'diff-path', title, text: title }),
        doc ? el('span', { class: 'diff-count' }, el('span', { class: 'plus', text: `+${doc.added}` }), el('span', { class: 'minus', text: ` −${doc.removed}` })) : null),
      el('div', { class: 'diff-tools' }, fileButtons, layoutToggle,
        el('button', { class: 'icon-btn', title: '닫기 (Esc)', text: '✕', onclick: () => state.api.close() })));
    const bar = el('div', { class: 'diff-selection' });
    let body;
    if (state.error) body = el('div', { class: 'diff-empty error-text', text: state.error });
    else if (!doc) body = el('div', { class: 'diff-empty muted', text: '불러오는 중…' });
    else if (doc.binary) body = el('div', { class: 'diff-empty muted', text: '바이너리 파일이라 내용을 비교해 보여 줄 수 없습니다.' });
    else if (!doc.lines.length) body = el('div', { class: 'diff-empty muted', text: '바뀐 내용이 없습니다(파일 모드·이름만 바뀌었거나 이미 모두 Stage 됨).' });
    else {
      const shown = doc.lines.length > MAX_RENDERED_LINES ? doc.lines.slice(0, MAX_RENDERED_LINES) : doc.lines;
      const rows = layout === 'split' ? splitRows(shown) : inlineRows(shown);
      body = el('div', { class: `diff-body ${layout}` }, rows,
        shown !== doc.lines ? el('div', { class: 'diff-empty muted', text: `diff 가 너무 길어 앞의 ${MAX_RENDERED_LINES}줄만 보여 줍니다.` }) : null);
      body.addEventListener('click', (event) => {
        const node = event.target.closest('[data-i]');
        if (node && !event.target.closest('button')) selectLine(Number(node.dataset.i), event);
      });
    }
    const scroll = container.querySelector('.diff-body')?.scrollTop ?? 0;
    container.replaceChildren(header, bar, body);
    renderSelectionBar(bar);
    updateSelection();
    if (body.classList.contains('diff-body')) body.scrollTop = scroll;
  }

  function setLayout(layout) {
    state.layout = layout;
    state.api.setLayout(layout);
    render();
  }

  return {
    open,
    reload,
    close,
    get isOpen() { return state != null; },
    get target() { return state?.target; },
  };
}
