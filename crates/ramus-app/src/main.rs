//! Ramus 데스크톱 앱: tao 창 하나에 wry 웹뷰를 띄우고, 화면(ui/)과 JSON 메시지로 주고받는다.
//!
//! - 화면 → Rust: `window.ipc.postMessage('{"id":1,"cmd":"status","args":{}}')`
//! - Rust → 화면: 작업 스레드가 결과를 이벤트 루프에 넘기면(`UserEvent`) `window.__gitvcs.reply({...})` 를 실행한다.
//!
//! git 은 모두 작업 스레드에서 돈다. 폴더 고르기 창만 이벤트 루프(메인 스레드)에서 띄운다 — macOS 는 창을 메인 스레드에서만 만든다.
//!
//! 메뉴 막대(menu.rs)를 누르면 `UserEvent::Menu(id)` 로 이벤트 루프에 오고, `window.__gitvcs.menu("<id>")` 로 화면에 넘긴다.
//! 화면은 상태가 바뀌면 `menuState` 로 항목을 켜고 끈다.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod commands;
#[cfg(debug_assertions)]
mod devtools;
mod menu;
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
/// 창을 이보다 좁게 줄이지 못한다(원본 GitWindow.MinLayoutSize). UI 배율을 곱한다.
const MIN_WIDTH: f64 = 640.0;
const MIN_HEIGHT: f64 = 360.0;

enum UserEvent {
    /// 요청 `id` 에 대한 응답(이미 JSON 글자로 만든 것).
    Reply(String),
    /// 폴더 고르기 창을 띄우고 고른 레포지토리를 연다.
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
    /// 메뉴 막대 항목을 눌렀다(또는 macOS 에서 그 단축키를 눌렀다).
    Menu(String),
    /// 화면이 알린 메뉴 항목 켜기·끄기: (id, 켬).
    MenuState(Vec<(String, bool)>),
    /// 전체 화면을 켜고 끈다(Windows: 메뉴 항목·F11).
    ToggleFullscreen,
    /// 탭 막대 빈 곳을 끌기 시작했다 — 창을 옮긴다(macOS).
    WindowDrag,
    /// 탭 막대 빈 곳을 두 번 눌렀다 — 창을 키우거나 되돌린다(macOS).
    WindowZoom,
    /// 끄기를 물었더니 "계속하기" — 다음 닫기 요청에 다시 묻는다.
    QuitDismissed,
    /// 원격 작업을 정리했다 — 이제 끈다.
    Quit,
    /// 글의 언어를 바꿨다 — 메뉴 막대를 새 언어로 다시 만든다.
    Relabel,
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

fn reply_json(id: u64, result: ramus_core::repo::Result<Value>) -> String {
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
        let result = state.explain_gone(state.handle(&request.cmd, request.args, &mut effects));
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

/// 전체 화면(테두리 없이 그 화면 가득)을 켜고 끈다.
fn toggle_fullscreen(window: &tao::window::Window) {
    let next = if window.fullscreen().is_some() { None } else { Some(tao::window::Fullscreen::Borderless(None)) };
    window.set_fullscreen(next);
}

fn main() -> wry::Result<()> {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    // git 진행 줄(받는 중 45% 등)을 화면에 알린다 — 오래 걸리는 Pull·Push 가 멈춘 것처럼 보이지 않게.
    let progress_proxy = Mutex::new(proxy.clone());
    ramus_core::set_progress_sink(move |progress| {
        let body = json!({ "event": "progress", "data": progress }).to_string();
        let _ = progress_proxy.lock().unwrap().send_event(UserEvent::Emit(body));
    });
    let emit_proxy = Mutex::new(proxy.clone());
    let state = Arc::new(AppState::load(Box::new(move |name, data| {
        let body = json!({ "event": name, "data": data }).to_string();
        let _ = emit_proxy.lock().unwrap().send_event(UserEvent::Emit(body));
    })));

    // 5초마다 레포지토리 폴더가 아직 있는지 본다(드라이브를 빼면 파일 감시가 알리지 못한다).
    // 자동 페치는 30초마다 때가 됐는지 본다(간격은 설정, 기본 10분).
    let fetch_state = Arc::downgrade(&state);
    thread::spawn(move || {
        for tick in 1u32.. {
            thread::sleep(Duration::from_secs(5));
            let Some(state) = fetch_state.upgrade() else { break };
            if state.notice_gone() {
                continue;
            }
            if tick % 6 == 0 {
                state.auto_fetch_tick();
            }
        }
    });

    let theme = state.settings.lock().unwrap().theme.clone();
    // 시작 화면(boot.js)이 쓸 힌트: 화면이 그려지기 전에 window.__boot 로 넘긴다(첫 그림부터 맞는 테마 바탕색으로).
    let boot = json!({
        "theme": theme,
        "platform": std::env::consts::OS,
        // 화면 글의 언어(ui/i18n.js). 설정에서 바꾸면 화면이 다시 읽는다.
        "language": ramus_core::i18n::language(),
        // 개발 빌드: 화면이 점검용 손잡이(window.__ramus)를 드러낸다.
        "dev": cfg!(debug_assertions),
    });
    let dark = theme != "light";
    let builder = WindowBuilder::new()
        .with_title("Ramus")
        .with_inner_size(LogicalSize::new(1440.0, 900.0))
        .with_min_inner_size(LogicalSize::new(MIN_WIDTH, MIN_HEIGHT));
    // macOS 는 화면의 탭 막대가 제목 막대를 겸한다(GitKraken 처럼): 제목 막대를 비우고 웹뷰를 창 꼭대기까지 펴며,
    // 신호등 버튼은 38px 높이 탭 막대의 가운데에 오게 내린다.
    #[cfg(target_os = "macos")]
    let builder = {
        use tao::platform::macos::WindowBuilderExtMacOS;
        builder
            .with_titlebar_transparent(true)
            .with_title_hidden(true)
            .with_fullsize_content_view(true)
            .with_traffic_light_inset(tao::dpi::LogicalPosition::new(14.0, 21.0))
    };
    let window = builder.build(&event_loop).expect("창을 만들지 못했습니다");

    // 메뉴 막대. 항목을 누르면(macOS 는 단축키도) 이벤트 루프로 id 를 보낸다.
    let mut app_menu = menu::AppMenu::build();
    let menu_proxy = Mutex::new(proxy.clone());
    muda::MenuEvent::set_event_handler(Some(move |event: muda::MenuEvent| {
        let _ = menu_proxy.lock().unwrap().send_event(UserEvent::Menu(event.id().0.clone()));
    }));
    let menu_theme = match theme.as_str() {
        "light" => Some(false),
        "system" => None,
        _ => Some(true),
    };
    // Windows 는 웹뷰를 붙이기 전에 메뉴 막대를 붙인다 — 메뉴 높이만큼 줄어든 창 안쪽에 웹뷰가 맞춰지게.
    #[cfg(not(target_os = "macos"))]
    app_menu.attach(&window, menu_theme);

    #[cfg(debug_assertions)]
    let dev_pending = devtools::Pending::default();
    #[cfg(debug_assertions)]
    if let Some(port) = std::env::var("RAMUS_DEV_PORT").ok().and_then(|p| p.parse().ok()) {
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
        .with_initialization_script(format!("window.__boot = {boot};"))
        .with_background_color(background)
        .with_devtools(cfg!(debug_assertions) || std::env::var_os("RAMUS_DEVTOOLS").is_some())
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
            } else if request.cmd == "menuState" {
                // {items: {id: 켬}} — 메뉴 항목은 이벤트 루프(메인 스레드)에서만 만진다.
                let states = request
                    .args
                    .get("items")
                    .and_then(Value::as_object)
                    .map(|items| items.iter().map(|(id, on)| (id.clone(), on.as_bool().unwrap_or(false))).collect())
                    .unwrap_or_default();
                let _ = ipc_proxy.send_event(UserEvent::MenuState(states));
                let _ = ipc_proxy.send_event(UserEvent::Reply(reply_json(request.id, Ok(Value::Null))));
            } else if request.cmd == "setUi" && request.args.get("key").and_then(Value::as_str) == Some("language") {
                // 언어는 메뉴 막대(메인 스레드)도 바꾼다. 다시 만들기 전에 언어부터 정한다.
                ramus_core::i18n::set_language(request.args.get("value").and_then(Value::as_str).unwrap_or("ko"));
                let _ = ipc_proxy.send_event(UserEvent::Relabel);
                dispatch(ipc_state.clone(), ipc_proxy.clone(), request);
            } else if request.cmd == "toggleFullscreen" {
                let _ = ipc_proxy.send_event(UserEvent::ToggleFullscreen);
                let _ = ipc_proxy.send_event(UserEvent::Reply(reply_json(request.id, Ok(Value::Null))));
            } else if request.cmd == "windowDrag" || request.cmd == "windowZoom" {
                let event = if request.cmd == "windowDrag" { UserEvent::WindowDrag } else { UserEvent::WindowZoom };
                let _ = ipc_proxy.send_event(event);
                let _ = ipc_proxy.send_event(UserEvent::Reply(reply_json(request.id, Ok(Value::Null))));
            } else if request.cmd == "quit" {
                // 끄기 확인에 대한 답. cancel: 끈다 — Clone·Fetch·Push 는 멈추고, Pull 은 끝날 때까지 기다린 뒤 끈다.
                if request.args.get("cancel").and_then(Value::as_bool).unwrap_or(false) {
                    let state = ipc_state.clone();
                    let proxy = ipc_proxy.clone();
                    thread::spawn(move || {
                        state.cancel_for_quit();
                        let started = std::time::Instant::now();
                        loop {
                            let running = state.running_jobs();
                            // 멈추라고 한 작업이 10초 넘게 안 끝나면(프로세스가 말을 안 들음) 기다리지 않는다. Pull·브랜치 전환은 끝까지 기다린다.
                            if running.is_empty() || (started.elapsed() > Duration::from_secs(10) && !running.iter().any(|k| commands::touches_files(k))) {
                                break;
                            }
                            thread::sleep(Duration::from_millis(100));
                        }
                        let _ = proxy.send_event(UserEvent::Quit);
                    });
                } else {
                    let _ = ipc_proxy.send_event(UserEvent::QuitDismissed);
                }
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

    let mut was_fullscreen = false;
    // 끄기를 물어본 뒤 답을 기다리는 중. 이때 또 닫으면(화면이 멈췄을 수 있다) 묻지 않고 끈다.
    let mut quit_asked = false;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            // macOS 는 NSApp 이 다 뜬 뒤에 앱 메뉴를 붙인다.
            #[cfg(target_os = "macos")]
            Event::NewEvents(tao::event::StartCause::Init) => app_menu.attach(&window, menu_theme),
            // 창 닫기·종료 메뉴: 원격 작업(Clone·Fetch·Pull·Push)이 돌면 화면에 묻는다. 끊으면 받다 만 폴더·작업 트리가 남는다.
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                if quit_asked || state.running_jobs().is_empty() {
                    *control_flow = ControlFlow::Exit;
                } else {
                    quit_asked = true;
                    let _ = webview.evaluate_script("window.__gitvcs && window.__gitvcs.event({\"event\":\"quitRequested\",\"data\":null})");
                }
            }
            Event::UserEvent(UserEvent::Menu(id)) if id == menu::QUIT => {
                if quit_asked || state.running_jobs().is_empty() {
                    *control_flow = ControlFlow::Exit;
                } else {
                    quit_asked = true;
                    let _ = webview.evaluate_script("window.__gitvcs && window.__gitvcs.event({\"event\":\"quitRequested\",\"data\":null})");
                }
            }
            Event::UserEvent(UserEvent::QuitDismissed) => quit_asked = false,
            Event::UserEvent(UserEvent::Quit) => *control_flow = ControlFlow::Exit,
            #[cfg(not(target_os = "macos"))]
            Event::UserEvent(UserEvent::Menu(id)) if id == menu::FULLSCREEN => toggle_fullscreen(&window),
            Event::UserEvent(UserEvent::Menu(id)) => {
                let _ = webview.evaluate_script(&format!("window.__gitvcs && window.__gitvcs.menu && window.__gitvcs.menu({})", json!(id)));
            }
            Event::UserEvent(UserEvent::MenuState(states)) => app_menu.set_enabled(&states),
            Event::UserEvent(UserEvent::Relabel) => {
                // 켜고 끈 상태는 화면이 다시 읽으며 menuState 로 다시 알린다.
                app_menu.detach(&window);
                app_menu = menu::AppMenu::build();
                app_menu.attach(&window, menu_theme);
            }
            Event::UserEvent(UserEvent::ToggleFullscreen) => toggle_fullscreen(&window),
            Event::UserEvent(UserEvent::WindowDrag) => {
                let _ = window.drag_window();
            }
            Event::UserEvent(UserEvent::WindowZoom) => window.set_maximized(!window.is_maximized()),
            // 전체 화면이 바뀌면 화면에 알린다(macOS 탭 막대가 신호등 자리 여백을 거두게).
            Event::WindowEvent { event: WindowEvent::Resized(_), .. } => {
                let fullscreen = window.fullscreen().is_some();
                if was_fullscreen != fullscreen {
                    was_fullscreen = fullscreen;
                    let body = json!({ "event": "window", "data": { "fullscreen": fullscreen } });
                    let _ = webview.evaluate_script(&format!("window.__gitvcs && window.__gitvcs.event({body})"));
                }
            }
            Event::UserEvent(UserEvent::Reply(body)) => {
                // 객체 리터럴이 아니라 JSON 글을 넘겨 JSON.parse 로 읽는다 — 큰 응답(수천 줄 diff)은 웹뷰가 리터럴로 파싱하는 것보다 몇 배 빠르다.
                let started = std::time::Instant::now();
                let text = serde_json::to_string(&body).unwrap_or_else(|_| "\"\"".into());
                let _ = webview.evaluate_script(&format!("window.__gitvcs && window.__gitvcs.reply(JSON.parse({text}))"));
                if ramus_core::runner::trace_enabled() && body.len() > 64 * 1024 {
                    ramus_core::runner::trace(&format!("reply {}KB marshal+eval", body.len() / 1024), started);
                }
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
            Event::UserEvent(UserEvent::PickRepo(id)) => match rfd::FileDialog::new().set_title(ramus_core::i18n::tr("Git 레포지토리 폴더 열기", "Open Git Repository Folder")).pick_folder() {
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
