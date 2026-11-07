// 원격 작업(Clone·Fetch·Pull·Push·브랜치 전환) 목록. 탭 막대 오른쪽 끝의 작업 버튼(도는 개수 배지·진행 고리)을 누르면
// 팝오버에 작업마다 한 줄씩 이름·짧은 단계·막대와 취소만 보인다(주소·개수·걸린 시간은 넣지 않는다 — 받는 곳은 이름의 툴팁에) — Unity Hub 의 다운로드 목록처럼.
// 작업은 탭과 상관없이 뒤에서 돈다: 탭을 바꿔도, 다른 레포를 Clone 해도 그대로 이어진다.
//
// - Fetch·Pull·Push 는 0.9초가 지나야 보인다(금방 끝나는 것은 깜빡이지 않게). 끝나면 ✓ 를 잠깐 보이고 사라진다.
// - Clone 은 바로 보이고, 끝나면 "열기" 를 남긴다(시작 화면이면 바로 연다). 실패하면 "다시 시도"·"자세히" 를 남긴다.
// - Pull 은 파일을 고치는 단계에 들어가면 취소를 숨긴다 — 그때 끊으면 작업 트리가 찢어진다.

import { el } from './util.js';
import { icon } from './icons.js';
import { onProgress, phaseLabel, cloneOverall, touchesFiles } from './progress.js';

const SHOW_AFTER_MS = 900;
const DONE_LINGER_MS = 4000;
const RING_R = 12;
const RING_C = 2 * Math.PI * RING_R;
const NS = 'http://www.w3.org/2000/svg';

const KIND = {
  clone: { glyph: 'clone', verb: '받기' },
  fetch: { glyph: 'fetch', verb: '페치' },
  pull: { glyph: 'pull', verb: '풀' },
  push: { glyph: 'push', verb: '푸시' },
  // 브랜치 전환: LFS 파일을 서버에서 받느라 오래 걸릴 수 있다. 파일을 고치는 일이라 처음부터 취소를 숨긴다.
  checkout: { glyph: 'branch', verb: '전환' },
};

const newJobId = (kind) => `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** "풀 하는 중… (앞으로 감기만)" → "풀 (앞으로 감기만)". */
const shortLabel = (label) => {
  const m = /^(.+?)\s*(?:하는\s*)?중…?\s*(.*)$/.exec(String(label ?? '').trim());
  return m ? `${m[1].trim()}${m[2] ? ` ${m[2].trim()}` : ''}` : label;
};

function svg(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/**
 * ctx: { call, withLogin, openRepo(path), currentRepo() → 보고 있는 레포 경로, showError(error, title), toast(text, kind),
 *        onCloned(repo) → 받은 뒤 할 일(설정 다시 읽기 등). true 를 돌려주면 그 자리에서 열었다는 뜻 }
 */
export function createJobs(ctx) {
  /** job → 작업 */
  const jobs = new Map();
  let unseen = false;
  let pop = null; // {node, close}
  let quitNote = '';

  // ── 버튼 ──
  const ringFill = svg('circle', { class: 'tab-jobs-ring-fill', cx: '14', cy: '14', r: String(RING_R), 'stroke-dasharray': String(RING_C), 'stroke-dashoffset': String(RING_C) });
  const ring = svg('svg', { class: 'tab-jobs-ring', viewBox: '0 0 28 28', 'aria-hidden': 'true' });
  ring.append(svg('circle', { class: 'tab-jobs-ring-track', cx: '14', cy: '14', r: String(RING_R) }), ringFill);
  const badge = el('span', { class: 'tab-jobs-badge', hidden: true });
  const dot = el('span', { class: 'tab-jobs-dot', hidden: true });
  // 버튼은 늘 보인다(작업이 없으면 빈 목록). 도는 것이 있으면 배지·고리가 붙는다.
  const button = el('button', {
    class: 'tab-jobs', 'data-tip': '작업 목록', 'aria-label': '작업 목록',
    onclick: (event) => { event.stopPropagation(); pop ? closePop() : openPop(); },
  }, ring, icon('inbox', 15), badge, dot);

  const visible = () => [...jobs.values()].filter((j) => j.shown);
  const running = () => visible().filter((j) => j.status === 'running');

  /** 작업 하나의 진행(0~1). 모르면 null. */
  function fraction(j) {
    if (j.status === 'done') return 1;
    if (j.kind === 'clone') return j.progress ? cloneOverall(j.memo, j.progress) : 0;
    return j.progress?.percent != null ? j.progress.percent / 100 : null;
  }

  function drawButton() {
    const now = running();
    badge.hidden = now.length === 0;
    badge.textContent = String(now.length);
    dot.hidden = !unseen || now.length > 0;
    button.classList.toggle('working', now.length > 0);
    const known = now.map(fraction).filter((f) => f != null);
    const value = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0;
    ringFill.setAttribute('stroke-dashoffset', String(RING_C * (1 - value)));
    ring.classList.toggle('known', known.length > 0);
  }

  // ── 줄 ──
  function makeRow(j) {
    const meta = KIND[j.kind];
    j.nodes = {};
    const n = j.nodes;
    n.badge = el('span', { class: 'jobs-row-icon' }, icon(meta.glyph, 15));
    n.title = el('div', { class: 'jobs-row-title', text: j.title, 'data-tip': j.where });
    n.phase = el('div', { class: 'jobs-row-phase', text: j.kind === 'clone' ? '연결 중' : '기다리는 중' });
    n.fill = el('div', { class: 'jobs-row-fill' });
    n.bar = el('div', { class: 'jobs-row-bar' }, n.fill);
    n.actions = el('div', { class: 'jobs-row-actions' });
    n.cancel = el('button', {
      class: 'jobs-row-x', 'data-tip': '취소', 'aria-label': '취소',
      onclick: (event) => {
        event.stopPropagation();
        n.cancel.disabled = true;
        n.phase.textContent = '취소하는 중…';
        ctx.call('cancelJob', { job: j.job }).catch(() => {});
      },
    }, icon('close', 10));
    n.row = el('div', {
      class: `jobs-row kind-${j.kind}${j.repoPath ? ' linked' : ''}`,
      onclick: () => {
        // Fetch·Pull·Push 줄은 그 레포 탭으로 데려간다.
        if (j.repoPath && ctx.currentRepo() !== j.repoPath) {
          closePop();
          ctx.openRepo(j.repoPath);
        }
      },
    },
    n.badge,
    el('div', { class: 'jobs-row-body' },
      n.title,
      n.phase,
      n.bar,
      n.actions),
    n.cancel);
  }

  function drawRow(j) {
    const n = j.nodes;
    if (!n) return;
    const f = fraction(j);
    n.row.classList.toggle('done', j.status === 'done');
    n.row.classList.toggle('failed', j.status === 'failed');
    n.bar.classList.toggle('known', f != null);
    if (f == null) {
      n.fill.style.width = '';
      j.shownFill = null;
    } else {
      // 막대는 알린 값으로 바로 뛰지 않고 따라간다(easeFill). 뒤로는 가지 않는다.
      j.fillTarget = Math.max(f, j.fillTarget ?? 0);
      if (j.shownFill == null) j.shownFill = 0;
      easeFill(j);
    }
    if (j.status === 'running') {
      if (j.progress && !n.cancel.disabled) n.phase.textContent = [phaseLabel(j.progress), f != null ? `${Math.round(f * 100)}%` : ''].filter(Boolean).join(' · ');
      // Pull 이 파일을 고치기 시작하면 끊지 못하게 한다(한 번 들어가면 끝까지).
      if ((j.kind === 'pull' && touchesFiles(j.progress)) || j.kind === 'checkout') j.locked = true;
      n.cancel.hidden = !!j.locked;
    }
  }

  /**
   * 막대를 목표 값까지 매 프레임 부드럽게 채운다 — git 이 띄엄띄엄 알려도 계단처럼 뛰지 않고 차오른다.
   * 남은 거리의 일정 몫씩 다가가되(멀면 빨리, 가까우면 천천히) 너무 느려지지 않게 최소 속도를 둔다.
   */
  function easeFill(j) {
    if (j.fillFrame) return;
    let last = performance.now();
    const step = (now) => {
      const n = j.nodes;
      if (!n || j.shownFill == null) { j.fillFrame = 0; return; }
      const dt = Math.min(64, now - last);
      last = now;
      const gap = j.fillTarget - j.shownFill;
      if (gap <= 0.0005) {
        j.shownFill = j.fillTarget;
        n.fill.style.width = `${j.shownFill * 100}%`;
        j.fillFrame = 0;
        return;
      }
      // 시간 상수 약 350ms 의 지수 접근 + 초당 2% 의 최소 속도.
      j.shownFill += Math.min(gap, Math.max(gap * (1 - Math.exp(-dt / 350)), 0.02 * dt / 1000));
      n.fill.style.width = `${j.shownFill * 100}%`;
      j.fillFrame = requestAnimationFrame(step);
    };
    j.fillFrame = requestAnimationFrame(step);
  }

  function finishRow(j) {
    const n = j.nodes;
    if (!n) return;
    n.cancel.hidden = true;
    n.actions.replaceChildren();
    const remove = el('button', { class: 'jobs-row-x', 'data-tip': '목록에서 지우기', 'aria-label': '목록에서 지우기', onclick: (event) => { event.stopPropagation(); drop(j); } }, icon('close', 10));
    if (j.status === 'done') {
      n.badge.replaceChildren(icon('check', 15));
      n.phase.textContent = j.doneText ?? '완료';
      if (j.repo) {
        n.actions.append(el('button', { class: 'btn small primary', text: '열기', onclick: (event) => { event.stopPropagation(); drop(j); closePop(); ctx.openRepo(j.repo.path); } }));
        n.row.append(remove);
      }
    } else if (j.kind === 'clone') {
      n.badge.replaceChildren(icon('warning', 15));
      n.phase.textContent = String(j.error?.message ?? j.error ?? '실패했습니다.').split('\n')[0];
      n.actions.append(
        el('button', { class: 'btn small', text: '다시 시도', onclick: (event) => { event.stopPropagation(); drop(j); startClone(j.request); } }),
        el('button', { class: 'btn small', text: '자세히', onclick: (event) => { event.stopPropagation(); ctx.showError(j.error, 'Clone 실패'); } }));
      n.row.append(remove);
    }
    n.actions.hidden = !n.actions.childElementCount;
    drawRow(j);
  }

  function drop(j) {
    clearTimeout(j.showTimer);
    j.stop?.();
    jobs.delete(j.job);
    j.nodes?.row.remove();
    if (!visible().some((x) => x.status !== 'running' && x.kind === 'clone')) unseen = false;
    drawButton();
    if (pop) drawPop();
  }

  // ── 팝오버 ──
  const popHead = el('div', { class: 'jobs-pop-head' });
  const popList = el('div', { class: 'jobs-pop-list' });
  const popFoot = el('div', { class: 'jobs-pop-foot' });

  function drawPop() {
    const list = visible();
    const now = list.filter((j) => j.status === 'running').length;
    const doneCount = list.length - now;
    // replaceChildren 은 null 을 "null" 글자로 넣으므로 빈 것은 걸러 낸다. 작업이 없으면 개수 글도 뺀다(아래 안내가 말한다).
    const count = [now ? `진행 중 ${now}` : '', doneCount ? `완료 ${doneCount}` : ''].filter(Boolean).join(' · ');
    popHead.replaceChildren(...[
      el('span', { class: 'jobs-pop-title', text: '작업' }),
      count ? el('span', { class: 'jobs-pop-count', text: count }) : null,
      quitNote ? el('span', { class: 'jobs-pop-note', text: quitNote }) : null,
    ].filter(Boolean));
    if (!list.length) popList.replaceChildren(el('div', { class: 'jobs-pop-empty', text: '진행 중인 작업 없음' }));
    else popList.querySelector('.jobs-pop-empty')?.remove();
    // 진행 중인 것을 위로, 그다음 끝난 것(최근 것 위).
    const order = [...list].sort((a, b) => (a.status === 'running') === (b.status === 'running') ? b.started - a.started : a.status === 'running' ? -1 : 1);
    order.forEach((j) => popList.append(j.nodes.row));
    const finished = list.filter((j) => j.status !== 'running');
    popFoot.hidden = !finished.length;
    popFoot.replaceChildren(el('button', { class: 'link', text: '끝난 항목 지우기', onclick: (event) => { event.stopPropagation(); finished.forEach(drop); } }));
  }

  function place() {
    if (!pop) return;
    const rect = button.getBoundingClientRect();
    pop.node.style.top = `${Math.round(rect.bottom + 6)}px`;
    pop.node.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
  }

  function openPop() {
    if (pop) return;
    unseen = false;
    const node = el('div', { class: 'jobs-pop', role: 'dialog', 'aria-label': '작업 목록' }, popHead, popList, popFoot);
    const onDown = (event) => { if (!node.contains(event.target) && !button.contains(event.target)) closePop(); };
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); closePop(); } };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    pop = {
      node,
      close: () => {
        document.removeEventListener('pointerdown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', place);
        node.remove();
      },
    };
    button.classList.add('open');
    document.body.append(node);
    drawPop();
    place();
    drawButton();
  }

  function closePop() {
    if (!pop) return;
    pop.close();
    pop = null;
    button.classList.remove('open');
  }

  // 걸린 시간: 도는 것이 있을 때만 1초마다.
  let clock = 0;
  function tickClock() {
    const any = [...jobs.values()].some((j) => j.status === 'running');
    if (any && !clock) clock = setInterval(() => { for (const j of jobs.values()) if (j.status === 'running') drawRow(j); }, 1000);
    if (!any && clock) { clearInterval(clock); clock = 0; }
  }

  /** 작업을 목록에 올린다. delay 뒤에 보인다(그 전에 끝나면 아예 보이지 않는다). */
  function add(j, delay) {
    j.started = performance.now();
    j.status = 'running';
    j.memo = {};
    jobs.set(j.job, j);
    makeRow(j);
    j.stop = onProgress((p) => {
      j.progress = p;
      if (!j.shown) return;
      drawRow(j);
      drawButton();
    }, j.job);
    const show = () => {
      if (!jobs.has(j.job) || j.shown) return;
      j.shown = true;
      drawRow(j);
      drawButton();
      if (pop) drawPop();
    };
    if (delay > 0) j.showTimer = setTimeout(show, delay);
    else show();
    tickClock();
  }

  function settle(j, status, extra = {}) {
    clearTimeout(j.showTimer);
    j.stop?.();
    Object.assign(j, extra, { status, ended: performance.now() });
    tickClock();
    if (!j.shown) {
      jobs.delete(j.job);
      return;
    }
    finishRow(j);
    drawButton();
    if (pop) drawPop();
  }

  /**
   * Fetch·Pull·Push 하나를 돌린다. task(job) 은 그 job 이름을 git 요청에 붙여 부르는 Promise.
   * 결과·오류는 그대로 돌려준다(오류 알림은 부른 쪽 act 가 한다).
   */
  async function run({ job, kind, label, repoPath, repoName }, task) {
    const j = { job, kind, title: `${repoName} · ${shortLabel(label)}`, where: repoPath, repoPath };
    add(j, SHOW_AFTER_MS);
    try {
      const result = await task(job);
      settle(j, 'done');
      if (j.shown) setTimeout(() => { if (jobs.get(job) === j) drop(j); }, DONE_LINGER_MS);
      return result;
    } catch (error) {
      // 실패·취소는 줄을 바로 치운다 — 오류는 act 가 오류 창으로 알린다.
      settle(j, 'failed', { error });
      drop(j);
      throw error;
    }
  }

  /** Clone 하나를 뒤에서 받는다. req: { url, dest, name, account, upstream } */
  function startClone(req) {
    const job = newJobId('clone');
    const j = { job, kind: 'clone', title: `${req.name} 받기`, where: req.dest, request: req, dest: req.dest };
    add(j, 0);
    // 진행이 어디로 갔는지 보이게 한 번 연다.
    openPop();
    ctx.withLogin(() => ctx.call('clone', { url: req.url, dest: req.dest, account: req.account, upstream: req.upstream, job, open: false }))
      .then(async (repo) => {
        const opened = await ctx.onCloned(repo);
        if (opened) {
          settle(j, 'done');
          drop(j);
          return;
        }
        settle(j, 'done', { repo, doneText: '받았습니다' });
        unseen = !pop;
        drawButton();
        ctx.toast(`${repo.name} 를 받았습니다. 위쪽 작업 목록에서 열 수 있습니다.`, 'success');
      }, (error) => {
        if (error?.cancelled) {
          settle(j, 'failed', { error });
          drop(j);
          ctx.toast(`'${req.name}' Clone 을 취소했습니다.`, 'info');
          return;
        }
        settle(j, 'failed', { error });
        unseen = !pop;
        drawButton();
        ctx.toast(`'${req.name}' 를 받지 못했습니다. 위쪽 작업 목록에서 자세히 볼 수 있습니다.`, 'error');
      });
  }

  return {
    button,
    run,
    startClone,
    newJobId,
    /** 지금 받는 중인 Clone 의 받을 곳들(같은 곳으로 또 받지 않게). */
    busyDests: () => new Set([...jobs.values()].filter((j) => j.kind === 'clone' && j.status === 'running').map((j) => j.dest)),
    /** 도는 작업 이름들(끄기 확인 글). */
    runningTitles: () => [...jobs.values()].filter((j) => j.status === 'running').map((j) => ({ kind: j.kind, title: j.title })),
    /** 끄기를 골랐는데 Pull 이 남아 기다리는 중: 목록을 열고 머리에 알린다. */
    waitForQuit(note) {
      quitNote = note;
      openPop();
      if (pop) drawPop();
    },
  };
}
