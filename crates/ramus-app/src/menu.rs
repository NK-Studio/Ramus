//! 운영체제 메뉴: macOS 는 화면 맨 위 메뉴 막대. Windows 는 창에 메뉴 막대를 붙이지 않고, 화면이 그린 제목 막대(ui/titlebar.js)의
//! 메뉴 단추를 누르면 그 아래에 같은 하위 메뉴를 운영체제 팝업으로 띄운다(Fork 처럼 메뉴와 제목 막대가 한 줄).
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
use ramus_core::i18n::tr;

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

/// Rust 가 직접 처리하는 항목(화면에 넘기지 않는다). 끄기는 도는 원격 작업이 있으면 먼저 묻는다(main.rs).
pub const QUIT: &str = "quit";
#[cfg(not(target_os = "macos"))]
pub const FULLSCREEN: &str = "fullscreen";

pub struct AppMenu {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    menu: Menu,
    items: HashMap<&'static str, MenuItem>,
    /// 맨 위 메뉴들(파일·편집·…) 차례대로. Windows 제목 막대의 메뉴 단추가 번호로 고른다.
    #[cfg_attr(not(windows), allow(dead_code))]
    submenus: Vec<Submenu>,
}

/// 그 항목의 단축키. 표의 글은 테스트가 모두 읽어 본다.
fn accelerator(id: &str) -> Option<Accelerator> {
    // macOS 의 끄기는 ⌘Q(표의 Alt+F4 는 Windows 것).
    if cfg!(target_os = "macos") && id == QUIT {
        return "Cmd+KeyQ".parse().ok();
    }
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
        let reveal_label = if cfg!(windows) { tr("탐색기에서 보기", "Show in Explorer") } else { tr("Finder 에서 보기", "Reveal in Finder") };

        let menu = Menu::new();
        let mut submenus = Vec::new();

        #[cfg(target_os = "macos")]
        {
            // "Ramus 정보" 는 운영체제 기본 창 대신 화면이 그린다(ui/about.js) — 빌드·git·웹뷰 정보를 함께 보이려고.
            let app = Submenu::with_items(
                "Ramus",
                true,
                &[
                    &item("about", tr("Ramus 정보", "About Ramus")),
                    &sep(),
                    &item("settings", tr("설정…", "Settings…")),
                    &sep(),
                    &PredefinedMenuItem::services(Some(tr("서비스", "Services"))),
                    &sep(),
                    &PredefinedMenuItem::hide(Some(tr("Ramus 가리기", "Hide Ramus"))),
                    &PredefinedMenuItem::hide_others(Some(tr("기타 가리기", "Hide Others"))),
                    &PredefinedMenuItem::show_all(Some(tr("모두 보기", "Show All"))),
                    &sep(),
                    // 기본 종료 항목은 NSApp 이 바로 끝내 버려서, 도는 작업을 묻지 못한다 — 보통 항목으로 받아 main.rs 가 처리한다.
                    &item(QUIT, tr("Ramus 종료", "Quit Ramus")),
                ],
            )
            .expect("앱 메뉴");
            menu.append(&app).expect("앱 메뉴");
        }

        let file = Submenu::with_items(
            tr("파일", "File"),
            true,
            &[
                &item("newTab", tr("새 탭", "New Tab")),
                &item("closeTab", tr("탭 닫기", "Close Tab")),
                &item("reopenTab", tr("닫은 탭 다시 열기", "Reopen Closed Tab")),
                &sep(),
                &item("clone", tr("레포지토리 복제…", "Clone Repository…")),
                &item("initRepo", tr("레포지토리 만들기…", "Create Repository…")),
                &item("openRepo", tr("레포지토리 열기…", "Open Repository…")),
                &sep(),
                &item("terminal", tr("터미널에서 열기", "Open in Terminal")),
                &item("reveal", reveal_label),
                &sep(),
                &item("githubLogout", tr("GitHub 로그아웃", "Sign Out of GitHub")),
            ],
        )
        .expect("파일 메뉴");
        // Windows 는 앱 메뉴가 없으니 설정·끝내기를 파일 메뉴 끝에 둔다.
        #[cfg(not(target_os = "macos"))]
        file.append_items(&[&sep(), &item("settings", tr("설정…", "Settings…")), &sep(), &item(QUIT, tr("끝내기", "Exit"))])
            .expect("파일 메뉴");
        menu.append(&file).expect("파일 메뉴");
        submenus.push(file);

        // 실행 취소·다시 실행은 직접 만든 항목: 글 칸이면 화면이 글 편집을 되돌리고, 아니면 git 작업을 되돌린다(undoRedo).
        let edit = Submenu::with_items(
            tr("편집", "Edit"),
            true,
            &[
                &item("undo", tr("실행 취소", "Undo")),
                &item("redo", tr("다시 실행", "Redo")),
                &sep(),
                &PredefinedMenuItem::cut(Some(tr("잘라내기", "Cut"))),
                &PredefinedMenuItem::copy(Some(tr("복사", "Copy"))),
                &PredefinedMenuItem::paste(Some(tr("붙여넣기", "Paste"))),
                &PredefinedMenuItem::select_all(Some(tr("모두 선택", "Select All"))),
                &sep(),
                &item("find", tr("찾기", "Find")),
            ],
        )
        .expect("편집 메뉴");
        menu.append(&edit).expect("편집 메뉴");
        submenus.push(edit);

        let view = Submenu::with_items(
            tr("보기", "View"),
            true,
            &[
                &item("zoomIn", tr("확대", "Zoom In")),
                &item("zoomOut", tr("축소", "Zoom Out")),
                &item("zoomReset", tr("실제 크기", "Actual Size")),
                &sep(),
                &item("refresh", tr("새로 고침", "Refresh")),
                &sep(),
            ],
        )
        .expect("보기 메뉴");
        #[cfg(target_os = "macos")]
        view.append(&PredefinedMenuItem::fullscreen(Some(tr("전체 화면", "Enter Full Screen")))).expect("보기 메뉴");
        // Windows 에는 운영체제 기본 전체 화면 항목이 없어 창을 직접 바꾼다.
        #[cfg(not(target_os = "macos"))]
        view.append(&item(FULLSCREEN, tr("전체 화면", "Full Screen"))).expect("보기 메뉴");
        menu.append(&view).expect("보기 메뉴");
        submenus.push(view);

        let repo = Submenu::with_items(
            tr("레포지토리", "Repository"),
            true,
            &[
                &item("commit", tr("커밋", "Commit")),
                &sep(),
                &item("fetch", "Fetch"),
                &item("pull", "Pull"),
                &item("push", "Push"),
                &sep(),
                &item("stash", tr("Stash 저장", "Stash Changes")),
                &item("pop", tr("Stash 꺼내기 (Pop)", "Pop Stash")),
                &sep(),
                &item("switchBranch", tr("브랜치 전환…", "Switch Branch…")),
                &item("newBranch", tr("새 브랜치…", "New Branch…")),
                &item("newTag", tr("새 태그…", "New Tag…")),
                &item("newWorktree", tr("새 워크트리…", "New Worktree…")),
            ],
        )
        .expect("레포지토리 메뉴");
        menu.append(&repo).expect("레포지토리 메뉴");
        submenus.push(repo);

        let window = Submenu::with_items(
            tr("창", "Window"),
            true,
            &[&PredefinedMenuItem::minimize(Some(tr("최소화", "Minimize"))), &PredefinedMenuItem::maximize(Some(tr("확대/축소", "Zoom")))],
        )
        .expect("창 메뉴");
        #[cfg(target_os = "macos")]
        {
            window.append_items(&[&sep(), &PredefinedMenuItem::bring_all_to_front(Some(tr("모두 앞으로 가져오기", "Bring All to Front")))]).expect("창 메뉴");
            window.set_as_windows_menu_for_nsapp();
        }
        menu.append(&window).expect("창 메뉴");
        submenus.push(window);

        let help = Submenu::with_items(tr("도움말", "Help"), true, &[&item("shortcuts", tr("키보드 단축키 보기", "Keyboard Shortcuts"))]).expect("도움말 메뉴");
        #[cfg(not(target_os = "macos"))]
        help.append_items(&[&sep(), &item("about", tr("Ramus 정보", "About Ramus"))]).expect("도움말 메뉴");
        // macOS 가 도움말 메뉴 맨 위에 검색 칸을 넣는다.
        #[cfg(target_os = "macos")]
        help.set_as_help_menu_for_nsapp();
        menu.append(&help).expect("도움말 메뉴");
        submenus.push(help);

        AppMenu { menu, items, submenus }
    }

    /// 메뉴를 붙인다. macOS 는 앱 전체(NSApp). Windows 는 창에 붙이지 않는다(제목 막대 단추가 `popup` 으로 띄운다). 리눅스도 붙이지 않는다.
    pub fn attach(&self) {
        #[cfg(target_os = "macos")]
        self.menu.init_for_nsapp();
    }

    /// 맨 위 메뉴 이름들(Windows 제목 막대가 단추로 그린다). 차례가 `popup` 의 번호다.
    #[cfg(windows)]
    pub fn titles(&self) -> Vec<String> {
        self.submenus.iter().map(Submenu::text).collect()
    }

    /// Windows: `index` 번째 맨 위 메뉴를 창 안쪽 논리 좌표 (x, y) 에 팝업으로 띄운다. 고를 때까지 돌아오지 않는다.
    /// 고른 항목은 메뉴 막대와 똑같이 `MenuEvent` 로 온다.
    #[cfg(windows)]
    pub fn popup(&self, window: &tao::window::Window, index: usize, x: f64, y: f64) {
        use muda::ContextMenu;
        use tao::platform::windows::WindowExtWindows;
        let Some(submenu) = self.submenus.get(index) else { return };
        let position = muda::dpi::LogicalPosition::new(x, y);
        // SAFETY: tao 가 만든 살아 있는 창의 HWND 다.
        unsafe { submenu.show_context_menu_for_hwnd(window.hwnd(), Some(position.into())) };
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
