// 선 아이콘. 원본 패키지 Elements/ActionGlyph.cs 의 그림을 20 칸 SVG 로 옮겼다 — 글꼴마다 모양이 다른 유니코드 글자를 쓰지 않고,
// 테마 글자색(currentColor)으로 물든다. 선 굵기는 원본과 같은 1.6 칸.

const NS = 'http://www.w3.org/2000/svg';
const STROKE = 1.6;

const pt = (x, y) => `${+x.toFixed(3)} ${+y.toFixed(3)}`;
const poly = (...points) => ({ d: `M${points.map(([x, y]) => pt(x, y)).join('L')}` });
const ring = (cx, cy, r) => ({ circle: [cx, cy, r] });
const box = (left, top) => poly([left, top], [left + 5, top], [left + 5, top + 5], [left, top + 5], [left, top]);
const dot = (cx, cy, r) => ({ circle: [cx, cy, r], fill: true });

/** 호의 끝점. 각도는 원본 Painter2D 처럼 +x 에서 시계 방향(화면 y 아래). */
function arcPoint(cx, cy, r, degrees) {
  const a = (degrees * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** 이어 긋는 호(SVG A). clockwise 면 각도가 커지는 쪽. */
function arcTo(cx, cy, r, from, to, clockwise = true) {
  const sweep = clockwise ? to - from : from - to;
  const [x, y] = arcPoint(cx, cy, r, to);
  return `A${r} ${r} 0 ${Math.abs(sweep) > 180 ? 1 : 0} ${clockwise ? 1 : 0} ${pt(x, y)}`;
}

function curvedArrow(mirrored) {
  const X = (x) => (mirrored ? 20 - x : x);
  return [
    { d: `M${pt(X(5), 8)}L${pt(X(12), 8)}C${pt(X(18), 8)} ${pt(X(18), 16)} ${pt(X(12), 16)}L${pt(X(8), 16)}` },
    poly([X(8.5), 4.5], [X(5), 8], [X(8.5), 11.5]),
  ];
}

const tray = () => poly([4, 11], [4, 17], [16, 17], [16, 11]);
const magnifier = () => [ring(7.8, 7.8, 4.7), poly([11.2, 11.2], [16.5, 16.5])];

const SHAPES = {
  undo: () => curvedArrow(false),
  redo: () => curvedArrow(true),
  fetch: () => [poly([5, 11], [4, 8.5], [6.5, 5.5], [10, 4.5], [13.5, 5.5], [16, 8.5], [15, 11]), poly([10, 8], [10, 17]), poly([7, 14], [10, 17], [13, 14])],
  pull: () => [poly([10, 3], [10, 13]), poly([6, 9], [10, 13], [14, 9]), poly([4, 17], [16, 17])],
  push: () => [poly([10, 15], [10, 5]), poly([6, 9], [10, 5], [14, 9]), poly([4, 17], [16, 17])],
  stash: () => [tray(), poly([10, 2.5], [10, 11]), poly([7, 8], [10, 11], [13, 8])],
  pop: () => [tray(), poly([10, 11], [10, 2.5]), poly([7, 5.5], [10, 2.5], [13, 5.5])],
  terminal: () => [poly([4, 6], [9, 10], [4, 14]), poly([10.5, 15], [16, 15])],
  refresh: () => [{ d: `M${pt(...arcPoint(10, 10.5, 6, -60))}${arcTo(10, 10.5, 6, -60, 240)}` }, poly([3.6, 4.4], [7, 5.3], [6.1, 8.7])],
  pathList: () => [poly([3, 5], [17, 5]), poly([3, 10], [17, 10]), poly([3, 15], [17, 15])],
  fileTree: () => [box(2.5, 2.5), poly([5, 7.5], [5, 15], [10, 15]), poly([5, 10], [10, 10]), box(10.5, 7.5), box(10.5, 12.5)],
  home: () => [poly([8.3, 16.9], [8.3, 11.7], [11.7, 11.7], [11.7, 16.9], [16, 16.9], [16, 7.8], [10, 3.3], [4, 7.8], [4, 16.9], [8.3, 16.9])],
  zoomIn: () => [...magnifier(), poly([6.2, 7.8], [9.4, 7.8]), poly([7.8, 6.2], [7.8, 9.4])],
  zoomOut: () => [...magnifier(), poly([6.2, 7.8], [9.4, 7.8])],
  branch: () => [ring(7, 5.6, 1.6), ring(7, 14.4, 1.6), ring(13.2, 6.8, 1.6), poly([7, 7.2], [7, 12.8]),
    { d: `M${pt(13.2, 8.4)}C${pt(13.2, 11)} ${pt(7, 10)} ${pt(7, 12.8)}` }],
  tag: () => [poly([3.5, 3.5], [10, 3.5], [16.5, 10], [10, 16.5], [3.5, 10], [3.5, 3.5]), ring(7, 7, 1.2)],
  folder: () => [poly([3, 5], [8, 5], [9.5, 7], [17, 7], [17, 15.5], [3, 15.5], [3, 5])],
  cloud: () => [{
    d: `M${pt(5.5, 15.5)}L${pt(15, 15.5)}${arcTo(15, 12.5, 3, 90, -90, false)}`
      + `L${pt(...arcPoint(10.2, 10.3, 4.8, -9.5))}${arcTo(10.2, 10.3, 4.8, -9.5, -165, false)}`
      + `L${pt(...arcPoint(5.5, 12.25, 3.25, -89))}${arcTo(5.5, 12.25, 3.25, -89, -270, false)}Z`,
  }],
  github: () => [{
    fill: true,
    d: `M${pt(10, 2)}C${pt(14.42, 2)} ${pt(18, 5.58)} ${pt(18, 10)}${arcTo(10, 10, 8, 0, 71.429)}`
      + 'C12.15 17.67 12 17.42 12 17.21C12 16.94 12.01 16.08 12.01 15.01C12.01 14.26 11.76 13.78 11.47 13.53'
      + 'C13.25 13.33 15.12 12.65 15.12 9.58C15.12 8.7 14.81 7.99 14.3 7.43C14.38 7.23 14.66 6.41 14.22 5.31'
      + 'C14.22 5.31 13.55 5.09 12.02 6.13C11.38 5.95 10.7 5.86 10.02 5.86C9.34 5.86 8.66 5.95 8.02 6.13'
      + 'C6.49 5.1 5.82 5.31 5.82 5.31C5.38 6.41 5.66 7.23 5.74 7.43C5.23 7.99 4.92 8.71 4.92 9.58'
      + 'C4.92 12.64 6.78 13.33 8.56 13.53C8.33 13.73 8.12 14.08 8.05 14.6C7.59 14.81 6.44 15.15 5.72 13.94'
      + 'C5.57 13.7 5.12 13.11 4.49 13.12C3.82 13.13 4.22 13.5 4.5 13.65C4.84 13.84 5.23 14.55 5.32 14.78'
      + 'C5.48 15.23 6 16.09 8.01 15.72C8.01 16.39 8.02 17.02 8.02 17.21C8.02 17.42 7.87 17.66 7.47 17.59'
      + `L${pt(...arcPoint(10, 10, 8, 108.435))}${arcTo(10, 10, 8, 108.435, 180)}C2 5.58 5.58 2 10 2Z`,
  }],
  globe: () => [ring(10, 10, 7.5), { d: 'M10 2.5C14 6 14 14 10 17.5C6 14 6 6 10 2.5' }, poly([2.5, 10], [17.5, 10]), poly([4, 6.2], [16, 6.2]), poly([4, 13.8], [16, 13.8])],
  pullRequest: () => [ring(6, 4.5, 1.6), ring(6, 15.5, 1.6), ring(14, 15.5, 1.6), poly([6, 6.1], [6, 13.9]),
    poly([14, 13.9], [14, 7.5], [12, 5.5], [9, 5.5]), poly([10.8, 3.7], [9, 5.5], [10.8, 7.3])],
  laptop: () => [poly([5, 13], [5, 5], [15, 5], [15, 13], [5, 13]), poly([3, 15.5], [17, 15.5])],
  submodule: () => [poly([3.5, 3.5], [16.5, 3.5], [16.5, 16.5], [3.5, 16.5], [3.5, 3.5]), box(7.5, 7.5)],
  worktree: () => [{
    fill: true, evenodd: true, outline: STROKE - 1.25,
    d: 'M11.208 18.333L8.813 18.333L8.813 15.229L2.5 15.229L6.438 9.521L4.458 9.521L10 1.667L15.542 9.521L13.583 9.521L17.5 15.229L11.208 15.229Z'
      + 'M4.917 13.979L15.104 13.979L11.167 8.271L13.021 8.271L10 3.979L6.979 8.271L8.854 8.271Z',
  }],
  check: () => [poly([4.5, 10.4], [8.2, 14.1], [15.5, 6.4])],
  hierarchy: () => [poly([8, 2.5], [12, 2.5], [12, 6.5], [8, 6.5], [8, 2.5]), poly([10, 6.5], [10, 13.5]), poly([4, 13.5], [4, 10], [16, 10], [16, 13.5]),
    poly([2.5, 13.5], [5.5, 13.5], [5.5, 16.5], [2.5, 16.5], [2.5, 13.5]), poly([8.5, 13.5], [11.5, 13.5], [11.5, 16.5], [8.5, 16.5], [8.5, 13.5]),
    poly([14.5, 13.5], [17.5, 13.5], [17.5, 16.5], [14.5, 16.5], [14.5, 13.5])],
  comment: () => [poly([3.5, 3.5], [16.5, 3.5], [16.5, 13], [8, 13], [4.5, 16.5], [4.5, 13], [3.5, 13], [3.5, 3.5])],
  pencil: () => [poly([13.5, 3.5], [16.5, 6.5], [7, 16], [3.5, 16.5], [4, 13], [13.5, 3.5]), poly([11.5, 5.5], [14.5, 8.5])],
  search: () => [ring(7.85, 7.81, 4.7), { ...poly([11.2, 11.15], [17.05, 17]), butt: true }],
  filterAdd: () => [poly([9.8, 9.1], [15.2, 3], [1.8, 3], [7.2, 9.1], [7.2, 15.7], [8.6, 14.9]), {
    fill: true, evenodd: true,
    d: `M${pt(14.6 + 4.6, 11.8)}${arcTo(14.6, 11.8, 4.6, 0, 180)}${arcTo(14.6, 11.8, 4.6, 180, 360)}Z`
      + 'M13.8 9.4L15.4 9.4L15.4 11L17 11L17 12.6L15.4 12.6L15.4 14.2L13.8 14.2L13.8 12.6L12.2 12.6L12.2 11L13.8 11Z',
  }],
  caret: () => [{ fill: true, d: 'M5 7.5L15 7.5L10 13Z' }],
  expand: () => [ring(10, 10, 7.5), poly([8.5, 6.5], [12, 10], [8.5, 13.5])],
  info: () => [ring(10, 10, 7.5), poly([10, 9.2], [10, 14]), dot(10, 6.3, 1.1)],
  moreVert: () => [dot(10, 4.8, 1.55), dot(10, 10, 1.55), dot(10, 15.2, 1.55)],
  trash: () => [poly([7.8, 4.6], [7.8, 2.4], [12.2, 2.4], [12.2, 4.6]), poly([3.4, 4.6], [16.6, 4.6]), poly([5.2, 4.6], [5.2, 16.9], [14.8, 16.9], [14.8, 4.6]),
    poly([8.3, 8.2], [8.3, 13.6]), poly([11.7, 8.2], [11.7, 13.6])],
  // 아래는 원본의 상태 그림(Icons/Modified·Added·Deleted)과 같은 모양을 선으로 그린 것.
  plus: () => [poly([10, 4], [10, 16]), poly([4, 10], [16, 10])],
  minus: () => [poly([4, 10], [16, 10])],
  close: () => [poly([5, 5], [15, 15]), poly([15, 5], [5, 15])],
  chevronRight: () => [poly([8, 5], [13, 10], [8, 15])],
  chevronDown: () => [poly([5, 8], [10, 13], [15, 8])],
  arrowUp: () => [poly([10, 16], [10, 4]), poly([5, 9], [10, 4], [15, 9])],
  arrowDown: () => [poly([10, 4], [10, 16]), poly([5, 11], [10, 16], [15, 11])],
  warning: () => [poly([10, 2.8], [18, 16.8], [2, 16.8], [10, 2.8]), poly([10, 7.5], [10, 11.6]), dot(10, 14.1, 1)],
  settings: () => [ring(10, 10, 2.6), {
    d: Array.from({ length: 8 }, (_, i) => {
      const a = (i * 45 * Math.PI) / 180;
      return `M${pt(10 + 5.4 * Math.cos(a), 10 + 5.4 * Math.sin(a))}L${pt(10 + 7.6 * Math.cos(a), 10 + 7.6 * Math.sin(a))}`;
    }).join('') + `M${pt(15.4, 10)}${arcTo(10, 10, 5.4, 0, 180)}${arcTo(10, 10, 5.4, 180, 360)}`,
  }],
  theme: () => [ring(10, 10, 7), { fill: true, d: `M10 3${arcTo(10, 10, 7, -90, 90)}Z` }],
  copy: () => [poly([7, 7], [16, 7], [16, 17], [7, 17], [7, 7]), poly([4, 13], [4, 3], [13, 3])],
  eye: () => [{ d: 'M2 10C5 4.5 15 4.5 18 10C15 15.5 5 15.5 2 10Z' }, ring(10, 10, 2.6)],
  file: () => [poly([5, 2.5], [11.5, 2.5], [15, 6], [15, 17.5], [5, 17.5], [5, 2.5]), poly([11.5, 2.5], [11.5, 6], [15, 6])],
  history: () => [{ d: `M${pt(...arcPoint(10, 10, 7, 200))}${arcTo(10, 10, 7, 200, 520)}` }, poly([2.6, 5.6], [3.4, 7.6], [5.4, 6.8]), poly([10, 6], [10, 10], [13, 12])],
  blame: () => [poly([3, 5], [8, 5]), poly([3, 10], [8, 10]), poly([3, 15], [8, 15]), poly([11, 5], [17, 5]), poly([11, 10], [15, 10]), poly([11, 15], [17, 15])],
  whitespace: () => [dot(5, 10, 1.2), dot(10, 10, 1.2), poly([13, 10], [17, 10]), poly([15, 8], [17, 10], [15, 12])],
  wrap: () => [poly([3, 5], [17, 5]), { d: 'M3 10L14 10C17.5 10 17.5 15 14 15L9 15' }, poly([11, 13], [9, 15], [11, 17]), poly([3, 15], [6, 15])],
  hunk: () => [poly([3, 4], [17, 4]), poly([3, 16], [17, 16]), { d: 'M3 8.5L17 8.5L17 11.5L3 11.5Z', fill: true }],
  inline: () => [poly([3, 4], [17, 4]), poly([3, 8], [17, 8]), poly([3, 12], [17, 12]), poly([3, 16], [17, 16])],
  split: () => [poly([3, 4], [17, 4], [17, 16], [3, 16], [3, 4]), poly([10, 4], [10, 16])],
  edit: () => [poly([13.5, 3.5], [16.5, 6.5], [7, 16], [3.5, 16.5], [4, 13], [13.5, 3.5])],
  external: () => [poly([11, 3], [17, 3], [17, 9]), poly([17, 3], [9, 11]), poly([14, 12], [14, 17], [3, 17], [3, 6], [8, 6])],
  merge: () => [ring(6, 4.5, 1.6), ring(6, 15.5, 1.6), ring(14, 10, 1.6), poly([6, 6.1], [6, 13.9]), { d: 'M6 6.1C6 9 9 10 12.4 10' }],
  lock: () => [poly([5, 9], [15, 9], [15, 17], [5, 17], [5, 9]), { d: 'M7 9L7 6.5C7 3 13 3 13 6.5L13 9' }],
  user: () => [ring(10, 7, 3.2), { d: 'M3.5 17C4.5 12.5 15.5 12.5 16.5 17' }],
  sun: () => [ring(10, 10, 3.5), ...Array.from({ length: 8 }, (_, i) => {
    const a = (i * 45 * Math.PI) / 180;
    return poly([10 + 5.6 * Math.cos(a), 10 + 5.6 * Math.sin(a)], [10 + 7.6 * Math.cos(a), 10 + 7.6 * Math.sin(a)]);
  })],
};

/** 아이콘 SVG. kind 는 SHAPES 의 이름, size 는 px(정사각). */
export function icon(kind, size = 16, className = '') {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('class', `ico ${className}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const shapes = SHAPES[kind]?.() ?? [];
  for (const shape of shapes) {
    let node;
    if (shape.circle) {
      node = document.createElementNS(NS, 'circle');
      const [cx, cy, r] = shape.circle;
      node.setAttribute('cx', cx);
      node.setAttribute('cy', cy);
      node.setAttribute('r', r);
    } else {
      node = document.createElementNS(NS, 'path');
      node.setAttribute('d', shape.d);
    }
    if (shape.fill) {
      node.setAttribute('fill', 'currentColor');
      if (shape.evenodd) node.setAttribute('fill-rule', 'evenodd');
      if (shape.outline) {
        node.setAttribute('stroke', 'currentColor');
        node.setAttribute('stroke-width', shape.outline);
      } else {
        node.setAttribute('stroke', 'none');
      }
    } else {
      node.setAttribute('fill', 'none');
      node.setAttribute('stroke', 'currentColor');
      node.setAttribute('stroke-width', STROKE);
      node.setAttribute('stroke-linecap', shape.butt ? 'butt' : 'round');
      node.setAttribute('stroke-linejoin', 'round');
    }
    svg.append(node);
  }
  return svg;
}

export const ICON_KINDS = Object.keys(SHAPES);
