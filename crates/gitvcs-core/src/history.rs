//! 파일 히스토리·Blame·비교·텍스트 파일 읽고 쓰기. 원본 `Core/GitHistory.cs`(FileLog)·`GitBlame`·`GitCompare`·`GitTextFile.cs` 를 옮겼다.

use serde::Serialize;

use crate::log::{self, Commit, FileChange};
use crate::repo::{GitError, Repository, Result};

/// 파일 히스토리의 한 줄: 커밋과 그때의 경로(이름 변경을 따라간다).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRevision {
    pub commit: Commit,
    pub path: String,
    pub original_path: Option<String>,
    pub status: char,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    /// 커밋하지 않은 줄은 0 으로만 된 해시.
    pub hash: String,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub summary: String,
    pub line: u32,
    pub text: String,
}

/// `git blame --porcelain` 출력.
pub fn parse_blame(output: &str) -> Vec<BlameLine> {
    use std::collections::HashMap;
    #[derive(Default, Clone)]
    struct Meta {
        author: String,
        email: String,
        time: i64,
        summary: String,
    }
    let mut metas: HashMap<String, Meta> = HashMap::new();
    let mut lines = Vec::new();
    let mut current: Option<(String, u32)> = None;
    for raw in output.lines() {
        if let Some(text) = raw.strip_prefix('\t') {
            if let Some((hash, line)) = current.take() {
                let m = metas.get(&hash).cloned().unwrap_or_default();
                lines.push(BlameLine { hash, author: m.author, email: m.email, time: m.time, summary: m.summary, line, text: text.to_string() });
            }
            continue;
        }
        let mut parts = raw.split(' ');
        let first = parts.next().unwrap_or_default();
        if first.len() == 40 && first.chars().all(|c| c.is_ascii_hexdigit()) {
            let final_line = parts.nth(1).and_then(|n| n.parse().ok()).unwrap_or(0);
            metas.entry(first.to_string()).or_default();
            current = Some((first.to_string(), final_line));
            continue;
        }
        let Some((hash, _)) = &current else { continue };
        let meta = metas.get_mut(hash).unwrap();
        let value = raw.split_once(' ').map(|(_, v)| v).unwrap_or_default().to_string();
        match first {
            "author" => meta.author = value,
            "author-mail" => meta.email = value.trim_start_matches('<').trim_end_matches('>').to_string(),
            "author-time" => meta.time = value.parse().unwrap_or(0),
            "summary" => meta.summary = value,
            _ => {}
        }
    }
    lines
}

/// 텍스트 파일 하나: 인코딩·BOM·줄 끝을 기억해 두었다가 저장할 때 그대로 돌려놓는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    /// 줄 끝은 \n 으로 바꾼 글.
    pub text: String,
    /// utf-8, utf-16le, utf-16be
    pub encoding: String,
    pub bom: bool,
    /// "\n" 또는 "\r\n"
    pub eol: String,
    /// 저장할 때 다른 곳에서 바뀌었는지 확인한다(밀리초).
    pub modified: u64,
    /// 들여쓰기 짐작: "\t" 또는 공백 n개.
    pub indent: String,
}

pub fn decode(bytes: &[u8]) -> Option<(String, String, bool)> {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(rest.to_vec()).ok().map(|t| (t, "utf-8".into(), true));
    }
    let utf16 = |rest: &[u8], le: bool| -> Option<String> {
        if rest.len() % 2 != 0 {
            return None;
        }
        let units: Vec<u16> = rest.chunks(2).map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) }).collect();
        String::from_utf16(&units).ok()
    };
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return utf16(rest, true).map(|t| (t, "utf-16le".into(), true));
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return utf16(rest, false).map(|t| (t, "utf-16be".into(), true));
    }
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes.to_vec()).ok().map(|t| (t, "utf-8".into(), false))
}

pub fn encode(text: &str, encoding: &str, bom: bool, eol: &str) -> Vec<u8> {
    let text = if eol == "\r\n" { text.replace("\r\n", "\n").replace('\n', "\r\n") } else { text.replace("\r\n", "\n") };
    let mut out = Vec::new();
    match encoding {
        "utf-16le" | "utf-16be" => {
            let le = encoding == "utf-16le";
            if bom {
                out.extend(if le { [0xFF, 0xFE] } else { [0xFE, 0xFF] });
            }
            for unit in text.encode_utf16() {
                out.extend(if le { unit.to_le_bytes() } else { unit.to_be_bytes() });
            }
        }
        _ => {
            if bom {
                out.extend([0xEF, 0xBB, 0xBF]);
            }
            out.extend(text.as_bytes());
        }
    }
    out
}

/// 들여쓰기 규칙 짐작: 탭으로 시작하는 줄이 더 많으면 탭, 아니면 가장 흔한 공백 수(2·4).
pub fn guess_indent(text: &str) -> String {
    let (mut tabs, mut two, mut four) = (0, 0, 0);
    for line in text.lines() {
        if line.starts_with('\t') {
            tabs += 1;
        } else {
            let n = line.len() - line.trim_start_matches(' ').len();
            if n > 0 && n % 4 == 0 {
                four += 1;
            } else if n > 0 && n % 2 == 0 {
                two += 1;
            }
        }
    }
    if tabs > two + four { "\t".into() } else if two > four { "  ".into() } else { "    ".into() }
}

fn modified_ms(path: &std::path::Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Repository {
    /// 파일 히스토리(이름 변경을 따라간다). 새 커밋이 앞.
    pub fn file_log(&self, path: &str, max_count: usize) -> Result<Vec<FileRevision>> {
        let remotes = self.remotes()?;
        let max = format!("--max-count={max_count}");
        // 커밋마다 레코드 구분자 뒤에 --name-status 가 따라 나온다.
        let out = self.git_run(&["log", "--follow", "-M", &max, log::LOG_FORMAT, "--name-status", "-z", "--", path])?;
        // 조각마다 [앞 커밋의 name-status][다음 커밋 머리]. 머리는 40자 해시 뒤 \x1f 로 시작한다.
        let mut headers = Vec::new();
        let mut statuses = Vec::new();
        for (k, piece) in out.split('\x1e').enumerate() {
            let (status, header) = match piece.find('\x1f') {
                Some(at) if at >= 40 => (&piece[..at - 40], &piece[at - 40..]),
                _ => (piece, ""),
            };
            if k > 0 {
                statuses.push(status);
            }
            if !header.is_empty() {
                headers.push(header);
            }
        }
        let mut list = Vec::new();
        for (i, header) in headers.iter().enumerate() {
            let Some(commit) = log::parse_commits(&format!("{header}\x1e"), &remotes).into_iter().next() else { continue };
            let change = statuses.get(i).map(|s| log::parse_name_status(s.trim_start_matches(['\n', '\0']))).and_then(|c| c.into_iter().next());
            list.push(match change {
                Some(c) => FileRevision { commit, path: c.path, original_path: c.original_path, status: c.status },
                None => FileRevision { commit, path: path.to_string(), original_path: None, status: 'M' },
            });
        }
        Ok(list)
    }

    /// 줄마다 마지막으로 바꾼 커밋. `revision` 이 비면 작업 트리(커밋 안 된 줄 포함).
    pub fn blame(&self, path: &str, revision: Option<&str>) -> Result<Vec<BlameLine>> {
        let mut args = vec!["blame", "--porcelain", "-M"];
        if let Some(rev) = revision.filter(|r| !r.is_empty()) {
            args.push(rev);
        }
        args.extend(["--", path]);
        Ok(parse_blame(&self.git_run(&args)?))
    }

    /// 두 판 사이 바뀐 파일. `to` 가 없으면 `from` ↔ 작업 트리. `range` 면 공통 조상부터(from...to).
    pub fn compare_files(&self, from: &str, to: Option<&str>, range: bool) -> Result<Vec<FileChange>> {
        let spec = match (to, range) {
            (Some(to), true) => vec![format!("{from}...{to}")],
            (Some(to), false) => vec![from.to_string(), to.to_string()],
            (None, _) => vec![from.to_string()],
        };
        let mut args = vec!["diff".to_string(), "--name-status".into(), "-z".into(), "-M".into(), "--no-ext-diff".into()];
        args.extend(spec);
        Ok(log::parse_name_status(&self.git_run(&args)?))
    }

    pub fn read_text(&self, path: &str) -> Result<TextFile> {
        let full = self.safe_path(path)?;
        let bytes = std::fs::read(&full).map_err(|e| GitError::new(format!("{path} 를 읽지 못했습니다: {e}")))?;
        let (raw, encoding, bom) = decode(&bytes).ok_or_else(|| GitError::new("UTF-8·UTF-16 이 아닌 파일입니다. 외부 편집기로 열어 주세요."))?;
        let crlf = raw.matches("\r\n").count();
        let lf = raw.matches('\n').count() - crlf;
        let eol = if crlf > lf { "\r\n" } else { "\n" };
        let text = raw.replace("\r\n", "\n");
        Ok(TextFile { indent: guess_indent(&text), text, encoding, bom, eol: eol.into(), modified: modified_ms(&full) })
    }

    /// 편집한 글을 원래 인코딩·BOM·줄 끝으로 쓴다. `expected` 와 지금 수정 시각이 다르면(다른 곳에서 바뀜) `force` 가 아니면 거절한다.
    pub fn write_text(&self, path: &str, text: &str, original: &TextFile, force: bool) -> Result<u64> {
        let full = self.safe_path(path)?;
        if !force && modified_ms(&full) != original.modified {
            return Err(GitError::new("CHANGED_ON_DISK"));
        }
        let bytes = encode(text, &original.encoding, original.bom, &original.eol);
        let tmp = full.with_extension("gitvcs-save");
        std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, &full)).map_err(|e| GitError::new(format!("{path} 를 쓰지 못했습니다: {e}")))?;
        Ok(modified_ms(&full))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_and_encodes_round_trip() {
        for (encoding, bom) in [("utf-8", false), ("utf-8", true), ("utf-16le", true), ("utf-16be", true)] {
            let bytes = encode("가나\n다\n", encoding, bom, "\r\n");
            let (text, enc, b) = decode(&bytes).unwrap();
            assert_eq!((enc.as_str(), b), (encoding, bom));
            assert_eq!(text, "가나\r\n다\r\n");
        }
        assert!(decode(&[0x41, 0x00, 0x42]).is_none());
    }

    #[test]
    fn indent_guess() {
        assert_eq!(guess_indent("a\n\tb\n\tc\n"), "\t");
        assert_eq!(guess_indent("a\n  b\n  c\n    d\n"), "  ");
        assert_eq!(guess_indent("a\n    b\n"), "    ");
    }

    #[test]
    fn parses_porcelain_blame() {
        let h = "a".repeat(40);
        let out = format!("{h} 1 1 2\nauthor 김\nauthor-mail <k@x>\nauthor-time 100\nsummary 첫\nfilename a.txt\n\tline one\n{h} 2 2\n\tline two\n");
        let b = parse_blame(&out);
        assert_eq!(b.len(), 2);
        assert_eq!(b[1].author, "김");
        assert_eq!(b[1].email, "k@x");
        assert_eq!(b[1].line, 2);
        assert_eq!(b[0].text, "line one");
    }
}

/// 워크스페이스 표의 한 줄.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub path: String,
    /// "", modified, added, deleted, renamed, untracked, conflicted, ignored
    pub state: String,
    pub size: Option<u64>,
    /// 유닉스 초.
    pub modified: Option<i64>,
}

/// 탐색 화면에 쓸 히스토리 범위.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExplorerQuery {
    /// 이 날짜(유닉스 초) 뒤 커밋만. 0 이면 전체.
    pub since: i64,
    /// 모든 브랜치(아니면 지금 브랜치만).
    pub all: bool,
    pub max_count: usize,
    /// 세로 그래프 배치(아니면 main·지금 브랜치가 앞 — 가로 탐색기).
    pub top_down: bool,
    pub skip: usize,
}

impl Repository {
    /// 탐색 화면용 히스토리: 기간·모든 브랜치·건너뛰기를 고른다.
    pub fn explorer_history(&self, q: &ExplorerQuery) -> Result<crate::repo::History> {
        let refs = self.refs()?;
        let head = self.head();
        if head.is_none() {
            return Ok(crate::repo::History { commits: Vec::new(), graph: crate::graph::GraphLayout { lane_count: 1, ..Default::default() }, head, truncated: false });
        }
        let max = q.max_count.clamp(1, 1_000_000);
        let mut args = vec!["log".to_string(), log::LOG_FORMAT.into(), "--date-order".into(), format!("--max-count={max}"), format!("--skip={}", q.skip)];
        if q.since > 0 {
            args.push(format!("--since={}", q.since));
        }
        if q.all {
            args.extend(["--exclude=refs/stash".into(), "--all".into()]);
        }
        args.push("HEAD".into());
        args.push("--".into());
        let out = self.git_run(&args)?;
        let commits = log::parse_commits(&out, &refs.remotes);
        let tips: Vec<crate::graph::BranchTip> = refs
            .local
            .iter()
            .chain(refs.remote.iter())
            .filter(|b| q.all || b.current)
            .map(|b| crate::graph::BranchTip { name: b.name.clone(), hash: b.hash.clone(), remote: b.remote.is_some(), current: b.current, time: b.time })
            .collect();
        let graph = crate::graph::build(&commits, &tips, crate::graph::ANONYMOUS_LANE, crate::graph::Options { top_down: q.top_down, head_first: false });
        let truncated = commits.len() >= max;
        Ok(crate::repo::History { commits, graph, head, truncated })
    }

    /// 저장소의 파일 표: 추적 중·새 파일(무시한 파일은 `ignored` 일 때), 상태·크기·수정 시각.
    pub fn workspace(&self, ignored: bool) -> Result<Vec<WorkspaceEntry>> {
        let st = self.status()?;
        let mut state_of: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for e in st.unstaged.iter().chain(st.staged.iter()) {
            let name = serde_json::to_value(e.state).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
            state_of.insert(e.path.clone(), name);
        }
        let mut paths: Vec<(String, String)> = Vec::new();
        for p in self.git_run(&["ls-files", "-z", "--cached", "--others", "--exclude-standard"])?.split('\0').filter(|p| !p.is_empty()) {
            paths.push((p.to_string(), state_of.get(p).cloned().unwrap_or_default()));
        }
        if ignored {
            for p in self.git_run(&["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"])?.split('\0').filter(|p| !p.is_empty()) {
                paths.push((p.trim_end_matches('/').to_string(), "ignored".into()));
            }
        }
        // 지운 파일은 ls-files --cached 에 남아 있다.
        paths.sort();
        paths.dedup_by(|a, b| a.0 == b.0);
        Ok(paths
            .into_iter()
            .map(|(path, state)| {
                let meta = self.root().join(&path).metadata().ok();
                WorkspaceEntry {
                    size: meta.as_ref().filter(|m| m.is_file()).map(|m| m.len()),
                    modified: meta.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64),
                    path,
                    state,
                }
            })
            .collect())
    }

    /// 그 커밋 시점의 모든 파일 경로.
    pub fn tree_files(&self, revision: &str) -> Result<Vec<String>> {
        Ok(self.git_run(&["ls-tree", "-r", "-z", "--name-only", revision])?.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect())
    }
}
