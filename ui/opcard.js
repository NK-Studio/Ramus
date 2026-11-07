// 오래 걸리는 작업(Pull·Push·Fetch·Clone 등)의 진행 카드. 오른쪽 아래(알림 자리)에 뜬다.
// 짧게 끝나는 작업은 깜빡이지 않게 0.9초가 지나야 보인다. git 이 알리는 진행(받기 45% 등)이 오면 단계·막대·숫자를 채우고,
// 진행을 모르는 동안은 "서버 응답을 기다리는 중…" 과 흐르는 막대. 끝나면 "완료" 를 잠깐 보이고 사라진다(실패는 오류 창이 알린다).
// 원격 작업(Clone·Fetch·Pull·Push)은 여기가 아니라 탭 막대의 작업 목록(jobs.js)에 보인다 — 이 카드는 그 밖의 오래 걸리는 작업용.

import { el } from './util.js';
import { icon } from './icons.js';
import { onProgress, progressText } from './progress.js';

const SHOW_AFTER_MS = 900;

/** 지금 보고 있는 레포지토리(탭). owner 가 붙은 카드는 그 탭에서만 보인다. */
let viewing = null;

/** 탭을 바꿨다: 그 탭에서 시작한 작업의 카드만 보이고 나머지는 숨긴다(작업은 뒤에서 계속 돈다). */
export function setOpCardViewing(path, host) {
  viewing = path ?? null;
  for (const card of host.querySelectorAll('.op-card[data-owner]')) card.hidden = card.dataset.owner !== viewing;
}
const DONE_LINGER_MS = 1400;

/** 진행 글("풀 하는 중… (앞으로 감기만)")로 아이콘을 고른다. */
function glyphOf(label) {
  if (/^풀/.test(label)) return 'pull';
  if (/^푸시/.test(label)) return 'push';
  if (/페치|Fetch/.test(label)) return 'fetch';
  return 'refresh';
}

const seconds = (ms) => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
};

/**
 * 작업 하나의 카드를 시작한다. host: 카드를 넣을 곳(알림 묶음). 돌려준 finish(ok, doneText) 로 끝낸다.
 * showAfter: 몇 ms 뒤에 보일지(기본 0.9초). owner: 작업을 시작한 레포지토리 경로. 주면 그 탭을 보고 있을 때만 카드가 보인다.
 */
export function startOpCard(host, label, { showAfter = SHOW_AFTER_MS, owner = null } = {}) {
  const started = performance.now();
  const title = label;
  // "풀 하는 중… (앞으로 감기만)" → "풀"(완료 제목용).
  const short = label.replace(/\s*\(.*\)\s*$/, '').replace(/\s*(하는\s*)?중…?$/, '').trim() || label;
  const badge = el('span', { class: 'op-card-badge' }, icon(glyphOf(label), 18), el('span', { class: 'op-card-spin' }));
  const titleNode = el('span', { class: 'op-card-title', text: title });
  const phase = el('div', { class: 'op-card-phase', text: '서버 응답을 기다리는 중…' });
  const elapsed = el('span', { class: 'op-card-time', text: '' });
  const fill = el('div', { class: 'op-card-fill' });
  const bar = el('div', { class: 'op-card-bar' }, fill);
  const node = el('div', { class: 'op-card', role: 'status', 'aria-live': 'polite' },
    badge,
    el('div', { class: 'op-card-body' },
      el('div', { class: 'op-card-head' }, titleNode, elapsed),
      phase,
      bar));

  let shown = false;
  let ended = false;
  const tick = () => { elapsed.textContent = seconds(performance.now() - started); };
  const showTimer = setTimeout(() => {
    if (ended) return;
    shown = true;
    tick();
    if (owner != null) {
      node.dataset.owner = owner;
      node.hidden = owner !== viewing;
    }
    host.prepend(node);
  }, showAfter);
  const clock = setInterval(tick, 1000);
  const stop = onProgress((p) => {
    if (ended) return;
    phase.textContent = progressText(p);
    bar.classList.toggle('known', p.percent != null);
    fill.style.width = p.percent != null ? `${p.percent}%` : '';
  });

  /** 끝낸다. 카드가 보이고 있었으면 true(완료를 카드가 알렸으니 따로 알림을 띄우지 않아도 된다). */
  return function finish(ok, doneText) {
    if (ended) return false;
    ended = true;
    clearTimeout(showTimer);
    clearInterval(clock);
    stop();
    if (!shown) return false;
    if (!ok) {
      node.remove();
      return true;
    }
    // 완료: 막대를 끝까지 채우고 체크를 보인 뒤 사라진다.
    node.classList.add('done');
    bar.classList.add('known');
    fill.style.width = '100%';
    badge.replaceChildren(icon('check', 18));
    titleNode.textContent = `${short} 완료`;
    phase.textContent = doneText ? `${doneText} · ${seconds(performance.now() - started)}` : `완료 · ${seconds(performance.now() - started)} 걸렸습니다`;
    elapsed.textContent = '';
    setTimeout(() => {
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 220);
    }, DONE_LINGER_MS);
    return true;
  };
}
