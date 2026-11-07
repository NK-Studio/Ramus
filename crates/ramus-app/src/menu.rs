//! 운영체제 메뉴 막대: macOS 는 화면 맨 위 메뉴, Windows 는 창 위 메뉴 막대.
//!
//! 우리가 만든 항목은 누르면 id 를 화면에 넘기고(`window.__gitvcs.menu("fetch")`), 화면이 도구 막대·키 처리와 같은 함수를 부른다.
//! 잘라내기·복사·붙여넣기·모두 선택·창 다루기는 운영체제 기본 항목(predefined)이라 글 칸에서 그대로 동작한다.
//!
//! 단축키: macOS 는 메뉴가 키를 받아 이 경로 하나로 부른다(화면의 keydown 은 이 키들을 건드리지 않는다).
//! Windows 는 메뉴 막대에 단축키 글만 보이고, 키는 웹뷰(WebView2)가 받아 화면의 keydown 이 같은 id 로 부른다 —
//! 이벤트 루프에서 TranslateAcceleratorW 를 부르지 않으므로 메뉴 단축키가 따로 한 번 더 불리는 일이 없다.

use std::collections::HashMap;

use muda::accelerator::Accelerator;
use muda::{Menu, MenuItem, PredefinedMenuItem, Submenu};

/// 화면이 켜고 끄는(menuState) 항목. 처음에는 꺼 두고, 화면이 상태를 알리면 바꾼다.
const STATEFUL: &[&str] = &[
    "newTab", "closeTab", "reopenTab", "terminal", "reveal", "githubLogout", "find", "refresh", "commit", "fetch", "pull", "push", "stash",
    "pop", "switchBranch", "newBranch", "newTag", "newWorktree",
];

/// 항목 id → 단축키(muda 형식, CmdOrCtrl = macOS ⌘ / 그 밖 Ctrl). 화면 app.js 의 MENU keys 와 같은 키다.
const ACCELERATORS: &[(&str, &str)] = &[
    ("settings", "CmdOrCtrl+Comma"),
    ("newTab", "CmdOrCtrl+KeyT"),
    ("closeTab", "CmdOrCtrl+KeyW"),
    ("reopenTab", "CmdOrCtrl+Shift+KeyT"),
    ("clone", "CmdOrCtrl+KeyN"),
    ("initRepo", "CmdOrCtrl+KeyI"),
    ("openRepo", "CmdOrCtrl+KeyO"),
    ("terminal", "Alt+KeyT"),
    ("reveal", "Alt+KeyO"),
    ("quit", "Alt+F4"),
    ("undo", "CmdOrCtrl+KeyZ"),
    ("redo", "CmdOrCtrl+Shift+KeyZ"),
    ("find", "CmdOrCtrl+KeyF"),
    ("zoomIn", "CmdOrCtrl+Equal"),
    ("zoomOut", "CmdOrCtrl+Minus"),
    ("zoomReset", "CmdOrCtrl+Digit0"),
    ("refresh", "CmdOrCtrl+KeyR"),
    ("fullscreen", "F11"),
    ("commit", "CmdOrCtrl+Shift+KeyC"),
    ("fetch", "CmdOrCtrl+Shift+KeyF"),
    ("pull", "CmdOrCtrl+Shift+KeyL"),
    ("push", "CmdOrCtrl+Shift+KeyP"),
    ("stash", "CmdOrCtrl+Shift+KeyH"),
    ("switchBranch", "CmdOrCtrl+KeyB"),
    ("newBranch", "CmdOrCtrl+Shift+KeyB"),
    ("newTag", "CmdOrCtrl+Shift+KeyG"),
];

/// Rust 가 직접 처리하는 항목(화면에 넘기지 않는다).
#[cfg(not(target_os = "macos"))]
pub const QUIT: &str = "quit";
#[cfg(not(target_os = "macos"))]
pub const FULLSCREEN: &str = "fullscreen";

pub struct AppMenu {
    menu: Menu,
    items: HashMap<&'static str, MenuItem>,
}

/// 그 항목의 단축키. 표의 글은 테스트가 모두 읽어 본다.
fn accelerator(id: &str) -> Option<Accelerator> {
    let (_, text) = ACCELERATORS.iter().find(|(key, _)| *key == id)?;
    text.parse().ok()
}

impl AppMenu {
    pub fn build() -> AppMenu {
        let mut items = HashMap::new();
        let mut item = |id: &'static str, text: &str| -> MenuItem {
            let made = MenuItem::with_id(id, text, !STATEFUL.contains(&id), accelerator(id));
            items.insert(id, made.clone());
            made
        };
        let sep = PredefinedMenuItem::separator;
        let reveal_label = if cfg!(windows) { "탐색기에서 보기" } else { "Finder 에서 보기" };

        let menu = Menu::new();

        #[cfg(target_os = "macos")]
        {
            // "Ramus 정보" 는 운영체제 기본 창 대신 화면이 그린다(ui/about.js) — 빌드·git·웹뷰 정보를 함께 보이려고.
            let app = Submenu::with_items(
                "Ramus",
                true,
                &[
                    &item("about", "Ramus 정보"),
                    &sep(),
                    &item("settings", "설정…"),
                    &sep(),
                    &PredefinedMenuItem::services(Some("서비스")),
                    &sep(),
                    &PredefinedMenuItem::hide(Some("Ramus 가리기")),
                    &PredefinedMenuItem::hide_others(Some("기타 가리기")),
                    &PredefinedMenuItem::show_all(Some("모두 보기")),
                    &sep(),
                    &PredefinedMenuItem::quit(Some("Ramus 종료")),
                ],
            )
            .expect("앱 메뉴");
            menu.append(&app).expect("앱 메뉴");
        }

        let file = Submenu::with_items(
            "파일",
            true,
            &[
                &item("newTab", "새 탭"),
                &item("closeTab", "탭 닫기"),
                &item("reopenTab", "닫은 탭 다시 열기"),
                &sep(),
                &item("clone", "레포지토리 복제…"),
                &item("initRepo", "레포지토리 만들기…"),
                &item("openRepo", "레포지토리 열기…"),
                &sep(),
                &item("terminal", "터미널에서 열기"),
                &item("reveal", reveal_label),
                &sep(),
                &item("githubLogout", "GitHub 로그아웃"),
            ],
        )
        .expect("파일 메뉴");
        // Windows 는 앱 메뉴가 없으니 설정·끝내기를 파일 메뉴 끝에 둔다.
        #[cfg(not(target_os = "macos"))]
        file.append_items(&[&sep(), &item("settings", "설정…"), &sep(), &item(QUIT, "끝내기")])
            .expect("파일 메뉴");
        menu.append(&file).expect("파일 메뉴");

        // 실행 취소·다시 실행은 직접 만든 항목: 글 칸이면 화면이 글 편집을 되돌리고, 아니면 git 작업을 되돌린다(undoRedo).
        let edit = Submenu::with_items(
            "편집",
            true,
            &[
                &item("undo", "실행 취소"),
                &item("redo", "다시 실행"),
                &sep(),
                &PredefinedMenuItem::cut(Some("잘라내기")),
                &PredefinedMenuItem::copy(Some("복사")),
                &PredefinedMenuItem::paste(Some("붙여넣기")),
                &PredefinedMenuItem::select_all(Some("모두 선택")),
                &sep(),
                &item("find", "찾기"),
            ],
        )
        .expect("편집 메뉴");
        menu.append(&edit).expect("편집 메뉴");

        let view = Submenu::with_items(
            "보기",
            true,
            &[
                &item("zoomIn", "확대"),
                &item("zoomOut", "축소"),
                &item("zoomReset", "실제 크기"),
                &sep(),
                &item("refresh", "새로 고침"),
                &sep(),
            ],
        )
        .expect("보기 메뉴");
        #[cfg(target_os = "macos")]
        view.append(&PredefinedMenuItem::fullscreen(Some("전체 화면"))).expect("보기 메뉴");
        // Windows 에는 운영체제 기본 전체 화면 항목이 없어 창을 직접 바꾼다.
        #[cfg(not(target_os = "macos"))]
        view.append(&item(FULLSCREEN, "전체 화면")).expect("보기 메뉴");
        menu.append(&view).expect("보기 메뉴");

        let repo = Submenu::with_items(
            "레포지토리",
            true,
            &[
                &item("commit", "커밋"),
                &sep(),
                &item("fetch", "Fetch"),
                &item("pull", "Pull"),
                &item("push", "Push"),
                &sep(),
                &item("stash", "Stash 저장"),
                &item("pop", "Stash 꺼내기 (Pop)"),
                &sep(),
                &item("switchBranch", "브랜치 전환…"),
                &item("newBranch", "새 브랜치…"),
                &item("newTag", "새 태그…"),
                &item("newWorktree", "새 워크트리…"),
            ],
        )
        .expect("레포지토리 메뉴");
        menu.append(&repo).expect("레포지토리 메뉴");

        let window = Submenu::with_items(
            "창",
            true,
            &[&PredefinedMenuItem::minimize(Some("최소화")), &PredefinedMenuItem::maximize(Some("확대/축소"))],
        )
        .expect("창 메뉴");
        #[cfg(target_os = "macos")]
        {
            window.append_items(&[&sep(), &PredefinedMenuItem::bring_all_to_front(Some("모두 앞으로 가져오기"))]).expect("창 메뉴");
            window.set_as_windows_menu_for_nsapp();
        }
        menu.append(&window).expect("창 메뉴");

        let help = Submenu::with_items("도움말", true, &[&item("shortcuts", "키보드 단축키 보기")]).expect("도움말 메뉴");
        #[cfg(not(target_os = "macos"))]
        help.append_items(&[&sep(), &item("about", "Ramus 정보")]).expect("도움말 메뉴");
        // macOS 가 도움말 메뉴 맨 위에 검색 칸을 넣는다.
        #[cfg(target_os = "macos")]
        help.set_as_help_menu_for_nsapp();
        menu.append(&help).expect("도움말 메뉴");

        AppMenu { menu, items }
    }

    /// 메뉴를 붙인다. macOS 는 앱 전체(NSApp), Windows 는 이 창. 그 밖(리눅스)은 붙이지 않는다.
    #[allow(unused_variables)]
    pub fn attach(&self, window: &tao::window::Window, dark: Option<bool>) {
        #[cfg(target_os = "macos")]
        self.menu.init_for_nsapp();
        #[cfg(target_os = "windows")]
        {
            use tao::platform::windows::WindowExtWindows;
            let theme = match dark {
                Some(true) => muda::MenuTheme::Dark,
                Some(false) => muda::MenuTheme::Light,
                None => muda::MenuTheme::Auto,
            };
            // SAFETY: tao 가 만든 살아 있는 창의 HWND 다.
            if let Err(e) = unsafe { self.menu.init_for_hwnd_with_theme(window.hwnd(), theme) } {
                eprintln!("메뉴 막대를 붙이지 못했습니다: {e}");
            }
        }
    }

    /// 화면이 알린 상태로 항목을 켜고 끈다. 모르는 id 는 건너뛴다.
    pub fn set_enabled(&self, states: &[(String, bool)]) {
        for (id, on) in states {
            if let Some(item) = self.items.get(id.as_str()) {
                item.set_enabled(*on);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accelerators_parse() {
        for (id, text) in ACCELERATORS {
            assert!(text.parse::<Accelerator>().is_ok(), "{id}: {text}");
        }
    }
}
