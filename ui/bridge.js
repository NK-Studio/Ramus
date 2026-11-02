// Rust 와 주고받는 통로. 요청마다 번호를 붙여 보내고, Rust 가 같은 번호로 답하면 기다리던 Promise 를 푼다.
// Rust 가 요청 없이 알리는 일(파일 변경·자동 페치)은 on() 으로 받는다.

const pending = new Map();
const listeners = new Map();
let nextId = 1;

window.__gitvcs = {
  reply(message) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message.value);
    else waiter.reject(message.error);
  },
  event(message) {
    for (const handler of listeners.get(message.event) ?? []) handler(message.data);
  },
};

/** Rust 에 요청한다. 실패하면 {message, ssl, auth} 로 reject 된다. */
export function call(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    window.ipc.postMessage(JSON.stringify({ id, cmd, args }));
  });
}

/** Rust 가 보내는 알림을 받는다: changed(파일 변경), fetching, fetched({ok, error, auto}). */
export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(handler);
}
