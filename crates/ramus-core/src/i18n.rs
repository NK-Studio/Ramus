//! 사용자에게 보이는 글의 언어(한국어 · 영어). 화면(ui/i18n.js)과 같은 설정(설정 파일의 `ui.language`)을 따른다.
//!
//! 글은 쓰는 자리에서 두 언어를 함께 적는다: `tr("커밋", "Commit")`, 형식 글은 `trf!("{n}개", "{n} items", n = 3)`.
//! 기본은 한국어라서, 언어를 정하지 않은 시험(tests/)은 한국어 글을 그대로 본다.

use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

/// 언어 코드("ko" · "en")로 정한다. 모르는 코드는 한국어.
pub fn set_language(code: &str) {
    ENGLISH.store(code == "en", Ordering::Relaxed);
}

/// 지금 언어가 영어인지.
pub fn is_en() -> bool {
    ENGLISH.load(Ordering::Relaxed)
}

/// 지금 언어의 코드.
pub fn language() -> &'static str {
    if is_en() { "en" } else { "ko" }
}

/// 두 언어 글 중 지금 언어의 것.
pub fn tr(ko: &'static str, en: &'static str) -> &'static str {
    if is_en() { en } else { ko }
}

/// `format!` 의 두 언어판: `trf!("'{}' 를 지웠습니다", "Deleted '{}'", name)`. 인자는 한 번만 평가한다.
#[macro_export]
macro_rules! trf {
    ($ko:literal, $en:literal $(,)?) => {
        if $crate::i18n::is_en() { format!($en) } else { format!($ko) }
    };
    ($ko:literal, $en:literal, $($args:tt)+) => {
        match $crate::i18n::is_en() {
            true => format!($en, $($args)+),
            false => format!($ko, $($args)+),
        }
    };
}
