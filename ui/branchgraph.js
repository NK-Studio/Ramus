// Unity VCS 모양 브랜치 탐색기 캔버스. 원본 Elements/BranchGraph/BranchGraphElement.cs · GraphViewport.cs · GraphStyle.cs · GraphLabelLayer.cs 를 옮겼다.
//
// 가지마다 한 줄, 시간은 왼쪽→오른쪽. 배치(가지·칸·줄)는 Rust graph::build(원본 GitGraph.cs)가 하고, 여기는 선·원 그리기(canvas 2D)와
// 글자(가지 이름표·머리글자·메시지·알약·날짜 — 원본처럼 절대 위치 요소를 재사용), 입력(끌기·휠·클릭)만 맡는다.

import { namedLaneRgb } from './graph.js';
import { formatDate, initials } from './util.js';

// ── GraphStyle ──────────────────────────────────────
const COLUMN_WIDTH = 110;
// 가지 줄 사이 높이. 줄 머리표·커밋 제목이 위아래 줄과 붙어 보이지 않게 넉넉히 둔다.
const ROW_HEIGHT = 112;
const ORIGIN_X = 120;
const ORIGIN_Y = 96;
const NODE_RADIUS = 15;
const HEADER_HEIGHT = 24;
/** 이보다 작게 축소하면 글자를 숨긴다(읽을 수 없는 크기라). */
const TEXT_ZOOM_THRESHOLD = 0.55;
/** 병합 선(Unity VCS Branch Explorer 처럼 가지 색과 따로 초록). */
const MERGE_LINE = [0.42, 0.78, 0.55].map((c) => c * 255);
/** 태그(레이블)가 붙은 커밋을 두르는 고리. */
const TAG_RING = [0.33, 0.86, 0.6].map((c) => c * 255);

// ── GraphViewport ───────────────────────────────────
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
/** 휠 한 칸(delta 1)에 옮기는 픽셀. */
const WHEEL_PAN_STEP = 18;

// 올려 둔 커밋의 장식(빛 번짐·굵어지는 테두리·퍼지는 고리).
const HOVER_FADE_SECONDS = 0.15;
const HOVER_PULSE_SECONDS = 1.4;

/** 머리가 화면 왼쪽 밖으로 나간 가지의 이름표가 붙는 자리(왼쪽 끝에서 띄우는 거리). */
const STICKY_MARGIN = 8;
const MIN_LANE_LABEL_WIDTH = 28;
// .bx-lane 의 좌우 여백(9 + 10)·왼쪽 가지 색 막대(2.5), 위아래 여백(3 + 4).
const LANE_LABEL_PADDING = { x: 21.5, y: 7 };
// .bx-lane--compact 의 좌우 여백(4 + 5)·막대(2), 위아래 여백(0 + 1).
const COMPACT_LANE_LABEL_PADDING = { x: 11, y: 1 };
// .bx-pill 의 좌우 여백(5 + 5).
const PILL_PADDING = 10;
// 이름표끼리 이만큼은 떨어져 있어야 한다 — 맞닿아도 그림자 때문에 한 덩어리로 보였다.
const LABEL_GAP = 3;
/** 이름표 글자 줄 높이 배율(.bx-label 의 line-height 와 같다). */
const LINE_HEIGHT = 1.2;

/** 병합 메시지에서 이름을 찾지 못한 가지(graph.rs ANONYMOUS_LANE · 원본 graph.mergedBranch). */
export const MERGED_BRANCH = '(병합된 브랜치)';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);
const css = ([r, g, b], a = 1) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
const nfc = (text) => (text ?? '').normalize('NFC');

/** 날짜(현지 시각)의 날 부분. 날짜 띠를 가른다. */
const dayOf = (unix) => {
  const d = new Date(unix * 1000);
  return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
};

/**
 * explorerHistory 결과를 원본 GitGraph 모양으로 바꾼다: 노드는 오래된 커밋부터(칸 = 번호), 가지마다 첫·끝 칸, 줄 이름이 아닌 참조 꼬리표.
 */
export function buildModel(h) {
  const commits = h?.commits ?? [];
  const n = commits.length;
  const lanes = (h?.graph?.lanes ?? []).map((l) => ({
    name: l.name, row: l.column, colorIndex: l.color, anonymous: !!l.anonymous, remote: !!l.remote, current: !!l.current,
    firstColumn: Infinity, lastColumn: -1, rgb: namedLaneRgb({ color: l.color, anonymous: !!l.anonymous }),
  }));
  const nodes = [];
  const nodeByHash = new Map();
  for (let column = 0; column < n; column++) {
    const index = n - 1 - column;
    const commit = commits[index];
    const g = h.graph.nodes[index];
    const lane = lanes[g?.lane ?? 0];
    const node = { commit, index, column, lane, isHead: commit.hash === h.head, truncated: !!g?.truncated, refLabels: [], headBranch: null, refs: '' };
    if (lane) {
      lane.firstColumn = Math.min(lane.firstColumn, column);
      lane.lastColumn = Math.max(lane.lastColumn, column);
    }
    nodes.push(node);
    nodeByHash.set(commit.hash, node);
  }
  // 원본 CollectRefLabels: "HEAD -> main" 은 main(그리고 HeadBranch), HEAD·x/HEAD 는 빼고, 태그는 "tag: v0.1" 그대로.
  // 줄 이름과 같은 브랜치는 가지 이름표에 이미 나온다 — 끝 커밋이 아닐 때만(줄이 더 이어질 때) 다시 붙인다.
  for (const node of nodes) {
    const raw = [];
    for (const ref of node.commit.refs ?? []) {
      if (ref.kind === 'detachedHead') {
        raw.push('HEAD');
        continue;
      }
      if (ref.kind === 'head') {
        node.headBranch = ref.name;
        raw.push(`HEAD -> ${ref.name}`);
      } else raw.push(ref.kind === 'tag' ? `tag: ${ref.name}` : ref.name);
      const label = ref.kind === 'tag' ? `tag: ${ref.name}` : ref.name;
      if (label === 'HEAD' || label.endsWith('/HEAD')) continue;
      if (node.lane && label === node.lane.name && node.column === node.lane.lastColumn) continue;
      node.refLabels.push(label);
    }
    node.refs = raw.join(', ');
  }
  const edges = (h?.graph?.edges ?? []).map((e) => ({ parent: nodes[n - 1 - e.parent], child: nodes[n - 1 - e.child], merge: !!e.merge }));
  return { nodes, lanes, edges, nodeByHash, truncated: nodes.filter((node) => node.truncated) };
}

/**
 * 브랜치 탐색기 캔버스를 만든다.
 * opts: { avatars, avatarsOn(), zoom, onSelect(node), onChoose(node), onContextMenu(event, node), onViewport({ zoom, pan }) }
 */
export function createBranchGraph(opts = {}) {
  const root = document.createElement('div');
  root.className = 'bx-graph';
  const canvas = document.createElement('canvas');
  canvas.className = 'bx-canvas';
  const labelLayer = div('bx-layer');
  const header = div('bx-header');
  const empty = div('bx-empty');
  empty.hidden = true;
  const tooltip = div('bx-label bx-tooltip');
  tooltip.hidden = true;
  root.append(canvas, labelLayer, header, empty, tooltip);
  const labels = labelPool(labelLayer);
  const headerLabels = labelPool(header);
  const measurer = document.createElement('canvas').getContext('2d');

  const viewport = { zoom: clamp(opts.zoom ?? 1, MIN_ZOOM, MAX_ZOOM), pan: { x: 0, y: 0 } };
  let graph = null;
  let size = { w: 0, h: 0 };
  let selectedHash = null;
  let search = '';
  let centerPending = true;
  let panning = null;
  let hovered = null;
  let pointer = { x: 0, y: 0 };
  let occupied = [];
  let nextLaneStart = null;
  let colors = readColors();
  let fontFamily = null;
  let disposed = false;

  // 올려 둔 커밋의 장식: 0→1 로 차오르고, 떠난 커밋은 1→0 으로 사라진다.
  let hoverIn = 0;
  let hoverFading = null;
  let hoverOut = 0;
  let hoverStart = 0;
  let lastHoverTick = 0;
  let hoverTicker = null;

  // ── 좌표 ──
  const worldOf = (node) => ({ x: ORIGIN_X + node.column * COLUMN_WIDTH, y: ORIGIN_Y + node.lane.row * ROW_HEIGHT });
  const toCanvas = (world) => ({ x: world.x * viewport.zoom - viewport.pan.x, y: world.y * viewport.zoom - viewport.pan.y });
  const toWorld = (p) => ({ x: (p.x + viewport.pan.x) / viewport.zoom, y: (p.y + viewport.pan.y) / viewport.zoom });
  const canvasX = (column) => (ORIGIN_X + column * COLUMN_WIDTH) * viewport.zoom - viewport.pan.x;
  const canvasY = (lane) => (ORIGIN_Y + lane.row * ROW_HEIGHT) * viewport.zoom - viewport.pan.y;
  const nodePos = (node) => toCanvas(worldOf(node));
  const tubeRadius = () => (NODE_RADIUS + 8) * viewport.zoom;
  const isVisibleX = (x, margin) => x >= -margin && x <= size.w + margin;

  function panBy(dx, dy) {
    viewport.pan = { x: viewport.pan.x - dx, y: viewport.pan.y - dy };
  }
  /** 캔버스의 한 점(마우스 위치 등) 아래 월드 지점이 그대로 있도록 확대·축소한다. */
  function zoomAround(point, newZoom) {
    const world = toWorld(point);
    viewport.zoom = clamp(newZoom, MIN_ZOOM, MAX_ZOOM);
    viewport.pan = { x: world.x * viewport.zoom - point.x, y: world.y * viewport.zoom - point.y };
  }
  /** 월드 지점을 화면 정중앙에 둔다. */
  function focusWorld(world) {
    viewport.pan = { x: world.x * viewport.zoom - size.w * 0.5, y: world.y * viewport.zoom - size.h * 0.5 };
  }
  const viewportChanged = () => opts.onViewport?.({ zoom: viewport.zoom, pan: { ...viewport.pan } });

  // ── 외부 API ──

  /** emptyMessage: 커밋이 없을 때 가운데 보일 문구. */
  function setGraph(model, emptyMessage) {
    const firstGraph = graph == null;
    graph = model;
    nextLaneStart = null;
    centerPending ||= firstGraph;
    const message = !model || model.nodes.length === 0 ? emptyMessage ?? '' : '';
    empty.textContent = message;
    empty.hidden = !message;
    if (hovered && !model?.nodeByHash.has(hovered.commit.hash)) setHovered(null);
    hoverFading = null;
    measureSize();
    tryCenterOnHead();
    refresh();
  }

  function setSelected(hash) {
    selectedHash = hash;
    refresh();
  }

  function setSearch(query) {
    search = (query ?? '').trim().toLowerCase();
    refresh();
  }

  function matches(node) {
    if (!search) return true;
    const c = node.commit;
    return c.subject.toLowerCase().includes(search) || c.authorName.toLowerCase().includes(search) || c.hash.toLowerCase().startsWith(search)
      || node.refs.toLowerCase().includes(search) || node.lane.name.toLowerCase().includes(search);
  }

  function focusNode(node) {
    if (!node) return;
    measureSize();
    focusWorld(worldOf(node));
    refresh();
    viewportChanged();
  }

  function zoomBy(factor) {
    measureSize();
    zoomAround({ x: size.w * 0.5, y: size.h * 0.5 }, viewport.zoom * factor);
    refresh();
    viewportChanged();
  }

  function findHead() {
    return graph?.nodes.find((node) => node.isHead) ?? null;
  }

  // ── 그리기 ──

  function measureSize() {
    size = { w: root.clientWidth, h: root.clientHeight };
  }

  function refresh() {
    if (disposed) return;
    draw();
    updateLabels();
  }

  /** 처음 받은 그래프는 HEAD(없으면 가장 최근 커밋)를 가운데에 두고 시작한다. 크기가 잡히기 전이면 미룬다. */
  function tryCenterOnHead() {
    if (!centerPending || !graph || graph.nodes.length === 0 || size.w <= 1) return;
    centerPending = false;
    const head = findHead() ?? graph.nodes[graph.nodes.length - 1];
    focusWorld(worldOf(head));
    viewportChanged();
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(size.w * dpr));
    const ph = Math.max(1, Math.round(size.h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
      canvas.style.width = `${size.w}px`;
      canvas.style.height = `${size.h}px`;
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.w, size.h);
    if (!graph || graph.nodes.length === 0) return;
    drawDateBands(g);
    drawLaneTubes(g);
    drawEdges(g);
    drawNodes(g);
  }

  /** 날짜가 같은 연속 칸의 [시작, 끝] 칸 번호. */
  function dateRuns() {
    const runs = [];
    const nodes = graph.nodes;
    let start = 0;
    for (let i = 1; i <= nodes.length; i++) {
      if (i === nodes.length || dayOf(nodes[i].commit.time) !== dayOf(nodes[start].commit.time)) {
        runs.push([start, i - 1]);
        start = i;
      }
    }
    return runs;
  }

  /** 날짜가 같은 연속 칸을 묶어 띠로 번갈아 칠한다. */
  function drawDateBands(g) {
    g.fillStyle = css(colors.dateBand, colors.dateBand[3]);
    dateRuns().forEach(([start, end], bandIndex) => {
      if (bandIndex % 2 === 0) return;
      const x0 = canvasX(start - 0.5);
      const x1 = canvasX(end + 0.5);
      if (x1 < 0 || x0 > size.w) return;
      g.fillRect(x0, 0, x1 - x0, size.h);
    });
  }

  /**
   * 가지마다 첫 커밋부터 마지막 커밋까지를 감싸는 관: 옅게 칠한 둥근 막대 + 가지 색 테두리. 고른 커밋의 가지는 진하게 칠한다.
   */
  function drawLaneTubes(g) {
    const radius = tubeRadius();
    const selected = selectedHash ? graph.nodeByHash.get(selectedHash)?.lane : null;
    g.lineWidth = Math.max(1, 1.5 * viewport.zoom);
    for (const lane of graph.lanes) {
      if (lane.lastColumn < 0) continue;
      const x0 = canvasX(lane.firstColumn) - radius;
      const x1 = canvasX(lane.lastColumn) + radius;
      if (x1 < -10 || x0 > size.w + 10) continue;
      const y = canvasY(lane);
      const isSelected = lane === selected;
      capsulePath(g, x0, x1, y, radius);
      g.fillStyle = css(lane.rgb, isSelected ? 0.22 : 0.07);
      g.fill();
      g.strokeStyle = css(lane.rgb, isSelected ? 0.95 : 0.45);
      g.stroke();
    }
  }

  function drawEdges(g) {
    const zoom = viewport.zoom;
    g.lineWidth = Math.max(1.5, 3 * zoom);
    for (const edge of graph.edges) {
      const from = nodePos(edge.parent);
      const to = nodePos(edge.child);
      if (Math.max(from.x, to.x) < -50 || Math.min(from.x, to.x) > size.w + 50) continue;
      // 같은 가지 안은 곧은 선 + 부모 쪽 화살촉, 가지를 만든 선은 부모에서 가지 관 머리까지 곧게, 병합 선은 초록 곡선.
      // 색은 새 커밋 쪽 가지 색이고 병합 선만 병합 색이다.
      const sameLane = edge.parent.lane === edge.child.lane;
      const rgb = edge.merge ? MERGE_LINE : edge.child.lane.rgb;
      const alpha = matches(edge.parent) || matches(edge.child) ? 0.9 : 0.25;
      g.strokeStyle = css(rgb, alpha);
      g.beginPath();
      g.moveTo(from.x, from.y);
      const sameY = Math.abs(from.y - to.y) < 1e-3;
      if (edge.merge && !sameY) {
        // 병합 선: 들어오는 커밋에서 오른쪽으로 나가 둥글게 휘어 병합 커밋에 위·아래로 꽂힌다.
        const dx = Math.max(to.x - from.x, 1);
        g.bezierCurveTo(from.x + dx * 0.55, from.y, to.x, to.y + (from.y - to.y) * 0.55, to.x, to.y);
      } else if (!sameLane && !sameY) {
        // 가지를 만든 선: 부모에서 새 가지 관의 왼쪽 머리까지 곧게, 거기서 관 안을 따라 첫 커밋으로.
        g.lineTo(Math.max(from.x, to.x - tubeRadius()), to.y);
        g.lineTo(to.x, to.y);
      } else {
        g.lineTo(to.x, to.y);
      }
      g.stroke();
      if (sameLane) drawArrowHead(g, from, css(rgb, alpha));
    }
    // 기간 밖으로 이어지는 히스토리: 왼쪽으로 짧은 흐린 선.
    g.strokeStyle = css(colors.truncated, colors.truncated[3]);
    for (const node of graph.truncated) {
      const p = nodePos(node);
      g.beginPath();
      g.moveTo(p.x, p.y);
      g.lineTo(p.x - COLUMN_WIDTH * 0.6 * zoom, p.y);
      g.stroke();
    }
  }

  /** 같은 가지 안의 선 끝(부모 커밋 오른쪽)에 부모를 가리키는 작은 화살촉. 너무 작게 축소하면 그리지 않는다. */
  function drawArrowHead(g, parent, color) {
    const zoom = viewport.zoom;
    if (zoom < TEXT_ZOOM_THRESHOLD) return;
    const tip = parent.x + (NODE_RADIUS + 5) * zoom;
    const length = 6 * zoom;
    const half = 3.5 * zoom;
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(tip, parent.y);
    g.lineTo(tip + length, parent.y - half);
    g.lineTo(tip + length, parent.y + half);
    g.closePath();
    g.fill();
  }

  function drawNodes(g) {
    const zoom = viewport.zoom;
    const radius = NODE_RADIUS * zoom;
    const searching = search.length > 0;
    for (const node of graph.nodes) {
      const p = nodePos(node);
      if (!isVisibleX(p.x, COLUMN_WIDTH)) continue;
      const isMatch = matches(node);
      const alpha = isMatch ? 1 : 0.3;
      if (node.commit.hash === selectedHash) fillCircle(g, p, radius + 7, css(colors.selection, colors.selection[3]));
      else if (searching && isMatch) fillCircle(g, p, radius + 7, css(colors.search, colors.search[3]));

      const isLaneTip = node.column === node.lane.lastColumn;
      const ring = node.isHead ? colors.head : node.lane.rgb;
      const hover = hoverAmount(node);
      if (hover > 0) drawHoverGlow(g, p, radius, ring, alpha, hover, node === hovered);
      const ringRadius = radius + (isLaneTip ? 4 : 2.5) + 2 * hover;
      drawShadow(g, p, ringRadius, alpha);
      fillCircle(g, p, ringRadius, css(ring, alpha));

      // 안쪽은 가지 색을 어둡게 — 흰 머리글자가 잘 읽힌다.
      const fill = lerp(lerp(node.lane.rgb, [0, 0, 0], 0.45), [255, 255, 255], 0.15 * hover);
      fillCircle(g, p, radius, css(fill, alpha));

      // 태그가 붙은 커밋은 Unity VCS 의 레이블처럼 바깥에 초록 고리를 두른다(태그 이름은 위에 글자로).
      if (node.refLabels.some((label) => label.startsWith('tag: '))) {
        g.strokeStyle = css(TAG_RING, alpha);
        g.lineWidth = Math.max(1.5, 2.5 * zoom);
        g.beginPath();
        g.arc(p.x, p.y, ringRadius + 4 * zoom, 0, Math.PI * 2);
        g.closePath();
        g.stroke();
      }
    }
  }

  /** 0(장식 없음)~1(다 드러남). 차오름·사라짐에 ease-out 을 걸어 끝이 부드럽게 멈추게 한다. */
  function hoverAmount(node) {
    const linear = node === hovered ? hoverIn : node === hoverFading ? hoverOut : 0;
    return 1 - (1 - linear) * (1 - linear);
  }

  /** 테두리 아래에 깔리는 빛 번짐과, 올려 두는 동안 바깥으로 퍼지며 옅어지는 고리. */
  function drawHoverGlow(g, center, radius, rgb, alpha, amount, isPulsing) {
    // 많이 축소해도 장식이 커밋보다 커 보이지 않게, 확대만큼만 키운다(최소 0.6배).
    const scale = Math.max(viewport.zoom, 0.6);
    const offsets = [16, 11, 7];
    const strengths = [0.06, 0.1, 0.16];
    for (let i = 0; i < offsets.length; i++) fillCircle(g, center, radius + offsets[i] * scale, css(rgb, alpha * strengths[i] * amount));
    if (!isPulsing) return;
    const elapsed = (performance.now() - hoverStart) / 1000;
    const phase = (elapsed % HOVER_PULSE_SECONDS) / HOVER_PULSE_SECONDS;
    g.strokeStyle = css(rgb, alpha * 0.7 * (1 - phase) * amount);
    g.lineWidth = 2;
    g.beginPath();
    g.arc(center.x, center.y, radius + (5 + phase * 16) * scale, 0, Math.PI * 2);
    g.closePath();
    g.stroke();
  }

  /**
   * 원 아래 그림자. 아래로 조금 내린 원을 바깥에서 안쪽으로 조금씩 줄이며 옅게 겹쳐 번지게 한다(원본 Painter2D 와 같은 방법).
   */
  function drawShadow(g, center, radius, alpha) {
    const LAYERS = 12;
    const scale = Math.max(viewport.zoom, 0.6);
    const drop = 2 * scale;
    const spread = 6 * scale;
    const color = css(colors.shadow, colors.shadow[3] * 0.06 * alpha);
    for (let i = 0; i < LAYERS; i++) fillCircle(g, { x: center.x, y: center.y + drop }, radius + spread * (1 - i / LAYERS), color);
  }

  // ── 글자 ──

  function updateLabels() {
    labels.begin();
    headerLabels.begin();
    occupied = [];
    if (graph && graph.nodes.length > 0 && size.w > 1) {
      const hiddenText = viewport.zoom < TEXT_ZOOM_THRESHOLD;
      root.classList.toggle('bx-graph--hidden-text', hiddenText);
      placeLaneLabels(hiddenText);
      // 읽을 수 없게 작으면 커밋 글자(머리글자·메시지·이름표)는 놓지 않는다.
      if (!hiddenText) placeNodeLabels();
      placeDateLabels();
    }
    labels.end();
    headerLabels.end();
    updateTooltip();
  }

  /** 글자 폭·높이(.bx-label 글꼴로 잰다). */
  function measure(text, fontSize, weight = 400, italic = false) {
    fontFamily ??= getComputedStyle(root).fontFamily || 'sans-serif';
    measurer.font = `${italic ? 'italic ' : ''}${weight} ${fontSize}px ${fontFamily}`;
    return { x: measurer.measureText(nfc(text)).width, y: Math.ceil(fontSize * LINE_HEIGHT) };
  }

  /**
   * 가지 이름표: 가지 관 머리의 위쪽에 둔다 — 선 위에 얹지 않아 선·커밋을 가리지 않는다.
   * 가지 머리가 화면 왼쪽 밖으로 나가면 가지가 보이는 동안 화면 왼쪽 끝에 붙어 따라오다가, 가지 끝에 닿으면 함께 밀려 나간다.
   * 글자는 확대에 맞춰 커진다. 같은 행의 다음 가지 머리를 넘지 않게 자르고 넘치면 말줄임.
   */
  function placeLaneLabels(compact) {
    const radius = tubeRadius();
    const padding = compact ? COMPACT_LANE_LABEL_PADDING : LANE_LABEL_PADDING;
    const fontSize = clamp(13 * viewport.zoom, 6, 22);
    for (const lane of graph.lanes) {
      if (lane.lastColumn < 0) continue;
      const start = canvasX(lane.firstColumn) - radius;
      const end = canvasX(lane.lastColumn) + radius;
      if (end < 0 || start > size.w) continue;
      // 이름 없는(병합된) 줄은 병합 메시지에서 딴 이름을 "master 에서 병합" 처럼 출처로 보인다 — 그냥 "master" 라고 쓰면 진짜 master 줄과 헷갈렸다.
      const text = !lane.anonymous ? `/${lane.name}` : lane.name === MERGED_BRANCH ? lane.name : `${lane.name} 에서 병합`;
      let left = Math.max(start, STICKY_MARGIN);
      let maxWidth = Infinity;
      const next = laneStartAfter(lane);
      if (next != null) {
        maxWidth = canvasX(next) - radius - LABEL_GAP * 2 - left;
        if (maxWidth < MIN_LANE_LABEL_WIDTH) continue;
      }
      const modifiers = [];
      if (lane.anonymous) modifiers.push('bx-lane--anonymous');
      if (compact) modifiers.push('bx-lane--compact');
      const label = labels.place('bx-lane', text, { fontSize, modifiers });
      label.style.maxWidth = Number.isFinite(maxWidth) ? `${maxWidth}px` : '';
      label.style.borderLeftColor = css(lane.rgb);
      const textSize = measure(text, fontSize, 400, lane.anonymous);
      const width = Math.min(textSize.x + padding.x, maxWidth);
      const height = textSize.y + padding.y;
      if (start < STICKY_MARGIN) left = Math.min(left, end - width);
      const top = canvasY(lane) - radius - 4 - height;
      label.style.left = `${left}px`;
      label.style.top = `${top}px`;
      occupied.push({ x: left, y: top, w: width, h: height });
    }
  }

  /** 그 줄과 같은 행에서 그 줄이 끝난 뒤 가장 먼저 시작하는 줄의 첫 칸(이름표가 그 머리를 넘지 않게). 그래프가 바뀔 때만 다시 센다. */
  function laneStartAfter(lane) {
    if (!nextLaneStart) {
      nextLaneStart = new Map();
      const rows = new Map();
      for (const each of graph.lanes) {
        if (each.lastColumn < 0) continue;
        if (!rows.has(each.row)) rows.set(each.row, []);
        rows.get(each.row).push(each);
      }
      for (const row of rows.values()) {
        const ordered = row.slice().sort((a, b) => a.firstColumn - b.firstColumn);
        ordered.forEach((each, i) => {
          const next = ordered.slice(i + 1).find((other) => other.firstColumn > each.lastColumn);
          if (next) nextLaneStart.set(each, next.firstColumn);
        });
      }
    }
    return nextLaneStart.get(lane) ?? null;
  }

  function isOccupied(rect) {
    const padded = { x: rect.x - LABEL_GAP, y: rect.y - LABEL_GAP, w: rect.w + LABEL_GAP * 2, h: rect.h + LABEL_GAP * 2 };
    return occupied.some((each) => each.x < padded.x + padded.w && padded.x < each.x + each.w && each.y < padded.y + padded.h && padded.y < each.y + each.h);
  }

  function placeNodeLabels() {
    const zoom = viewport.zoom;
    const radius = NODE_RADIUS * zoom;
    const initialsSize = clamp(11 * zoom, 6, 20);
    const subjectSize = clamp(10 * zoom, 6, 18);
    const subjectWidth = COLUMN_WIDTH * zoom - 10;
    const showAvatars = opts.avatarsOn?.() ?? true;
    for (const node of graph.nodes) {
      const p = nodePos(node);
      if (!isVisibleX(p.x, COLUMN_WIDTH)) continue;
      const opacity = matches(node) ? '1' : '0.3';
      const avatar = showAvatars ? opts.avatars?.get?.(node.commit.authorEmail, node.commit.hash) : null;
      if (avatar) {
        const image = labels.placeImage('bx-avatar', avatar.src, p, radius);
        image.style.opacity = opacity;
      } else {
        const label = labels.place('bx-initials', initials(node.commit.authorName), { x: p.x - radius, y: p.y - radius, w: radius * 2, h: radius * 2, fontSize: initialsSize });
        label.style.lineHeight = `${radius * 2}px`;
        label.style.opacity = opacity;
      }
      // 폭은 글자에 맞추고(바탕 상자가 글자 둘레만 선을 가리게) 칸 폭을 넘으면 말줄임.
      const subject = labels.place('bx-subject', node.commit.subject, { x: p.x, y: p.y + radius + 6, fontSize: subjectSize, anchorX: 0.5 });
      subject.style.maxWidth = `${subjectWidth}px`;
      subject.style.opacity = opacity;
      placePills(node, p, radius);
    }
  }

  /**
   * 커밋 위에 HEAD·브랜치·태그 이름표를 쌓는다. 셋 넘으면 "+n" 으로 줄인다.
   * HEAD 커밋은 "HEAD" 대신 지금 브랜치 이름을 HEAD 색으로(detached 면 "HEAD"). 줄 이름과 같은 브랜치는 refLabels 에서 빠진다.
   */
  function placePills(node, p, radius) {
    const pills = [];
    let headName = null;
    if (node.isHead) {
      headName = node.headBranch || 'HEAD';
      pills.push([headName, 'bx-pill--head']);
    }
    for (const label of node.refLabels) {
      if (label === headName) continue;
      const isTag = label.startsWith('tag: ');
      pills.push([isTag ? label.slice(5) : label, isTag ? 'bx-pill--tag' : null]);
    }
    // 셋까지 쌓고 넘치면 셋째 자리를 "+n" 으로. 위로 쌓다가 줄 머리표·다른 커밋 이름표와 겹치는 자리가 나오면 거기서 멈추고
    // 바로 앞 자리를 "+n" 으로 바꾼다(첫 자리만 들어가면 첫 이름표만). 지금 브랜치(HEAD) 이름표는 겹쳐도 보인다.
    const PILL_HEIGHT = 16;
    const slots = Math.min(pills.length, 3);
    const placed = [];
    for (let i = 0; i < slots; i++) {
      const isOverflow = i === 2 && pills.length > 3;
      const pill = placePill(isOverflow ? `+${pills.length - 2}` : pills[i][0], isOverflow ? null : pills[i][1], p, radius, i, PILL_HEIGHT);
      if (isOccupied(pill.rect) && (i > 0 || headName == null)) {
        pill.label.style.display = 'none';
        if (placed.length >= 2) {
          const last = placed.length - 1;
          placed[last].label.style.display = 'none';
          const overflow = placePill(`+${pills.length - last}`, null, p, radius, last, PILL_HEIGHT);
          placed[last] = { label: null, rect: overflow.rect };
        }
        break;
      }
      placed.push(pill);
    }
    for (const each of placed) occupied.push(each.rect);
  }

  function placePill(text, modifier, p, radius, slot, pillHeight) {
    const y = p.y - radius - 6 - (slot + 1) * (pillHeight + 2);
    const label = labels.place('bx-pill', text, { x: p.x, y, h: pillHeight, anchorX: 0.5, modifiers: modifier ? [modifier] : [] });
    const width = measure(text, modifier === 'bx-pill--tag' ? 11 : 9, 700).x + PILL_PADDING;
    return { label, rect: { x: p.x - width / 2, y, w: width, h: pillHeight } };
  }

  function placeDateLabels() {
    for (const [start, end] of dateRuns()) {
      const x0 = canvasX(start - 0.5);
      const x1 = canvasX(end + 0.5);
      if (x1 < 0 || x0 > size.w) continue;
      // 띠가 화면 밖으로 일부 나가도 날짜는 보이는 부분 가운데에 둔다.
      const left = Math.max(x0, 0);
      const right = Math.min(x1, size.w);
      headerLabels.place('bx-date', formatDate(graph.nodes[start].commit.time), { x: left, y: 0, w: right - left, h: HEADER_HEIGHT });
    }
  }

  function updateTooltip() {
    if (!hovered || panning) {
      tooltip.hidden = true;
      return;
    }
    const c = hovered.commit;
    tooltip.textContent = nfc(`${c.subject}\n${c.shortHash} · ${c.authorName} · ${formatDate(c.time, true)}\n줄: ${hovered.lane.name}`);
    tooltip.style.left = `${pointer.x + 14}px`;
    tooltip.style.top = `${pointer.y + 14}px`;
    tooltip.hidden = false;
  }

  // ── 입력 ──

  function local(event) {
    const rect = root.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function hitTest(point) {
    if (!graph) return null;
    const radius = NODE_RADIUS * viewport.zoom + 3;
    for (const node of graph.nodes) {
      const p = nodePos(node);
      if (Math.hypot(point.x - p.x, point.y - p.y) <= radius) return node;
    }
    return null;
  }

  root.addEventListener('pointerdown', (event) => {
    const position = local(event);
    if (event.button === 0) {
      const hit = hitTest(position);
      if (hit) {
        opts.onSelect?.(hit);
        event.stopPropagation();
        return;
      }
    }
    // 빈 곳을 왼쪽·가운데 단추로 끌면 이동.
    if (event.button === 0 || event.button === 1) {
      panning = { id: event.pointerId, x: event.clientX, y: event.clientY };
      try {
        root.setPointerCapture(event.pointerId);
      } catch {
        // 합성 이벤트 등 잡을 수 없는 포인터 — 그래도 끌기는 된다.
      }
      setHovered(null);
      event.preventDefault();
      event.stopPropagation();
    }
  });
  root.addEventListener('pointermove', (event) => {
    pointer = local(event);
    if (panning && panning.id === event.pointerId) {
      panBy(event.clientX - panning.x, event.clientY - panning.y);
      panning.x = event.clientX;
      panning.y = event.clientY;
      refresh();
      return;
    }
    setHovered(hitTest(pointer));
  });
  const endPan = (event) => {
    if (!panning || panning.id !== event.pointerId) return;
    panning = null;
    if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
    viewportChanged();
  };
  root.addEventListener('pointerup', endPan);
  root.addEventListener('pointercancel', endPan);
  root.addEventListener('pointerleave', () => {
    if (!panning) setHovered(null);
  });
  // 커밋 원을 두 번 누르면 부모와 비교(원본 NodeChosen).
  root.addEventListener('dblclick', (event) => {
    const hit = hitTest(local(event));
    if (hit) opts.onChoose?.(hit);
  });
  root.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const hit = hitTest(local(event));
    if (!hit) return;
    setHovered(null);
    opts.onSelect?.(hit);
    opts.onContextMenu?.(event, hit);
  });
  // 가로 휠(트랙패드 좌우 스와이프·Shift+휠)은 좌우로 옮기고, 세로 휠은 확대·축소한다(원본 OnWheel · GraphViewport.HorizontalWheel).
  root.addEventListener('wheel', (event) => {
    event.preventDefault();
    // 원본(Unity)의 휠 한 칸은 delta 3 쯤이다. 마우스 휠 한 칸(wheelDelta 가 120 의 배수)은 그 단위로, 트랙패드처럼 잘게 오는 픽셀 단위는
    // 한 칸 100px 남짓을 3 으로 바꾼다.
    const notch = (wheel, delta) => (wheel && wheel % 120 === 0 ? (-wheel / 120) * 3 : delta * (event.deltaMode === 1 ? 1 : event.deltaMode === 2 ? 30 : 0.03));
    const dx = notch(event.wheelDeltaX, event.deltaX);
    const dy = notch(event.wheelDeltaY, event.deltaY);
    const horizontal = event.shiftKey ? (dx !== 0 ? dx : dy) : Math.abs(dx) > Math.abs(dy) ? dx : 0;
    pointer = local(event);
    if (horizontal !== 0) {
      panBy(-horizontal * WHEEL_PAN_STEP, 0);
      // 그래프가 마우스 밑에서 움직였으니 올려 둔 커밋을 다시 고른다.
      setHovered(hitTest(pointer));
    } else {
      zoomAround(pointer, viewport.zoom * clamp(1 - dy * 0.05, 0.5, 1.5));
    }
    refresh();
    viewportChanged();
  }, { passive: false });

  function setHovered(node) {
    if (hovered === node && node == null) return;
    if (hovered !== node) {
      // 떠나는 커밋은 지금 드러난 만큼에서 사라지기 시작한다(빠르게 옮겨 다녀도 뚝 끊기지 않게).
      if (hovered) {
        hoverFading = hovered;
        hoverOut = hoverIn;
      }
      hoverIn = 0;
      hoverStart = performance.now();
      startHoverTicker();
    }
    hovered = node;
    // 커밋 위에서는 손가락 커서(누르면 고른다).
    root.classList.toggle('bx-graph--node-hover', node != null);
    updateTooltip();
  }

  /** 장식이 움직이는 동안만 다시 그린다. 다 사라지면 멈춘다(가만히 있는 그래프는 다시 그리지 않는다). */
  function tickHover() {
    const now = performance.now();
    const step = (now - lastHoverTick) / 1000 / HOVER_FADE_SECONDS;
    lastHoverTick = now;
    hoverIn = hovered == null ? 0 : Math.min(1, hoverIn + step);
    hoverOut = Math.max(0, hoverOut - step);
    if (hoverOut <= 0) hoverFading = null;
    if (!disposed) draw();
    if ((hovered == null && hoverFading == null) || disposed) {
      clearInterval(hoverTicker);
      hoverTicker = null;
    }
  }

  function startHoverTicker() {
    lastHoverTick = performance.now();
    hoverTicker ??= setInterval(tickHover, 16);
  }

  // ── 테마 ──

  /** 캔버스로 그리는 색 중 배경에 따라 달라야 하는 것은 테마 토큰(--git-graph-*)에서 읽는다. 기본값은 어두운 테마 값. */
  function readColors() {
    const style = getComputedStyle(document.documentElement);
    const read = (name, fallback) => parseColor(style.getPropertyValue(name).trim()) ?? fallback;
    return {
      selection: read('--git-graph-selection', [255, 255, 255, 1]),
      search: read('--git-graph-search', [255, 230, 51, 1]),
      head: read('--git-graph-head', [51, 191, 89, 1]),
      dateBand: read('--git-graph-date-band', [255, 255, 255, 0.06]),
      truncated: read('--git-graph-truncated', [153, 153, 153, 0.5]),
      shadow: read('--git-graph-shadow', [0, 0, 0, 0.5]),
    };
  }
  const themeWatch = new MutationObserver(() => {
    colors = readColors();
    fontFamily = null;
    refresh();
  });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });

  const resize = new ResizeObserver(() => {
    measureSize();
    tryCenterOnHead();
    refresh();
  });
  resize.observe(root);
  const unsubscribeAvatars = opts.avatars?.onLoad?.(() => refresh());

  return {
    element: root,
    get graph() { return graph; },
    get viewport() { return { zoom: viewport.zoom, pan: { ...viewport.pan } }; },
    setGraph, setSelected, setSearch, matches, focusNode, zoomBy, findHead,
    /** 그래프 데이터는 그대로이고 보이는 것만 다시 그릴 때(아바타 켜기·끄기 등). */
    redraw: () => refresh(),
    dispose() {
      disposed = true;
      clearInterval(hoverTicker);
      themeWatch.disconnect();
      resize.disconnect();
      unsubscribeAvatars?.();
    },
  };
}

function div(className) {
  const node = document.createElement('div');
  node.className = className;
  return node;
}

function fillCircle(g, center, radius, color) {
  g.fillStyle = color;
  g.beginPath();
  g.arc(center.x, center.y, Math.max(0, radius), 0, Math.PI * 2);
  g.closePath();
  g.fill();
}

function capsulePath(g, x0, x1, y, radius) {
  g.beginPath();
  g.moveTo(x0 + radius, y - radius);
  g.lineTo(x1 - radius, y - radius);
  g.arc(x1 - radius, y, radius, -Math.PI / 2, Math.PI / 2);
  g.lineTo(x0 + radius, y + radius);
  g.arc(x0 + radius, y, radius, Math.PI / 2, Math.PI * 1.5);
  g.closePath();
}

const probe = document.createElement('canvas').getContext('2d');

/** CSS 색 → [r, g, b, a](a 는 0~1). 읽지 못하면 null. */
function parseColor(value) {
  if (!value) return null;
  probe.fillStyle = '#000';
  probe.fillStyle = value;
  const parsed = probe.fillStyle;
  if (parsed.startsWith('#')) {
    const n = parseInt(parsed.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = parsed.match(/[\d.]+/g);
  if (!m) return null;
  return [Number(m[0]), Number(m[1]), Number(m[2]), m[3] != null ? Number(m[3]) : 1];
}

/**
 * 그래프 위의 글자를 종류별로 재사용한다(원본 GraphLabelLayer). 매 갱신마다 begin → place… → end 순서로 부르면 이번에 쓰인 만큼만 보이고 나머지는 숨는다.
 */
function labelPool(container) {
  const pools = new Map();
  const images = [];
  let usedImages = 0;
  return {
    begin() {
      for (const pool of pools.values()) pool.used = 0;
      usedImages = 0;
    },
    /** 둥근 그림 하나(아바타)를 꺼내 위치·그림을 정한다. */
    placeImage(blockClass, src, center, radius) {
      if (usedImages === images.length) {
        const created = div(blockClass);
        container.append(created);
        images.push(created);
      }
      const image = images[usedImages++];
      image.style.display = '';
      const url = `url("${src}")`;
      if (image.style.backgroundImage !== url) image.style.backgroundImage = url;
      image.style.left = `${center.x - radius}px`;
      image.style.top = `${center.y - radius}px`;
      image.style.width = `${radius * 2}px`;
      image.style.height = `${radius * 2}px`;
      return image;
    },
    /**
     * blockClass 글자 하나를 꺼내 위치·글자를 정한다. w·h 가 0 이하면 그 방향은 글자 크기에 맡긴다.
     * anchorX 는 x 가 글자 가로 어디인지(0 왼쪽, 0.5 가운데) — 글자 폭을 몰라도 가운데 정렬할 수 있게 translate 퍼센트로 민다.
     */
    place(blockClass, text, { x = 0, y = 0, w = 0, h = 0, fontSize = 0, anchorX = 0, modifiers = [] } = {}) {
      let pool = pools.get(blockClass);
      if (!pool) {
        pool = { labels: [], used: 0 };
        pools.set(blockClass, pool);
      }
      if (pool.used === pool.labels.length) {
        const created = div(`bx-label ${blockClass}`);
        container.append(created);
        pool.labels.push(created);
      }
      const label = pool.labels[pool.used++];
      // 줄 이름·이름표(브랜치·태그)는 맥에서 만든 이름이면 자모로 풀려 있을 수 있다.
      const value = nfc(text);
      if (label.textContent !== value) label.textContent = value;
      const className = ['bx-label', blockClass, ...modifiers].join(' ');
      if (label.className !== className) label.className = className;
      const s = label.style;
      s.display = '';
      s.left = `${x}px`;
      s.top = `${y}px`;
      s.width = w > 0 ? `${w}px` : '';
      s.height = h > 0 ? `${h}px` : '';
      s.fontSize = fontSize > 0 ? `${fontSize}px` : '';
      s.transform = anchorX ? `translateX(${-anchorX * 100}%)` : '';
      s.maxWidth = '';
      s.opacity = '';
      s.lineHeight = '';
      s.borderLeftColor = '';
      return label;
    },
    end() {
      for (let i = usedImages; i < images.length; i++) images[i].style.display = 'none';
      for (const pool of pools.values()) {
        for (let i = pool.used; i < pool.labels.length; i++) pool.labels[i].style.display = 'none';
      }
    },
  };
}
