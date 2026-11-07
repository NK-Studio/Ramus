// Clone 하는 동안 대화상자를 채우는 진행 무대. 가운데 그라데이션 고리가 전체 진행(연결→받기→정리→꺼내기)을
// 부드럽게 채우고, 큰 숫자가 따라 올라가며, 단계 이름은 바뀔 때마다 위로 밀려 바뀐다. 뒤에는 흐린 빛이 천천히 돈다.
// 끝나면 고리가 초록으로 바뀌고 체크가 그려진다. git 은 단계마다 0~100% 를 따로 알리므로 단계별 몫을 더해 하나로 잇는다.

import { el } from './util.js';
import { phaseName, number } from './progress.js';

const NS = 'http://www.w3.org/2000/svg';
const RADIUS = 54;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// 전체 진행에서 각 단계가 차지하는 몫. 받기가 대부분의 시간을 쓴다.
const STAGES = [
  { key: 'connect', label: '연결', title: '서버에 연결하는 중', weight: 0.06 },
  { key: 'receive', label: '받기', title: '개체를 받는 중', weight: 0.64 },
  { key: 'resolve', label: '정리', title: '변경 사항을 정리하는 중', weight: 0.2 },
  { key: 'checkout', label: '꺼내기', title: '파일을 꺼내는 중', weight: 0.1 },
];

function stageIndex(p) {
  if (p.remote) return 0;
  switch (p.phase) {
    case 'Receiving objects': return 1;
    case 'Resolving deltas': return 2;
    case 'Updating files':
    case 'Checking out files':
    case 'Filtering content':
    case 'Downloading LFS objects': return 3;
    default: return 0;
  }
}

function svg(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

let gradientSeq = 0;

const seconds = (ms) => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초`;
};

/**
 * 진행 무대를 만든다. name: 받는 레포지토리 이름, where: 받을 곳(작게 보인다).
 * 돌려준 node 를 붙이고 update(p) 로 git 진행을 넣고, finish() 가 풀리면(완료 연출이 끝나면) 닫으면 된다.
 */
export function cloneStage({ name, where }) {
  const id = `cs-grad-${++gradientSeq}`;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── 고리 ──
  const ring = svg('svg', { class: 'cs-ring', viewBox: '0 0 128 128', 'aria-hidden': 'true' });
  const defs = svg('defs', {});
  const grad = svg('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '1' });
  grad.append(svg('stop', { offset: '0%', class: 'cs-stop-a' }), svg('stop', { offset: '55%', class: 'cs-stop-b' }), svg('stop', { offset: '100%', class: 'cs-stop-c' }));
  defs.append(grad);
  const track = svg('circle', { class: 'cs-track', cx: '64', cy: '64', r: String(RADIUS) });
  const comet = svg('circle', { class: 'cs-comet', cx: '64', cy: '64', r: String(RADIUS), stroke: `url(#${id})` });
  const arc = svg('circle', { class: 'cs-arc', cx: '64', cy: '64', r: String(RADIUS), stroke: `url(#${id})` });
  arc.style.strokeDasharray = `${CIRCUMFERENCE}`;
  arc.style.strokeDashoffset = `${CIRCUMFERENCE}`;
  comet.style.strokeDasharray = `${CIRCUMFERENCE * 0.18} ${CIRCUMFERENCE}`;
  const check = svg('path', { class: 'cs-check', d: 'M46 65.5 L58.5 78 L83 52' });
  ring.append(defs, track, comet, arc, check);

  const digits = el('span', { class: 'cs-digits', text: '0' });
  const percent = el('div', { class: 'cs-percent' }, digits, el('span', { class: 'cs-unit', text: '%' }));
  const dial = el('div', { class: 'cs-dial' }, el('div', { class: 'cs-halo' }), ring, percent);

  // ── 글 ──
  const headline = el('div', { class: 'cs-headline' }, el('span', { class: 'cs-line in', text: STAGES[0].title }));
  const title = el('div', { class: 'cs-name', text: name });
  // 지금 단계 하나만 캡슐로 보인다: ● 받기  2/4. 단계가 바뀌면 이름이 위로 밀려 바뀐다.
  const stepLabel = el('span', { class: 'cs-step-label' }, el('span', { class: 'cs-line in', text: STAGES[0].label }));
  const stepCount = el('span', { class: 'cs-step-count', text: `1/${STAGES.length}` });
  const stepRow = el('div', { class: 'cs-step' }, el('span', { class: 'cs-step-dot' }), stepLabel, stepCount);
  const counts = el('span', { class: 'cs-counts', text: '' });
  const elapsed = el('span', { class: 'cs-elapsed', text: '0초' });
  const meta = el('div', { class: 'cs-meta' }, counts, elapsed);

  const node = el('div', { class: `clone-stage${reduced ? ' reduced' : ''}`, role: 'status', 'aria-live': 'polite' },
    el('div', { class: 'cs-aura' }, el('span', { class: 'cs-blob a' }), el('span', { class: 'cs-blob b' }), el('span', { class: 'cs-blob c' })),
    el('div', { class: 'cs-body' },
      dial,
      title,
      headline,
      stepRow,
      meta,
      where ? el('div', { class: 'cs-where', text: where }) : null));

  // ── 상태 ──
  let stage = 0;
  let target = 0; // 0~1, 줄지 않는다.
  let shown = 0; // 화면에 그린 값, target 을 부드럽게 따라간다.
  let known = false;
  let frame = 0;
  let ended = false;
  const started = performance.now();

  const draw = () => {
    arc.style.strokeDashoffset = `${CIRCUMFERENCE * (1 - shown)}`;
    digits.textContent = String(Math.floor(shown * 100 + 0.0001));
  };

  const animate = () => {
    frame = 0;
    const gap = target - shown;
    // 남은 거리에 비례해 다가간다(스프링 느낌). 아주 가까우면 붙인다.
    shown = Math.abs(gap) < 0.0015 || reduced ? target : shown + gap * 0.09;
    draw();
    if (shown !== target) frame = requestAnimationFrame(animate);
  };
  const kick = () => { if (!frame) frame = requestAnimationFrame(animate); };

  /** box 안의 글을 바꾼다: 옛 글은 위로 사라지고 새 글이 아래에서 올라온다. */
  const swap = (box, text) => {
    const current = box.querySelector('.cs-line.in');
    if (current?.textContent === text) return;
    current?.classList.replace('in', 'out');
    current?.addEventListener('animationend', () => current.remove(), { once: true });
    if (reduced) current?.remove();
    box.append(el('span', { class: 'cs-line in', text }));
  };
  const setHeadline = (text) => swap(headline, text);

  const setStage = (index) => {
    if (index <= stage) return;
    stage = index;
    swap(stepLabel, STAGES[index].label);
    stepCount.textContent = `${index + 1}/${STAGES.length}`;
    setHeadline(STAGES[index].title);
  };

  const clock = setInterval(() => { elapsed.textContent = seconds(performance.now() - started); }, 1000);

  function update(p) {
    if (ended || !p) return;
    const index = stageIndex(p);
    setStage(index);
    if (index === stage && p.percent != null) {
      if (!known && index > 0) {
        known = true;
        node.classList.add('known');
      }
      const before = STAGES.slice(0, stage).reduce((sum, s) => sum + s.weight, 0);
      target = Math.max(target, Math.min(1, before + STAGES[stage].weight * (p.percent / 100)));
      kick();
    }
    const parts = [phaseName(p.phase)];
    if (p.current != null && p.total != null) parts.push(`${number(p.current)} / ${number(p.total)}`);
    if (p.detail) parts.push(p.detail);
    counts.textContent = parts.join(' · ');
  }

  /** 완료 연출: 고리를 끝까지 채우고 초록으로 바꾼 뒤 체크를 그린다. 연출이 끝나면 풀린다. */
  function finish() {
    if (ended) return Promise.resolve();
    ended = true;
    clearInterval(clock);
    node.classList.add('known');
    target = 1;
    kick();
    return new Promise((resolve) => {
      let completed = false;
      // 창이 가려져 그리기 프레임이 멈춰도 레포지토리 열기가 늦어지지 않게, 잠시 뒤엔 끝까지 붙인다.
      const force = setTimeout(() => { shown = target; draw(); settle(); }, 1400);
      const settle = () => {
        if (completed) return;
        if (shown < 0.999 && !reduced) { requestAnimationFrame(settle); return; }
        completed = true;
        clearTimeout(force);
        node.classList.add('done');
        setHeadline('받기 완료');
        swap(stepLabel, '완료');
        stepCount.textContent = '';
        counts.textContent = `${seconds(performance.now() - started)} 걸렸습니다`;
        elapsed.textContent = '';
        setTimeout(resolve, reduced ? 300 : 900);
      };
      settle();
    });
  }

  /** 실패·취소로 무대를 걷는다. */
  function dispose() {
    ended = true;
    clearInterval(clock);
    if (frame) cancelAnimationFrame(frame);
  }

  return { node, update, finish, dispose };
}
