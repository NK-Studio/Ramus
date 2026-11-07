// Rust 와 주고받는 통로. 요청마다 번호를 붙여 보내고, Rust 가 같은 번호로 답하면 기다리던 Promise 를 푼다.
// Rust 가 요청 없이 알리는 일(파일 변경·자동 페치)은 on() 으로, 메뉴 막대 항목은 onMenu() 로 받는다.
// 레포지토리에 묶인 요청은 전환 문(repocache.js)을 거친다: 탭을 바꾸는 중이면 openRepo 응답 뒤에 보내고, 보던 레포지토리 경로를 __repo 로 붙인다.

import { createSwitchGate, isRepoBound } from './repocache.js';

const pending = new Map();
const gate = createSwitchGate();
const listeners = new Map();
let nextId = 1;
let menuHandler = null;

/** 요청 왕복 시간 기록(개발 점검용): window.__ramusPerf.calls 의 최근 200개 {cmd, ms}. */
const perf = { calls: [] };
window.__ramusPerf = perf;

window.__gitvcs = {
  reply(message) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    perf.calls.push({ cmd: waiter.cmd, ms: Math.round(performance.now() - waiter.started), ok: !!message.ok });
    if (perf.calls.length > 200) perf.calls.splice(0, perf.calls.length - 200);
    if (message.ok) waiter.resolve(message.value);
    else waiter.reject(message.error);
  },
  event(message) {
    for (const handler of listeners.get(message.event) ?? []) handler(message.data);
  },
  /** 메뉴 막대 항목 id(예: "fetch"). Rust 의 이벤트 루프가 부른다. */
  menu(id) {
    menuHandler?.(id);
  },
};

/** Rust 에 요청한다. 실패하면 {message, ssl, auth, stale} 로 reject 된다(stale: 탭을 바꾸는 사이에 보낸 요청 — 화면은 조용히 버린다). */
export function call(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const post = (repoPath) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, cmd, started: performance.now() });
      const body = repoPath ? { ...args, __repo: repoPath } : args;
      window.ipc.postMessage(JSON.stringify({ id, cmd, args: body }));
    };
    if (isRepoBound(cmd)) gate.run(post);
    else post(null);
  });
}

/** 레포지토리를 바꾸는 요청(openRepo)을 보냈다. 끝날 때까지 레포지토리 요청을 미룬다. 끝나면 푸는 Promise(성공 여부)를 돌려준다. */
export function beginRepoSwitch(path, request) {
  return gate.begin(path, request);
}

/** 백엔드가 이미 연 레포지토리 경로를 맞춘다(앱 시작·Clone·만들기 뒤, 닫으면 null). */
export function setRepoPath(path) {
  gate.set(path);
}

/** Rust 가 보내는 알림을 받는다: changed(파일 변경), fetching, fetched({ok, error, auto}). */
export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(handler);
}

/** 메뉴 막대 항목을 받는다(한 곳만). */
export function onMenu(handler) {
  menuHandler = handler;
}
