// 가운데 커밋 그래프(GitKraken 모양). 원본 Elements/CommitGraph/CommitGraphList.cs 와 Core/VerticalGraphLayout.cs 를 옮겼다.
//
// 한 줄은 [브랜치/태그 이름표][그래프][메시지] 이고(Fork 모양이면 뒤에 작성자·SHA·날짜), 머리 줄 칸을 끌어 순서를, 칸 경계를 끌어 폭을 바꾼다.
// 맨 오른쪽 칸은 남은 폭을 갖는다. 줄은 보이는 것만 DOM 으로 만들고(가상 스크롤), 가지 선·커밋 원은 그 위에 겹친 canvas 에 그린다.
// 가지 배치는 Rust(gitvcs-core::graph)가 정해 보낸다: nodes[i] = {lane, truncated, refs}, lanes[k] = {name, column, color, …}, edges = [{child, parent, merge}].

import { el, formatDate, initials, isComposing } from './util.js';
import { icon } from './icons.js';

export const ROW_HEIGHT = 34;
const OVERSCAN = 6;

// ── 크기(원본 VerticalGraphLayout) ──
const AVATAR_RADIUS = 12;
const LANE_SPACING = 18;
const AVATAR_LANE_SPACING = 30;
const LEFT_PADDING = 14;
const AVATAR_LEFT_PADDING = 20;
const MIN_WIDTH = 48;
const MAX_WIDTH = 480;
const EDGE_CORNER_RADIUS = 10;
const LANE_BAR_WIDTH = 3;
const NODE_BAR_GAP = 7;
const PUSHED_NODE_OPACITY = 0.45;

// ── 칸 ──
const DEFAULT_ORDER = ['refs', 'graph', 'message'];
const DEFAULT_REFS_WIDTH = 170;
const DEFAULT_MESSAGE_WIDTH = 420;
const MIN_MESSAGE_WIDTH = 64;
const MIN_LAST_WIDTH = 40;
const MIN_REFS_WIDTH = 41;
const MIN_REFS_FIRST_WIDTH = 55;
const MAX_COLUMN_WIDTH = 2000;
const SQUEEZE_ORDER = ['message', 'refs', 'graph'];
const DETAIL_WIDTHS = { author: 150, sha: 84, date: 150 };
const HEADER = {
  refs: { text: '브랜치 / 태그', icon: 'branch' },
  graph: { text: '그래프', icon: 'hierarchy' },
  message: { text: '커밋 메시지', icon: 'comment' },
};

// ── 이름표 진하기(원본 CommitGraphList) ──
const REF_ALPHA = { current: 0.7, local: 0.35, remote: 0.2 };
const LANE_TINT_ALPHA = 0.1;
const SELECTED_LANE_TINT_ALPHA = 0.45;

// 원본 GraphStyle.LaneColors 와 같은 여덟 색.
const LANE_COLORS = ['#599eff', '#59cc73', '#ff9e40', '#b885ff', '#ff73a6', '#4dcccc', '#f2cc4d', '#f26659'];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const rgba = ([r, g, b], a = 1) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;

/** 가지 하나의 색(rgb). 이름 없는 가지(지워진 브랜치)는 회색 쪽으로 반 섞는다. */
export function laneRgb(lane) {
  if (!lane) return [128, 131, 138];
  const base = hexToRgb(LANE_COLORS[lane.color % LANE_COLORS.length]);
  return lane.anonymous ? base.map((c) => (c + 128) / 2) : base;
}

export const laneColor = (lane, alpha = 1) => rgba(laneRgb(lane), alpha);

function rgbToHsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max ? d / max : 0, max];
}

function hsvToRgb([h, s, v]) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
  return [r * 255, g * 255, b * 255];
}

const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);

/** 원본 GraphStyle.Muted: 지금 있지 않은 브랜치 이름표 선의 가라앉힌 색. */
function muted(rgb, background) {
  const [h, s, v] = rgbToHsv(rgb);
  const dark = (background[0] * 0.299 + background[1] * 0.587 + background[2] * 0.114) / 255 < 0.5;
  return dark ? hsvToRgb([h, s * 0.45, v * 0.2]) : mix(hsvToRgb([h, s * 0.45, v]), background, 0.85);
}

/** 원본 GraphStyle.AuthorColor: 이름 해시로 색상만 바꾼다. */
export function authorRgb(name) {
  let hash = 17;
  for (let i = 0; i < (name || '').length; i++) hash = (Math.imul(hash, 31) + name.charCodeAt(i)) | 0;
  return hsvToRgb([((hash & 0x7fffffff) % 360) / 360, 0.55, 0.75]);
}

function cssColor(name) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const probe = document.createElement('canvas').getContext('2d');
  probe.fillStyle = value || '#000';
  const parsed = probe.fillStyle;
  if (parsed.startsWith('#')) return hexToRgb(parsed);
  const m = parsed.match(/[\d.]+/g) || [0, 0, 0];
  return m.slice(0, 3).map(Number);
}

/** 이름표 hover: 바탕 밝기 ×1.3, 진하기 +0.2. */
function brighter(rgb, alpha) {
  const [h, s, v] = rgbToHsv(rgb);
  return rgba(hsvToRgb([h, s, Math.min(1, v * 1.3)]), Math.min(1, alpha + 0.2));
}

// ── 아바타 ──

const AI_LOGOS = { claude: 'icons/AiClaude.png', openai: 'icons/AiOpenAI.png', gemini: 'icons/AiGemini.png' };

/**
 * 작성자 사진. load(email, hash) 는 Rust 에 묻는 함수({url}|{ai}|null). 한 번에 넷까지만 묻는다. 받으면 onLoad 로 다시 그리게 한다.
 */
export function createAvatars(load) {
  const cache = new Map(); // email → {img, ready} | 'pending' | null
  const queue = [];
  let running = 0;
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn());

  function pump() {
    while (running < 4 && queue.length) {
      const { email, hash } = queue.shift();
      running++;
      load(email, hash).then((answer) => {
        const src = answer?.url ?? (answer?.ai ? AI_LOGOS[answer.ai] : null);
        if (!src) {
          cache.set(email, null);
          return;
        }
        const img = new Image();
        const entry = { img, ready: false };
        cache.set(email, entry);
        img.onload = () => { entry.ready = true; notify(); };
        img.onerror = () => cache.set(email, null);
        img.src = src;
      }).catch(() => cache.set(email, null)).finally(() => {
        running--;
        pump();
      });
    }
  }

  return {
    /** 그릴 수 있는 그림. 아직 없으면 묻기 시작하고 null. */
    get(email, hash) {
      if (!email) return null;
      const entry = cache.get(email);
      if (entry === undefined) {
        cache.set(email, 'pending');
        queue.push({ email, hash });
        pump();
        return null;
      }
      return entry && entry !== 'pending' && entry.ready ? entry.img : null;
    },
    /** 상세 화면 등 <img> 에 쓸 주소(없으면 null). */
    async url(email, hash) {
      const answer = await load(email, hash).catch(() => null);
      return answer?.url ?? (answer?.ai ? AI_LOGOS[answer.ai] : null);
    },
    onLoad(fn) { listeners.add(fn); },
  };
}

// ── 브랜치 이름 검사(git check-ref-format --branch 와 같은 규칙) ──

export function branchNameProblem(name, existing = []) {
  const n = name.trim();
  if (!n) return '이름을 적어 주세요.';
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(n)) return '공백과 ~ ^ : ? * [ \\ 는 쓸 수 없습니다.';
  if (n.includes('..') || n.includes('//') || n.includes('@{') || n === '@') return "'..', '//', '@{' 는 쓸 수 없습니다.";
  if (n.startsWith('/') || n.endsWith('/') || n.startsWith('-')) return "'/' 나 '-' 로 시작하거나 '/' 로 끝날 수 없습니다.";
  if (n.endsWith('.') || n.endsWith('.lock') || n.split('/').some((part) => part.startsWith('.'))) return "'.' 로 시작·끝나거나 '.lock' 으로 끝날 수 없습니다.";
  if (existing.includes(n)) return `'${n}' 브랜치가 이미 있습니다.`;
  return null;
}

/**
 * 그래프를 만든다.
 * opts: { pane, header, scroll, sizer, canvas, rows, onSelect(key), onContextMenu(key, event, commit, ref?), onRefActivate(ref, commit),
 *         onWipSubject(text), onWipFocus(), onNeedMore(), avatars, prefs:{get(key), set(key, value)} }
 */
export function createGraph(opts) {
  const { pane, header, scroll, sizer, canvas, rows } = opts;

  let commits = [];
  let nodes = [];
  let lanes = [];
  let edges = [];
  let laneCount = 1;
  let hasWip = false;
  let wip = { modified: 0, added: 0, deleted: 0, total: 0 };
  let headRow = -1;
  let headLane = null;
  let mergeIncoming = -1;
  let conflicts = 0;
  let conflictTarget = '';
  let selected = null;
  let truncatedHistory = false;
  let frame = 0;
  let wipSubject = '';
  let branchInput = null; // {hash, element, validate, submit}
  let searchMatches = null; // Set of row indexes (커밋 번호) — 검색 중이면 안 맞는 줄을 흐린다
  const rendered = new Map(); // key → row element

  // 칸 설정(저장)
  let order = parseOrder(opts.prefs.get('graph.order'));
  const widths = Object.assign({ refs: DEFAULT_REFS_WIDTH, graph: 0, message: DEFAULT_MESSAGE_WIDTH }, opts.prefs.get('graph.widths') || {});
  let showAvatars = opts.prefs.get('graph.avatars') !== false;
  let detailColumns = false;
  let colors = { bg: [25, 26, 28], head: [95, 184, 101], truncated: 'rgba(128,131,138,0.5)', muted: [128, 131, 138] };

  function parseOrder(saved) {
    return Array.isArray(saved) && saved.length === 3 && DEFAULT_ORDER.every((c) => saved.includes(c)) ? [...saved] : [...DEFAULT_ORDER];
  }

  const rowCount = () => commits.length + (hasWip ? 1 : 0);
  const offset = () => (hasWip ? 1 : 0);
  const keyOf = (row) => (hasWip && row === 0 ? 'wip' : commits[row - offset()]?.hash);
  const laneOf = (index) => lanes[nodes[index]?.lane];

  // ── 배치 값 ──

  const spacing = () => (showAvatars ? AVATAR_LANE_SPACING : LANE_SPACING);
  const firstLaneOffset = () => (showAvatars ? AVATAR_LEFT_PADDING : LEFT_PADDING);
  const nodeOuterRadius = () => (showAvatars ? AVATAR_RADIUS + 4 : 8);
  const wallInset = () => nodeOuterRadius() + 2;
  // 기본 폭: 맨 오른쪽 원과 그 선이 벽에 밀리거나 흐려지지 않는 폭(원 + 벽 여백 + 선이 흐려지기 시작하는 거리 + 막대).
  const naturalGraphWidth = () => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, laneCount <= 1
    ? firstLaneOffset() * 2
    : firstLaneOffset() + (laneCount - 1) * spacing() + wallInset() + spacing() * 0.5 + LANE_BAR_WIDTH));
  const isLast = (column) => order[order.length - 1] === column;
  const barWidth = () => (isLast('graph') ? 0 : LANE_BAR_WIDTH);
  const minGraphWidth = () => (laneCount === 1
    ? firstLaneOffset() + nodeOuterRadius() + NODE_BAR_GAP + barWidth()
    : firstLaneOffset() + wallInset() + barWidth());
  const minRefsWidth = () => (order[0] === 'refs' ? MIN_REFS_FIRST_WIDTH : MIN_REFS_WIDTH);
  const detailsWidth = () => (detailColumns ? DETAIL_WIDTHS.author + DETAIL_WIDTHS.sha + DETAIL_WIDTHS.date : 0);

  function storedWidth(column) {
    if (column === 'refs') return Math.max(widths.refs, minRefsWidth());
    if (column === 'graph') return widths.graph > 0 ? Math.max(widths.graph, minGraphWidth()) : Math.max(naturalGraphWidth(), minGraphWidth());
    return widths.message;
  }

  function minColumnWidth(column) {
    if (isLast(column)) return column === 'refs' ? Math.max(MIN_LAST_WIDTH, MIN_REFS_WIDTH) : MIN_LAST_WIDTH;
    return { refs: minRefsWidth(), graph: minGraphWidth(), message: MIN_MESSAGE_WIDTH }[column];
  }

  /** 줄 폭(스크롤바 뺀 것). */
  const rowsWidth = () => scroll.clientWidth - 4;

  /** 창이 좁을 때 맨 오른쪽 칸이 최소 폭을 받도록 메시지 → 이름표 → 그래프 순으로 줄인 폭(저장 폭은 그대로). */
  function fixedWidths() {
    const result = {};
    for (const c of order) if (!isLast(c)) result[c] = storedWidth(c);
    let deficit = minColumnWidth(order[order.length - 1]) + detailsWidth() - rowsWidth();
    for (const c of Object.keys(result)) deficit += result[c];
    for (const c of SQUEEZE_ORDER) {
      if (deficit <= 0) break;
      if (isLast(c)) continue;
      const cut = Math.min(deficit, Math.max(result[c] - minColumnWidth(c), 0));
      result[c] -= cut;
      deficit -= cut;
    }
    return result;
  }

  let layout = { start: {}, width: {} };

  function computeLayout() {
    const fixed = fixedWidths();
    const start = {};
    const width = {};
    let x = 0;
    for (const c of order) {
      start[c] = x;
      width[c] = isLast(c) ? Math.max(rowsWidth() - x - detailsWidth(), minColumnWidth(c)) : fixed[c];
      x += width[c];
    }
    layout = { start, width };
    pane.style.setProperty('--gc-refs-w', `${width.refs}px`);
    pane.style.setProperty('--gc-graph-w', `${width.graph}px`);
    pane.style.setProperty('--gc-message-w', `${width.message}px`);
    order.forEach((c, i) => pane.style.setProperty(`--gc-${c}-o`, i));
    for (const c of DEFAULT_ORDER) pane.classList.toggle(`last-${c}`, isLast(c));
    pane.classList.toggle('refs-first', order[0] === 'refs');
    pane.classList.toggle('message-first', order[0] === 'message');
    pane.classList.toggle('graph-last', isLast('graph'));
    pane.classList.toggle('details', detailColumns);
    // 브랜치/태그 칸이 최소 폭이면 이름표를 아이콘 하나로 줄인다.
    pane.classList.toggle('refs-centered', width.refs <= minColumnWidth('refs') + 1);
    renderHeader();
  }

  const graphContentWidth = () => layout.width.graph - barWidth();
  const wallRoom = () => graphContentWidth() - wallInset() - firstLaneOffset();
  const laneSpacingNow = () => (laneCount <= 1 ? spacing() : Math.min(spacing(), Math.max(0, wallRoom() / (laneCount - 1))));
  const compact = () => laneCount > 1 && laneSpacingNow() < 0.5;

  /** 열의 원 자리(칸 왼쪽에서). 원은 제자리에 있다가 오른쪽 벽이 닿으면 밀린다. */
  function laneOffset(column) {
    if (laneCount <= 1) return firstLaneOffset();
    const wall = graphContentWidth() - wallInset();
    return Math.max(firstLaneOffset(), Math.min(firstLaneOffset() + column * spacing(), wall));
  }

  const X = (column) => layout.start.graph + laneOffset(column);
  const edgeX = (column) => layout.start.graph + firstLaneOffset() + column * spacing();
  const Y = (row) => row * ROW_HEIGHT + ROW_HEIGHT / 2 - scroll.scrollTop;

  /** 선의 진하기: 오른쪽 벽이 그 선에 열 간격 절반만큼 다가오면 흐려지기 시작해 닿으면 사라진다. */
  function edgeAlpha(maxColumn) {
    const wall = graphContentWidth() - wallInset();
    return Math.min(1, Math.max(0, (wall - (firstLaneOffset() + maxColumn * spacing())) / (spacing() * 0.5)));
  }

  /** 원의 진하기: 벽에 밀려 간 만큼 가라앉는다. 모든 가지가 한 줄로 모이면 원래 색. */
  function nodeOpacity(column) {
    const natural = firstLaneOffset() + column * spacing();
    const pushed = natural - laneOffset(column);
    const dim = Math.min(1, Math.max(0, pushed / spacing())) * Math.min(1, Math.max(0, wallRoom() / spacing()));
    return 1 + (PUSHED_NODE_OPACITY - 1) * dim;
  }

  // ── 데이터 ──

  function setData(history, status) {
    commits = history.commits;
    nodes = history.graph.nodes;
    lanes = history.graph.lanes;
    edges = history.graph.edges;
    laneCount = Math.max(1, history.graph.laneCount);
    truncatedHistory = history.truncated;
    const entries = new Map();
    for (const e of [...(status?.staged ?? []), ...(status?.unstaged ?? [])]) entries.set(e.path, e.state);
    wip = { modified: 0, added: 0, deleted: 0, total: entries.size };
    for (const state of entries.values()) {
      if (state === 'added' || state === 'untracked') wip.added++;
      else if (state === 'deleted') wip.deleted++;
      else wip.modified++;
    }
    // 커밋이 하나도 없는 저장소도 WIP 줄은 둔다(첫 커밋을 만들 수 있게).
    hasWip = wip.total > 0 || commits.length === 0;
    headRow = history.head ? commits.findIndex((c) => c.hash === history.head) : -1;
    headLane = headRow >= 0 ? laneOf(headRow) : null;
    mergeIncoming = status?.mergeHead ? commits.findIndex((c) => c.hash === status.mergeHead) : -1;
    conflicts = status?.operation ? status.conflicted : 0;
    conflictTarget = status?.branch?.detached ? 'HEAD' : status?.branch?.name ?? 'HEAD';
    if (selected && selected !== 'wip' && !commits.some((c) => c.hash === selected)) selected = null;
    if (selected === 'wip' && !hasWip) selected = null;
    sizer.style.height = `${rowCount() * ROW_HEIGHT}px`;
    // 줄 요소는 다시 만든다(작업 중 줄은 입력란 포커스를 지키려고 그대로 두고 내용만 바꾼다).
    for (const [key, element] of rendered) {
      if (key !== 'wip') {
        element.remove();
        rendered.delete(key);
      }
    }
    if (!hasWip && rendered.has('wip')) {
      rendered.get('wip').remove();
      rendered.delete('wip');
    }
    computeLayout();
    render();
  }

  function setColors() {
    colors = {
      bg: cssColor('--git-graph-bg'),
      head: cssColor('--git-graph-head'),
      truncated: getComputedStyle(document.documentElement).getPropertyValue('--git-graph-truncated').trim() || 'rgba(128,131,138,0.5)',
      muted: cssColor('--git-text-muted'),
    };
  }

  // ── 고르기 ──

  function select(key, notify = true) {
    selected = key;
    for (const [k, element] of rendered) element.classList.toggle('selected', k === key);
    draw();
    if (notify) opts.onSelect(key);
  }

  /** 그 커밋 줄로 스크롤해 목록 가운데쯤에 둔다(CM-04). */
  function reveal(hash, center = true) {
    const index = hash === 'wip' ? -1 : commits.findIndex((c) => c.hash === hash);
    if (hash !== 'wip' && index < 0) return false;
    const row = hash === 'wip' ? 0 : index + offset();
    const top = row * ROW_HEIGHT;
    if (center) scroll.scrollTop = Math.max(0, top - scroll.clientHeight / 2 + ROW_HEIGHT / 2);
    else if (top < scroll.scrollTop) scroll.scrollTop = top;
    else if (top + ROW_HEIGHT > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = top + ROW_HEIGHT - scroll.clientHeight;
    render();
    return true;
  }

  // ── 머리 줄: 칸 폭 끌기·순서 끌기 ──

  function renderHeader() {
    const cells = order.map((column) => {
      const w = layout.width[column];
      const iconOnly = w <= minColumnWidth(column) + 1;
      const cell = el('div', {
        class: `gh-cell gh-${column}${iconOnly ? ' icon-only' : ''}${order[0] === column ? ' first' : ''}`,
        'data-column': column,
        'data-tip': iconOnly ? HEADER[column].text : null,
        style: isLast(column) ? { flex: '1 1 0', minWidth: `${minColumnWidth(column)}px` } : { width: `${w}px`, flex: 'none' },
      }, iconOnly ? icon(HEADER[column].icon, 14) : el('span', { class: 'gh-text', text: HEADER[column].text }));
      cell.addEventListener('pointerdown', (event) => startReorder(event, column, cell));
      if (!isLast(column)) {
        const handle = el('div', { class: 'gh-resize', 'data-tip': '끌어서 폭 바꾸기 · 두 번 누르면 기본 폭' });
        handle.addEventListener('pointerdown', (event) => startResize(event, column));
        handle.addEventListener('dblclick', () => {
          widths[column] = column === 'graph' ? 0 : column === 'refs' ? DEFAULT_REFS_WIDTH : DEFAULT_MESSAGE_WIDTH;
          saveWidths();
        });
        cell.append(handle);
      }
      return cell;
    });
    const details = detailColumns
      ? [el('div', { class: 'gh-cell gh-author', style: { width: `${DETAIL_WIDTHS.author}px` }, text: '작성자' }),
        el('div', { class: 'gh-cell gh-sha', style: { width: `${DETAIL_WIDTHS.sha}px` }, text: 'SHA' }),
        el('div', { class: 'gh-cell gh-date', style: { width: `${DETAIL_WIDTHS.date}px` }, text: '날짜' })]
      : [];
    header.replaceChildren(...cells, ...details);
  }

  function saveWidths() {
    opts.prefs.set('graph.widths', { ...widths });
    computeLayout();
    render();
  }

  function startResize(event, column) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = layout.width[column];
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-col');
    const move = (e) => {
      // 맨 오른쪽 칸이 최소 폭으로 남을 때까지만 넓힌다.
      let room = rowsWidth() - detailsWidth() - minColumnWidth(order[order.length - 1]);
      for (const c of order) if (c !== column && !isLast(c)) room -= layout.width[c];
      const minimum = column === 'graph' ? minGraphWidth() : column === 'refs' ? minRefsWidth() : MIN_MESSAGE_WIDTH;
      const w = Math.max(minimum, Math.min(MAX_COLUMN_WIDTH, Math.min(startWidth + e.clientX - startX, Math.max(room, startWidth))));
      widths[column] = w;
      computeLayout();
      render();
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      document.body.classList.remove('resizing-col');
      opts.prefs.set('graph.widths', { ...widths });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up, { once: true });
  }

  function startReorder(event, column, cell) {
    if (event.button !== 0 || event.target.closest('.gh-resize')) return;
    const startX = event.clientX;
    let ghost = null;
    let marker = null;
    let to = -1;
    const headerRect = header.getBoundingClientRect();
    const move = (e) => {
      if (!ghost && Math.abs(e.clientX - startX) < 4) return;
      if (!ghost) {
        ghost = el('div', { class: 'gh-ghost', text: HEADER[column].text });
        marker = el('div', { class: 'gh-marker' });
        header.append(ghost, marker);
      }
      ghost.style.left = `${e.clientX - headerRect.left - 30}px`;
      // 놓일 자리: 각 칸 가운데를 기준으로 고른다.
      const x = e.clientX - headerRect.left;
      to = order.length;
      for (let i = 0; i < order.length; i++) {
        if (x < layout.start[order[i]] + layout.width[order[i]] / 2) {
          to = i;
          break;
        }
      }
      const markX = to < order.length ? layout.start[order[to]] : layout.start[order[order.length - 1]] + layout.width[order[order.length - 1]];
      marker.style.left = `${markX - 1}px`;
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      ghost?.remove();
      marker?.remove();
      if (!ghost || to < 0) return;
      const from = order.indexOf(column);
      const next = order.filter((c) => c !== column);
      next.splice(to > from ? to - 1 : to, 0, column);
      if (next.join() === order.join()) return;
      order = next;
      opts.prefs.set('graph.order', order);
      hideRefsPopup();
      computeLayout();
      render();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up, { once: true });
    cell.addEventListener('dragstart', (e) => e.preventDefault(), { once: true });
  }

  // ── 줄 ──

  function refPill(ref, lane) {
    const kind = ref.kind;
    const display = kind === 'remote' ? ref.name.replace(/^[^/]+\//, '') : ref.name;
    const pill = el('span', {
      class: `ref-pill ref-${kind}${ref.hasRemote ? ' synced' : ''}`,
      'data-kind': kind,
      'data-name': ref.name,
    },
    kind === 'current' ? icon('check', 16, 'ref-check') : null,
    el('span', { class: 'ref-name', text: display }),
    el('span', { class: 'ref-gap' }),
    kind === 'current' || kind === 'local' ? el('span', { class: 'ref-laptop' }) : null,
    kind === 'remote' || ref.hasRemote ? icon('cloud', 16, 'ref-cloud') : null,
    kind === 'tag' ? icon('tag', 16, 'ref-tag-icon') : null);
    if (kind !== 'tag') {
      const rgb = laneRgb(lane);
      const alpha = REF_ALPHA[kind] ?? 0.35;
      pill.style.background = rgba(rgb, alpha);
      if (kind !== 'current') {
        pill.addEventListener('mouseenter', () => { pill.style.background = brighter(rgb, alpha); });
        pill.addEventListener('mouseleave', () => { pill.style.background = rgba(rgb, alpha); });
      }
    }
    return pill;
  }

  function wipCounts() {
    const group = (kind, count) => (count ? el('span', { class: `wip-count wip-${kind}` }, el('span', { class: `wip-icon wip-icon-${kind}` }), el('span', { text: count })) : null);
    return el('span', { class: 'wip-counts' }, group('modified', wip.modified), group('added', wip.added), group('deleted', wip.deleted));
  }

  function makeWipRow() {
    const input = el('input', { class: 'wip-input', placeholder: '// 작업 중', spellcheck: 'false', autocomplete: 'off' });
    input.value = wipSubject;
    input.addEventListener('input', () => {
      wipSubject = input.value;
      opts.onWipSubject?.(wipSubject);
    });
    input.addEventListener('focus', () => {
      if (selected !== 'wip') select('wip');
      opts.onWipFocus?.();
    });
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if ((event.key === 'Enter' || event.key === 'Escape') && !isComposing(event)) {
        event.preventDefault();
        input.blur();
        scroll.focus();
      }
    });
    const row = el('div', { class: 'grow wip', 'data-key': 'wip' },
      el('div', { class: 'gc gc-refs' }),
      el('div', { class: 'gc gc-graph' }, el('div', { class: 'band' }, el('div', { class: 'band-glow' }))),
      el('div', { class: 'gc gc-message' }, el('div', { class: 'msg-hl' }), el('span', { class: 'wip-editor' }, input), el('span', { class: 'wip-slot' }),
        el('span', { class: 'wip-warning' }, icon('warning', 16)), el('span', { class: 'subject' })),
      detailColumns ? el('div', { class: 'gc gc-details' }) : null);
    row.wipInput = input;
    return row;
  }

  function bindWipRow(row) {
    const conflict = conflicts > 0;
    row.classList.toggle('wip-conflict', conflict);
    row.querySelector('.wip-slot').replaceChildren(conflict ? '' : wipCounts());
    row.querySelector('.subject').textContent = conflict ? `충돌 파일 ${conflicts}개가 있어 ${conflictTarget} 에 병합하지 못했습니다` : '';
    row.querySelector('.gc-message').dataset.tip = conflict ? '' : `${conflictTarget} 의 변경 ${wip.total}개`;
    if (document.activeElement !== row.wipInput && row.wipInput.value !== wipSubject) row.wipInput.value = wipSubject;
    const band = row.querySelector('.band');
    if (headLane) paintBand(band, headLane, headRow >= 0 ? headLane.column : 0);
    else band.style.display = 'none';
  }

  function paintBand(band, lane, column) {
    band.style.display = '';
    band.style.left = `${laneOffset(column)}px`;
    band.style.background = laneColor(lane, LANE_TINT_ALPHA);
    band.style.borderRightColor = laneColor(lane);
    band.firstChild.style.background = laneColor(lane, SELECTED_LANE_TINT_ALPHA);
  }

  function makeCommitRow(index) {
    const commit = commits[index];
    const node = nodes[index];
    const lane = lanes[node.lane];
    const refs = node.refs ?? [];
    const refsCell = el('div', { class: 'gc gc-refs' });
    if (refs.length) {
      refsCell.append(refPill(refs[0], lane));
      if (refs.length > 1) refsCell.append(el('span', { class: 'ref-more', text: `+${refs.length - 1}`, style: { background: laneColor(lane, REF_ALPHA.local) } }));
    }
    const band = el('div', { class: 'band' }, el('div', { class: 'band-glow' }));
    paintBand(band, lane, lane.column);
    const tip = `${commit.shortHash}  ${commit.subject}\n${commit.authorName}  ·  ${formatDate(commit.time, true)}`;
    const row = el('div', { class: `grow${index === headRow ? ' head' : ''}`, 'data-key': commit.hash, 'data-index': index },
      refsCell,
      el('div', { class: 'gc gc-graph' }, band),
      el('div', { class: 'gc gc-message', 'data-tip': tip }, el('div', { class: 'msg-hl' }), el('span', { class: 'subject', text: commit.subject })),
      detailColumns ? el('div', { class: 'gc gc-details' },
        el('span', { class: 'gd-author', style: { width: `${DETAIL_WIDTHS.author}px` }, text: commit.authorName, 'data-tip': commit.authorEmail }),
        el('span', { class: 'gd-sha mono', style: { width: `${DETAIL_WIDTHS.sha}px` }, text: commit.shortHash }),
        el('span', { class: 'gd-date', style: { width: `${DETAIL_WIDTHS.date}px` }, text: formatDate(commit.time, true) })) : null);
    if (searchMatches && !searchMatches.has(index)) row.classList.add('dimmed');
    return row;
  }

  function render() {
    cancelAnimationFrame(frame);
    const top = scroll.scrollTop;
    const height = scroll.clientHeight;
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(rowCount() - 1, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
    const wanted = new Set();
    for (let row = first; row <= last; row++) {
      const key = keyOf(row);
      wanted.add(key);
      let element = rendered.get(key);
      if (!element) {
        element = key === 'wip' ? makeWipRow() : makeCommitRow(row - offset());
        rendered.set(key, element);
        rows.append(element);
      }
      if (key === 'wip') bindWipRow(element);
      else {
        const lane = laneOf(row - offset());
        paintBand(element.querySelector('.band'), lane, lane.column);
      }
      element.style.top = `${row * ROW_HEIGHT}px`;
      element.classList.toggle('selected', key === selected);
    }
    for (const [key, element] of rendered) {
      // 쓰는 중인 작업 중 줄은 화면 밖으로 나가도 지우지 않는다(포커스를 잃지 않게).
      if (!wanted.has(key) && !(key === 'wip' && element.contains(document.activeElement))) {
        element.remove();
        rendered.delete(key);
      }
    }
    placeBranchInput();
    draw();
    // 끝에 닿으면 더 읽는다(무한 스크롤).
    if (truncatedHistory && last >= rowCount() - 40) opts.onNeedMore?.();
  }

  // ── 그리기 ──

  /** 화면 줄마다 이름표·"+n" 의 오른쪽 끝(선을 잇는 자리). */
  function refSpans() {
    const spans = new Map();
    const paneRect = scroll.getBoundingClientRect();
    for (const [key, element] of rendered) {
      if (key === 'wip') continue;
      const cell = element.querySelector('.gc-refs');
      const pill = cell?.querySelector('.ref-pill');
      if (!pill) continue;
      const cellEnd = cell.getBoundingClientRect().right - (order[0] === 'refs' ? 13 : 6) - paneRect.left;
      const pillEnd = Math.min(pill.getBoundingClientRect().right - paneRect.left, cellEnd);
      const more = cell.querySelector('.ref-more');
      const moreRect = more?.getBoundingClientRect();
      const hasMore = more && !more.classList.contains('covered') && moreRect.left - paneRect.left < cellEnd;
      spans.set(Number(element.dataset.index), {
        pillEnd,
        moreStart: hasMore ? moreRect.left - paneRect.left : 0,
        end: hasMore ? Math.min(moreRect.right - paneRect.left, cellEnd) : pillEnd,
        hasMore,
      });
    }
    return spans;
  }

  function line(ctx, fromX, toX, y) {
    if (toX <= fromX) return;
    ctx.beginPath();
    ctx.moveTo(fromX, y);
    ctx.lineTo(toX, y);
    ctx.stroke();
  }

  function drawRefConnectors(ctx, spans, current, first, last) {
    const refsLeftOfGraph = order.indexOf('refs') === order.indexOf('graph') - 1;
    if (!refsLeftOfGraph) return;
    ctx.lineWidth = 1.5;
    const popupEnd = refsPopup.index >= 0 ? refsPopup.element.getBoundingClientRect().right - scroll.getBoundingClientRect().left : NaN;
    for (let i = Math.max(0, first); i <= Math.min(commits.length - 1, last); i++) {
      const y = Y(i + offset());
      const refs = nodes[i].refs ?? [];
      const typing = branchInput && branchInput.hash === commits[i].hash;
      if (!refs.length && !typing) continue;
      const isCurrent = typing || refs.some((r) => r.kind === 'current');
      if (isCurrent !== current) continue;
      const lane = laneOf(i);
      ctx.strokeStyle = isCurrent ? laneColor(lane) : rgba(muted(laneRgb(lane), colors.bg));
      let startX = layout.start.graph - 6;
      const span = spans.get(i);
      if (typing) startX = layout.start.graph - 6;
      else if (refsPopup.index === i && !Number.isNaN(popupEnd)) startX = popupEnd;
      else if (span) {
        startX = span.end;
        if (span.hasMore) line(ctx, span.pillEnd, span.moreStart, y);
      }
      line(ctx, startX, X(lane.column), y);
    }
  }

  function drawEdges(ctx, first, last) {
    if (compact()) return;
    ctx.lineWidth = 2;
    for (const edge of edges) {
      if (edge.child > last || edge.parent < first) continue;
      const childLane = laneOf(edge.child);
      const parentLane = laneOf(edge.parent);
      const alpha = edgeAlpha(Math.max(childLane.column, parentLane.column));
      if (alpha <= 0) continue;
      const yc = Y(edge.child + offset());
      const yp = Y(edge.parent + offset());
      const xc = edgeX(childLane.column);
      const xp = edgeX(parentLane.column);
      const dim = searchMatches && !(searchMatches.has(edge.child) && searchMatches.has(edge.parent)) ? 0.28 : 1;
      // 병합으로 들어오는 선은 들어오는 가지(부모) 색, 나머지는 새 커밋 쪽 가지 색.
      ctx.strokeStyle = laneColor(edge.merge ? parentLane : childLane, alpha * dim);
      ctx.beginPath();
      ctx.moveTo(xc, yc);
      if (Math.abs(xc - xp) < 0.5) {
        ctx.lineTo(xp, yp);
      } else {
        // 가로로 나가 둥근 모서리에서 세로로 꺾는다. 병합은 병합 커밋 줄에서 옆 가지로, 갈라짐은 부모 줄에서 부모로.
        const radius = Math.min(EDGE_CORNER_RADIUS, Math.abs(xp - xc), yp - yc);
        const [cx, cy] = edge.merge ? [xp, yc] : [xc, yp];
        ctx.arcTo(cx, cy, xp, yp, radius);
        ctx.lineTo(xp, yp);
      }
      ctx.stroke();
    }
    // 읽은 범위 밖으로 이어지는 히스토리: 아래로 짧게 흐린 선.
    ctx.strokeStyle = colors.truncated;
    for (let i = Math.max(0, first); i <= Math.min(commits.length - 1, last); i++) {
      if (!nodes[i].truncated) continue;
      const x = X(laneOf(i).column);
      const y = Y(i + offset());
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + ROW_HEIGHT * 0.8);
      ctx.stroke();
    }
  }

  function nodeTopRadius(index) {
    if (showAvatars && commits[index].parents.length < 2) return AVATAR_RADIUS + (index === headRow ? 4 : 2);
    return index === headRow ? 8 : 6.5;
  }

  function fillCircle(ctx, x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 꺾인 선을 따라 길이로 이어지는 점선. */
  function dashedPath(ctx, points, dash, gap) {
    ctx.setLineDash([dash, gap]);
    ctx.beginPath();
    ctx.moveTo(...points[0]);
    for (const p of points.slice(1)) ctx.lineTo(...p);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawWip(ctx) {
    if (!hasWip) return;
    const x = X(headLane?.column ?? 0);
    const y = Y(0);
    const radius = showAvatars ? AVATAR_RADIUS + 2 : 6.5;
    const color = headLane ? laneColor(headLane) : rgba(colors.muted);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    if (headRow >= 0 && !compact()) {
      const headTop = Y(headRow + offset()) - nodeTopRadius(headRow);
      for (let dy = y + radius + 2; dy < headTop; dy += 6) {
        ctx.beginPath();
        ctx.moveTo(x, dy);
        ctx.lineTo(x, Math.min(dy + 3, headTop));
        ctx.stroke();
      }
    }
    // 멈춘 병합: 작업 중 원에서 합쳐 오는 커밋(MERGE_HEAD)까지 점선.
    if (mergeIncoming >= 0 && !compact()) {
      const incoming = laneOf(mergeIncoming);
      const xi = X(incoming.column);
      const yi = Y(mergeIncoming + offset()) - nodeTopRadius(mergeIncoming);
      const points = [];
      if (Math.abs(xi - x) < 0.5) {
        points.push([x, y + radius], [x, yi]);
      } else {
        const corner = Math.min(EDGE_CORNER_RADIUS, Math.abs(xi - x), yi - y);
        const dir = Math.sign(xi - x);
        points.push([x + dir * radius, y]);
        for (let i = 0; i <= 8; i++) {
          const a = (Math.PI / 2) * (i / 8);
          points.push([xi - dir * corner + dir * Math.sin(a) * corner, y + corner - Math.cos(a) * corner]);
        }
        points.push([xi, yi]);
      }
      ctx.strokeStyle = laneColor(incoming);
      dashedPath(ctx, points, 3, 3);
      ctx.strokeStyle = color;
    }
    fillCircle(ctx, x, y, radius, rgba(colors.bg));
    ctx.lineWidth = 2;
    const step = (Math.PI * 2) / 12;
    for (let i = 0; i < 12; i++) {
      ctx.beginPath();
      ctx.arc(x, y, radius - 1, i * step, i * step + step * 0.55);
      ctx.stroke();
    }
  }

  function drawNodes(ctx, first, last) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = Math.max(0, first); i <= Math.min(commits.length - 1, last); i++) {
      const lane = laneOf(i);
      const commit = commits[i];
      const x = X(lane.column);
      const y = Y(i + offset());
      const opacity = nodeOpacity(lane.column);
      const searchDim = searchMatches && !searchMatches.has(i) ? 0.28 : 1;
      // 벽에 밀린 원은 바탕색 쪽으로 섞어 가라앉힌다(겹쳐 쌓여도 비쳐 보이지 않게).
      const dim = (rgb) => rgba(mix(colors.bg, rgb, opacity * searchDim));
      const laneRgbNow = laneRgb(lane);
      const isHead = i === headRow;
      const isMerge = commit.parents.length > 1;
      if (showAvatars && !isMerge) {
        if (isHead) {
          fillCircle(ctx, x, y, AVATAR_RADIUS + 4, dim(colors.head));
          fillCircle(ctx, x, y, AVATAR_RADIUS + 3, rgba(colors.bg));
        }
        fillCircle(ctx, x, y, AVATAR_RADIUS + 2, dim(laneRgbNow));
        const image = opts.avatars?.get(commit.authorEmail, commit.hash);
        ctx.globalAlpha = opacity * searchDim;
        if (image) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(x, y, AVATAR_RADIUS, 0, Math.PI * 2);
          ctx.clip();
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.drawImage(image, x - AVATAR_RADIUS, y - AVATAR_RADIUS, AVATAR_RADIUS * 2, AVATAR_RADIUS * 2);
          ctx.restore();
        } else {
          fillCircle(ctx, x, y, AVATAR_RADIUS, rgba(authorRgb(commit.authorName)));
          ctx.fillStyle = '#ffffff';
          ctx.font = '700 10px "IBM Plex Sans KR", -apple-system, "Segoe UI", "Malgun Gothic", sans-serif';
          ctx.fillText(initials(commit.authorName), x, y + 0.5);
        }
        ctx.globalAlpha = 1;
        continue;
      }
      if (isHead) fillCircle(ctx, x, y, 8, dim(colors.head));
      fillCircle(ctx, x, y, 6.5, rgba(colors.bg));
      fillCircle(ctx, x, y, 5, isMerge ? rgba(colors.bg) : dim(laneRgbNow));
      if (isMerge) {
        ctx.strokeStyle = dim(laneRgbNow);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const width = scroll.clientWidth;
    const height = scroll.clientHeight;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!commits.length && !hasWip) return;
    const first = Math.floor(scroll.scrollTop / ROW_HEIGHT) - offset() - 1;
    const last = Math.ceil((scroll.scrollTop + height) / ROW_HEIGHT) - offset() + 1;
    const spans = refSpans();
    // 선·원은 그래프 칸(과 바로 왼쪽 이름표 칸) 안에만 그린다.
    const refsLeftOfGraph = order.indexOf('refs') === order.indexOf('graph') - 1;
    const clipLeft = refsLeftOfGraph ? layout.start.refs : layout.start.graph;
    ctx.save();
    ctx.beginPath();
    ctx.rect(clipLeft, 0, layout.start.graph + layout.width.graph - clipLeft, height);
    ctx.clip();
    ctx.lineCap = 'round';
    drawRefConnectors(ctx, spans, false, first, last);
    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.start.graph, 0, layout.width.graph, height);
    ctx.clip();
    drawEdges(ctx, first, last);
    ctx.restore();
    drawRefConnectors(ctx, spans, true, first, last);
    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.start.graph, 0, layout.width.graph, height);
    ctx.clip();
    drawWip(ctx);
    drawNodes(ctx, first, last);
    ctx.restore();
    ctx.restore();
  }

  // ── 이름표 펼침 ──

  const refsPopup = { element: el('div', { class: 'refs-popup', hidden: true }), index: -1, more: null };
  pane.append(refsPopup.element);

  function showRefsPopup(row) {
    if (branchInput || pressed) return;
    const index = Number(row.dataset.index);
    if (Number.isNaN(index)) return;
    const refs = nodes[index].refs ?? [];
    if (!refs.length) return;
    const pill = row.querySelector('.ref-pill');
    const name = pill.querySelector('.ref-name');
    const cut = name.scrollWidth > name.clientWidth + 0.5 || name.offsetParent === null || pill.clientWidth < pill.scrollWidth;
    if (refs.length === 1 && !cut) return;
    const lane = laneOf(index);
    const items = refs.map((ref, i) => {
      const item = refPill(ref, lane);
      item.classList.toggle('stack-first', i === 0);
      item.classList.toggle('stack-last', i === refs.length - 1);
      item.addEventListener('click', () => select(commits[index].hash));
      item.addEventListener('dblclick', () => opts.onRefActivate?.(ref, commits[index]));
      item.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        select(commits[index].hash);
        opts.onContextMenu?.(commits[index].hash, event, commits[index], ref);
      });
      return item;
    });
    refsPopup.element.replaceChildren(...items);
    const paneRect = pane.getBoundingClientRect();
    const rect = pill.getBoundingClientRect();
    Object.assign(refsPopup.element.style, { left: `${rect.left - paneRect.left}px`, top: `${rect.top - paneRect.top}px`, minWidth: `${rect.width}px` });
    refsPopup.element.hidden = false;
    refsPopup.index = index;
    refsPopup.more?.classList.remove('covered');
    refsPopup.more = row.querySelector('.ref-more');
    refsPopup.more?.classList.add('covered');
    draw();
  }

  function hideRefsPopup() {
    if (refsPopup.index < 0) return;
    refsPopup.index = -1;
    refsPopup.element.hidden = true;
    refsPopup.more?.classList.remove('covered');
    refsPopup.more = null;
    draw();
  }

  refsPopup.element.addEventListener('mouseleave', (event) => {
    if (!event.relatedTarget?.closest?.('.gc-refs')) hideRefsPopup();
  });

  // ── 줄 안 새 브랜치 이름 ──

  function beginBranchInput(hash, { validate, submit }) {
    cancelBranchInput();
    hideRefsPopup();
    if (!reveal(hash, false)) return false;
    const input = el('input', { class: 'branch-input field', placeholder: '브랜치 이름', spellcheck: 'false', autocomplete: 'off' });
    branchInput = { hash, element: input, validate, submit };
    const check = () => {
      const problem = validate(input.value);
      input.classList.toggle('invalid', !!problem && input.value.length > 0);
      input.dataset.tip = input.value ? problem ?? '' : '';
      return problem;
    };
    input.addEventListener('input', check);
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (isComposing(event)) return;
      if (event.key === 'Escape') cancelBranchInput();
      else if (event.key === 'Enter' && !check()) {
        const name = input.value.trim();
        cancelBranchInput();
        submit(name);
      }
    });
    input.addEventListener('blur', () => setTimeout(() => { if (branchInput?.element === input) cancelBranchInput(); }, 0));
    pane.append(input);
    placeBranchInput();
    input.focus();
    draw();
    return true;
  }

  function cancelBranchInput() {
    if (!branchInput) return;
    branchInput.element.remove();
    branchInput = null;
    draw();
  }

  function placeBranchInput() {
    if (!branchInput) return;
    const index = commits.findIndex((c) => c.hash === branchInput.hash);
    if (index < 0) return cancelBranchInput();
    const top = (index + offset()) * ROW_HEIGHT - scroll.scrollTop + scroll.offsetTop + 5;
    const left = layout.start.refs + 6;
    Object.assign(branchInput.element.style, { top: `${top}px`, left: `${left}px`, width: `${Math.max(20, layout.width.refs - 12)}px` });
    branchInput.element.style.visibility = top < scroll.offsetTop - 10 || top > scroll.offsetTop + scroll.clientHeight ? 'hidden' : '';
  }

  // ── 입력 ──

  let pressed = false;
  document.addEventListener('pointerdown', () => { pressed = true; }, true);
  document.addEventListener('pointerup', () => { pressed = false; }, true);

  scroll.addEventListener('scroll', () => {
    hideRefsPopup();
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(render);
  });
  new ResizeObserver(() => {
    computeLayout();
    render();
  }).observe(scroll);

  rows.addEventListener('mouseover', (event) => {
    const cell = event.target.closest('.gc-refs');
    if (cell && !cell.contains(event.relatedTarget)) showRefsPopup(cell.parentElement);
  });
  rows.addEventListener('mouseout', (event) => {
    const cell = event.target.closest('.gc-refs');
    if (cell && !cell.contains(event.relatedTarget) && !refsPopup.element.contains(event.relatedTarget)) hideRefsPopup();
  });
  rows.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('.grow');
    if (!row || event.target.closest('input')) return;
    event.preventDefault();
    select(row.dataset.key);
    const pill = event.target.closest('.ref-pill');
    const commit = commits.find((c) => c.hash === row.dataset.key);
    const ref = pill ? (nodes[Number(row.dataset.index)].refs ?? []).find((r) => r.name === pill.dataset.name && r.kind === pill.dataset.kind) : null;
    opts.onContextMenu?.(row.dataset.key, event, commit, ref);
  });
  rows.addEventListener('dblclick', (event) => {
    const pill = event.target.closest('.ref-pill');
    const row = event.target.closest('.grow');
    if (!pill || !row) return;
    const ref = (nodes[Number(row.dataset.index)].refs ?? []).find((r) => r.name === pill.dataset.name && r.kind === pill.dataset.kind);
    if (ref) opts.onRefActivate?.(ref, commits[Number(row.dataset.index)]);
  });
  rows.addEventListener('click', (event) => {
    const row = event.target.closest('.grow');
    if (!row || event.target.closest('input')) return;
    // 고른 줄을 다시 누르면 선택을 푼다(오른쪽 패널을 접는다).
    if (row.dataset.key === selected && event.detail === 1) select(null);
    else if (row.dataset.key !== selected) select(row.dataset.key);
  });
  scroll.addEventListener('keydown', (event) => {
    if (event.target !== scroll) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      let row = -1;
      for (let r = 0; r < rowCount(); r++) if (keyOf(r) === selected) row = r;
      row = Math.max(0, Math.min(rowCount() - 1, row + (event.key === 'ArrowDown' ? 1 : -1)));
      select(keyOf(row));
      reveal(keyOf(row), false);
    } else if (event.key === 'Enter' && selected) {
      event.preventDefault();
      opts.onSelect(selected);
    }
  });

  setColors();
  computeLayout();

  return {
    setData,
    select,
    reveal,
    redraw() {
      setColors();
      computeLayout();
      render();
    },
    setWipSubject(text) {
      wipSubject = text ?? '';
      const row = rendered.get('wip');
      if (row && document.activeElement !== row.wipInput) row.wipInput.value = wipSubject;
    },
    focusWip() {
      reveal('wip', false);
      rendered.get('wip')?.wipInput.focus();
    },
    setAvatars(on) {
      showAvatars = on;
      opts.prefs.set('graph.avatars', on);
      computeLayout();
      render();
    },
    setDetailColumns(on) {
      detailColumns = on;
      for (const [, element] of rendered) element.remove();
      rendered.clear();
      computeLayout();
      render();
    },
    /** 검색: 맞는 커밋 번호 집합(null 이면 끔). 안 맞는 줄·선·원을 흐린다. */
    setSearchMatches(set) {
      searchMatches = set;
      for (const [key, element] of rendered) if (key !== 'wip') element.classList.toggle('dimmed', !!set && !set.has(Number(element.dataset.index)));
      draw();
    },
    beginBranchInput,
    cancelBranchInput,
    get selected() { return selected; },
    get hasWip() { return hasWip; },
    get commits() { return commits; },
    get avatarsOn() { return showAvatars; },
    laneOfHash(hash) {
      const index = commits.findIndex((c) => c.hash === hash);
      return index >= 0 ? laneOf(index) : null;
    },
  };
}
