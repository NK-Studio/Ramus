//! gitvcs 데스크톱 앱: tao 창 하나에 wry 웹뷰를 띄우고, 화면(ui/)과 JSON 메시지로 주고받는다.
//!
//! - 화면 → Rust: `window.ipc.postMessage('{"id":1,"cmd":"status","args":{}}')`
//! - Rust → 화면: 작업 스레드가 결과를 이벤트 루프에 넘기면(`UserEvent`) `window.__gitvcs.reply({...})` 를 실행한다.
//!
//! git 은 모두 작업 스레드에서 돈다. 폴더 고르기 창만 이벤트 루프(메인 스레드)에서 띄운다 — macOS 는 창을 메인 스레드에서만 만든다.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod commands;
#[cfg(debug_assertions)]
mod devtools;
mod watcher;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use commands::{AppState, SideEffect};
use serde::Deserialize;
use serde_json::{Value, json};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::WindowBuilder;
use wry::WebViewBuilder;

const PROTOCOL: &str = "gitvcs";
const MIN_WIDTH: f64 = 900.0;
const MIN_HEIGHT: f64 = 560.0;

enum UserEvent {
    /// 요청 `id` 에 대한 응답(이미 JSON 글자로 만든 것).
    Reply(String),
    /// 폴더 고르기 창을 띄우고 고른 저장소를 연다.
    PickRepo(u64),
    /// 폴더·파일 고르기(저장 포함) 창을 띄우고 고른 경로를 돌려준다.
    Pick(u64, PickRequest),
    Title(String),
    /// 요청 없이 화면에 알릴 일(파일 변경·자동 페치).
    Emit(String),
    /// UI 배율: 웹뷰 확대와 최소 창 크기.
    Zoom(f64),
    /// 개발 빌드 점검 통로: 이 JS 를 실행한다.
    #[allow(dead_code)]
    Eval(String),
}

/// 고르기 창 하나. kind: folder | file | save.
#[derive(Deserialize, Default)]
#[serde(default)]
struct PickRequest {
    kind: String,
    start: Option<String>,
    title: Option<String>,
    name: Option<String>,
    filters: Vec<PickFilter>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct PickFilter {
    name: String,
    ext: Vec<String>,
}

#[derive(Deserialize)]
struct IpcRequest {
    id: u64,
    cmd: String,
    #[serde(default)]
    args: Value,
}

fn start_url() -> String {
    // Windows(WebView2)는 사용자 정의 프로토콜을 http://<이름>.localhost 로 연다.
    if cfg!(windows) { format!("http://{PROTOCOL}.localhost/index.html") } else { format!("{PROTOCOL}://localhost/index.html") }
}

fn reply_json(id: u64, result: gitvcs_core::repo::Result<Value>) -> String {
    let body = match result {
        Ok(value) => json!({ "id": id, "ok": true, "value": value }),
        Err(error) => json!({ "id": id, "ok": false, "error": error }),
    };
    body.to_string()
}

/// 작업 스레드에서 요청을 처리하고 응답을 이벤트 루프로 보낸다.
fn dispatch(state: Arc<AppState>, proxy: EventLoopProxy<UserEvent>, request: IpcRequest) {
    thread::spawn(move || {
        let mut effects = Vec::new();
        let result = state.handle(&request.cmd, request.args, &mut effects);
        for effect in effects {
            match effect {
                SideEffect::Title(title) => {
                    let _ = proxy.send_event(UserEvent::Title(title));
                }
            }
        }
        let _ = proxy.send_event(UserEvent::Reply(reply_json(request.id, result)));
    });
}

fn main() -> wry::Result<()> {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let emit_proxy = Mutex::new(proxy.clone());
    let state = Arc::new(AppState::load(Box::new(move |name, data| {
        let body = json!({ "event": name, "data": data }).to_string();
        let _ = emit_proxy.lock().unwrap().send_event(UserEvent::Emit(body));
    })));

    // 자동 페치: 30초마다 때가 됐는지 본다(간격은 설정, 기본 10분).
    let fetch_state = Arc::downgrade(&state);
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_secs(30));
            match fetch_state.upgrade() {
                Some(state) => state.auto_fetch_tick(),
                None => break,
            }
        }
    });

    let dark = state.settings.lock().unwrap().theme != "light";
    let window = WindowBuilder::new()
        .with_title("GitVcs")
        .with_inner_size(LogicalSize::new(1440.0, 900.0))
        .with_min_inner_size(LogicalSize::new(MIN_WIDTH, MIN_HEIGHT))
        .build(&event_loop)
        .expect("창을 만들지 못했습니다");

    #[cfg(debug_assertions)]
    let dev_pending = devtools::Pending::default();
    #[cfg(debug_assertions)]
    if let Some(port) = std::env::var("GITVCS_DEV_PORT").ok().and_then(|p| p.parse().ok()) {
        let eval_proxy = Mutex::new(proxy.clone());
        devtools::start(port, dev_pending.clone(), move |id, js| {
            let _ = eval_proxy.lock().unwrap().send_event(UserEvent::Eval(devtools::wrap(id, &js)));
        });
    }

    let ipc_state = state.clone();
    let ipc_proxy = proxy.clone();
    let background = if dark { (0x19, 0x1a, 0x1c, 0xff) } else { (0xff, 0xff, 0xff, 0xff) };
    let webview = WebViewBuilder::new()
        .with_custom_protocol(PROTOCOL.into(), |_id, request| assets::respond(request))
        .with_url(start_url())
        .with_background_color(background)
        .with_devtools(cfg!(debug_assertions) || std::env::var_os("GITVCS_DEVTOOLS").is_some())
        // 외부 주소는 웹뷰 안에서 열지 않는다(화면 파일만).
        .with_navigation_handler(|url| url.starts_with(&format!("{PROTOCOL}:")) || url.starts_with(&format!("http://{PROTOCOL}.localhost")))
        .with_ipc_handler(move |request| {
            let request: IpcRequest = match serde_json::from_str(request.body()) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("잘못된 요청: {e}");
                    return;
                }
            };
            #[cfg(debug_assertions)]
            if request.cmd == "__devResult" {
                let text = request.args.get("text").and_then(Value::as_str).unwrap_or("null").to_string();
                dev_pending.resolve(request.id, text);
                return;
            }
            if request.cmd == "setZoom" {
                let scale = request.args.get("scale").and_then(Value::as_f64).unwrap_or(1.0).clamp(0.6, 2.0);
                let _ = ipc_proxy.send_event(UserEvent::Zoom(scale));
                let _ = ipc_proxy.send_event(UserEvent::Reply(reply_json(request.id, Ok(Value::Null))));
            } else if request.cmd == "pickRepo" {
                let _ = ipc_proxy.send_event(UserEvent::PickRepo(request.id));
            } else if request.cmd == "pick" {
                let pick: PickRequest = serde_json::from_value(request.args).unwrap_or_default();
                let _ = ipc_proxy.send_event(UserEvent::Pick(request.id, pick));
            } else {
                dispatch(ipc_state.clone(), ipc_proxy.clone(), request);
            }
        })
        .build(&window)?;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => *control_flow = ControlFlow::Exit,
            Event::UserEvent(UserEvent::Reply(body)) => {
                let _ = webview.evaluate_script(&format!("window.__gitvcs && window.__gitvcs.reply({body})"));
            }
            Event::UserEvent(UserEvent::Title(title)) => window.set_title(&title),
            Event::UserEvent(UserEvent::Zoom(scale)) => {
                let _ = webview.zoom(scale);
                window.set_min_inner_size(Some(LogicalSize::new(MIN_WIDTH * scale, MIN_HEIGHT * scale)));
            }
            Event::UserEvent(UserEvent::Eval(js)) => {
                let _ = webview.evaluate_script(&js);
            }
            Event::UserEvent(UserEvent::Emit(body)) => {
                let _ = webview.evaluate_script(&format!("window.__gitvcs && window.__gitvcs.event({body})"));
            }
            Event::UserEvent(UserEvent::Pick(id, pick)) => {
                let mut dialog = rfd::FileDialog::new();
                if let Some(start) = pick.start.as_deref().filter(|s| Path::new(s).is_dir()) {
                    dialog = dialog.set_directory(start);
                }
                if let Some(title) = &pick.title {
                    dialog = dialog.set_title(title);
                }
                for filter in &pick.filters {
                    let ext: Vec<&str> = filter.ext.iter().map(String::as_str).collect();
                    dialog = dialog.add_filter(&filter.name, &ext);
                }
                let picked = match pick.kind.as_str() {
                    "file" => dialog.pick_file(),
                    "save" => dialog.set_file_name(pick.name.as_deref().unwrap_or("")).save_file(),
                    _ => dialog.pick_folder(),
                };
                let value = picked.map(|p| json!(p.display().to_string())).unwrap_or(Value::Null);
                let _ = webview.evaluate_script(&format!("window.__gitvcs.reply({})", reply_json(id, Ok(value))));
            }
            Event::UserEvent(UserEvent::PickRepo(id)) => match rfd::FileDialog::new().set_title("Git 저장소 폴더 열기").pick_folder() {
                Some(folder) => dispatch(
                    state.clone(),
                    proxy.clone(),
                    IpcRequest { id, cmd: "openRepo".into(), args: json!({ "path": folder.display().to_string() }) },
                ),
                None => {
                    let _ = webview.evaluate_script(&format!("window.__gitvcs.reply({})", reply_json(id, Ok(Value::Null))));
                }
            },
            _ => {}
        }
    });
}
