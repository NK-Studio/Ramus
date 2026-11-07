// 가운데를 덮는 도구 화면: 파일 히스토리 · Blame · 비교 · 코드 편집기 · 이미지 diff.
// 원본 FileHistoryPanel·GitBlameWindow·GitCompareWindow·GitCodeEditor·GitImageDiffView 를 옮겼다.

import { el, relativeTime, formatDate, initials, isComposing } from './util.js';
import { icon } from './icons.js';
import { createDiffView } from './diff.js';
import { fileList, viewSwitch, CHANGE_STATE, fileIcon } from './files.js';
import { confirmDialog, choiceDialog, showMenu } from './dialogs.js';
import { highlight, languageOf } from './syntax.js';
import { authorRgb } from './graph.js';

const rgb = (c) => `rgb(${c.map(Math.round).join(',')})`;
const ZERO = /^0+$/;
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** 40자 해시만 7자리로(원본 GitDisplay.ShortRevision). `해시^` 도 줄인다. 브랜치 이름·HEAD 는 그대로. */
export const shortRevision = (rev) => (rev ? rev.replace(/^([0-9a-f]{40})/i, (h) => h.slice(0, 7)) : rev);

/**
 * 칸 경계 끌기(원본 TwoPaneSplitView). `pane` 은 크기를 정해 둔 칸(나머지 칸이 남는 크기를 갖는다).
 * 경계를 끌면 폭(axis 'x')·높이('y')를 바꾸고 prefs 에 남긴다. 두 번 누르면 처음 크기로.
 * opts: { pane, axis, prefs, key, size(처음 크기), min(칸 최소), rest(다른 칸 최소), after(pane 이 경계 뒤쪽이면 true) }
 */
export function splitter({ pane, axis = 'x', prefs, key, size, min = 60, rest = 80, after = false }) {
  const handle = el('div', { class: `pane-split ${axis === 'x' ? 'cols' : 'rows'}` });
  const prop = axis === 'x' ? 'width' : 'height';
  const apply = (value) => { pane.style.flex = `0 0 ${Math.round(value)}px`; };
  apply(prefs?.get(key) ?? size);
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const start = axis === 'x' ? event.clientX : event.clientY;
    const startSize = pane.getBoundingClientRect()[prop];
    const total = pane.parentElement.getBoundingClientRect()[prop];
    handle.classList.add('dragging');
    const move = (ev) => {
      const d = (axis === 'x' ? ev.clientX : ev.clientY) - start;
      apply(Math.max(min, Math.min(total - rest, startSize + (after ? -d : d))));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.classList.remove('dragging');
      prefs?.set(key, Math.round(pane.getBoundingClientRect()[prop]));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('dblclick', () => {
    apply(size);
    prefs?.set(key, null);
  });
  return handle;
}

/**
 * 고정 높이 줄을 보이는 것만 그리는 목록(원본 ListView FixedHeight). scroller 안에 sizer 를 두고 줄을 절대 위치로 놓는다.
 * renderRow(i) 는 줄 요소를 돌려준다. 돌려주는 refresh() 로 다시 그린다.
 */
function virtualRows(scroller, { count, rowHeight, renderRow, minWidth = 0 }) {
  const sizer = el('div', { class: 'vrows' });
  scroller.append(sizer);
  let n = count;
  let frame = 0;
  const draw = () => {
    sizer.style.height = `${n * rowHeight}px`;
    if (minWidth) sizer.style.minWidth = `${minWidth}px`;
    const top = scroller.scrollTop;
    const first = Math.max(0, Math.floor(top / rowHeight) - 20);
    const last = Math.min(n, Math.ceil((top + scroller.clientHeight) / rowHeight) + 20);
    const rows = [];
    for (let i = first; i < last; i++) {
      const row = renderRow(i);
      row.style.top = `${i * rowHeight}px`;
      rows.push(row);
    }
    sizer.replaceChildren(...rows);
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  };
  scroller.addEventListener('scroll', schedule);
  new ResizeObserver(schedule).observe(scroller);
  draw();
  return {
    refresh: draw,
    setCount(value) { n = value; draw(); },
    scrollTo(i) { scroller.scrollTop = Math.max(0, i * rowHeight - scroller.clientHeight / 2); draw(); },
  };
}

/**
 * ctx: { host(tool-view 요소), call, prefs, showError, act, diffApi, revealCommit(hash), onOpen(), onClose(), avatarUrl(email, hash), openEditor(path, line), onSaved(path) }
 */
export function createTools(ctx) {
  const host = ctx.host;
  let current = null; // { kind, dispose, beforeClose, beforeCancel, closed }
  let closing = null;

  /** 지금 화면을 닫고(저장 안 한 편집이 있으면 묻는다) 새 화면을 연다. 사용자가 취소하면 열지 않고 false. */
  async function open(kind, build) {
    if (!(await close())) return false;
    host.hidden = false;
    host.replaceChildren();
    const me = { kind, closed: false };
    current = me;
    build(host, me);
    ctx.onOpen();
    return true;
  }

  /**
   * 닫는다. 저장 안 한 편집이 있으면 원본 LeaveEdit 처럼 [저장][버리기][취소] 를 묻고, 취소하면 false.
   * mode 'cancel' 은 원본 Esc·취소(CancelEdit)처럼 버릴지만 묻는다. 묻는 동안 다시 부르면 같은 물음을 기다린다.
   */
  function close(mode) {
    if (!current) return Promise.resolve(true);
    if (closing) return closing;
    const me = current;
    const ask = mode === 'cancel' ? me.beforeCancel : me.beforeClose;
    if (!ask) {
      finish(me);
      return Promise.resolve(true);
    }
    closing = ask().then((ok) => {
      closing = null;
      if (ok) finish(me);
      return !!ok;
    }, (error) => {
      closing = null;
      ctx.showError(error);
      return false;
    });
    return closing;
  }

  function finish(me = current) {
    if (!me || me !== current) return;
    me.closed = true;
    me.dispose?.();
    current = null;
    host.hidden = true;
    host.replaceChildren();
    ctx.onClose();
  }

  /** 머리 줄(원본 file-history__header): 제목 · × */
  const header = (title, extra = [], closeTip = '닫기 (Esc)') => el('div', { class: 'tool-head' },
    el('span', { class: 'tool-title', text: title, 'data-tip': title }), extra,
    el('button', { class: 'tool-close', text: '×', 'data-tip': closeTip, onclick: () => close() }));

  function avatar(name, email, hash) {
    const node = el('span', { class: 'fh-avatar', style: { background: rgb(authorRgb(name)) }, text: initials(name) });
    ctx.avatarUrl?.(email, hash).then((url) => {
      if (!url) return;
      node.replaceChildren();
      node.style.background = `center / cover no-repeat url("${url}")`;
    });
    return node;
  }

  // ── 파일 히스토리(TL-05, 원본 FileHistoryPanel) ──

  const HISTORY_MAX = 500;

  function fileHistory(path) {
    return open('history', async (root, me) => {
      const notice = el('div', { class: 'fh-notice', text: '불러오는 중…' });
      const rows = el('div', { class: 'fh-rows', tabindex: '0' });
      const footer = el('div', { class: 'fh-footer' });
      const list = el('div', { class: 'fh-list' }, notice, rows, footer);
      const diffHost = el('div', { class: 'fh-diff diff-view embedded' });
      const diff = createDiffView(diffHost);
      root.append(header(`파일 히스토리: ${path}`, [], '히스토리 닫기(Esc)'),
        el('div', { class: 'fh-body' }, list, splitter({ pane: list, prefs: ctx.prefs, key: 'history.split', size: 400, min: 160 }), diffHost));
      me.dispose = () => diff.close();
      let revisions;
      try {
        revisions = await ctx.call('fileLog', { path, maxCount: HISTORY_MAX });
      } catch (error) {
        if (!me.closed) notice.textContent = error?.message ?? String(error);
        return;
      }
      if (me.closed) return;
      notice.hidden = revisions.length > 0;
      notice.textContent = '이 파일을 바꾼 커밋이 없습니다.';
      footer.textContent = revisions.length >= HISTORY_MAX ? `최근 ${HISTORY_MAX}개까지만 보입니다.` : '히스토리 끝';
      let active = -1;
      const items = revisions.map((rev, i) => {
        const c = rev.commit;
        const row = el('div', {
          class: 'fh-row',
          'data-tip': `${c.subject}\n${c.authorName} <${c.authorEmail}>\n${formatDate(c.time, true)}  ${c.shortHash}`,
          onclick: () => choose(i),
        }, avatar(c.authorName, c.authorEmail, c.hash),
        el('div', { class: 'fh-text' }, el('div', { class: 'fh-subject', text: c.subject }), el('div', { class: 'fh-meta', text: `${relativeTime(c.time)} · ${c.authorName}` })),
        el('span', { class: 'fh-hash', text: c.shortHash }));
        return row;
      });
      rows.replaceChildren(...items);
      function choose(i) {
        if (i < 0 || i >= revisions.length) return;
        items[active]?.classList.remove('active');
        active = i;
        items[i].classList.add('active');
        items[i].scrollIntoView({ block: 'nearest' });
        const rev = revisions[i];
        // 이미 이 파일의 히스토리를 보고 있다 — diff 막대의 [히스토리] 는 끈다(원본 ShowHistoryButton(false)).
        diff.open({ target: { kind: 'commit', hash: rev.commit.hash, path: rev.path, originalPath: rev.originalPath ?? null }, mode: 'commit', title: rev.path, api: { ...ctx.diffApi, history: null, close: () => close() } });
      }
      rows.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          choose(active + (event.key === 'ArrowDown' ? 1 : -1));
        }
      });
      if (revisions.length) choose(0);
      rows.focus();
    });
  }

  // ── Blame(TL-06, 원본 GitBlameWindow) ──

  const BLAME_ROW = 18;

  function blame(path, revision) {
    return open('blame', async (root, me) => {
      const name = path.split('/').pop();
      const summary = el('div', { class: 'bl-summary', text: '불러오는 중…' });
      const scroller = el('div', { class: 'blame-body' });
      root.append(header(`Blame: ${name}${revision ? ` @ ${shortRevision(revision)}` : ''}`), summary, scroller);
      let lines;
      try {
        lines = await ctx.call('blame', { path, revision });
      } catch (error) {
        if (!me.closed) summary.textContent = error?.message ?? String(error);
        return;
      }
      if (me.closed) return;
      summary.textContent = `${path} — ${lines.length}줄`;
      // 같은 커밋이 이어지는 묶음: 첫 줄에만 정보, 묶음마다 바탕을 번갈아 칠한다.
      const starts = [];
      const odd = [];
      let flip = false;
      lines.forEach((line, i) => {
        const start = i === 0 || line.hash !== lines[i - 1].hash;
        if (start && i > 0) flip = !flip;
        starts.push(start);
        odd.push(flip);
      });
      const longest = lines.reduce((m, l) => Math.max(m, l.text.replace(/\t/g, '    ').length), 0);
      // 코드 칸은 diff 와 같은 문법 색(원본 1.2.0). 첫 줄부터 이어 훑어 블록 주석도 이어진다. 50,000 줄이 넘으면 칠하지 않는다.
      const lang = lines.length <= 50000 ? languageOf(path) : null;
      const colored = lang ? highlight(lines.map((l) => l.text).join('\n'), lang) : null;
      let selected = -1;
      const view = virtualRows(scroller, {
        count: lines.length,
        rowHeight: BLAME_ROW,
        minWidth: 360 + longest * 7.3 + 20,
        renderRow: (i) => {
          const line = lines[i];
          const uncommitted = ZERO.test(line.hash);
          const first = starts[i];
          const code = el('span', { class: 'bl-code' });
          if (colored) code.innerHTML = colored[i] ?? '';
          else code.textContent = line.text.replace(/\t/g, '    ');
          return el('div', {
            class: `bl-row${odd[i] ? ' odd' : ''}${first ? ' start' : ''}${uncommitted ? ' uncommitted' : ''}${i === selected ? ' selected' : ''}`,
            'data-tip': uncommitted ? '커밋 안 됨' : `${line.hash.slice(0, 7)}  ${line.author}  ${formatDate(line.time, true)}\n${line.summary}`,
            onclick: () => { selected = i; view.refresh(); },
            ondblclick: () => { if (!uncommitted) close().then((ok) => ok && ctx.revealCommit(line.hash)); },
          },
          el('span', { class: 'bl-hash', text: first ? (uncommitted ? '커밋 안 됨' : line.hash.slice(0, 7)) : '' }),
          el('span', { class: 'bl-author', text: first && !uncommitted ? line.author : '' }),
          el('span', { class: 'bl-date', text: first && !uncommitted ? formatDate(line.time, true) : '' }),
          el('span', { class: 'bl-ln', text: line.line }),
          code);
        },
      });
    });
  }

  // ── 비교(TL-07, 원본 GitCompareWindow) ──

  /** from ↔ to(없으면 작업 트리). range 면 공통 조상부터(From...To). */
  function compare(from, to, { range = false, title } = {}) {
    return open('compare', async (root, me) => {
      const a = shortRevision(from);
      const b = shortRevision(to);
      const commitOnly = to && from === `${to}^`;
      const label = title ?? (to == null ? `${a} ↔ 작업 트리` : commitOnly ? `커밋 ${b}` : range ? `${a}...${b}` : `${a} ↔ ${b}`);
      const summaryOf = (n) => (to == null ? `${a} ↔ 작업 트리 · 파일 ${n}개 (새 파일 제외)`
        : commitOnly ? `${b} 의 부모 ↔ ${b} · 파일 ${n}개`
          : range ? `${b} 이 ${a} 에서 갈라진 뒤 바꾼 파일 ${n}개` : `${a} ↔ ${b} · 파일 ${n}개`);
      const summary = el('span', { class: 'cmp-summary', text: '불러오는 중…' });
      const modeHost = el('span');
      const top = el('div', { class: 'cmp-files' });
      const diffHost = el('div', { class: 'cmp-diff diff-view embedded' });
      const diff = createDiffView(diffHost);
      root.append(header(label), el('div', { class: 'cmp-bar' }, summary, el('span', { class: 'spacer' }), modeHost),
        el('div', { class: 'cmp-split' }, top, splitter({ pane: diffHost, axis: 'y', prefs: ctx.prefs, key: 'compare.split', size: 360, min: 80, after: true }), diffHost));
      me.dispose = () => diff.close();
      let view = ctx.prefs.get('compare.view') ?? 'path';
      const st = { selected: new Set(), anchor: null };
      let files;
      try {
        files = (await ctx.call('compareFiles', { from, to, range })).map((f) => ({ ...f, state: CHANGE_STATE[f.status] ?? 'modified' }));
      } catch (error) {
        if (!me.closed) summary.textContent = error?.message ?? String(error);
        return;
      }
      if (me.closed) return;
      summary.textContent = summaryOf(files.length);
      const openFile = (f) => diff.open({ target: { kind: 'range', from, to: to ?? null, range, path: f.path, originalPath: f.originalPath ?? null }, mode: 'commit', title: f.path, api: { ...ctx.diffApi, close: () => close() } });
      const draw = () => {
        modeHost.replaceChildren(viewSwitch(view, (v) => { view = v; ctx.prefs.set('compare.view', v); draw(); }));
        top.replaceChildren(fileList({ entries: files, view, state: st, onOpen: openFile, empty: '두 판이 같습니다.' }));
      };
      draw();
      if (files[0]) {
        st.selected.add(files[0].path);
        st.anchor = files[0].path;
        draw();
        openFile(files[0]);
      }
    });
  }

  // ── 코드 편집기(TL-01·02·03, 원본 GitDiffPanel 의 "이 파일 편집" + GitCodeEditor) ──

  const LH = 18; // 원본 GitCodeEditor.LineHeight
  const TEXT_LEFT = 10; // 원본 TextPadding
  const OVERSCAN = 20;

  /** 작업 사본 파일을 고친다. line 이 없으면 작업 사본의 첫 변경 줄로 간다(원본 LineToOpen). */
  function editFile(path, line) {
    return open('editor', async (root, me) => {
      let file;
      try {
        file = await ctx.call('readText', { path });
      } catch (error) {
        if (me.closed) return;
        finish(me);
        if (/UTF-8·UTF-16/.test(error?.message ?? '')) {
          if (await confirmDialog({ title: '여기서 편집할 수 없음', glyph: 'pencil', message: `${path}은(는) UTF-8·UTF-16 글 파일이 아니어서 여기서 고치면 내용이 깨질 수 있습니다. 외부 편집기에서 열까요?`, ok: '외부 편집기에서 열기' })) ctx.openEditor(path, line ?? 1);
        } else {
          ctx.showError(error);
        }
        return;
      }
      if (me.closed) return;
      const lang = file.text.length < 400000 ? languageOf(path) : null;
      let saved = file.text;
      let saving = false;
      let moved = line != null;

      // 막대: 원본처럼 "이 파일 편집" 자리에 연필 + "편집 중" + [저장][취소][외부 편집기].
      const label = el('span', { class: 'ed-label', text: '편집 중' });
      const saveButton = el('button', { class: 'dbar-text outlined ed-save', text: '저장', 'data-tip': '고친 내용을 작업 사본 파일에 씁니다(Ctrl+S). 인코딩과 줄 끝은 원래대로 둡니다.', onclick: () => save() });
      root.append(
        el('div', { class: 'diff-bar ed-bar' },
          el('div', { class: 'dbar-left' },
            el('span', { class: 'ed-editing' }, icon('pencil', 14), label),
            saveButton,
            el('button', { class: 'dbar-text outlined', text: '취소', 'data-tip': '편집을 그만두고 diff 로 돌아갑니다(Esc).', onclick: () => close('cancel') }),
            el('button', { class: 'dbar-text outlined', text: '외부 편집기', 'data-tip': '코드 편집기에서 이 파일을 엽니다(보고 있는 줄로 갑니다).', onclick: () => ctx.openEditor(path, caretLine() + 1) }),
            el('div', { class: 'diff-title' }, fileIcon(path), el('span', { class: 'diff-path', text: path, 'data-tip': path }))),
          el('div', { class: 'dbar-right' }, el('button', { class: 'dbar-btn', 'data-tip': '닫기', onclick: () => close() }, icon('close', 14)))));

      const numbers = el('div', { class: 'ed-numbers' });
      const gutter = el('div', { class: 'ed-gutter' }, numbers);
      const currentLine = el('div', { class: 'ed-current' });
      const layer = el('div', { class: 'ed-layer', 'aria-hidden': 'true' });
      const textarea = el('textarea', { class: 'ed-input', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off' });
      textarea.value = file.text;
      const sizer = el('div', { class: 'ed-sizer' }, currentLine, layer, textarea);
      const scroller = el('div', { class: 'ed-scroll' }, sizer);
      const measure = el('span', { class: 'ed-measure', text: 'x'.repeat(100) });
      root.append(el('div', { class: 'ed-body' }, gutter, scroller, measure));

      let lines = [];
      let colored = null;
      let longest = 0;
      let charWidth = 7.2;
      let changed = new Set();
      let caret = 0;

      const dirty = () => textarea.value !== saved;
      const caretLine = () => {
        const v = textarea.value;
        let n = 0;
        for (let i = v.indexOf('\n'); i >= 0 && i < textarea.selectionStart; i = v.indexOf('\n', i + 1)) n++;
        return n;
      };
      const indentWidth = file.indent === '\t' ? 4 : file.indent.length || 4;

      /** 글이 바뀌면 줄·색칠·가장 긴 줄을 다시 잰다. */
      function reflow() {
        lines = textarea.value.split('\n');
        colored = lang ? highlight(textarea.value, lang) : null;
        longest = 0;
        for (const l of lines) {
          let w = l.length;
          if (l.includes('\t')) w += (l.split('\t').length - 1) * 3;
          if (w > longest) longest = w;
        }
        charWidth = measure.getBoundingClientRect().width / 100 || charWidth;
      }

      /** 보이는 줄만 그린다(원본처럼 수천 줄 파일에서도 타자가 느려지지 않게). */
      function draw() {
        const view = scroller.clientHeight;
        const height = lines.length * LH + Math.max(0, view * 0.5);
        const width = Math.max(scroller.clientWidth, TEXT_LEFT + longest * charWidth + 40);
        sizer.style.height = `${height}px`;
        sizer.style.width = `${width}px`;
        const top = scroller.scrollTop;
        const first = Math.max(0, Math.floor(top / LH) - OVERSCAN);
        const last = Math.min(lines.length, Math.ceil((top + view) / LH) + OVERSCAN);
        const html = [];
        const nums = [];
        for (let i = first; i < last; i++) {
          const text = lines[i];
          const body = colored ? colored[i] ?? '' : esc(text);
          const lead = text.match(/^[ \t]*/)[0];
          const shown = lead && body.startsWith(lead) ? `<span class="ed-ind">${lead}</span>${body.slice(lead.length)}` : body;
          html.push(`<div class="ed-line" style="top:${i * LH}px">${shown || ' '}</div>`);
          nums.push(`<div class="ed-ln${i === caret ? ' cur' : ''}${changed.has(i + 1) ? ' changed' : ''}" style="top:${i * LH - top}px">${i + 1}</div>`);
        }
        layer.innerHTML = html.join('');
        numbers.innerHTML = nums.join('');
        numbers.style.width = `calc(${Math.max(3, String(lines.length).length)}ch + 14px)`;
        currentLine.style.top = `${caret * LH}px`;
        const d = dirty();
        label.textContent = d ? '편집 중 · 저장 안 됨' : '편집 중';
        label.classList.toggle('dirty', d);
        saveButton.disabled = !d;
      }

      let frame = 0;
      const schedule = (textChanged) => {
        if (textChanged) reflow();
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(draw);
      };

      /** 커서가 보이게 스크롤한다. */
      function reveal() {
        caret = caretLine();
        const y = caret * LH;
        if (y < scroller.scrollTop) scroller.scrollTop = y;
        else if (y + LH > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + LH - scroller.clientHeight;
        const start = textarea.value.lastIndexOf('\n', textarea.selectionStart - 1) + 1;
        const before = textarea.value.slice(start, textarea.selectionStart).replace(/\t/g, '    ');
        const x = TEXT_LEFT + before.length * charWidth;
        if (x < scroller.scrollLeft + TEXT_LEFT) scroller.scrollLeft = Math.max(0, x - 40);
        else if (x > scroller.scrollLeft + scroller.clientWidth - 20) scroller.scrollLeft = x - scroller.clientWidth + 60;
        schedule(false);
      }

      /** 줄 n(0부터)으로 커서를 옮기고 몇 줄 위부터 보인다. */
      function goToLine(n) {
        const target = Math.max(0, Math.min(lines.length - 1, n));
        let at = 0;
        for (let i = 0; i < target; i++) at += lines[i].length + 1;
        textarea.setSelectionRange(at, at);
        caret = target;
        scroller.scrollTop = Math.max(0, (target - 3) * LH);
        schedule(false);
      }

      scroller.addEventListener('scroll', () => schedule(false));
      new ResizeObserver(() => schedule(false)).observe(scroller);
      textarea.addEventListener('input', () => {
        moved = true;
        schedule(true);
        requestAnimationFrame(reveal);
      });
      for (const type of ['keyup', 'click', 'select']) textarea.addEventListener(type, () => { moved = true; reveal(); });
      textarea.addEventListener('keydown', (event) => {
        const mod = event.metaKey || event.ctrlKey;
        if (isComposing(event)) return;
        if (mod && event.key.toLowerCase() === 's') {
          event.preventDefault();
          save();
        } else if (event.key === 'Tab') {
          event.preventDefault();
          indent(event.shiftKey);
        } else if (event.key === 'Enter' && !mod) {
          // 새 줄은 앞 줄 들여쓰기를 이어 받는다.
          event.preventDefault();
          const start = textarea.selectionStart;
          const lineStart = textarea.value.lastIndexOf('\n', start - 1) + 1;
          const lead = textarea.value.slice(lineStart, start).match(/^[ \t]*/)[0];
          document.execCommand('insertText', false, `\n${lead}`);
        }
      });
      // 오른쪽 버튼 메뉴(원본 GitCodeEditor 의 메뉴 + 외부 편집기에서 열기).
      textarea.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const selection = textarea.selectionStart !== textarea.selectionEnd;
        showMenu(event.clientX, event.clientY, [
          { label: '되돌리기', action: () => { textarea.focus(); document.execCommand('undo'); } },
          { label: '다시 실행', action: () => { textarea.focus(); document.execCommand('redo'); } },
          '-',
          { label: '잘라 내기', disabled: !selection, action: () => { textarea.focus(); document.execCommand('cut'); } },
          { label: '복사', disabled: !selection, action: () => { textarea.focus(); document.execCommand('copy'); } },
          {
            label: '붙여 넣기',
            action: async () => {
              textarea.focus();
              const text = await navigator.clipboard?.readText?.().catch(() => null);
              if (text != null) document.execCommand('insertText', false, text.replace(/\r\n?/g, '\n'));
              else document.execCommand('paste');
            },
          },
          '-',
          { label: '모두 선택', action: () => { textarea.focus(); textarea.select(); } },
          '-',
          { label: '외부 편집기에서 열기', action: () => ctx.openEditor(path, caretLine() + 1) },
        ]);
      });
      // Esc 는 원본 CancelEdit: 저장 안 한 편집이 있으면 버릴지만 묻는다. 창 전체 Esc(도구 닫기)보다 먼저 받는다.
      const onKey = (event) => {
        if (event.key !== 'Escape' || current !== me || isComposing(event)) return;
        if (document.querySelector('.modal-backdrop, .menu')) return;
        event.preventDefault();
        event.stopPropagation();
        close('cancel');
      };
      document.addEventListener('keydown', onKey, true);
      me.dispose = () => {
        cancelAnimationFrame(frame);
        document.removeEventListener('keydown', onKey, true);
      };

      function indent(outdent) {
        const unit = file.indent;
        const { selectionStart: s, selectionEnd: e, value } = textarea;
        const lineStart = value.lastIndexOf('\n', s - 1) + 1;
        if (!outdent && s === e) {
          document.execCommand('insertText', false, unit);
          return;
        }
        const block = value.slice(lineStart, e);
        const next = outdent
          ? block.split('\n').map((l) => (l.startsWith(unit) ? l.slice(unit.length) : l.replace(/^[ \t]/, ''))).join('\n')
          : block.split('\n').map((l) => unit + l).join('\n');
        textarea.setSelectionRange(lineStart, e);
        document.execCommand('insertText', false, next);
        textarea.setSelectionRange(lineStart, lineStart + next.length);
      }

      /** 작업 사본에서 바뀐 줄(초록 띠). 처음 열 때는 첫 변경 줄로 간다. */
      function loadChanged(first) {
        ctx.call('diff', { target: { kind: 'unstaged', path, untracked: false }, options: { context: 1000000 } }).then((doc) => {
          if (me.closed) return;
          changed = new Set(doc.lines.filter((l) => l.kind === 'added' && l.new > 0).map((l) => l.new));
          if (first && !moved) {
            const index = doc.lines.findIndex((l) => l.kind === 'added' || l.kind === 'removed');
            const target = index < 0 ? null : doc.lines.slice(index).find((l) => l.new > 0)?.new;
            if (target) goToLine(target - 1);
          }
          schedule(false);
        }).catch(() => {});
      }

      async function save(force = false) {
        if ((!dirty() && !force) || saving) return !dirty();
        saving = true;
        try {
          const text = textarea.value;
          file = await ctx.call('writeText', { path, text, original: file, force });
          saved = text;
          schedule(false);
          ctx.onSaved?.(path);
          loadChanged(false);
          return true;
        } catch (error) {
          if (error?.message === 'CHANGED_ON_DISK') {
            const choice = await choiceDialog({ title: '디스크의 파일이 바뀌었습니다', glyph: 'pencil', tone: 'warning', message: `편집을 시작한 뒤 다른 곳에서 ${path}이(가) 바뀌었습니다. 덮어쓰면 그 변경은 사라집니다.`, ok: '덮어쓰기', alt: '편집 버리고 다시 읽기' });
            if (me.closed) return false;
            saving = false;
            if (choice === 'ok') return save(true);
            if (choice === 'alt') await reloadFromDisk();
            textarea.focus();
            return false;
          }
          ctx.showError({ ...error, message: `${path}을(를) 쓰지 못했습니다.\n\n${error?.message ?? error}` });
          return false;
        } finally {
          saving = false;
        }
      }

      /** 디스크의 지금 파일로 다시 채운다(편집은 버린다). 글 파일이 아니게 되었으면 편집을 끝낸다. */
      async function reloadFromDisk() {
        const keep = caretLine();
        try {
          file = await ctx.call('readText', { path });
        } catch {
          finish(me);
          return;
        }
        textarea.value = file.text;
        saved = file.text;
        schedule(true);
        goToLine(keep);
        loadChanged(false);
      }

      // 다른 곳으로 떠날 때: 원본 AskToLeaveEdit([저장][버리기][취소]). 저장에 실패하면 남는다.
      me.beforeClose = async () => {
        if (!dirty()) return true;
        const choice = await choiceDialog({ title: '저장하지 않은 편집', glyph: 'pencil', message: `${path} 에 저장하지 않은 편집이 있습니다. 저장할까요?`, ok: '저장', alt: '버리기' });
        if (choice === 'ok') return save();
        if (choice !== 'alt') textarea.focus();
        return choice === 'alt';
      };
      // Esc·[취소]: 원본 CancelEdit(버릴지만 묻는다).
      me.beforeCancel = async () => {
        if (!dirty()) return true;
        const ok = await confirmDialog({ title: '저장하지 않은 편집', glyph: 'pencil', danger: true, message: `${path} 의 저장하지 않은 편집을 버릴까요?`, ok: '버리기' });
        if (!ok) textarea.focus();
        return ok;
      };

      reflow();
      draw();
      textarea.focus({ preventScroll: true });
      if (line != null) goToLine(line - 1);
      else textarea.setSelectionRange(0, 0);
      loadChanged(true);
    });
  }

  async function newFile(folder) {
    const { formDialog } = await import('./dialogs.js');
    const values = await formDialog({ title: '새 파일', glyph: 'file', message: `${folder}/ 에 만듭니다.`, fields: [{ name: 'name', placeholder: '이름.txt' }], ok: '만들기', validate: (v) => (!v.name.trim() ? '이름을 적어 주세요.' : /[\\:*?"<>|]/.test(v.name) ? '쓸 수 없는 글자가 있습니다.' : null) });
    if (!values) return;
    const path = `${folder}/${values.name.trim()}`;
    try {
      await ctx.call('createFile', { path });
      editFile(path, 1);
    } catch (error) {
      ctx.showError(error);
    }
  }

  // ── 이미지 diff(TL-04, 원본 GitImageDiffView) ──

  /** 두 판의 (판, 경로). 판 '' 은 작업 트리, ':0' 은 인덱스. */
  function revisions(target) {
    const old = target.originalPath ?? target.path;
    switch (target.kind) {
      case 'staged': return [['HEAD', old], [':0', target.path]];
      case 'commit': return [[`${target.hash}^`, old], [target.hash, target.path]];
      case 'range': return [[target.from, old], [target.to ?? '', target.path]];
      default: return [target.untracked ? null : [':0', target.path], ['', target.path]];
    }
  }

  /** 판 이름(원본 GitDiffService.LabelOf): 인덱스는 Staged, 작업 트리는 작업 사본, 해시는 7자리. */
  const revisionLabel = (rev) => (!rev ? '없음' : rev[0] === '' ? '작업 사본' : rev[0] === ':0' ? 'Staged' : shortRevision(rev[0]));

  async function loadImage(rev) {
    if (!rev) return null;
    try {
      const data = await ctx.call('fileBytes', { revision: rev[0], path: rev[1] });
      const img = new Image();
      img.src = `data:${data.mime === 'application/octet-stream' ? 'image/png' : data.mime};base64,${data.base64}`;
      await img.decode();
      const ext = rev[1].match(/\.[^./]+$/)?.[0] ?? '';
      return { img, w: img.naturalWidth, h: img.naturalHeight, size: data.size, format: ext.toLowerCase(), label: revisionLabel(rev) };
    } catch {
      return null;
    }
  }

  /** 원본 GitImageDiff.FormatBytes: 512 B, 34.2 KB, 1.5 MB. */
  const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1).replace(/\.0$/, '')} KB` : `${(n / 1048576).toFixed(1).replace(/\.0$/, '')} MB`);
  const pixelsOf = (side, w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (side) g.drawImage(side.img, 0, 0);
    return g.getImageData(0, 0, w, h).data;
  };

  /**
   * 차이 이미지(원본 GitImageDiff.Compare·InvertedDifference). 같으면 흰색, 둘 다 그려진 곳은 255 − 8×(이전 − 이후),
   * 한쪽에만 있는 곳은 있는 쪽 색의 보색. 큰 이미지에서도 멈추지 않게 줄 묶음마다 쉬며 한 번만 계산한다.
   */
  async function compareImages(a, b, alive) {
    const w = Math.max(a.w, b.w);
    const h = Math.max(a.h, b.h);
    const pa = pixelsOf(a, w, h);
    const pb = pixelsOf(b, w, h);
    const mask = new ImageData(w, h);
    const out = mask.data;
    let changed = 0;
    const channel = (x, ax, y, ay, overlap) => {
      const d = Math.trunc((x * ax) / 255) - Math.trunc((y * ay) / 255);
      return Math.max(0, Math.min(255, overlap ? 255 - 8 * d : 255 - Math.abs(d)));
    };
    for (let row = 0; row < h; row++) {
      for (let x = 0; x < w; x++) {
        const hasA = x < a.w && row < a.h;
        const hasB = x < b.w && row < b.h;
        if (!hasA && !hasB) continue;
        const i = (row * w + x) * 4;
        const [r1, g1, b1, a1] = hasA ? [pa[i], pa[i + 1], pa[i + 2], pa[i + 3]] : [0, 0, 0, 0];
        const [r2, g2, b2, a2] = hasB ? [pb[i], pb[i + 1], pb[i + 2], pb[i + 3]] : [0, 0, 0, 0];
        const different = hasA !== hasB || (!(a1 === 0 && a2 === 0) && (r1 !== r2 || g1 !== g2 || b1 !== b2 || a1 !== a2));
        if (different) changed++;
        const alpha = Math.max(a1, a2);
        if (!alpha) continue;
        const overlap = a1 > 0 && a2 > 0;
        out[i] = channel(r1, a1, r2, a2, overlap);
        out[i + 1] = channel(g1, a1, g2, a2, overlap);
        out[i + 2] = channel(b1, a1, b2, a2, overlap);
        out[i + 3] = alpha;
      }
      if (row % 64 === 63) {
        await new Promise((resolve) => setTimeout(resolve));
        if (!alive()) return null;
      }
    }
    const canvas = el('canvas', { width: w, height: h });
    canvas.getContext('2d').putImageData(mask, 0, 0);
    return { canvas, changed, total: w * h };
  }

  /** diff 보기가 이미지 파일이면 부른다. 그림을 그렸으면 true. */
  async function imageDiff(target, container, diffState) {
    const [before, after] = await Promise.all(revisions(target).map(loadImage));
    if (!before && !after) return false;
    const single = !before || !after;
    const MODES = { twoUp: '나란히 보기', swipe: '스와이프', onion: '겹쳐 보기', difference: '차이 강조' };
    const stored = ctx.prefs.get('image.mode');
    let mode = MODES[stored] ? stored : stored === 'diff' || stored === 'invert' ? 'difference' : 'twoUp';
    let zoom = 1;
    let pan = { x: 0, y: 0 };
    let isFit = true;
    let swipe = 0.5;
    let opacity = 0.5;
    let showProps = !!ctx.prefs.get('image.props');
    let viewports = [];
    let diffResult = null;
    const token = {};
    diffState.imageToken = token;
    const alive = () => diffState.imageToken === token && container.isConnected;
    const W = Math.max(before?.w ?? 0, after?.w ?? 0);
    const H = Math.max(before?.h ?? 0, after?.h ?? 0);
    const zoomTip = '휠로 확대·축소, 끌어서 이동, 두 번 클릭하면 화면에 맞춥니다.';

    // 위 막대: 파일 · 상태 · 닫기(코드 diff 막대 자리).
    const bar = el('div', { class: 'diff-bar' },
      el('div', { class: 'dbar-left' }, el('div', { class: 'diff-title' }, fileIcon(target.path), el('span', { class: 'diff-path', text: target.path, 'data-tip': target.path }),
        el('span', { class: 'diff-state muted small', text: before && after ? '수정' : before ? '삭제' : '추가' }))),
      el('div', { class: 'dbar-right' }, el('button', { class: 'dbar-btn', 'data-tip': '닫기 (Esc)', onclick: () => diffState.api.close() }, icon('close', 14))));
    // 보기 막대: [나란히 보기|스와이프|겹쳐 보기|차이 강조] (불투명도)   151% [화면에 맞춤|100%] [속성 보기]
    const modeButtons = Object.entries(MODES).map(([key, text]) => el('button', { class: 'dbar-text', text, onclick: () => { mode = key; ctx.prefs.set('image.mode', key); syncModes(); build(); } }));
    const slider = el('input', { type: 'range', min: 0, max: 100, value: 50, class: 'img-slider' });
    slider.addEventListener('input', () => { opacity = slider.value / 100; layout(); });
    const sliderBox = el('label', { class: 'img-opacity' }, el('span', { text: '불투명도' }), slider);
    const zoomLabel = el('span', { class: 'img-zoom', 'data-tip': zoomTip });
    const propsButton = el('button', { class: `dbar-text outlined img-props-btn${showProps ? ' on' : ''}`, text: '속성 보기', 'data-tip': '이전·이후 파일의 크기·형식·해상도를 아래에 나란히 보여 줍니다.', onclick: () => { showProps = !showProps; ctx.prefs.set('image.props', showProps); propsButton.classList.toggle('on', showProps); renderProps(); } });
    const toolbar = el('div', { class: 'diff-bar img-toolbar' },
      single ? null : el('div', { class: 'img-modes' }, el('div', { class: 'dbar-seg' }, modeButtons), sliderBox),
      el('span', { class: 'spacer' }),
      zoomLabel,
      el('div', { class: 'dbar-seg' }, el('button', { class: 'dbar-text', text: '화면에 맞춤', 'data-tip': zoomTip, onclick: fit }), el('button', { class: 'dbar-text', text: '100%', onclick: () => zoomAt(1, center()) })),
      propsButton);
    // 정보 줄: 크기 변경 · 바뀐 픽셀 수.
    const sizeChanged = el('span', { class: 'img-size-changed', text: '크기가 바뀜', hidden: single || (before.w === after.w && before.h === after.h) });
    const changedInfo = el('span', { class: 'img-changed', text: '차이를 계산하는 중…' });
    const info = el('div', { class: 'img-info', hidden: single }, sizeChanged, changedInfo);
    const stage = el('div', { class: 'img-stage' });
    const props = el('div', { class: 'img-props' });
    const propsSplit = el('div', { class: 'img-props-split' }, el('div', { class: 'img-props-line' }));
    container.replaceChildren(bar, toolbar, info, stage, propsSplit, props);

    function syncModes() {
      modeButtons.forEach((b, i) => b.classList.toggle('on', Object.keys(MODES)[i] === mode));
      sliderBox.hidden = mode !== 'onion';
    }

    const imgOf = (side) => {
      const node = side.img.cloneNode();
      node.className = 'img-layer';
      node.draggable = false;
      return node;
    };
    const place = (node, left, top, width, height) => Object.assign(node.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });

    /** 뷰포트 하나(원본 Viewport): 체커 바탕 · 이미지 층 · 왼쪽 위 캡션. */
    function viewport(caption) {
      const root = el('div', { class: 'img-vp' });
      const backdrop = el('div', { class: 'img-layer img-checker' });
      const content = el('div', { class: 'img-layer' });
      root.append(backdrop, content, el('span', { class: 'img-caption', text: caption }));
      const vp = { root, backdrop, content, layers: {} };
      root.addEventListener('wheel', (event) => {
        event.preventDefault();
        const r = root.getBoundingClientRect();
        zoomAt(zoom * (event.deltaY > 0 ? 1 / 1.15 : 1.15), { x: event.clientX - r.left, y: event.clientY - r.top });
      }, { passive: false });
      root.addEventListener('dblclick', fit);
      root.addEventListener('contextmenu', (event) => event.preventDefault());
      root.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 && event.button !== 2) return;
        if (event.target.closest('.img-swipe')) return;
        root.setPointerCapture(event.pointerId);
        const start = { x: event.clientX, y: event.clientY };
        const from = { ...pan };
        root.classList.add('panning');
        const move = (ev) => {
          pan = { x: from.x + ev.clientX - start.x, y: from.y + ev.clientY - start.y };
          isFit = false;
          layout();
        };
        const up = () => {
          root.classList.remove('panning');
          root.removeEventListener('pointermove', move);
          root.removeEventListener('pointerup', up);
        };
        root.addEventListener('pointermove', move);
        root.addEventListener('pointerup', up);
      });
      return vp;
    }

    function build() {
      if (single) {
        const side = after ?? before;
        const vp = viewport(side.label);
        vp.layers.bottom = [imgOf(side), side];
        vp.content.append(vp.layers.bottom[0]);
        vp.root.classList.add(after ? 'added' : 'deleted');
        vp.backdrop.classList.add('framed');
        vp.root.append(el('span', { class: 'img-status', text: after ? '추가됨' : '삭제됨' }));
        viewports = [vp];
      } else if (mode === 'twoUp') {
        const left = viewport(`이전 · ${before.label}`);
        const right = viewport(`이후 · ${after.label}`);
        left.root.classList.add('left');
        left.layers.bottom = [imgOf(before), before];
        right.layers.bottom = [imgOf(after), after];
        left.content.append(left.layers.bottom[0]);
        right.content.append(right.layers.bottom[0]);
        viewports = [left, right];
      } else if (mode === 'swipe') {
        // 경계선 왼쪽은 이전만, 오른쪽은 이후만 — 두 층을 각각 잘라 겹치지 않게 한다.
        const vp = viewport(`이전 · ${before.label}  |  이후 · ${after.label}`);
        const leftClip = el('div', { class: 'img-layer img-clip' }, imgOf(before));
        const rightImg = imgOf(after);
        const rightClip = el('div', { class: 'img-layer img-clip' }, rightImg);
        vp.content.append(leftClip, rightClip);
        const handle = el('div', { class: 'img-swipe' }, el('span', { class: 'img-swipe-line' }), el('span', { class: 'img-swipe-knob' }, el('span', { class: 'png-icon', style: { '--png': 'url(icons/SwipeArrows.png)' } })));
        handle.addEventListener('pointerdown', (event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          handle.setPointerCapture(event.pointerId);
          const move = (ev) => {
            const r = vp.root.getBoundingClientRect();
            if (W * zoom > 0) swipe = Math.min(1, Math.max(0, (ev.clientX - r.left - pan.x) / (W * zoom)));
            layout();
          };
          const up = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
          };
          handle.addEventListener('pointermove', move);
          handle.addEventListener('pointerup', up);
        });
        vp.root.append(handle);
        vp.layers.swipe = { leftClip, rightClip, rightImg, handle };
        viewports = [vp];
      } else if (mode === 'onion') {
        const vp = viewport(`이전 · ${before.label}  →  이후 · ${after.label}`);
        vp.layers.bottom = [imgOf(before), before];
        vp.layers.onion = [imgOf(after), after];
        vp.content.append(vp.layers.bottom[0], vp.layers.onion[0]);
        viewports = [vp];
      } else {
        const vp = viewport('차이 강조');
        vp.layers.difference = el('div', { class: 'img-layer' });
        if (diffResult) vp.layers.difference.append(diffResult.canvas);
        vp.content.append(vp.layers.difference);
        viewports = [vp];
      }
      stage.replaceChildren(...viewports.map((v) => v.root));
      if (isFit) requestAnimationFrame(fit);
      else layout();
    }

    function size() {
      const r = viewports[0]?.root.getBoundingClientRect();
      return r ? { w: r.width, h: r.height } : { w: 0, h: 0 };
    }
    function center() {
      const s = size();
      return { x: s.w / 2, y: s.h / 2 };
    }
    /** 뷰포트에 다 들어오게 맞추고 가운데에 둔다. 작은 이미지(아이콘 등)는 8배까지 키운다(원본 Fit). */
    function fit() {
      isFit = true;
      const s = size();
      if (s.w > 0 && s.h > 0 && W && H) {
        zoom = Math.max(0.02, Math.min(8, Math.min((s.w - 16) / W, (s.h - 16) / H)));
        pan = { x: (s.w - W * zoom) / 2, y: (s.h - H * zoom) / 2 };
      }
      layout();
    }
    /** 커서 자리를 기준으로 확대·축소(원본 ZoomAt). */
    function zoomAt(next, anchor) {
      next = Math.max(0.02, Math.min(64, next));
      const content = { x: (anchor.x - pan.x) / zoom, y: (anchor.y - pan.y) / zoom };
      zoom = next;
      pan = { x: anchor.x - content.x * zoom, y: anchor.y - content.y * zoom };
      isFit = false;
      layout();
    }
    function layout() {
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      const width = W * zoom;
      const height = H * zoom;
      for (const vp of viewports) {
        place(vp.backdrop, pan.x, pan.y, width, height);
        place(vp.content, pan.x, pan.y, width, height);
        const { bottom, onion, swipe: sw, difference } = vp.layers;
        if (bottom) place(bottom[0], 0, 0, bottom[1].w * zoom, bottom[1].h * zoom);
        if (onion) {
          // 교차 페이드: 이후는 불투명도만큼, 이전은 그 반대로(이후의 투명한 곳으로 이전이 비치지 않게).
          place(onion[0], 0, 0, onion[1].w * zoom, onion[1].h * zoom);
          onion[0].style.opacity = opacity;
          bottom[0].style.opacity = 1 - opacity;
        }
        if (difference) {
          place(difference, 0, 0, width, height);
          const canvas = difference.firstChild;
          if (canvas) Object.assign(canvas.style, { width: `${width}px`, height: `${height}px` });
        }
        if (sw) {
          const split = width * swipe;
          place(sw.leftClip, 0, 0, split, height);
          place(sw.leftClip.firstChild, 0, 0, before.w * zoom, before.h * zoom);
          place(sw.rightClip, split, 0, Math.max(0, width - split), height);
          place(sw.rightImg, -split, 0, after.w * zoom, after.h * zoom);
          sw.handle.style.left = `${pan.x + split - 6}px`;
        }
      }
    }

    /** 아래 속성 칸(원본 "Show properties"): 판마다 크기·형식·해상도, 다른 값은 강조. 위 경계를 끌어 높이를 바꾼다. */
    function renderProps() {
      props.hidden = !showProps;
      propsSplit.hidden = !showProps;
      if (!showProps) return;
      props.style.height = `${ctx.prefs.get('image.propsHeight') ?? 90}px`;
      const values = (s) => [`크기: ${formatBytes(s.size)} (${s.size.toLocaleString('en-US')}바이트)`, `형식: ${s.format || '-'}`, `해상도: ${s.w}×${s.h}`];
      const column = (side, other, kind) => {
        const own = values(side);
        const theirs = other ? values(other) : null;
        return el('div', { class: 'img-prop-col' }, el('div', { class: 'img-prop-head', text: side.label }),
          own.map((v, i) => el('div', { class: `img-prop${theirs && theirs[i] !== v ? ` changed ${kind}` : ''}` }, el('span', { class: 'img-prop-n', text: i + 1 }), el('span', { class: 'img-prop-v', text: v }))));
      };
      props.replaceChildren(...(single ? [column(after ?? before, null)] : [column(before, after, 'before'), el('div', { class: 'img-prop-gutter' }), column(after, before, 'after')]));
    }
    propsSplit.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      propsSplit.setPointerCapture(event.pointerId);
      const startY = event.clientY;
      const startHeight = props.getBoundingClientRect().height;
      const available = stage.getBoundingClientRect().height + startHeight;
      const move = (ev) => {
        props.style.height = `${Math.max(40, Math.min(Math.max(40, available - 80), startHeight - (ev.clientY - startY)))}px`;
      };
      const up = () => {
        propsSplit.removeEventListener('pointermove', move);
        propsSplit.removeEventListener('pointerup', up);
        ctx.prefs.set('image.propsHeight', Math.round(props.getBoundingClientRect().height));
      };
      propsSplit.addEventListener('pointermove', move);
      propsSplit.addEventListener('pointerup', up);
    });

    new ResizeObserver(() => { if (alive()) (isFit ? fit() : layout()); }).observe(stage);
    syncModes();
    renderProps();
    build();
    if (!single) {
      // 차이는 무거울 수 있어 한 번만, 쉬어 가며 계산한다. 그 사이 다른 파일을 열면 버린다.
      compareImages(before, after, alive).then((result) => {
        if (!result || !alive()) return;
        diffResult = result;
        changedInfo.textContent = result.changed === 0 ? '바뀐 픽셀이 없습니다'
          : `바뀐 픽셀 ${result.changed.toLocaleString('en-US')}개 / 전체 ${result.total.toLocaleString('en-US')}개 (${+((result.changed / result.total) * 100).toFixed(2)}%)`;
        changedInfo.classList.toggle('changed', result.changed > 0);
        for (const vp of viewports) {
          if (vp.layers.difference) vp.layers.difference.replaceChildren(result.canvas);
        }
        layout();
      });
    }
    return true;
  }

  return {
    fileHistory, blame, compare, editFile, newFile, imageDiff,
    /** 닫는다. 저장 안 한 편집이 있으면 묻고, 사용자가 취소하면 false 로 끝난다. mode 'cancel' 은 버릴지만 묻는다(원본 Esc). */
    close: (mode) => close(mode),
    get isOpen() { return current != null; },
    get kind() { return current?.kind ?? null; },
  };
}
