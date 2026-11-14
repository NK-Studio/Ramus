//! GitHub 마크다운(PR 설명·코멘트·리뷰)을 화면에 넣을 HTML 로 바꾼다.
//!
//! GitHub 이 그리는 것처럼 표·취소선·체크 목록·자동 링크·각주·알림(`> [!NOTE]`)을 켜고,
//! 코멘트 칸처럼 줄바꿈 하나도 줄을 바꾼다. 글 속 HTML(`<details>`·`<img>`·`<kbd>`…)도 그리되,
//! 남이 쓴 글을 앱 화면에 그대로 넣는 것이라 안전한 태그·속성만 남긴다(ammonia): `<script>`·`on…=`·`style`·
//! `javascript:` 주소는 지우고, `id` 는 GitHub 처럼 `user-content-` 를 앞에 붙여 앱 화면의 id 와 겹치지 않게 한다.

use ammonia::Builder;
use comrak::{Options, markdown_to_html};

/// 글 속 id 앞에 붙이는 말. 각주 링크(`#fn-1`)는 화면에서 이것을 붙여 찾는다.
pub const ID_PREFIX: &str = "user-content-";

/// 마크다운 `text` 를 HTML 조각으로 바꾼다. 예: `"**a**"` → `"<p><strong>a</strong></p>\n"`.
pub fn to_html(text: &str) -> String {
    sanitizer().clean(&markdown_to_html(text, &options())).to_string()
}

fn options() -> Options<'static> {
    let mut o = Options::default();
    o.extension.strikethrough = true;
    o.extension.table = true;
    o.extension.autolink = true;
    o.extension.tasklist = true;
    o.extension.footnotes = true;
    o.extension.alerts = true;
    o.render.hardbreaks = true;
    o.render.github_pre_lang = true;
    o.render.tasklist_classes = true;
    // 글 속 HTML 을 그대로 내보내고 거르기는 sanitizer 가 한다.
    o.render.r#unsafe = true;
    o
}

/// ammonia 기본(안전한 서식 태그, http·https·mailto 링크) + comrak 이 만드는 체크 목록·각주·알림.
fn sanitizer() -> Builder<'static> {
    let mut b = Builder::default();
    b.add_tags(["input", "section"])
        // 체크 목록의 칸. 글에 쓴 `<input>` 도 누를 수 없는 체크 칸으로만 남는다.
        .add_tag_attributes("input", ["checked"])
        .set_tag_attribute_value("input", "type", "checkbox")
        .set_tag_attribute_value("input", "disabled", "")
        // README 에 흔한 `<p align="center">`.
        .add_tag_attributes("p", ["align"])
        .add_tag_attributes("div", ["align"])
        .add_tag_attributes("h1", ["align"])
        .add_tag_attributes("h2", ["align"])
        .add_tag_attributes("h3", ["align"])
        .add_generic_attributes(["id"])
        .id_prefix(Some(ID_PREFIX))
        .add_allowed_classes("ul", ["contains-task-list"])
        .add_allowed_classes("ol", ["contains-task-list"])
        .add_allowed_classes("li", ["task-list-item"])
        .add_allowed_classes("input", ["task-list-item-checkbox"])
        .add_allowed_classes("section", ["footnotes"])
        .add_allowed_classes("sup", ["footnote-ref"])
        .add_allowed_classes("a", ["footnote-backref"])
        .add_allowed_classes("p", ["markdown-alert-title"])
        .add_allowed_classes(
            "div",
            ["markdown-alert", "markdown-alert-note", "markdown-alert-tip", "markdown-alert-important", "markdown-alert-warning", "markdown-alert-caution"],
        );
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_github_flavored_markdown() {
        let html = to_html("## Summary\n\n- **bold** `code`\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nsee https://example.com\n\n> [!NOTE]\n> hi");
        assert!(html.contains("<h2>Summary</h2>"));
        assert!(html.contains("<strong>bold</strong>"));
        assert!(html.contains("<code>code</code>"));
        assert!(html.contains("<li class=\"task-list-item\">"));
        assert!(html.contains("type=\"checkbox\""));
        assert!(html.contains("<table>"));
        assert!(html.contains("href=\"https://example.com\""));
        assert!(html.contains("class=\"markdown-alert markdown-alert-note\""));
    }

    #[test]
    fn single_newline_breaks_the_line() {
        assert!(to_html("a\nb").contains("a<br>"));
    }

    #[test]
    fn keeps_safe_html() {
        let html = to_html("<details><summary>more</summary>\n\nbody\n\n</details>\n\n<p align=\"center\"><img src=\"https://x/y.png\" width=\"80\"></p>\n\n<kbd>Ctrl</kbd>");
        assert!(html.contains("<details><summary>more</summary>"));
        assert!(html.contains("<p>body</p>"));
        assert!(html.contains("<p align=\"center\"><img src=\"https://x/y.png\" width=\"80\"></p>"));
        assert!(html.contains("<kbd>Ctrl</kbd>"));
    }

    #[test]
    fn drops_dangerous_html() {
        let html = to_html(
            "<script>alert(1)</script>\n\n[x](javascript:alert(1)) <img src=x onerror=alert(1)> <a href=\"javascript:alert(1)\">y</a>\n\n<div style=\"position:fixed\" class=\"drawer\">z</div><iframe src=\"https://x\"></iframe>",
        );
        assert!(!html.contains("<script") && !html.contains("alert(1)</"));
        assert!(!html.contains("javascript:"));
        assert!(!html.contains("onerror"));
        assert!(!html.contains("style=") && !html.contains("drawer"));
        assert!(!html.contains("<iframe"));
    }

    #[test]
    fn written_inputs_become_disabled_checkboxes() {
        let html = to_html("<input type=\"text\" value=\"x\">");
        assert!(html.contains("type=\"checkbox\"") && html.contains("disabled"));
        assert!(!html.contains("text") && !html.contains("value"));
    }

    #[test]
    fn prefixes_ids_so_footnotes_do_not_clash_with_the_app() {
        let html = to_html("a[^1]\n\n[^1]: note\n\n<span id=\"commit-description\">x</span>");
        assert!(html.contains("href=\"#fn-1\""));
        assert!(html.contains("id=\"user-content-fn-1\""));
        assert!(html.contains("id=\"user-content-commit-description\""));
    }
}
