//! 개발 빌드 전용 점검 통로. `GITVCS_DEV_PORT=7777` 을 주고 띄우면 127.0.0.1:7777 에서 JS 한 줄을 받아 웹뷰에서 실행하고
//! 결과(JSON)를 한 줄로 돌려준다. 화면을 사람 손 없이 확인하려고 둔다 — 릴리스 빌드에는 들어가지 않는다.
//!
//! ```sh
//! echo 'return document.title' | nc 127.0.0.1 7777
//! ```

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// 실행을 기다리는 요청들: 번호 → 결과를 돌려줄 곳.
#[derive(Clone, Default)]
pub struct Pending(Arc<Mutex<HashMap<u64, mpsc::Sender<String>>>>);

impl Pending {
    /// 화면이 `__devResult` 로 보낸 결과를 기다리던 연결에 넘긴다.
    pub fn resolve(&self, id: u64, result: String) {
        if let Some(tx) = self.0.lock().unwrap().remove(&id) {
            let _ = tx.send(result);
        }
    }
}

/// `eval(id, js)` 는 이벤트 루프에서 JS 를 실행하게 하는 함수.
pub fn start(port: u16, pending: Pending, eval: impl Fn(u64, String) + Send + Sync + 'static) {
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("점검 통로를 열지 못했습니다(127.0.0.1:{port}): {e}");
            return;
        }
    };
    eprintln!("점검 통로: 127.0.0.1:{port}");
    let eval = Arc::new(eval);
    let next = Arc::new(Mutex::new(1u64));
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (pending, eval, next) = (pending.clone(), eval.clone(), next.clone());
            thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut writer = stream;
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 {
                    let js = line.trim().to_string();
                    line.clear();
                    if js.is_empty() {
                        continue;
                    }
                    let id = {
                        let mut n = next.lock().unwrap();
                        *n += 1;
                        *n
                    };
                    let (tx, rx) = mpsc::channel();
                    pending.0.lock().unwrap().insert(id, tx);
                    eval(id, js);
                    let result = rx.recv_timeout(Duration::from_secs(30)).unwrap_or_else(|_| "\"(시간 초과)\"".into());
                    if writeln!(writer, "{result}").is_err() {
                        break;
                    }
                }
            });
        }
    });
}

/// 받은 JS 를 async 함수 본문으로 실행하고 `return` 한 값(Promise 면 푼 값)을 `__devResult` 로 돌려보내게 한다.
pub fn wrap(id: u64, js: &str) -> String {
    let code = serde_json::to_string(js).unwrap();
    format!(
        "(async () => {{ let r; try {{ const AsyncFunction = Object.getPrototypeOf(async function () {{}}).constructor; r = await new AsyncFunction({code})(); }} catch (e) {{ r = 'ERROR: ' + (e && e.message) + ' ' + (e && e.stack || e); }} \
         let text; try {{ text = JSON.stringify(r === undefined ? null : r); }} catch (e) {{ text = JSON.stringify(String(r)); }} \
         window.ipc.postMessage(JSON.stringify({{ id: {id}, cmd: '__devResult', args: {{ text }} }})); }})()"
    )
}
