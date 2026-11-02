// 가운데 커밋 그래프. 줄은 보이는 것만 DOM 으로 만들고(가상 스크롤), 가지 선·커밋 원은 그 위에 겹친 canvas 하나에 그린다.
// 열 배치는 Rust(gitvcs-core::graph)가 정해 보낸다: nodes[i] = {row, lane, color}, edges = [{points:[[row,lane]…], color, merge}].

import { el, relativeTime, formatDate, authorColor, initials } from './util.js';

export const ROW_HEIGHT = 32;
const LANE_SPACING = 26;
const PADDING = 18;
const AVATAR_RADIUS = 10;
const MIN_GRAPH_WIDTH = 64;
const MAX_GRAPH_WIDTH = 420;
const OVERSCAN = 6;

// 원본 GraphStyle.LaneColors 와 같은 여덟 색.
const LANE_COLORS = ['#599eff', '#59cc73', '#ff9e40', '#b885ff', '#ff73a6', '#4dcccc', '#f2cc4d', '#f26659'];
export const laneColor = (index) => LANE_COLORS[index % LANE_COLORS.length];

export function createGraph({ scroll, sizer, canvas, rows, header, onSelect }) {
  let commits = [];
  let nodes = [];
  let edges = [];
  let laneCount = 1;
  let hasWip = false;
  let wipCount = 0;
  let headRow = -1;
  let selected = null;
  let graphWidth = MIN_GRAPH_WIDTH;
  let frame = 0;

  const rowCount = () => commits.length + (hasWip ? 1 : 0);
  const offset = () => (hasWip ? 1 : 0);
  const keyOf = (row) => (hasWip && row === 0 ? 'wip' : commits[row - offset()]?.hash);

  function columnX() {
    const style = getComputedStyle(document.documentElement);
    return parseFloat(style.getPropertyValue('--col-refs')) || 0;
  }

  function setData(history, status) {
    commits = history.commits;
    nodes = history.graph.nodes;
    edges = history.graph.edges.map((e) => ({ ...e, min: e.points[0][0], max: e.points[e.points.length - 1][0] }));
    laneCount = Math.max(1, history.graph.laneCount);
    wipCount = status ? status.staged.length + status.unstaged.length : 0;
    // 커밋이 하나도 없는 저장소도 WIP 줄은 둔다(첫 커밋을 만들 수 있게).
    hasWip = wipCount > 0 || commits.length === 0;
    headRow = history.head ? commits.findIndex((c) => c.hash === history.head) : -1;
    graphWidth = Math.min(MAX_GRAPH_WIDTH, Math.max(MIN_GRAPH_WIDTH, PADDING * 2 + (laneCount - 1) * LANE_SPACING));
    document.documentElement.style.setProperty('--col-graph', `${graphWidth}px`);
    if (selected && selected !== 'wip' && !commits.some((c) => c.hash === selected)) selected = null;
    if (selected === 'wip' && !hasWip) selected = null;
    sizer.style.height = `${rowCount() * ROW_HEIGHT}px`;
    render();
  }

  function select(key, notify = true) {
    selected = key;
    for (const row of rows.children) row.classList.toggle('selected', row.dataset.key === key);
    if (notify) onSelect(key);
  }

  function rowElement(row) {
    if (hasWip && row === 0) {
      return el('div', { class: 'grow wip', 'data-key': 'wip', style: { top: `${row * ROW_HEIGHT}px` } },
        el('div', { class: 'col col-refs' }),
        el('div', { class: 'col col-graph' }),
        el('div', { class: 'col col-msg' }, el('span', { class: 'wip-label', text: '// WIP' }),
          el('span', { class: 'wip-count', text: wipCount ? `변경 ${wipCount}개` : '변경 없음' })),
        el('div', { class: 'col col-author' }),
        el('div', { class: 'col col-date' }),
        el('div', { class: 'col col-sha' }));
    }
    const index = row - offset();
    const commit = commits[index];
    const node = nodes[index];
    const color = laneColor(node.color);
    // 지금 브랜치 → 로컬 → 원격 → 태그 순서로 보인다(첫 이름표만 보이고 나머지는 +n).
    const order = { head: 0, local: 1, detachedHead: 1, remote: 2, tag: 3 };
    const refs = [...commit.refs].sort((a, b) => order[a.kind] - order[b.kind]);
    const pills = refs.slice(0, 1).map((r) => refPill(r, color));
    if (refs.length > 1) pills.push(el('span', { class: 'ref-more', title: refs.map((r) => r.name).join('\n'), text: `+${refs.length - 1}` }));
    return el('div', { class: `grow${index === headRow ? ' head' : ''}`, 'data-key': commit.hash, style: { top: `${row * ROW_HEIGHT}px` } },
      el('div', { class: 'col col-refs' }, pills),
      el('div', { class: 'col col-graph' }),
      el('div', { class: 'col col-msg', title: commit.subject }, commit.subject),
      el('div', { class: 'col col-author', title: commit.authorEmail }, commit.authorName),
      el('div', { class: 'col col-date', title: formatDate(commit.time, true) }, relativeTime(commit.time)),
      el('div', { class: 'col col-sha mono' }, commit.shortHash));
  }

  function render() {
    const top = scroll.scrollTop;
    const height = scroll.clientHeight;
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(rowCount() - 1, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
    const fragment = document.createDocumentFragment();
    for (let row = first; row <= last; row++) {
      const element = rowElement(row);
      if (element.dataset.key === selected) element.classList.add('selected');
      fragment.append(element);
    }
    rows.replaceChildren(fragment);
    draw(first, last);
  }

  function draw(first, last) {
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
    const left = columnX();
    const scrollTop = scroll.scrollTop;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, 0, graphWidth, height);
    ctx.clip();
    const x = (lane) => left + PADDING + lane * LANE_SPACING;
    const y = (row) => (row + offset()) * ROW_HEIGHT + ROW_HEIGHT / 2 - scrollTop;
    const background = getComputedStyle(document.documentElement).getPropertyValue('--git-graph-bg').trim();

    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (const edge of edges) {
      if (edge.max < first - offset() - 1 || edge.min > last) continue;
      ctx.strokeStyle = laneColor(edge.color);
      ctx.beginPath();
      const [r0, l0] = edge.points[0];
      ctx.moveTo(x(l0), y(r0));
      for (let i = 1; i < edge.points.length; i++) {
        const [r1, l1] = edge.points[i - 1];
        const [r2, l2] = edge.points[i];
        if (l1 === l2) {
          ctx.lineTo(x(l2), y(r2));
        } else {
          // 한 줄 사이에서 옆 열로 넘어가는 곡선.
          const midY = (y(r1) + y(r2)) / 2;
          ctx.bezierCurveTo(x(l1), midY, x(l2), midY, x(l2), y(r2));
        }
      }
      ctx.stroke();
    }

    // WIP: 지금 커밋에서 점선으로 올라온 빈 원.
    if (hasWip) {
      const lane = headRow >= 0 ? nodes[headRow].lane : 0;
      const wy = ROW_HEIGHT / 2 - scrollTop;
      const color = headRow >= 0 ? laneColor(nodes[headRow].color) : laneColor(0);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = color;
      if (headRow >= 0) {
        ctx.beginPath();
        ctx.moveTo(x(lane), wy + AVATAR_RADIUS);
        ctx.lineTo(x(lane), y(headRow) - AVATAR_RADIUS);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x(lane), wy, AVATAR_RADIUS - 1, 0, Math.PI * 2);
      ctx.fillStyle = background;
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const firstCommit = Math.max(0, first - offset());
    const lastCommit = Math.min(commits.length - 1, last - offset());
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 9px -apple-system, "Segoe UI", "Malgun Gothic", sans-serif';
    for (let i = firstCommit; i <= lastCommit; i++) {
      const node = nodes[i];
      const commit = commits[i];
      const cx = x(node.lane);
      const cy = y(node.row);
      const color = laneColor(node.color);
      if (commit.parents.length > 1) {
        // 병합 커밋은 작은 점.
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.arc(cx, cy, AVATAR_RADIUS + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, AVATAR_RADIUS - 1, 0, Math.PI * 2);
      ctx.fillStyle = authorColor(commit.authorName);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(initials(commit.authorName), cx, cy + 0.5);
      if (i === headRow) {
        ctx.beginPath();
        ctx.arc(cx, cy, AVATAR_RADIUS + 4, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.lineWidth = 2;
      }
    }
    ctx.restore();
  }

  function onScroll() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(render);
  }

  scroll.addEventListener('scroll', onScroll);
  window.addEventListener('resize', onScroll);
  rows.addEventListener('click', (event) => {
    const row = event.target.closest('.grow');
    if (row) select(row.dataset.key);
  });
  scroll.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    let row = 0;
    for (let r = 0; r < rowCount(); r++) if (keyOf(r) === selected) row = r;
    row = Math.max(0, Math.min(rowCount() - 1, row + (event.key === 'ArrowDown' ? 1 : -1)));
    const top = row * ROW_HEIGHT;
    if (top < scroll.scrollTop) scroll.scrollTop = top;
    else if (top + ROW_HEIGHT > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = top + ROW_HEIGHT - scroll.clientHeight;
    select(keyOf(row));
  });

  return {
    setData,
    select,
    redraw: render,
    get selected() { return selected; },
    get hasWip() { return hasWip; },
  };
}

function refPill(ref, color) {
  const icon = { head: '✓ ', local: '', remote: '☁ ', tag: '◆ ', detachedHead: '' }[ref.kind] ?? '';
  const pill = el('span', { class: `ref-pill ref-${ref.kind}`, title: ref.name, text: icon + ref.name });
  if (ref.kind !== 'tag') pill.style.setProperty('--pill', color);
  return pill;
}
