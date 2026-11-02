//! gitvcs 데스크톱 앱: tao 창 하나에 wry 웹뷰를 띄우고, 화면(ui/)과 JSON 메시지로 주고받는다.
//!
//! - 화면 → Rust: `window.ipc.postMessage('{"id":1,"cmd":"status","args":{}}')`
//! - Rust → 화면: 작업 스레드가 결과를 이벤트 루프에 넘기면(`UserEvent`) `window.__gitvcs.reply({...})` 를 실행한다.
//!
//! git 은 모두 작업 스레드에서 돈다. 폴더 고르기 창만 이벤트 루프(메인 스레드)에서 띄운다 — macOS 는 창을 메인 스레드에서만 만든다.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod commands;

use std::sync::Arc;
use std::thread;

use commands::{AppState, SideEffect};
use serde::Deserialize;
use serde_json::{Value, json};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::WindowBuilder;
use wry::WebViewBuilder;

const PROTOCOL: &str = "gitvcs";

enum UserEvent {
    /// 요청 `id` 에 대한 응답(이미 JSON 글자로 만든 것).
    Reply(String),
    /// 폴더 고르기 창을 띄우고 고른 저장소를 연다.
    PickRepo(u64),
    Title(String),
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
    let state = Arc::new(AppState::load());
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let dark = state.settings.lock().unwrap().theme != "light";
    let window = WindowBuilder::new()
        .with_title("GitVcs")
        .with_inner_size(LogicalSize::new(1440.0, 900.0))
        .with_min_inner_size(LogicalSize::new(900.0, 560.0))
        .build(&event_loop)
        .expect("창을 만들지 못했습니다");

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
            if request.cmd == "pickRepo" {
                let _ = ipc_proxy.send_event(UserEvent::PickRepo(request.id));
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
