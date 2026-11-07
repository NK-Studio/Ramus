// 가운데 칸의 diff 보기. 원본 Elements/GitDiffPanel.cs 를 옮겼다. 변경 목록·커밋 파일을 누르면 그래프 대신 열린다. Esc·× 로 그래프로 돌아간다.
//
// 제목 줄(32px): [경로][+n][−n][비교하는 두 판] … [다시 읽기][×].
// 막대(32px): [이 파일 편집] · 가운데 [파일 보기 | Diff 보기] · 오른쪽 [Blame | 히스토리] [↑ | ↓] [Hunk | Inline | Split] [−≡ | +≡] [↕] [공백 | 줄바꿈].
// 좁아지면 단계적으로 줄인다. Hunk 는 늘 바뀐 곳과 문맥 n줄, Inline·Split(Fork 식 포함)은 ↕(파일 전체 보기, 기본 켬)를 끄면 문맥 n줄만, 파일 보기는 파일 전체.
// 줄은 보이는 것만 그린다(가상화) — 10만 줄도 바로 열린다. 줄 글은 문법 색으로 칠한다(옛 판·새 판을 따로 이어 훑는다).
// 부분 Stage(GitKraken 식): 거터 [+] = 이 줄(고른 줄 중 하나면 고른 줄 전부, Split 이면 같은 행의 짝도), 거터·줄 번호를 끌어 범위, Shift+클릭 늘리기, ⌘/Ctrl 하나씩,
// Hunk 보기 머리 줄의 [변경된 묶음 버리기][변경된 묶음 Stage]. 코드 글을 끌어 고르면 그 줄을 띠로 감싸고 [Stage | 되돌리기…] 를 띄운다.
// Fork 배치는 보기를 Inline 으로 고정하고, 마우스를 올린 변경 덩어리(위아래 2줄 포함)를 띠로 감싸 [Stage | 되돌리기…] 를 띄운다.
// 고른 줄은 Rust 의 DiffDocument.lines 인덱스 그대로이고 diff 지문(fingerprint)과 함께 보낸다 — 그 사이 파일이 바뀌면 Rust 가 거절한다.

import { el, isComposing } from './util.js';
import { icon } from './icons.js';
import { showMenu } from './dialogs.js';
import { fileIcon } from './files.js';
import { languageOf, tokenize, STATE_NORMAL } from './syntax.js';

const ROW = 18;
const HUNK_ROW = 30;
const OVERSCAN = 30;
const FULL_CONTEXT = 1000000;
const WRAP_LIMIT = 20000;
const JUMP_MARGIN = 2;
const HOVER_CONTEXT = 2;
const LOADING_DELAY = 250;
// 막대가 이보다 좁으면 단계적으로 줄인다(원본 CompactBarWidth…MicroBarWidth).
const BAR_STEPS = [['compact', 820], ['narrow', 690], ['tiny', 560], ['micro', 470]];
/** 문맥 줄 −/+ 가 오가는 단계(원본 GitDiffPanel.ContextSteps, Fork 처럼 한 번에 한 칸). */
const CONTEXT_STEPS = [0, 1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 100];
/** 이보다 줄이 많은 diff 는 칠하지 않는다(처음 열 때 모든 줄을 한 번 훑는다, 원본 MaxSyntaxLines). */
const MAX_SYNTAX_LINES = 50000;
/** 이보다 긴 줄은 이만큼만 그린다(VS Code 의 stopRenderingLineAfter 와 같은 뜻). */
const MAX_LINE_CHARS = 10000;
/** 긴 줄의 바뀐 곳이 뒤에 있으면 그 앞 이만큼부터 보인다. */
const LONG_LINE_LEAD = 1000;

/** current 에서 direction(−1·+1) 쪽 다음 단계. 끝이면 그대로. 단계 밖의 값이면 바로 위·아래 단계로(원본 NextContextStep). */
export function nextContextStep(current, direction) {
  if (direction < 0) {
    for (let i = CONTEXT_STEPS.length - 1; i >= 0; i--) if (CONTEXT_STEPS[i] < current) return CONTEXT_STEPS[i];
    return current;
  }
  return CONTEXT_STEPS.find((step) => step > current) ?? current;
}

const isChange = (line) => line?.kind === 'added' || line?.kind === 'removed';

/** 원본 Icons/Diff*.png 를 테마 글자색으로 물들인 아이콘. */
const pngIcon = (name) => el('span', { class: 'png-icon', style: { '--png': `url(icons/${name}.png)` } });

/** 막대 버튼: 아이콘·글자 중 하나 또는 둘 다(원본 BarButton). */
function barButton(onClick, tip, iconName, text, { on = false, disabled = false, cls = '' } = {}) {
  return el('button', { class: `dbar-btn${iconName && !text ? ' icon-only' : ''}${on ? ' on' : ''}${cls ? ` ${cls}` : ''}`, 'data-tip': tip, disabled, onclick: onClick },
    iconName ? pngIcon(iconName) : null, text ? el('span', { class: `dbar-label${iconName ? ' with-icon' : ''}`, text }) : null);
}

/** 막대 안의 묶음이 제 칸을 넘치는지. 오른쪽 칸은 끝 맞춤이라 왼쪽으로 넘쳐 scrollWidth 에 잡히지 않으니, 자식들이 차지한 폭을 잰다. */
function barOverflows(bar) {
  if (bar.scrollWidth > bar.clientWidth + 0.5) return true;
  const sides = [...bar.children];
  for (let i = 0; i < sides.length; i++) {
    const kids = [...sides[i].children].filter((k) => k.offsetParent !== null);
    if (!kids.length) continue;
    const box = sides[i].getBoundingClientRect();
    const left = kids[0].getBoundingClientRect().left;
    const right = kids[kids.length - 1].getBoundingClientRect().right;
    if (left < box.left - 0.5 || right > box.right + 0.5) return true;
    // 이웃 칸과 겹치는지(가운데 칸의 여백까지 먹으면 묶음 테두리가 맞붙는다).
    const next = sides[i + 1]?.getBoundingClientRect();
    if (next && box.right > next.left + 0.5) return true;
  }
  return false;
}

/** 한 테두리 안의 칸 묶음([파일 보기|Diff 보기]·[↑|↓] 등). */
const segment = (cls, buttons) => el('div', { class: `dbar-seg ${cls}` }, buttons);

/** "242 KB" (원본 GitImageDiff.FormatBytes). */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const fmt = (n) => String(Math.round(n * 10) / 10);
  return bytes < 1024 * 1024 ? `${fmt(bytes / 1024)} KB` : `${fmt(bytes / (1024 * 1024))} MB`;
}

/**
 * 줄 글. 글자 단위(코드 포인트)로 [start, start+len) 을 강조하고, 문법 색 조각(spans, UTF-16 위치)을 sx-갈래 로 칠한다.
 * 공백 보이기면 공백·탭을 흐린 · → 로. 강조·색·공백이 겹쳐도 셋 다 남는다(원본 RenderSelected).
 */
/** 글자(code point) 위치 → 문자열(UTF-16) 위치. Rust 가 주는 바뀐 구간은 글자 단위다. */
function utf16Offset(text, codePoints, from = 0, fromCp = 0) {
  let i = from;
  for (let n = fromCp; n < codePoints && i < text.length; n++) i += text.codePointAt(i) > 0xffff ? 2 : 1;
  return i;
}

/** 바뀐 구간(글자 start·len) → 문자열 위치 [from, to). 없으면 [0, 0]. */
function changeRange(text, start, len) {
  if (!len) return [0, 0];
  const from = utf16Offset(text, start);
  return [from, utf16Offset(text, start + len, from, start)];
}

function lineText(text, start, len, showWs, spans) {
  const [from, to] = changeRange(text, start, len);
  return lineTextRange(text, from, to, showWs, spans);
}

/** 줄 글 조각들. [from, to) 는 바뀐 구간(문자열 위치, 같으면 없음), spans 는 문법 색. */
function lineTextRange(text, from, to, showWs, spans) {
  const len = to - from;
  const cuts = new Set([0, text.length]);
  if (len) cuts.add(from).add(to);
  for (const sp of spans ?? []) cuts.add(sp.start).add(Math.min(text.length, sp.start + sp.length));
  const points = [...cuts].filter((x) => x >= 0 && x <= text.length).sort((a, b) => a - b);
  const out = [];
  let k = 0;
  for (let p = 0; p + 1 < points.length; p++) {
    const a = points[p];
    const b = points[p + 1];
    while (k < (spans?.length ?? 0) && spans[k].start + spans[k].length <= a) k++;
    const kind = spans && k < spans.length && spans[k].start <= a ? spans[k].kind : null;
    const cls = [kind ? `sx-${kind}` : '', len && a >= from && b <= to ? 'chg' : ''].filter(Boolean).join(' ');
    const part = text.slice(a, b);
    const pieces = showWs ? part.split(/([ \t]+)/).filter((x) => x) : [part];
    const nodes = pieces.map((x) => (showWs && /^[ \t]+$/.test(x) ? el('span', { class: 'ws', text: x.replace(/ /g, '·').replace(/\t/g, '→\t') }) : x));
    out.push(cls ? el('span', { class: cls }, nodes) : nodes);
  }
  return out.flat();
}

/**
 * diff 보기를 만든다. `api` 는 app.js 가 주는 함수들:
 * load(target, options), applyLines(action, target, fingerprint, lines, context), close, prefs,
 * edit(target), blame(target), history(target), openEditor(target, line), lfsPull(target) → 실패 글|null, chooseAccount(), imageDiff(target, container) → bool
 */
export function createDiffView(container) {
  let state = null;
  let body = null;
  let rowsHost = null;
  let rows = []; // 그릴 줄: {type:'hunk', index, hunk} | {type:'line', index, hunk} | {type:'split', left, right, hunk} | {type:'meta', index}
  let tops = [0]; // 행마다 위 끝(px). tops[r+1]-tops[r] = 행 높이(Hunk 보기의 머리 줄은 30px).
  let changeBlocks = []; // 바뀐 덩어리의 첫 행 번호
  let lineToRow = new Map(); // 문서 줄 → 행
  let hoverGroup = null; // Fork 식: 마우스를 올린 변경 덩어리 [첫 행, 끝 행]
  let dragging = null;
  /** 직전에 읽은 파일이 글이었는가(다음 파일을 읽는 동안 툴바 모양을 정하는 데 쓴다). */
  let lastWasText = true;

  let slowTimer = 0;
  let lastJumpRow = -1;
  let actionLines = [];

  const prefs = () => state.api.prefs;
  // 보이는 보기: Fork 식은 늘 Inline·Diff 보기.
  const shownView = () => (state.fork ? 'inline' : state.view);
  const shownFileView = () => !state.fork && state.fileView;
  /** 설정의 문맥 줄 수(Preferences 의 "문맥 줄 수" 와 같은 값). */
  const contextLines = () => prefs().get('diff.context') ?? 3;
  /** ↕ 가 뜻이 있는 보기인지: 파일 보기·Hunk 보기가 아닐 때. Fork 식은 늘 Inline 이라 늘 뜻이 있다(원본 EntireFileApplies). */
  const entireFileApplies = () => !shownFileView() && shownView() !== 'hunk';
  /** 지금 보기가 파일 전체를 읽는지(문맥 줄 수가 쓰이지 않는지, 원본 ShowsEntireFile). */
  const showsEntireFile = () => shownFileView() || (entireFileApplies() && state.entire);
  const contextFor = () => (showsEntireFile() ? FULL_CONTEXT : contextLines());
  /**
   * 열려 있지 않을 때, 다음에 열면 읽을 옵션(문맥 줄 수·공백 무시). 미리 읽기(마우스를 올린 파일)가 같은 옵션으로 읽어 두어야
   * 누를 때 캐시에 맞는다. open() 이 설정에서 상태를 만드는 규칙과 같아야 한다.
   */
  function expectedLoad(p, layout) {
    const fork = document.body.dataset.layout === 'fork';
    const view = p.get('diff.view') ?? (layout === 'split' ? 'split' : 'hunk');
    const fileView = !fork && !!p.get('diff.fileView');
    const applies = !fileView && (fork ? 'inline' : view) !== 'hunk';
    const entire = fileView || (applies && (p.get('diff.entireFile') ?? true));
    return { context: entire ? FULL_CONTEXT : (p.get('diff.context') ?? 3), ignoreWhitespace: !!p.get('diff.ignoreWhitespace') };
  }
  /** 줄·hunk 단위 Stage·Unstage 가 되는지. 공백을 무시한 diff 는 줄 내용이 인덱스와 달라 패치가 붙지 않으므로 뺀다. */
  const canStageLines = () => (state.mode === 'unstaged' || state.mode === 'staged') && !state.ignoreWs && !!state.doc && !state.doc.binary;
  /** 거터·줄 번호로 줄을 고르는지: 위 조건에 더해 Diff 보기에서만(파일 보기는 지운 줄을 숨겨 고를 줄이 반쪽이다). */
  const canPartial = () => canStageLines() && !shownFileView();
  /** 버리기: 작업 사본의 변경이고 git 이 이미 아는 파일일 때만. */
  const canDiscard = () => canStageLines() && state.mode === 'unstaged' && !state.target.untracked;
  const unstage = () => state.mode === 'staged';
  // ↕ 를 끈 Inline·Split 도 머리 줄에 버튼이 들어가 높인다. Fork 식은 머리 줄 버튼 대신 떠 있는 버튼을 쓴다.
  const tallHunks = () => !shownFileView() && !state.fork && canPartial() && (shownView() === 'hunk' || contextFor() !== FULL_CONTEXT);
  const isWrap = () => state.wrap && rows.length <= WRAP_LIMIT;

  function open(options) {
    const p = options.api.prefs;
    state = {
      ...options,
      doc: null,
      selected: new Set(),
      anchor: null,
      error: null,
      view: p.get('diff.view') ?? (options.layout === 'split' ? 'split' : 'hunk'),
      fileView: !!p.get('diff.fileView'),
      showWs: !!p.get('diff.whitespace'),
      wrap: !!p.get('diff.wrap'),
      ignoreWs: !!p.get('diff.ignoreWhitespace'),
      entire: p.get('diff.entireFile') ?? true,
      fork: document.body.dataset.layout === 'fork',
      lfs: { busy: false, failure: null },
      loading: true,
      scrollTop: true,
    };
    // 이미지 diff 에서 [글로 보기] 를 누르면 텍스트 diff 로.
    state.showText = () => {
      state.forceText = true;
      state.image = false;
      state.doc = null;
      render();
      reload();
    };
    hoverGroup = null;
    lastJumpRow = -1;
    render();
    reload();
  }

  async function reload() {
    if (!state) return;
    const current = state;
    clearTimeout(slowTimer);
    // 늦을 때만 내용 위에 "불러오는 중" 을 겹친다 — 본문을 갈아 끼워 깜빡이지 않게.
    slowTimer = setTimeout(() => container.querySelector('.diff-loading')?.removeAttribute('hidden'), LOADING_DELAY);
    try {
      if (state.api.imageDiff && /\.(png|jpe?g|gif|bmp|webp|tga|psd)$/i.test(state.target.path) && !state.forceText) {
        const handled = await state.api.imageDiff(state.target, container, state);
        if (handled && state === current) {
          clearTimeout(slowTimer);
          current.image = true;
          lastWasText = false;
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
      current.anchor = null;
      current.doc = doc;
      current.syntax = syntaxStates(doc.lines, current.target.path);
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

  // ── 문법 색 ──

  /**
   * 줄마다 칠하기 시작할 상태(앞 줄의 블록 주석·<script> 안 등)를 미리 구한다(원본 UpdateSyntaxStates).
   * 옛 판(지운 줄)과 새 판(더한 줄)은 따로 이어서 훑고, 바뀌지 않은 줄은 새 판 상태로 칠한 뒤 두 판을 같은 상태로 맞춘다.
   * 묶음(@@) 머리 줄에서는 앞 내용을 모르므로 보통 상태로 돌아간다. 칠하지 않는 파일이면 null.
   */
  function syntaxStates(lines, path) {
    const language = lines.length > MAX_SYNTAX_LINES ? null : languageOf(path);
    if (!language) return null;
    const states = new Array(lines.length);
    let oldState = STATE_NORMAL;
    let newState = STATE_NORMAL;
    lines.forEach((line, i) => {
      if (line.kind === 'removed') {
        states[i] = oldState;
        oldState = tokenize(line.text ?? '', language, oldState).state;
      } else if (line.kind === 'added') {
        states[i] = newState;
        newState = tokenize(line.text ?? '', language, newState).state;
      } else if (line.kind === 'context') {
        states[i] = newState;
        newState = tokenize(line.text ?? '', language, newState).state;
        oldState = newState;
      } else if (line.kind === 'hunk') {
        oldState = STATE_NORMAL;
        newState = STATE_NORMAL;
      }
    });
    return { language, states };
  }

  /** 이 줄의 문법 색 조각(칠하지 않는 파일이면 없음). end 를 주면 그 앞까지만 칠한다(긴 줄). */
  function syntaxSpans(i, end) {
    const syntax = state.syntax;
    const line = state.doc.lines[i];
    if (!syntax || !line.text || syntax.states[i] == null) return null;
    return tokenize(end == null ? line.text : line.text.slice(0, end), syntax.language, syntax.states[i]).spans;
  }

  /**
   * 줄 글. 아주 긴 줄(번들·데이터를 한 줄에 담은 파일)은 MAX_LINE_CHARS 만 그린다 — 수백만 자를 한 줄로 그리면
   * 웹뷰가 글자 배치에 몇 초씩 멈춘다. 바뀐 곳이 뒤에 있으면 그 앞쪽부터 보이고, 잘린 쪽에는 "…" 표시를 단다.
   */
  function lineContent(i) {
    const line = state.doc.lines[i];
    const text = line.text ?? '';
    if (text.length <= MAX_LINE_CHARS) return lineText(text, line.changeStart, line.changeLen, state.showWs, syntaxSpans(i));
    const [cFrom, cTo] = changeRange(text, line.changeStart, line.changeLen);
    const isLow = (k) => { const c = text.charCodeAt(k); return c >= 0xdc00 && c <= 0xdfff; };
    let a = cTo > cFrom && cFrom > MAX_LINE_CHARS - LONG_LINE_LEAD ? cFrom - LONG_LINE_LEAD : 0;
    if (a > 0 && isLow(a)) a++;
    let b = Math.min(text.length, a + MAX_LINE_CHARS);
    if (b < text.length && isLow(b)) b--;
    const spans = (syntaxSpans(i, b) ?? []).flatMap((sp) => {
      const s0 = Math.max(sp.start, a);
      const s1 = Math.min(sp.start + sp.length, b);
      return s1 > s0 ? [{ ...sp, start: s0 - a, length: s1 - s0 }] : [];
    });
    const clamp = (x) => Math.min(b - a, Math.max(0, x - a));
    const total = text.length.toLocaleString('en-US');
    const tip = `긴 줄이라 ${total}자 중 ${(a + 1).toLocaleString('en-US')}–${b.toLocaleString('en-US')}번째만 보입니다.`;
    return [
      a > 0 ? el('span', { class: 'tx-cut', 'data-tip': tip, text: `…(앞 ${a.toLocaleString('en-US')}자) ` }) : null,
      ...lineTextRange(text.slice(a, b), clamp(cFrom), clamp(cTo), state.showWs, spans),
      b < text.length ? el('span', { class: 'tx-cut', 'data-tip': tip, text: ` …(뒤 ${(text.length - b).toLocaleString('en-US')}자)` }) : null,
    ];
  }

  // ── 행 만들기 ──

  function buildRows() {
    const lines = state.doc.lines;
    rows = [];
    changeBlocks = [];
    lineToRow = new Map();
    const pushRow = (row, indexes) => {
      for (const i of indexes) if (i != null) lineToRow.set(i, rows.length);
      rows.push(row);
    };
    let prevChange = false;
    const markBlock = (changed) => {
      if (changed && !prevChange) changeBlocks.push(rows.length);
      prevChange = changed;
    };
    if (shownFileView()) {
      // 파일 보기: 바뀐 뒤 파일 전체(더한 줄 초록). 지운 파일은 옛 판 전체.
      const deletedFile = lines.every((l) => l.kind !== 'added' && l.kind !== 'context');
      lines.forEach((line, i) => {
        if (line.kind === 'hunk' || line.kind === 'noNewline') return;
        if (!deletedFile && line.kind === 'removed') return;
        markBlock(isChange(line));
        pushRow({ type: 'line', index: i, hunk: line.hunk }, [i]);
      });
    } else if (shownView() === 'split') {
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.kind === 'hunk') {
          markBlock(false);
          if (contextFor() !== FULL_CONTEXT) pushRow({ type: 'hunk', index: i, hunk: line.hunk }, [i]);
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
    } else {
      lines.forEach((line, i) => {
        if (line.kind === 'hunk') {
          markBlock(false);
          // Inline(파일 전체)은 hunk 머리를 보이지 않는다(덩어리가 하나뿐이다).
          if (contextFor() !== FULL_CONTEXT) pushRow({ type: 'hunk', index: i, hunk: line.hunk }, [i]);
          return;
        }
        markBlock(isChange(line));
        pushRow({ type: line.kind === 'noNewline' ? 'meta' : 'line', index: i, hunk: line.hunk }, [i]);
      });
    }
    tops = [0];
    const hunkHeight = tallHunks() ? HUNK_ROW : ROW;
    for (const row of rows) tops.push(tops[tops.length - 1] + (row.type === 'hunk' ? hunkHeight : ROW));
  }

  /** y(px) 에 있는 행. */
  function rowAt(y) {
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  /** 행 r 의 [위, 아래](본문 안 px). 줄 접기면 그려진 요소로 잰다. */
  function rowBounds(r) {
    if (isWrap()) {
      const node = rowsHost?.querySelector(`[data-row="${r}"]`);
      return node ? [node.offsetTop, node.offsetTop + node.offsetHeight] : null;
    }
    return [tops[r], tops[r + 1]];
  }

  // ── 그리기 ──

  /** 줄 번호 칸: 가장 큰 번호 자릿수(최소 2) × 7px + 10px(원본 NumberDigitWidth·NumberPadding). */
  function numberWidth() {
    let max = 1;
    for (const l of state.doc.lines) max = Math.max(max, l.old || 0, l.new || 0);
    return `${Math.max(2, String(max).length) * 7 + 10}px`;
  }

  function lineCells(i, side) {
    const line = state.doc.lines[i];
    const mark = { added: '+', removed: '-', context: ' ' }[line.kind] ?? '';
    const change = isChange(line);
    const cells = [];
    if (canPartial()) {
      // 거터: 바뀐 줄에 마우스를 올리면·고른 줄이면 [+](Staged 면 [−]). 고른 줄 중 하나를 누르면 고른 줄 전부.
      const many = state.selected.has(i) && state.selected.size > 1;
      cells.push(el('span', { class: 'gut', 'data-i': change ? i : null },
        change ? el('button', {
          class: `gut-btn${unstage() ? ' unstage' : ''}`, 'data-line': i, text: unstage() ? '−' : '+',
          'data-tip': many ? `고른 ${state.selected.size}줄 ${unstage() ? 'Unstage' : 'Stage'}` : `이 줄 ${unstage() ? 'Unstage' : 'Stage'}`,
        }) : null));
    }
    if (side !== 'right') cells.push(el('span', { class: 'ln ln-old', 'data-i': change ? i : null, text: line.old || '' }));
    if (side !== 'left') cells.push(el('span', { class: 'ln ln-new', 'data-i': change ? i : null, text: line.new || '' }));
    return [...cells, el('span', { class: 'mk', text: mark }),
      el('span', { class: 'tx', 'data-i': change ? i : null, 'data-cr': line.cr ? '1' : null }, lineContent(i))];
  }

  function rowElement(row, r) {
    const lines = state.doc.lines;
    if (row.type === 'hunk') {
      const line = lines[row.index];
      return el('div', { class: `dr dr-hunk${tallHunks() ? ' tall' : ''}`, 'data-row': r, 'data-hunk': row.hunk }, el('span', { class: 'hunk-text', text: line.text }), tallHunks() ? el('span', { class: 'hunk-actions' }, hunkButtons(row.hunk)) : null);
    }
    if (row.type === 'meta') {
      return el('div', { class: 'dr dr-meta', 'data-row': r }, el('span', { class: 'tx', text: lines[row.index].text }));
    }
    if (row.type === 'split') {
      const half = (i, side) => {
        if (i == null) return el('div', { class: 'half empty', 'data-side': side });
        const line = lines[i];
        return el('div', { class: `half k-${line.kind}${state.selected.has(i) ? ' picked' : ''}`, 'data-side': side }, lineCells(i, side));
      };
      return el('div', { class: 'dr dr-split', 'data-row': r, 'data-hunk': row.hunk }, half(row.left, 'left'), half(row.right, 'right'));
    }
    const line = lines[row.index];
    return el('div', { class: `dr k-${line.kind}${state.selected.has(row.index) ? ' picked' : ''}`, 'data-row': r, 'data-hunk': row.hunk }, lineCells(row.index, shownFileView() ? 'right' : null));
  }

  let lastRange = '';

  function paint(force = false) {
    if (!body || !state?.doc) return;
    const wrap = isWrap();
    const top = body.scrollTop;
    const first = wrap ? 0 : Math.max(0, rowAt(top) - OVERSCAN);
    const last = wrap ? rows.length - 1 : Math.min(rows.length - 1, rowAt(top + body.clientHeight) + OVERSCAN);
    const key = `${first}:${last}`;
    if (!force && key === lastRange) return;
    lastRange = key;
    const fragment = document.createDocumentFragment();
    for (let r = first; r <= last; r++) {
      const node = rowElement(rows[r], r);
      if (!wrap) node.style.top = `${tops[r]}px`;
      fragment.append(node);
    }
    rowsHost.replaceChildren(fragment);
    placeActions();
  }

  /** Hunk 보기 머리 줄 오른쪽: [변경된 묶음 버리기](빨강, Unstaged 만) [변경된 묶음 Stage](초록, Staged 면 [변경된 묶음 Unstage] 빨강). */
  function hunkButtons(hunk) {
    if (!canPartial()) return [];
    return [
      canDiscard() ? el('button', { class: 'hunk-btn discard', 'data-tip': '이 변경된 묶음을 작업 사본에서 되돌립니다(되돌릴 수 없음).', text: '변경된 묶음 버리기', onclick: () => run('discard', hunkLines(hunk)) }) : null,
      el('button', { class: `hunk-btn ${unstage() ? 'unstage' : 'stage'}`, text: unstage() ? '변경된 묶음 Unstage' : '변경된 묶음 Stage', onclick: () => run(unstage() ? 'unstage' : 'stage', hunkLines(hunk)) }),
    ];
  }

  function hunkLines(hunk) {
    return state.doc.lines.map((l, i) => (l.hunk === hunk && isChange(l) ? i : -1)).filter((i) => i >= 0);
  }

  /** Split 한 행은 바뀐 줄 한 쌍(왼쪽 '-', 오른쪽 '+')이다. 한쪽만 올리면 옛 줄과 새 줄이 둘 다 인덱스에 남으므로 같은 행의 반대쪽 바뀐 줄을 더한다. */
  function withSplitPartners(lines) {
    if (shownView() !== 'split' || shownFileView()) return lines;
    const out = new Set(lines);
    for (const i of lines) {
      const row = rows[lineToRow.get(i)];
      if (row?.type === 'split') for (const j of [row.left, row.right]) if (j != null && isChange(state.doc.lines[j])) out.add(j);
    }
    return [...out].sort((a, b) => a - b);
  }

  /** 파일 보기는 지운 줄(−)을 숨긴다. 고른 + 줄이 든 변경 덩어리의 − 줄도 넣어, 고친 줄을 올리면 옛 줄이 인덱스에 함께 남지 않게 한다. */
  function withHiddenRemovals(lines) {
    const all = state.doc.lines;
    const out = new Set(lines);
    for (const index of lines) {
      for (let i = index - 1; i >= 0 && isChange(all[i]); i--) if (all[i].kind === 'removed') out.add(i);
      for (let i = index + 1; i < all.length && isChange(all[i]); i++) if (all[i].kind === 'removed') out.add(i);
    }
    return [...out].sort((a, b) => a - b);
  }

  // ── 고르기(거터·줄 번호) ──

  /** 두 문서 줄 사이의 바뀐 줄을 모두 고른다(묶음 여러 개에 걸쳐도 된다 — 패치가 묶음마다 나눠 만든다). */
  function selectRange(from, to) {
    state.selected = new Set();
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) if (isChange(state.doc.lines[i])) state.selected.add(i);
  }

  function clearPicked() {
    if (!state.selected.size && state.anchor == null) return;
    state.selected = new Set();
    state.anchor = null;
    paint(true);
  }

  async function run(action, lines) {
    if (!lines.length || document.body.classList.contains('git-busy')) return;
    state.selected = new Set();
    state.anchor = null;
    window.getSelection()?.removeAllRanges();
    actionLines = [];
    hoverGroup = null;
    placeActions();
    const done = await state.api.applyLines(action, state.target, state.doc.fingerprint, lines, contextFor());
    if (done !== false && state) await reload();
  }

  // ── 띠와 떠 있는 [Stage | 되돌리기…] ──

  const band = el('div', { class: 'diff-band', hidden: true });
  const actionsBar = el('div', { class: 'diff-actions', hidden: true });
  actionsBar.addEventListener('pointerdown', (event) => event.stopPropagation());
  actionsBar.addEventListener('mouseleave', (event) => {
    if (!body?.contains(event.relatedTarget)) {
      hoverGroup = null;
      placeActions();
    }
  });

  /** 코드에서 끌어 고른 글이 걸친 바뀐 줄과 그 쪽(Split 의 왼쪽·오른쪽). 다음 줄 맨 앞에서 끝난 고르기는 그 줄을 넣지 않는다. */
  function textSelectionLines() {
    const selection = window.getSelection();
    if (!body || !selection || selection.isCollapsed || !rowsHost.contains(selection.anchorNode)) return null;
    const range = selection.getRangeAt(0);
    const side = body.classList.contains('select-left') ? 'left' : body.classList.contains('select-right') ? 'right' : null;
    const nodes = [...rowsHost.querySelectorAll('.tx')].filter((node) => range.intersectsNode(node) && (!side || node.closest('.half')?.dataset.side === side));
    if (!nodes.length) return null;
    const last = nodes[nodes.length - 1];
    if (nodes.length > 1 && last.contains(range.endContainer) && offsetIn(last, range.endContainer, range.endOffset) === 0) nodes.pop();
    const rowsOf = nodes.map((n) => Number(n.closest('[data-row]').dataset.row));
    let lines = nodes.filter((n) => n.dataset.i != null).map((n) => Number(n.dataset.i));
    if (!lines.length) return null;
    lines = shownFileView() ? withHiddenRemovals(lines) : withSplitPartners(lines);
    return { lines, first: Math.min(...rowsOf), last: Math.max(...rowsOf), side };
  }

  const isHunkRow = (r) => rows[r]?.type === 'hunk';
  const isChangeRow = (r) => {
    const x = rows[r];
    if (!x) return false;
    if (x.type === 'split') return isChange(state.doc.lines[x.left]) || isChange(state.doc.lines[x.right]);
    return x.type === 'line' && isChange(state.doc.lines[x.index]);
  };

  /** 행 r 에서 Fork 가 감싸는 변경 덩어리: 바뀐 줄이면 그 덩어리, 문맥 줄이면 위아래 2줄 안의 덩어리(가까운 쪽). 머리 줄은 넘지 않는다. */
  function groupAt(r) {
    if (r < 0 || r >= rows.length || isHunkRow(r)) return null;
    let target = isChangeRow(r) ? r : -1;
    for (let d = 1; d <= HOVER_CONTEXT && target < 0; d++) {
      for (const c of [r - d, r + d]) {
        if (c < 0 || c >= rows.length || !isChangeRow(c)) continue;
        let crosses = false;
        for (let k = Math.min(r, c); k <= Math.max(r, c); k++) if (isHunkRow(k)) crosses = true;
        if (!crosses) {
          target = c;
          break;
        }
      }
    }
    if (target < 0) return null;
    let a = target;
    let b = target;
    while (isChangeRow(a - 1)) a--;
    while (isChangeRow(b + 1)) b++;
    return [a, b];
  }

  function groupLines([a, b]) {
    const out = [];
    for (let r = a; r <= b; r++) {
      const x = rows[r];
      if (x.type === 'split') [x.left, x.right].forEach((i) => i != null && isChange(state.doc.lines[i]) && out.push(i));
      else if (x.index != null && isChange(state.doc.lines[x.index])) out.push(x.index);
    }
    return out;
  }

  /**
   * 띠(강조색 테두리 + 옅은 바탕)와 떠 있는 버튼을 맞춘다(원본 PlaceSelectionActions).
   * 끌어 고른 글에 바뀐 줄이 있으면 그 줄들을 감싸고 버튼은 띠 아래 오른쪽에(Split 은 고른 쪽 칸만).
   * 아니면(Fork 식) 마우스를 올린 덩어리와 위아래 문맥 2줄(머리 줄은 넘지 않는다)을 감싸고 버튼은 띠 안 오른쪽 위에.
   */
  function placeActions() {
    band.hidden = true;
    actionsBar.hidden = true;
    actionLines = [];
    if (!state || !body || !state.doc || !canStageLines()) return;
    const selected = textSelectionLines();
    let first;
    let last;
    let side = null;
    let lines;
    if (selected) {
      ({ first, last, side, lines } = selected);
    } else if (state.fork && hoverGroup && !dragging) {
      lines = groupLines(hoverGroup);
      first = hoverGroup[0];
      last = hoverGroup[1];
      for (let k = 1; k <= HOVER_CONTEXT && first - 1 >= 0 && !isHunkRow(first - 1); k++) first--;
      for (let k = 1; k <= HOVER_CONTEXT && last + 1 < rows.length && !isHunkRow(last + 1); k++) last++;
    } else return;
    const top = rowBounds(first);
    const bottom = rowBounds(last);
    if (!top || !bottom || !lines.length) return;
    const view = [body.scrollTop, body.scrollTop + body.clientHeight];
    const y1 = Math.max(top[0], view[0]);
    const y2 = Math.min(bottom[1], view[1]);
    if (y2 <= y1) return;
    // 왼쪽은 +/− 부호 칸이 시작하는 곳부터, 오른쪽은 줄(Split 은 고른 쪽 칸) 끝까지.
    const sample = [...rowsHost.querySelectorAll('[data-row]')].find((n) => Number(n.dataset.row) >= first && Number(n.dataset.row) <= last && !n.classList.contains('dr-hunk'));
    if (!sample) return;
    const part = side ? sample.querySelector(`.half[data-side="${side}"]`) ?? sample : sample;
    const sign = part.querySelector('.mk') ?? part.querySelector('.tx') ?? part;
    const origin = container.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const left = Math.max(sign.getBoundingClientRect().left, bodyRect.left) - origin.left;
    const right = Math.min(part.getBoundingClientRect().right, bodyRect.left + body.clientWidth) - origin.left;
    const offsetTop = bodyRect.top - origin.top - body.scrollTop;
    Object.assign(band.style, { left: `${left}px`, top: `${y1 + offsetTop}px`, width: `${Math.max(0, right - left)}px`, height: `${y2 - y1}px` });
    band.hidden = false;
    actionLines = lines;
    if (dragging || document.body.classList.contains('git-busy')) return;
    const discard = canDiscard();
    actionsBar.classList.toggle('single', !discard);
    actionsBar.replaceChildren(
      el('button', { class: 'act-stage', 'data-tip': `고른 ${lines.length}줄 ${unstage() ? 'Unstage' : 'Stage'}`, text: unstage() ? 'Unstage' : 'Stage', onclick: () => run(unstage() ? 'unstage' : 'stage', actionLines) }),
      discard ? el('button', { class: 'act-discard', 'data-tip': '이 변경된 묶음을 작업 사본에서 되돌립니다(되돌릴 수 없음).', text: '되돌리기…', onclick: () => run('discard', actionLines) }) : null);
    const barTop = selected ? Math.min(y2 + offsetTop, offsetTop + body.scrollTop + body.clientHeight - 26) + 2 : y1 + offsetTop + 4;
    actionsBar.style.top = `${barTop}px`;
    actionsBar.style.right = `${Math.max(24, origin.right - (right + origin.left) + 8)}px`;
    actionsBar.hidden = false;
  }

  // ── 이동 ──

  /** 이동의 기준 행: 방금 ↑↓ 로 간 행이 아직 화면 안이면 그 행, 맨 위에 있으면 -1(첫 변경부터), 아니면 화면 맨 위에서 2줄 아래. */
  function focusRow() {
    const firstVisible = rowAt(body.scrollTop);
    const lastVisible = rowAt(body.scrollTop + body.clientHeight - 1);
    if (lastJumpRow >= firstVisible && lastJumpRow <= lastVisible) return lastJumpRow;
    return body.scrollTop < ROW / 2 ? -1 : firstVisible + JUMP_MARGIN;
  }

  /** 앞(-1)·뒤(+1)의 다음 변경 덩어리로 간다. 간 행은 화면 위에서 2줄 아래에 둔다. 끝에서는 멈춘다(원본 JumpToChange). */
  function jump(delta) {
    if (!changeBlocks.length || !body) return;
    const focus = focusRow();
    const target = delta > 0 ? changeBlocks.find((r) => r > focus) : [...changeBlocks].reverse().find((r) => r < focus);
    if (target == null) return;
    lastJumpRow = target;
    if (isWrap()) rowsHost.querySelector(`[data-row="${target}"]`)?.scrollIntoView({ block: 'start' });
    else body.scrollTop = Math.max(0, tops[Math.max(0, target - JUMP_MARGIN)]);
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
      const start = node.contains(range.startContainer) ? offsetIn(node, range.startContainer, range.startOffset) : 0;
      if (node.contains(range.endContainer)) text = text.slice(0, offsetIn(node, range.endContainer, range.endOffset));
      text = text.slice(start);
      if (state.showWs) text = text.replace(/→\t/g, '\t').replace(/·/g, ' ');
      return { text, cr: node.dataset.cr === '1' };
    });
    const out = parts.map((p, k) => p.text + (k < parts.length - 1 ? (p.cr ? '\r\n' : '\n') : '')).join('');
    event.clipboardData.setData('text/plain', out);
    event.preventDefault();
  }

  function offsetIn(root, node, offset) {
    if (node === root && node.nodeType !== Node.TEXT_NODE) {
      let total = 0;
      for (let k = 0; k < offset && k < root.childNodes.length; k++) total += root.childNodes[k].textContent.length;
      return total;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let total = 0;
    while (walker.nextNode()) {
      if (walker.currentNode === node) return total + offset;
      total += walker.currentNode.textContent.length;
    }
    return total;
  }

  // ── 제목 줄·막대 ──

  /** 비교하는 두 판(원본 DescribeRevisions). */
  function twoSides() {
    const { target } = state;
    const short = (h) => (h ?? '').slice(0, 7);
    if (target.kind === 'commit') return `${short(target.hash)} 의 부모 ↔ ${short(target.hash)}`;
    if (target.kind === 'range') {
      if (target.range) return `${target.from} 와 ${target.to} 의 공통 조상 ↔ ${target.to}`;
      return target.to ? `${short(target.from)} ↔ ${short(target.to)}` : `${short(target.from)} ↔ 작업 트리`;
    }
    if (target.kind === 'staged') return 'HEAD ↔ Staged(인덱스)';
    if (target.untracked) return '새 파일 (git 이 아직 모름)';
    return 'Staged(인덱스) ↔ 작업 사본';
  }

  function setView(view) {
    const before = contextFor();
    state.view = view;
    state.fileView = false;
    prefs().set('diff.view', view);
    prefs().set('diff.fileView', false);
    state.api.setLayout?.(view === 'split' ? 'split' : 'inline');
    afterViewChange(before);
  }

  function setFileView(on) {
    const before = contextFor();
    state.fileView = on;
    prefs().set('diff.fileView', on);
    afterViewChange(before);
  }

  function afterViewChange(before) {
    state.selected = new Set();
    state.anchor = null;
    window.getSelection()?.removeAllRanges();
    if (before !== contextFor()) {
      state.doc = null;
      reload();
    }
    render();
  }

  function toggle(key, pref) {
    state[key] = !state[key];
    prefs().set(pref, state[key]);
    render();
  }

  /** 지금 보고 있는 변경 줄(↑↓ 로 간 변경, 없으면 첫 변경)의 새 판 줄 번호. 외부 편집기를 그 줄로 연다. */
  function currentLine() {
    if (!state.doc || !rows.length) return 1;
    const start = lastJumpRow >= 0 ? lastJumpRow : changeBlocks[0] ?? 0;
    for (let r = start; r < rows.length; r++) {
      const x = rows[r];
      const i = x?.type === 'split' ? (x.right ?? x.left) : x?.index;
      const line = state.doc.lines[i];
      if (line?.new) return line.new;
    }
    return 1;
  }

  /** 커밋된 판이 있는지(Blame·히스토리가 뜻이 있는지). 작업 중인 새 파일(untracked·새로 추가)은 없다. */
  const hasCommittedVersion = () => state.mode === 'commit' || state.target.kind === 'commit' || state.target.kind === 'range'
    || (state.entryState !== 'untracked' && state.entryState !== 'added' && !state.target.untracked);

  function header() {
    const { doc, target } = state;
    const title = target.originalPath && target.originalPath !== target.path ? `${target.originalPath} → ${target.path}` : target.path;
    const stats = doc && !doc.binary && !state.image;
    return el('div', { class: 'diff-head' },
      el('span', { class: 'diff-title', 'data-tip': title, text: title }),
      stats ? el('span', { class: 'diff-stat added', text: `+${doc.added}` }) : null,
      stats ? el('span', { class: 'diff-stat removed', text: `−${doc.removed}` }) : null,
      el('span', { class: 'diff-revisions', text: twoSides() }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'diff-head-btn', 'data-tip': '다시 읽기', onclick: () => { state.doc = null; reload(); } }, icon('refresh', 14)),
      el('button', { class: 'diff-close', 'data-tip': '닫기', text: '×', onclick: () => state.api.close() }));
  }

  function bar() {
    const { target } = state;
    // 아직 읽기 전이면 바이너리인지 모른다 — 직전에 본 파일 종류를 따라 그려, 글 전용 버튼이 한 프레임 떴다 사라지지 않게 한다.
    const isText = !state.image && (state.doc ? !state.doc.binary : lastWasText);
    const exists = state.entryState !== 'deleted';
    // 작업 사본의 글 diff 면 이 자리에서 고치고, 커밋·Staged 등이면 작업 사본 파일을 외부 편집기에서 연다.
    const inPlace = state.mode === 'unstaged' && !!state.api.edit;
    const edit = barButton(() => (inPlace ? state.api.edit(target, currentLine()) : state.api.openEditor?.(target, currentLine())),
      !exists ? '작업 사본에 이 파일이 없습니다.' : inPlace ? '이 자리에서 작업 사본 파일을 고칩니다. 오른쪽 클릭하면 외부 편집기에서 엽니다.' : '이 판이 아니라 지금 작업 사본의 이 파일을 외부 편집기에서 엽니다. 이 자리에서 고치기는 작업 사본의 변경(Unstaged)을 볼 때만 됩니다.',
      'DiffEdit', inPlace ? '이 파일 편집' : '작업 사본 열기', { disabled: !exists, cls: 'outlined edit' });
    edit.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showMenu(event.clientX, event.clientY, [{ label: '외부 편집기에서 열기', disabled: !exists || !state.api.openEditor, action: () => state.api.openEditor?.(target, currentLine()) }]);
    });
    const fileView = shownFileView();
    const view = shownView();
    const committed = hasCommittedVersion();
    const viewChoice = !state.fork;
    return el('div', { class: 'diff-bar' },
      el('div', { class: 'dbar-side' }, edit),
      el('div', { class: 'dbar-center' },
        isText && viewChoice ? segment('seg-view', [
          barButton(() => setFileView(true), '바뀐 뒤의 파일 전체를 봅니다(더한 줄은 초록).', null, '파일 보기', { on: fileView }),
          barButton(() => setFileView(false), '바뀐 내용을 봅니다(보기 방식은 오른쪽 세 버튼).', null, 'Diff 보기', { on: !fileView }),
        ]) : null),
      el('div', { class: 'dbar-side right' },
        segment('seg-file-tools', [
          barButton(() => state.api.blame?.(target), committed ? '줄마다 마지막으로 바꾼 커밋을 봅니다.' : '아직 커밋된 적 없는 파일입니다.', null, 'Blame', { disabled: !committed || !isText || !state.api.blame }),
          barButton(() => state.api.history?.(target), committed ? '이 파일을 바꾼 커밋 목록을 봅니다.' : '아직 커밋된 적 없는 파일입니다.', null, '히스토리', { disabled: !committed || !state.api.history }),
        ]),
        isText ? segment('seg-nav', [barButton(() => jump(-1), '이전 변경', 'DiffUp'), barButton(() => jump(1), '다음 변경', 'DiffDown')]) : null,
        isText && viewChoice ? segment('seg-layouts', [
          barButton(() => setView('hunk'), '변경된 묶음 보기(Hunk) — 바뀐 곳과 그 앞뒤 몇 줄만', 'DiffViewHunk', null, { on: !fileView && view === 'hunk', disabled: fileView }),
          barButton(() => setView('inline'), '통합 보기(Inline) — 바뀐 줄을 한 목록에서 제자리에', 'DiffViewInline', null, { on: !fileView && view === 'inline', disabled: fileView }),
          barButton(() => setView('split'), '나란히 보기(Split) — 옛 판과 새 판을 양쪽에', 'DiffViewSplit', null, { on: !fileView && view === 'split', disabled: fileView }),
        ]) : null,
        isText ? contextButtons() : null,
        isText ? segment('seg-display', [
          barButton(() => toggle('showWs', 'diff.whitespace'), '공백 문자 보이기(· 공백, → 탭)', 'DiffWhitespace', null, { on: state.showWs }),
          barButton(() => toggle('wrap', 'diff.wrap'), '긴 줄 접어 보기', 'DiffWrap', null, { on: state.wrap }),
        ]) : null));
  }

  /**
   * Fork 의 [−≡|+≡] [↕](원본 UpdateContextButtons). ↕ 는 파일 보기·Hunk 보기에서 끈다(읽는 범위가 정해져 있다).
   * −/+ 는 파일 전체를 보이는 중엔 끄고 까닭을 툴팁으로 알린다. 끝 단계면 그쪽 버튼만 끈다.
   */
  function contextButtons() {
    const applies = entireFileApplies();
    const fileView = shownFileView();
    const lines = contextLines();
    const entire = showsEntireFile();
    const off = fileView ? '파일 보기는 늘 파일 전체를 보입니다. Diff 보기에서 문맥 줄과 파일 전체 보기를 바꿀 수 있습니다.'
      : '파일 전체를 보이는 중에는 문맥 줄 수가 쓰이지 않습니다. ↕ 를 끄면 바꿀 수 있습니다.';
    return [
      segment('seg-context', [
        barButton(() => stepContext(-1), entire ? off : `문맥 줄 줄이기 (지금 ${lines}줄)`, 'DiffContextLess', null, { disabled: entire || nextContextStep(lines, -1) === lines }),
        barButton(() => stepContext(1), entire ? off : `문맥 줄 늘리기 (지금 ${lines}줄)`, 'DiffContextMore', null, { disabled: entire || nextContextStep(lines, 1) === lines }),
      ]),
      segment('seg-context', [
        barButton(toggleEntireFile, fileView ? off : applies ? '파일 전체 보기 — 끄면 바뀐 곳 앞뒤 문맥 줄만 묶음으로 보입니다'
          : '변경된 묶음(Hunk) 보기는 늘 바뀐 곳만 보입니다. 파일 전체는 통합·나란히 보기에서 볼 수 있습니다.', 'DiffEntireFile', null, { on: applies && state.entire, disabled: !applies }),
      ]),
    ];
  }

  /** 문맥 줄 수를 한 단계 바꾸고 다시 읽는다(설정의 "문맥 줄 수" 도 같이 바뀐다). */
  function stepContext(direction) {
    const before = contextFor();
    prefs().set('diff.context', nextContextStep(contextLines(), direction));
    afterViewChange(before);
  }

  /** 파일 전체 보기(↕)를 켜고 끈다. 읽을 범위가 달라지므로 git 을 다시 부른다. */
  function toggleEntireFile() {
    const before = contextFor();
    state.entire = !state.entire;
    prefs().set('diff.entireFile', state.entire);
    afterViewChange(before);
  }

  /** 막대 폭에 따라 단계적으로 줄인다: compact = 가운데 맞춤 풀고 편집은 아이콘만 · narrow = Blame·히스토리 숨김 · tiny = 공백·줄바꿈 숨김 · micro = 보기 방식 숨김. */
  function fitBar() {
    const node = container.querySelector('.diff-bar');
    if (!node) return;
    const width = node.clientWidth || container.clientWidth;
    for (const [name, limit] of BAR_STEPS) node.classList.toggle(name, width < limit);
    // 폭 기준만으로는 모자랄 수 있다(오른쪽 버튼이 늘면 반쪽 폭을 넘쳐 가운데 [파일 보기|Diff 보기]와 겹친다).
    // 아직 넘치면 다음 단계를 차례로 더한다.
    for (const [name] of BAR_STEPS) {
      if (node.classList.contains(name)) continue;
      if (!barOverflows(node)) break;
      node.classList.add(name);
    }
  }
  new ResizeObserver(() => {
    fitBar();
    if (state?.doc && body) placeActions();
  }).observe(container);
  window.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = null;
    placeActions();
  });

  /** 바이너리 파일 카드(원본 LoadBinaryAsync): 상태 글자, 판마다 회색 카드(아이콘·확장자)와 크기 "242 KB (248,320 B)", 옛 → 새. */
  function binaryCard() {
    const { doc, target } = state;
    const sizes = doc.sizes ?? {};
    const [status, cls] = sizes.old == null ? ['추가됨', 'created'] : sizes.new == null ? ['삭제됨', 'deleted'] : ['수정됨', 'modified'];
    const card = (path, bytes) => {
      const name = path.split('/').pop();
      const ext = /(\.[^.]+)$/.exec(name)?.[1] ?? name;
      return el('div', { class: 'binary-column' },
        el('div', { class: 'binary-card' }, el('span', { class: 'binary-icon' }, fileIcon(path)), el('span', { class: 'binary-ext', text: ext })),
        el('div', { class: 'binary-size', text: `${formatBytes(bytes)} (${bytes.toLocaleString('en-US')} B)` }));
    };
    return el('div', { class: 'diff-binary' },
      el('div', { class: `binary-status ${cls}`, text: status }),
      el('div', { class: 'binary-cards' },
        sizes.old != null ? card(target.originalPath ?? target.path, sizes.old) : null,
        sizes.old != null && sizes.new != null ? el('span', { class: 'binary-arrow', text: '→' }) : null,
        sizes.new != null ? card(target.path, sizes.new) : null));
  }

  /** LFS 원본을 받지 않은 파일: 안내와 [이 파일 원본 받기 (크기)], 계정 문제로 못 받았으면 [계정 고르기]. */
  function lfsView() {
    const pointer = state.doc.lines.filter((l) => l.kind !== 'removed').map((l) => /^size (\d+)$/.exec(l.text)?.[1]).find(Boolean);
    const failure = state.lfs.failure;
    const auth = failure && /not found|401|403|auth|credential|permission/i.test(failure);
    let message = '이 파일의 원본이 이 컴퓨터에 없습니다(Git LFS).\n받지 않았거나, 레포지토리 설정(lfs.fetchexclude)으로 받지 않게 되어 있는 파일입니다.';
    if (auth) message += "\n\n지금 계정으로는 이 레포지토리의 원본을 받을 수 없습니다(GitHub 가 '없음'으로 답했습니다).\n이 레포지토리에 쓸 계정을 고른 뒤 다시 받으세요.";
    else if (failure) message += `\n\n받지 못했습니다: ${failure.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('Downloading ')) ?? failure}`;
    const fetch = async () => {
      state.lfs = { busy: true, failure: null };
      render();
      const current = state;
      const error = await state.api.lfsPull?.(state.target);
      if (state !== current) return;
      state.lfs = { busy: false, failure: error ?? null };
      state.doc = null;
      reload();
    };
    return el('div', { class: 'diff-lfs' },
      el('div', { class: 'lfs-message', text: message }),
      state.api.lfsPull ? el('button', { class: 'lfs-btn', disabled: state.lfs.busy, text: state.lfs.busy ? '받는 중…' : pointer ? `이 파일 원본 받기 (${formatBytes(Number(pointer))})` : '이 파일 원본 받기', onclick: fetch }) : null,
      auth && state.api.chooseAccount ? el('button', { class: 'lfs-btn', text: '계정 고르기', onclick: () => state.api.chooseAccount() }) : null);
  }

  function render() {
    if (!state || state.image) return;
    const { doc } = state;
    if (doc) lastWasText = !doc.binary;
    const loading = el('div', { class: 'diff-loading', hidden: true, text: '불러오는 중…' });
    let content;
    body = null;
    if (state.error) content = el('div', { class: 'diff-notice error-text', text: state.error });
    else if (!doc) content = el('div', { class: 'diff-notice', text: '' });
    else if (doc.binary) content = binaryCard();
    else if (doc.lfsPointer) content = lfsView();
    else if (!doc.lines.length) content = el('div', { class: 'diff-notice', text: '내용 차이가 없습니다(공백 무시 설정이나 모드·권한만 바뀐 경우).' });
    else {
      buildRows();
      const old = doc.lines.some((l) => l.old);
      const neu = doc.lines.some((l) => l.new);
      const wrap = isWrap();
      body = el('div', {
        class: `diff-body view-${shownFileView() ? 'file' : shownView()}${wrap ? ' wrap' : ''}${old ? '' : ' no-old'}${neu ? '' : ' no-new'}${canPartial() ? ' pickable' : ''}`,
        style: { '--ln': numberWidth() },
        tabindex: '0',
      });
      const sizer = el('div', { class: 'diff-sizer', style: wrap ? null : { height: `${tops[rows.length]}px` } });
      rowsHost = el('div', { class: `diff-rows${wrap ? ' flow' : ''}` });
      sizer.append(rowsHost);
      body.append(sizer);
      content = body;
      wireBody();
    }
    const prevScroll = state.scrollTop ? 0 : container.querySelector('.diff-body')?.scrollTop ?? 0;
    container.replaceChildren(...[header(), bar(), content, band, actionsBar, loading].filter(Boolean));
    fitBar();
    if (body) {
      // 다른 파일로 바뀌었으면 맨 위에서 시작한다.
      body.scrollTop = prevScroll;
      state.scrollTop = false;
      lastRange = '';
      paint(true);
    } else {
      band.hidden = true;
      actionsBar.hidden = true;
    }
  }

  function wireBody() {
    body.addEventListener('scroll', () => {
      requestAnimationFrame(() => paint());
      placeActions();
    });
    body.addEventListener('copy', copySelection);
    body.addEventListener('mousemove', (event) => {
      if (!state.fork) return;
      const rect = body.getBoundingClientRect();
      const rowNode = event.target.closest('[data-row]');
      const r = rowNode ? Number(rowNode.dataset.row) : rowAt(event.clientY - rect.top + body.scrollTop);
      const group = groupAt(r);
      if (String(group) !== String(hoverGroup)) {
        hoverGroup = group;
        placeActions();
      }
    });
    body.addEventListener('mouseleave', (event) => {
      if (actionsBar.contains(event.relatedTarget)) return;
      dragging = null;
      if (hoverGroup) {
        hoverGroup = null;
        placeActions();
      }
    });
    // 거터 [+]: 고른 줄 중 하나면 고른 줄 전부, 아니면 그 줄 하나. Split 이면 같은 행의 짝도.
    body.addEventListener('click', (event) => {
      const button = event.target.closest('.gut-btn');
      if (!button) return;
      event.stopPropagation();
      const i = Number(button.dataset.line);
      const lines = state.selected.has(i) ? [...state.selected] : [i];
      run(unstage() ? 'unstage' : 'stage', withSplitPartners(lines));
    });
    // 거터·줄 번호를 끌어 범위, Shift+클릭으로 늘리기, ⌘/Ctrl 로 하나씩. 코드 칸은 글 고르기다.
    body.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const cell = event.target.closest('.gut, .ln');
      if (!cell) {
        // 코드 칸을 누르면 고른 줄은 푼다(두 가지가 한꺼번에 칠해지면 무엇을 올리는지 헷갈린다).
        if (event.target.closest('.tx') && state.selected.size) clearPicked();
        return;
      }
      if (event.target.closest('.gut-btn') || !canPartial()) return;
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      const i = cell.dataset.i != null ? Number(cell.dataset.i) : null;
      if (i == null) {
        clearPicked();
        return;
      }
      if (event.shiftKey && state.anchor != null) selectRange(state.anchor, i);
      else if (event.metaKey || event.ctrlKey) {
        if (state.selected.has(i)) state.selected.delete(i);
        else state.selected.add(i);
        state.anchor = i;
      } else {
        state.selected = new Set([i]);
        state.anchor = i;
      }
      dragging = { meta: event.metaKey || event.ctrlKey };
      paint(true);
    });
    // 끄는 동안 지나간 줄까지(문맥 줄 포함) 사이의 바뀐 줄을 고른다(원본 OnRowPointerEnter).
    body.addEventListener('pointerover', (event) => {
      if (!dragging || dragging.meta || state.anchor == null) return;
      const rowNode = event.target.closest('[data-row]');
      const x = rowNode && rows[Number(rowNode.dataset.row)];
      if (!x) return;
      const side = event.target.closest('.half')?.dataset.side;
      const i = x.type === 'split' ? (side === 'left' ? x.left ?? x.right : x.right ?? x.left) : x.type === 'hunk' ? null : x.index;
      if (i == null) return;
      selectRange(state.anchor, i);
      paint(true);
    });
    // Split 에서는 한쪽 글만 고른다. 끌어 고른 글이 바뀌면 띠·버튼을 맞춘다.
    body.addEventListener('mousedown', (event) => {
      const half = event.target.closest('.half');
      body.classList.toggle('select-left', half?.dataset.side === 'left');
      body.classList.toggle('select-right', half?.dataset.side === 'right');
    });
    body.addEventListener('mouseup', () => setTimeout(placeActions, 0));
    body.addEventListener('keyup', () => placeActions());
    body.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showMenu(event.clientX, event.clientY, [
        { label: '복사', hint: '⌘C', disabled: window.getSelection()?.isCollapsed, action: () => document.execCommand('copy') },
        { label: '모두 선택', hint: '⌘A', action: () => selectAllText() },
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
        state.anchor = null;
        window.getSelection()?.removeAllRanges();
        paint(true);
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
    placeActions();
  }

  return {
    open,
    reload,
    close,
    get isOpen() { return state != null; },
    get target() { return state?.target; },
    /** 지금 열면 읽을 옵션. 열려 있으면 그 상태, 아니면 설정에서(미리 읽기용). */
    loadOptions: (p, layout) => (state ? { context: contextFor(), ignoreWhitespace: state.ignoreWs } : expectedLoad(p, layout)),
  };
}
