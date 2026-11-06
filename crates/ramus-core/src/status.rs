//! `git status --porcelain=v1 -z --branch` 출력 파서.
//!
//! -z 를 쓰는 이유: 비 ASCII(한글) 경로가 따옴표·8진 이스케이프 없이 그대로 나오고, 공백이 든 경로도 안전하다.
//! -z 에서 이름 변경 레코드는 "XY 새경로\0원래경로\0" 순서다.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileState {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    /// 레포지토리 루트 기준 경로(슬래시 구분). git 명령에 그대로 넘긴다.
    pub path: String,
    /// 이름 변경·복사의 원래 경로.
    pub original_path: Option<String>,
    pub index: char,
    pub worktree: char,
    pub state: FileState,
}

impl StatusEntry {
    /// Stage 된 변경이 있는가(인덱스 칸).
    pub fn is_staged(&self) -> bool {
        self.state != FileState::Conflicted && self.index != ' ' && self.index != '?'
    }

    /// 작업 트리에 Stage 하지 않은 변경이 있는가. 충돌·새 파일도 여기 든다.
    pub fn is_unstaged(&self) -> bool {
        self.state == FileState::Conflicted || self.worktree != ' '
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub has_commits: bool,
    pub detached: bool,
}

pub fn to_state(x: char, y: char) -> FileState {
    if x == '?' && y == '?' {
        return FileState::Untracked;
    }
    // 병합 충돌: DD, AU, UD, UA, DU, AA, UU
    if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
        return FileState::Conflicted;
    }
    if x == 'D' || y == 'D' {
        return FileState::Deleted;
    }
    if x == 'R' || x == 'C' {
        return FileState::Renamed;
    }
    if x == 'A' {
        return FileState::Added;
    }
    FileState::Modified
}

pub fn parse(output: &str) -> (BranchInfo, Vec<StatusEntry>) {
    let mut branch = BranchInfo { has_commits: true, ..Default::default() };
    let mut entries = Vec::new();
    let records: Vec<&str> = output.split('\0').collect();
    let mut i = 0;
    while i < records.len() {
        let record = records[i];
        i += 1;
        if record.is_empty() {
            continue;
        }
        if let Some(header) = record.strip_prefix("## ") {
            branch = parse_branch(header);
            continue;
        }
        let mut chars = record.chars();
        let (Some(x), Some(y), Some(' ')) = (chars.next(), chars.next(), chars.next()) else {
            continue;
        };
        let path = chars.as_str().to_string();
        if path.is_empty() {
            continue;
        }
        let original_path = if (x == 'R' || x == 'C') && i < records.len() {
            i += 1;
            Some(records[i - 1].to_string())
        } else {
            None
        };
        entries.push(StatusEntry { path, original_path, index: x, worktree: y, state: to_state(x, y) });
    }
    (branch, entries)
}

fn parse_branch(header: &str) -> BranchInfo {
    let mut info = BranchInfo { has_commits: true, ..Default::default() };
    for prefix in ["No commits yet on ", "Initial commit on "] {
        if let Some(name) = header.strip_prefix(prefix) {
            info.has_commits = false;
            info.name = name.to_string();
            return info;
        }
    }
    if header.starts_with("HEAD (no branch)") {
        info.detached = true;
        info.name = "HEAD".into();
        return info;
    }

    // "main...origin/main [ahead 1, behind 2]"
    let (head, tracking) = match header.find(" [") {
        Some(at) => (&header[..at], Some(header[at + 2..].trim_end_matches(']'))),
        None => (header, None),
    };
    match head.find("...") {
        Some(at) => {
            info.name = head[..at].to_string();
            info.upstream = Some(head[at + 3..].to_string());
        }
        None => info.name = head.to_string(),
    }
    for part in tracking.unwrap_or("").split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            info.ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            info.behind = n.parse().unwrap_or(0);
        }
    }
    info
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_with_tracking() {
        let (b, e) = parse("## main...origin/main [ahead 1, behind 2]\0");
        assert_eq!(b.name, "main");
        assert_eq!(b.upstream.as_deref(), Some("origin/main"));
        assert_eq!((b.ahead, b.behind), (1, 2));
        assert!(b.has_commits);
        assert!(e.is_empty());
    }

    #[test]
    fn parses_branch_without_upstream_and_gone() {
        let (b, _) = parse("## feature\0");
        assert_eq!(b.name, "feature");
        assert_eq!(b.upstream, None);
        let (b, _) = parse("## main...origin/main [gone]\0");
        assert_eq!(b.upstream.as_deref(), Some("origin/main"));
        assert_eq!((b.ahead, b.behind), (0, 0));
    }

    #[test]
    fn parses_new_repository_and_detached() {
        let (b, _) = parse("## No commits yet on main\0");
        assert_eq!(b.name, "main");
        assert!(!b.has_commits);
        let (b, _) = parse("## HEAD (no branch)\0");
        assert!(b.detached);
    }

    #[test]
    fn parses_entries_with_korean_paths_and_renames() {
        let out = "## main\0 M 문서/한글 파일.txt\0R  new.txt\0old.txt\0?? 새 폴더/a.png\0UU conflict.cs\0D  gone.txt\0A  added.txt\0";
        let (_, e) = parse(out);
        assert_eq!(e.len(), 6);
        assert_eq!(e[0].path, "문서/한글 파일.txt");
        assert_eq!(e[0].state, FileState::Modified);
        assert!(!e[0].is_staged() && e[0].is_unstaged());
        assert_eq!(e[1].path, "new.txt");
        assert_eq!(e[1].original_path.as_deref(), Some("old.txt"));
        assert_eq!(e[1].state, FileState::Renamed);
        assert!(e[1].is_staged() && !e[1].is_unstaged());
        assert_eq!(e[2].state, FileState::Untracked);
        assert!(!e[2].is_staged() && e[2].is_unstaged());
        assert_eq!(e[3].state, FileState::Conflicted);
        assert!(!e[3].is_staged() && e[3].is_unstaged());
        assert_eq!(e[4].state, FileState::Deleted);
        assert_eq!(e[5].state, FileState::Added);
    }

    #[test]
    fn partially_staged_file_is_in_both_lists() {
        let (_, e) = parse("MM both.txt\0");
        assert!(e[0].is_staged() && e[0].is_unstaged());
    }

    #[test]
    fn conflict_codes() {
        for code in ["DD", "AU", "UD", "UA", "DU", "AA", "UU"] {
            let mut c = code.chars();
            assert_eq!(to_state(c.next().unwrap(), c.next().unwrap()), FileState::Conflicted, "{code}");
        }
    }
}
