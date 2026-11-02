//! diff 에서 고른 줄·변경 묶음(hunk)만 든 패치를 만든다(GitKraken 의 "이 줄 스테이지"·"hunk 스테이지").
//! 만든 패치는 `git apply --cached`(Stage), `git apply --cached --reverse`(Unstage), `git apply --reverse`(버리기)로 적용한다.
//!
//! `git add -p` 가 줄을 고를 때 쓰는 규칙과 같다:
//! Stage 는 인덱스(옛 판)에 적용하므로 고르지 않은 '-' 줄은 그대로 남는 문맥 줄이 되고 고르지 않은 '+' 줄은 뺀다.
//! Unstage(reverse)는 인덱스가 새 판이므로 고르지 않은 '+' 줄이 문맥 줄이 되고 고르지 않은 '-' 줄은 뺀다.
//! 줄 수가 달라졌으니 묶음 머리 줄의 줄 수는 다시 센다.

use std::collections::HashSet;
use std::fmt::Write;

use crate::diff::{DiffLine, HunkHeader, LineKind};

pub fn is_change(line: &DiffLine) -> bool {
    matches!(line.kind, LineKind::Added | LineKind::Removed)
}

/// 변경 묶음 하나의 바뀐 줄 인덱스. "hunk 스테이지" 가 이걸 골라 넘긴다.
pub fn changed_lines_of_hunk(lines: &[DiffLine], hunk: usize) -> Vec<usize> {
    lines.iter().enumerate().filter(|(_, l)| l.hunk == hunk && is_change(l)).map(|(i, _)| i).collect()
}

/// 고른 줄만 든 패치. 고른 줄에 바뀐 줄이 하나도 없으면 None.
/// `path` 는 저장소 기준 경로 — 이름이 바뀐 파일도 인덱스에는 새 경로로 있으므로 양쪽 다 새 경로를 쓴다.
pub fn build(lines: &[DiffLine], selected: &[usize], path: &str, reverse: bool) -> Option<String> {
    let chosen: HashSet<usize> = selected.iter().copied().collect();
    if chosen.is_empty() {
        return None;
    }
    let mut body = String::new();
    // 앞서 내보낸 묶음들이 줄 수를 얼마나 바꿨는지(새 판 줄 수 − 옛 판 줄 수의 합).
    let mut delta: i64 = 0;
    let mut i = 0;
    while i < lines.len() {
        if lines[i].kind != LineKind::Hunk {
            i += 1;
            continue;
        }
        let header_index = i;
        let mut end = i + 1;
        while end < lines.len() && lines[end].kind != LineKind::Hunk {
            end += 1;
        }
        i = end;
        let original = HunkHeader::parse(&lines[header_index].text)?;
        if let Some(hunk) = build_hunk(lines, header_index + 1, end, &chosen, reverse, &original, &mut delta) {
            body.push_str(&hunk);
        }
    }
    if body.is_empty() {
        return None;
    }
    let a = quote_path(&format!("a/{path}"));
    let b = quote_path(&format!("b/{path}"));
    Some(format!("diff --git {a} {b}\n--- {a}\n+++ {b}\n{body}"))
}

fn build_hunk(lines: &[DiffLine], start: usize, end: usize, chosen: &HashSet<usize>, reverse: bool, original: &HunkHeader, delta: &mut i64) -> Option<String> {
    let mut body = String::new();
    let (mut old_count, mut new_count) = (0i64, 0i64);
    let mut any_change = false;
    // 바로 앞 줄을 내보냈는지. "\ No newline" 은 앞 줄에 딸린 표시라 앞 줄을 뺐으면 같이 뺀다.
    let mut previous_emitted = false;
    for (i, line) in lines.iter().enumerate().take(end).skip(start) {
        let marker = match line.kind {
            LineKind::Context => ' ',
            LineKind::Added if chosen.contains(&i) => '+',
            // 인덱스(새 판)에 이미 있는 줄 — 그대로 둔다.
            LineKind::Added if reverse => ' ',
            LineKind::Removed if chosen.contains(&i) => '-',
            // 인덱스(옛 판)에 있고 지우지 않을 줄 — 문맥 줄로 둔다.
            LineKind::Removed if !reverse => ' ',
            LineKind::Added | LineKind::Removed => {
                previous_emitted = false;
                continue;
            }
            LineKind::NoNewline => {
                if previous_emitted {
                    body.push_str(&line.text);
                    body.push('\n');
                }
                continue;
            }
            LineKind::Hunk => unreachable!(),
        };
        previous_emitted = true;
        any_change |= marker != ' ';
        if marker != '+' {
            old_count += 1;
        }
        if marker != '-' {
            new_count += 1;
        }
        body.push(marker);
        body.push_str(&line.text);
        if line.cr {
            body.push('\r');
        }
        body.push('\n');
    }
    if !any_change {
        return None;
    }
    // Stage 는 옛 판에 적용하므로 옛 시작 줄은 원래 그대로이고 새 시작 줄만 앞 묶음들의 증감만큼 민다. Unstage 는 반대다.
    // 줄 수가 0 인 쪽은 git 처럼 "그 앞 줄" 번호를 쓴다.
    let (old_start, new_start);
    if !reverse {
        old_start = original.old_start as i64;
        let position = if original.old_count > 0 { original.old_start as i64 } else { original.old_start as i64 + 1 };
        new_start = position + *delta - if new_count == 0 { 1 } else { 0 };
    } else {
        new_start = original.new_start as i64;
        let position = if original.new_count > 0 { original.new_start as i64 } else { original.new_start as i64 + 1 };
        old_start = position - *delta - if old_count == 0 { 1 } else { 0 };
    }
    *delta += new_count - old_count;
    let mut out = String::new();
    let _ = writeln!(out, "@@ -{old_start},{old_count} +{new_start},{new_count} @@{}", original.trailer);
    out.push_str(&body);
    Some(out)
}

/// git 의 `core.quotepath` 와 같은 C 식 따옴표 묶기. 한글·공백·제어 문자·따옴표·역슬래시가 있으면 UTF-8 바이트를 8진수로 적는다.
pub fn quote_path(path: &str) -> String {
    let needs = path.bytes().any(|b| b < 0x20 || b >= 0x7f || b == b'"' || b == b'\\' || b == b' ');
    if !needs {
        return path.to_string();
    }
    let mut out = String::from("\"");
    for b in path.bytes() {
        match b {
            b'"' => out.push_str("\\\""),
            b'\\' => out.push_str("\\\\"),
            7 => out.push_str("\\a"),
            8 => out.push_str("\\b"),
            9 => out.push_str("\\t"),
            10 => out.push_str("\\n"),
            11 => out.push_str("\\v"),
            12 => out.push_str("\\f"),
            13 => out.push_str("\\r"),
            b if b < 0x20 || b >= 0x7f => {
                let _ = write!(out, "\\{b:03o}");
            }
            b => out.push(b as char),
        }
    }
    out.push('"');
    out
}

/// 원본 패키지 Tests/Editor/GitPartialPatchTests.cs 를 옮긴 것.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::parse;

    const HEADER: &str = "diff --git a/A.cs b/A.cs\n--- a/A.cs\n+++ b/A.cs\n";

    fn lines(diff: &str) -> Vec<DiffLine> {
        parse(diff).lines
    }

    fn pick(lines: &[DiffLine], texts: &[&str]) -> Vec<usize> {
        lines.iter().enumerate().filter(|(_, l)| is_change(l) && texts.contains(&l.text.as_str())).map(|(i, _)| i).collect()
    }

    fn p(diff: &str, texts: &[&str], reverse: bool) -> Option<String> {
        let l = lines(diff);
        build(&l, &pick(&l, texts), "A.cs", reverse)
    }

    #[test]
    fn stage_one_added_line_drops_other_added_lines() {
        assert_eq!(p("@@ -1,2 +1,4 @@\n a\n+x\n+y\n b\n", &["x"], false).unwrap(), format!("{HEADER}@@ -1,2 +1,3 @@\n a\n+x\n b\n"));
    }

    #[test]
    fn stage_one_removed_line_keeps_other_removed_as_context() {
        assert_eq!(p("@@ -1,3 +1,1 @@\n a\n-x\n-y\n", &["x"], false).unwrap(), format!("{HEADER}@@ -1,3 +1,2 @@\n a\n-x\n y\n"));
    }

    #[test]
    fn unstage_one_added_line_keeps_other_added_as_context() {
        assert_eq!(p("@@ -1,2 +1,4 @@\n a\n+x\n+y\n b\n", &["y"], true).unwrap(), format!("{HEADER}@@ -1,3 +1,4 @@\n a\n x\n+y\n b\n"));
    }

    #[test]
    fn unstage_one_removed_line_drops_other_removed_lines() {
        assert_eq!(p("@@ -1,3 +1,1 @@\n a\n-x\n-y\n", &["y"], true).unwrap(), format!("{HEADER}@@ -1,2 +1,1 @@\n a\n-y\n"));
    }

    #[test]
    fn selection_outside_changes_is_none() {
        let l = lines("@@ -1,2 +1,3 @@\n a\n+x\n b\n");
        assert!(build(&l, &[0, 1], "A.cs", false).is_none());
        assert!(build(&l, &[], "A.cs", false).is_none());
    }

    #[test]
    fn skips_hunks_without_selection_and_shifts_later_starts() {
        let diff = "@@ -1,2 +1,4 @@\n a\n+x\n+y\n b\n@@ -10,2 +12,3 @@\n c\n+z\n d\n@@ -20,2 +23,1 @@\n e\n-f\n";
        assert_eq!(p(diff, &["x", "f"], false).unwrap(), format!("{HEADER}@@ -1,2 +1,3 @@\n a\n+x\n b\n@@ -20,2 +21,1 @@\n e\n-f\n"));
    }

    #[test]
    fn unstage_shifts_later_old_starts() {
        let diff = "@@ -1,2 +1,4 @@\n a\n+x\n+y\n b\n@@ -20,2 +22,1 @@\n e\n-f\n";
        assert_eq!(p(diff, &["x", "f"], true).unwrap(), format!("{HEADER}@@ -1,3 +1,4 @@\n a\n+x\n y\n b\n@@ -21,2 +22,1 @@\n e\n-f\n"));
    }

    #[test]
    fn zero_count_side_uses_line_before_convention() {
        assert_eq!(p("@@ -5,2 +4,0 @@\n-x\n-y\n", &["x", "y"], false).unwrap(), format!("{HEADER}@@ -5,2 +4,0 @@\n-x\n-y\n"));
        assert_eq!(p("@@ -5,2 +4,0 @@\n-x\n-y\n", &["x"], false).unwrap(), format!("{HEADER}@@ -5,2 +5,1 @@\n-x\n y\n"));
    }

    #[test]
    fn new_file_stages_chosen_lines_from_empty_old_side() {
        assert_eq!(p("@@ -0,0 +1,3 @@\n+a\n+b\n+c\n", &["b"], false).unwrap(), format!("{HEADER}@@ -0,0 +1,1 @@\n+b\n"));
    }

    #[test]
    fn crlf_keeps_carriage_return_on_every_line() {
        let l = lines("@@ -1,2 +1,3 @@\r\n a\r\n+x\r\n b\r\n");
        assert_eq!(build(&l, &pick(&l, &["x"]), "A.cs", false).unwrap(), format!("{HEADER}@@ -1,2 +1,3 @@\n a\r\n+x\r\n b\r\n"));
        assert!(l[2].cr);
        assert_eq!(l[2].text, "x");
    }

    #[test]
    fn no_newline_marker_follows_its_line() {
        let diff = "@@ -1,2 +1,2 @@\n a\n-x\n\\ No newline at end of file\n+x\n";
        assert_eq!(p(diff, &["x"], false).unwrap(), format!("{HEADER}@@ -1,2 +1,2 @@\n a\n-x\n\\ No newline at end of file\n+x\n"));
        let l = lines(diff);
        assert!(build(&l, &[], "A.cs", true).is_none());
    }

    #[test]
    fn no_newline_dropped_line_drops_marker() {
        assert_eq!(p("@@ -1,1 +1,3 @@\n a\n+x\n+y\n\\ No newline at end of file\n", &["x"], false).unwrap(), format!("{HEADER}@@ -1,1 +1,2 @@\n a\n+x\n"));
    }

    #[test]
    fn no_newline_context_line_keeps_marker() {
        assert_eq!(
            p("@@ -1,1 +1,3 @@\n a\n+x\n+y\n\\ No newline at end of file\n", &["x"], true).unwrap(),
            format!("{HEADER}@@ -1,2 +1,3 @@\n a\n+x\n y\n\\ No newline at end of file\n")
        );
    }

    #[test]
    fn korean_path_is_quoted_like_git() {
        let l = lines("@@ -1,1 +1,2 @@\n a\n+x\n");
        let patch = build(&l, &pick(&l, &["x"]), "Assets/한글.cs", false).unwrap();
        assert!(patch.starts_with(
            "diff --git \"a/Assets/\\355\\225\\234\\352\\270\\200.cs\" \"b/Assets/\\355\\225\\234\\352\\270\\200.cs\"\n--- \"a/Assets/\\355\\225\\234\\352\\270\\200.cs\"\n+++ \"b/Assets/\\355\\225\\234\\352\\270\\200.cs\"\n@@ -1,1 +1,2 @@\n"
        ));
    }

    #[test]
    fn renamed_file_uses_new_path_on_both_sides() {
        let l = lines("diff --git a/Old.cs b/New.cs\nsimilarity index 80%\nrename from Old.cs\nrename to New.cs\n--- a/Old.cs\n+++ b/New.cs\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n");
        assert_eq!(build(&l, &pick(&l, &["b", "c"]), "New.cs", true).unwrap(), "diff --git a/New.cs b/New.cs\n--- a/New.cs\n+++ b/New.cs\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n");
    }

    #[test]
    fn keeps_hunk_trailer_text() {
        assert!(p("@@ -3,2 +3,3 @@ void Method()\n a\n+x\n b\n", &["x"], false).unwrap().contains("@@ -3,2 +3,3 @@ void Method()\n"));
    }

    #[test]
    fn changed_lines_of_hunk_returns_only_that_hunks_changes() {
        let l = lines("@@ -1,2 +1,3 @@\n a\n+x\n b\n@@ -10,2 +11,2 @@\n c\n-d\n+e\n");
        assert_eq!(changed_lines_of_hunk(&l, 1), vec![6, 7]);
        assert_eq!(l[4].hunk, 1);
    }
}
