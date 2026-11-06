//! unified diff 출력을 줄 목록으로 바꾼다. 파일 머리(diff --git, index, ---/+++)는 버리고 hunk 부터 담는다.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Hunk,
    Context,
    Added,
    Removed,
    /// `\ No newline at end of file` — 바로 앞 줄에 딸린 표시.
    NoNewline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    /// 옛 판 줄 번호(0 = 없음).
    pub old: u32,
    /// 새 판 줄 번호(0 = 없음).
    pub new: u32,
    /// 앞 표시(' ', '+', '-')를 뗀 글. hunk 머리 줄과 NoNewline 은 줄 전체.
    pub text: String,
    /// CRLF 파일의 '\r'. 화면에는 안 보이지만 패치로 돌려줄 때 필요하다.
    pub cr: bool,
    pub hunk: usize,
    /// 짝지은 줄과 실제로 다른 구간(글자 단위, UTF-16 이 아닌 char 기준). 없으면 0, 0.
    pub change_start: usize,
    pub change_len: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffDocument {
    pub lines: Vec<DiffLine>,
    pub binary: bool,
    pub added: usize,
    pub removed: usize,
    pub hunk_count: usize,
    /// 줄 내용의 지문. 화면이 본 diff 와 지금 diff 가 같은지 확인한다(줄 고르기 Stage 전에).
    pub fingerprint: String,
}

/// 줄 안 강조를 하려면 두 줄이 이만큼 같아야 한다(공통 앞·뒤 글자 수 / 긴 줄 길이). 다시 쓴 줄은 강조하지 않는다.
const MIN_INTRA_LINE_SIMILARITY: f32 = 0.5;

pub fn parse(output: &str) -> DiffDocument {
    let mut doc = DiffDocument::default();
    let mut old = 0u32;
    let mut new = 0u32;
    let mut in_hunk = false;
    let mut pieces: Vec<&str> = output.split('\n').collect();
    // 출력 끝의 줄바꿈 뒤 빈 조각은 내용이 아니다.
    if pieces.last() == Some(&"") {
        pieces.pop();
    }
    for raw in pieces {
        let cr = raw.ends_with('\r');
        let line = if cr { &raw[..raw.len() - 1] } else { raw };
        if line.starts_with("diff --git ") {
            in_hunk = false;
            continue;
        }
        if line.starts_with("@@") {
            let Some(header) = HunkHeader::parse(line) else {
                in_hunk = false;
                continue;
            };
            old = header.old_start;
            new = header.new_start;
            in_hunk = true;
            doc.hunk_count += 1;
            doc.lines.push(DiffLine { kind: LineKind::Hunk, old: 0, new: 0, text: line.to_string(), cr: false, hunk: doc.hunk_count - 1, change_start: 0, change_len: 0 });
            continue;
        }
        if !in_hunk {
            if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
                doc.binary = true;
            }
            continue;
        }
        let hunk = doc.hunk_count - 1;
        let mut push = |kind, o, n, text: &str| {
            doc.lines.push(DiffLine { kind, old: o, new: n, text: text.to_string(), cr, hunk, change_start: 0, change_len: 0 });
        };
        // 일부 도구는 빈 문맥 줄의 앞 공백을 지운다. 빈 문맥 줄로 본다.
        let marker = line.chars().next().unwrap_or(' ');
        let text = line.get(1..).unwrap_or("");
        match marker {
            ' ' => {
                push(LineKind::Context, old, new, text);
                old += 1;
                new += 1;
            }
            '-' => {
                push(LineKind::Removed, old, 0, text);
                old += 1;
                doc.removed += 1;
            }
            '+' => {
                push(LineKind::Added, 0, new, text);
                new += 1;
                doc.added += 1;
            }
            '\\' => push(LineKind::NoNewline, 0, 0, line),
            // hunk 가 끝나고 다음 파일 머리가 시작됐다.
            _ => in_hunk = false,
        }
    }
    mark_intra_line_changes(&mut doc.lines);
    doc.fingerprint = fingerprint(&doc.lines);
    doc
}

/// FNV-1a 64비트. 보안용이 아니라 "같은 diff 인가" 만 본다.
fn fingerprint(lines: &[DiffLine]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for line in lines {
        let kind = match line.kind {
            LineKind::Hunk => b'@',
            LineKind::Context => b' ',
            LineKind::Added => b'+',
            LineKind::Removed => b'-',
            LineKind::NoNewline => b'\\',
        };
        for b in std::iter::once(kind).chain(line.text.bytes()).chain(std::iter::once(b'\n')) {
            hash ^= b as u64;
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("{hash:016x}")
}

/// 연속한 "지운 줄 묶음 → 더한 줄 묶음"을 같은 순번끼리 짝지어, 짝마다 실제로 다른 구간을 표시한다.
fn mark_intra_line_changes(lines: &mut [DiffLine]) {
    let mut i = 0;
    while i < lines.len() {
        if lines[i].kind != LineKind::Removed {
            i += 1;
            continue;
        }
        let removed_start = i;
        while i < lines.len() && lines[i].kind == LineKind::Removed {
            i += 1;
        }
        let added_start = i;
        while i < lines.len() && lines[i].kind == LineKind::Added {
            i += 1;
        }
        let pairs = (added_start - removed_start).min(i - added_start);
        for k in 0..pairs {
            let (left, right) = lines.split_at_mut(added_start);
            mark_pair(&mut left[removed_start + k], &mut right[k]);
        }
    }
}

fn mark_pair(removed: &mut DiffLine, added: &mut DiffLine) {
    let a: Vec<char> = removed.text.chars().collect();
    let b: Vec<char> = added.text.chars().collect();
    let max_prefix = a.len().min(b.len());
    let prefix = (0..max_prefix).take_while(|&k| a[k] == b[k]).count();
    let max_suffix = max_prefix - prefix;
    let suffix = (0..max_suffix).take_while(|&k| a[a.len() - 1 - k] == b[b.len() - 1 - k]).count();
    let longer = a.len().max(b.len());
    if longer == 0 || ((prefix + suffix) as f32) < longer as f32 * MIN_INTRA_LINE_SIMILARITY {
        return;
    }
    removed.change_start = prefix;
    removed.change_len = a.len() - prefix - suffix;
    added.change_start = prefix;
    added.change_len = b.len() - prefix - suffix;
}

/// `@@ -oldStart,oldCount +newStart,newCount @@ 뒤 글`. 줄 수(",5")가 생략되면 1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HunkHeader {
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    /// 두 번째 `@@` 뒤의 글(함수 이름 등, 앞 공백 포함).
    pub trailer: String,
}

impl HunkHeader {
    pub fn parse(line: &str) -> Option<HunkHeader> {
        let rest = line.strip_prefix("@@ -")?;
        let (old_start, old_count, rest) = read_range(rest)?;
        let rest = rest.strip_prefix(" +")?;
        let (new_start, new_count, rest) = read_range(rest)?;
        let close = rest.find("@@")?;
        Some(HunkHeader { old_start, old_count, new_start, new_count, trailer: rest[close + 2..].to_string() })
    }
}

impl std::fmt::Display for HunkHeader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "@@ -{},{} +{},{} @@{}", self.old_start, self.old_count, self.new_start, self.new_count, self.trailer)
    }
}

fn read_range(s: &str) -> Option<(u32, u32, &str)> {
    let digits = s.bytes().take_while(u8::is_ascii_digit).count();
    let start: u32 = s[..digits].parse().ok()?;
    let rest = &s[digits..];
    if let Some(rest) = rest.strip_prefix(',') {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        let count: u32 = rest[..digits].parse().ok()?;
        Some((start, count, &rest[digits..]))
    } else {
        Some((start, 1, rest))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hunks_and_numbers() {
        let doc = parse("diff --git a/a b/a\nindex 1..2 100644\n--- a/a\n+++ b/a\n@@ -1,3 +1,3 @@ fn x()\n a\n-b\n+c\n d\n@@ -10 +10,2 @@\n e\n+f\n");
        assert_eq!(doc.hunk_count, 2);
        assert_eq!((doc.added, doc.removed), (2, 1));
        let k: Vec<LineKind> = doc.lines.iter().map(|l| l.kind).collect();
        use LineKind::*;
        assert_eq!(k, vec![Hunk, Context, Removed, Added, Context, Hunk, Context, Added]);
        assert_eq!((doc.lines[2].old, doc.lines[2].new), (2, 0));
        assert_eq!((doc.lines[3].old, doc.lines[3].new), (0, 2));
        assert_eq!((doc.lines[4].old, doc.lines[4].new), (3, 3));
        assert_eq!(doc.lines[7].new, 11);
        assert_eq!(doc.lines[7].hunk, 1);
    }

    #[test]
    fn binary_and_empty() {
        assert!(parse("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n").binary);
        let empty = parse("");
        assert!(empty.lines.is_empty() && !empty.binary);
    }

    #[test]
    fn crlf_and_no_newline() {
        let doc = parse("@@ -1,2 +1,2 @@\r\n a\r\n-x\n\\ No newline at end of file\n+x\r\n");
        assert!(doc.lines[1].cr);
        assert_eq!(doc.lines[1].text, "a");
        assert_eq!(doc.lines[3].kind, LineKind::NoNewline);
    }

    #[test]
    fn intra_line_marks_similar_pairs_only() {
        let doc = parse("@@ -1,2 +1,2 @@\n-int count = 1;\n-완전히 다른 줄\n+int count = 10;\n+something else entirely\n");
        // "…= 1;" → "…= 10;": 앞 13글자("int count = 1")와 끝 ";" 가 같아 "0" 하나만 더해진 것으로 본다.
        assert_eq!((doc.lines[1].change_start, doc.lines[1].change_len), (13, 0));
        assert_eq!((doc.lines[3].change_start, doc.lines[3].change_len), (13, 1));
        assert_eq!(doc.lines[2].change_len, 0);
    }

    #[test]
    fn fingerprint_changes_with_content() {
        let a = parse("@@ -1 +1 @@\n-a\n+b\n");
        let b = parse("@@ -1 +1 @@\n-a\n+c\n");
        assert_ne!(a.fingerprint, b.fingerprint);
        assert_eq!(a.fingerprint, parse("diff --git a/q b/q\n@@ -1 +1 @@\n-a\n+b\n").fingerprint);
    }

    #[test]
    fn hunk_header_round_trip() {
        let h = HunkHeader::parse("@@ -3 +4,0 @@ void M()").unwrap();
        assert_eq!((h.old_start, h.old_count, h.new_start, h.new_count), (3, 1, 4, 0));
        assert_eq!(h.to_string(), "@@ -3,1 +4,0 @@ void M()");
        assert!(HunkHeader::parse("@@ nope").is_none());
    }
}
