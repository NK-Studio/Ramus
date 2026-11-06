// git 진행 알림(Rust 의 "progress" 이벤트)을 받아 나눠 주고, 단계 이름을 한국어로 바꾼다.
// 알림: {remote, phase, percent, current, total, detail, done} — phase 는 git 의 영어 단계 이름 그대로.

import { on } from './bridge.js';

const PHASES = {
  'Enumerating objects': '개체 확인',
  'Counting objects': '개체 세기',
  'Compressing objects': '압축',
  'Writing objects': '올리기',
  'Receiving objects': '받기',
  'Resolving deltas': '변경 정리',
  'Unpacking objects': '풀기',
  'Updating files': '파일 갱신',
  'Checking out files': '파일 꺼내기',
  'Filtering content': 'LFS 파일 받기',
  'Downloading LFS objects': 'LFS 파일 받기',
  'Uploading LFS objects': 'LFS 파일 올리기',
};

const handlers = new Set();
on('progress', (p) => { for (const handler of handlers) handler(p); });

/** 진행 알림을 받는다. 그만 받을 때 부르는 함수를 돌려준다. */
export function onProgress(handler) {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

const number = (n) => Number(n).toLocaleString('ko-KR');

/** "받기 45% (1,234/2,700) · 1.20 MiB | 2.00 MiB/s", 서버 단계는 앞에 "서버 ". */
export function progressText(p) {
  if (!p) return '';
  const phase = `${p.remote ? '서버 ' : ''}${PHASES[p.phase] ?? p.phase}`;
  let text = phase;
  if (p.percent != null) text += ` ${p.percent}%`;
  if (p.current != null && p.total != null) text += ` (${number(p.current)}/${number(p.total)})`;
  else if (p.current != null) text += ` ${number(p.current)}개`;
  if (p.detail) text += ` · ${p.detail}`;
  return text;
}
