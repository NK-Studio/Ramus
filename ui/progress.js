// git 진행 알림(Rust 의 "progress" 이벤트)을 받아 나눠 주고, 단계 이름을 한국어로 바꾼다.
// 알림: {remote, phase, percent, current, total, detail, done} — phase 는 git 의 영어 단계 이름 그대로.

import { on } from './bridge.js';
import { scoped, locale } from './i18n.js';

/** 이 모듈의 글(locales/en/progress.js 를 먼저 본다). */
const t = scoped('progress');

const PHASES = {
  'Enumerating objects': t('개체 확인'),
  'Counting objects': t('개체 세기'),
  'Compressing objects': t('압축'),
  'Writing objects': t('올리기'),
  'Receiving objects': t('받기'),
  'Resolving deltas': t('변경 정리'),
  'Unpacking objects': t('풀기'),
  'Updating files': t('파일 갱신'),
  'Checking out files': t('파일 꺼내기'),
  'Filtering content': t('LFS 파일 받기'),
  'Downloading LFS objects': t('LFS 파일 받기'),
  'Uploading LFS objects': t('LFS 파일 올리기'),
};

const handlers = new Set();
on('progress', (p) => { for (const handler of handlers) handler(p); });

/**
 * 진행 알림을 받는다. 그만 받을 때 부르는 함수를 돌려준다.
 * job: 이 이름이 붙은 작업(Clone·Fetch·Pull·Push)의 진행만 받는다. 주지 않으면 이름 없는 작업의 것만 —
 * 여러 작업의 진행이 섞이지 않게. '*' 면 모두 받는다(받는 쪽이 p.job 으로 가린다).
 */
export function onProgress(handler, job = null) {
  const filtered = (p) => { if (job === '*' || (p?.job ?? null) === job) handler(p); };
  handlers.add(filtered);
  return () => handlers.delete(filtered);
}

/** git 단계 이름의 한국어("Receiving objects" → "받기"). 모르는 이름은 그대로. */
export function phaseName(phase) {
  return PHASES[phase] ?? phase;
}

export const number = (n) => Number(n).toLocaleString(locale);

/** 단계 이름만("받기", 서버 단계는 "서버 …") — 개수·세부 글 없이. 작업 목록의 한 줄 상태. */
export function phaseLabel(p) {
  return p ? (p.remote ? t('서버 {phase}', { phase: phaseName(p.phase) }) : phaseName(p.phase)) : '';
}

/** "받기 45% (1,234/2,700) · 1.20 MiB | 2.00 MiB/s", 서버 단계는 앞에 "서버 ". */
export function progressText(p) {
  if (!p) return '';
  const phase = phaseLabel(p);
  let text = phase;
  if (p.percent != null) text += ` ${p.percent}%`;
  if (p.current != null && p.total != null) text += ` (${number(p.current)}/${number(p.total)})`;
  else if (p.current != null) text += ` ${t('{objects}개', { objects: number(p.current) })}`;
  if (p.detail) text += ` · ${p.detail}`;
  return text;
}

// Clone 의 전체 진행에서 각 단계가 차지하는 몫. 받기가 대부분의 시간을 쓴다. git 은 단계마다 0~100% 를 따로 알리므로 몫을 더해 하나로 잇는다.
const CLONE_STAGES = [0.06, 0.64, 0.2, 0.1]; // 연결 · 받기 · 정리 · 꺼내기

function cloneStage(p) {
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

/**
 * Clone 의 전체 진행(0~1). memo({stage, value})에 지난 값을 두고 넘겨 받는다 — 단계가 바뀌어도 뒤로 가지 않는다.
 */
export function cloneOverall(memo, p) {
  if (!p) return memo.value ?? 0;
  const index = cloneStage(p);
  memo.stage = Math.max(memo.stage ?? 0, index);
  memo.value = memo.value ?? 0;
  if (index === memo.stage && p.percent != null) {
    const before = CLONE_STAGES.slice(0, index).reduce((sum, w) => sum + w, 0);
    memo.value = Math.max(memo.value, Math.min(1, before + CLONE_STAGES[index] * (p.percent / 100)));
  }
  return memo.value;
}

/** 이 진행이 작업 트리 파일을 고치는 단계인가(Pull 을 이때 끊으면 작업 트리가 찢어진다). */
export function touchesFiles(p) {
  return !!p && !p.remote && ['Updating files', 'Checking out files', 'Filtering content', 'Downloading LFS objects', 'Unpacking objects'].includes(p.phase);
}
