//! 병합 충돌: 작업 사본의 충돌 표시(`<<<<<<< A … ||||||| base … ======= … >>>>>>> B`)를 조각으로 나누고,
//! 멈춘 rebase·merge·cherry-pick·revert 를 알아보고 이어가거나(--continue) 건너뛰거나(--skip) 취소(--abort)한다.
//! 원본 패키지 GitConflictFile·GitInProgress 를 옮긴 것.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::repo::{GitError, Repository, Result};
use crate::status::FileState;

/// 충돌 파일의 한 조각: 양쪽이 같은 줄들, 또는 충돌 한 덩어리.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Segment {
    Common { lines: Vec<String> },
    /// `base` 는 diff3 형식(`|||||||`)일 때의 공통 조상 줄. 보이기만 한다.
    Conflict { a: Vec<String>, base: Vec<String>, b: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub segments: Vec<Segment>,
    /// `<<<<<<< HEAD` 의 HEAD, `>>>>>>> feature` 의 feature.
    pub a_label: String,
    pub b_label: String,
    /// "\n" 또는 "\r\n". 출력도 이걸 따른다.
    pub newline: String,
    pub ends_with_newline: bool,
}

/// 같은 글자 일곱 개로 시작하고, 끝나거나 빈칸이 뒤따르는 줄.
fn is_marker(line: &str, c: char) -> bool {
    let mut chars = line.chars();
    (0..7).all(|_| chars.next() == Some(c)) && matches!(chars.next(), None | Some(' '))
}

fn marker_label(line: &str) -> String {
    line.get(7..).unwrap_or("").trim().to_string()
}

/// 충돌 표시가 있는 글을 나눈다. 짝이 맞는 충돌 표시가 하나도 없으면 None.
pub fn parse(text: &str) -> Option<ConflictFile> {
    if text.is_empty() {
        return None;
    }
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count();
    let newline = if crlf > 0 && crlf * 2 >= lf { "\r\n" } else { "\n" };
    let ends_with_newline = text.ends_with('\n');
    let mut lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if ends_with_newline {
        lines.pop();
    }
    let mut file = ConflictFile { segments: Vec::new(), a_label: String::new(), b_label: String::new(), newline: newline.into(), ends_with_newline };
    // 0 = 바깥, 1 = A, 2 = base, 3 = B
    let mut part = 0;
    let (mut a, mut base, mut b) = (Vec::new(), Vec::new(), Vec::new());
    let mut pending: Vec<String> = Vec::new();
    let push_common = |file: &mut ConflictFile, line: String| match file.segments.last_mut() {
        Some(Segment::Common { lines }) => lines.push(line),
        _ => file.segments.push(Segment::Common { lines: vec![line] }),
    };
    for line in lines {
        if part == 0 {
            if is_marker(line, '<') {
                if file.a_label.is_empty() {
                    file.a_label = marker_label(line);
                }
                pending = vec![line.to_string()];
                part = 1;
            } else {
                push_common(&mut file, line.to_string());
            }
            continue;
        }
        pending.push(line.to_string());
        if part == 1 && is_marker(line, '|') {
            part = 2;
        } else if (part == 1 || part == 2) && line == "=======" {
            part = 3;
        } else if part == 3 && is_marker(line, '>') {
            if file.b_label.is_empty() {
                file.b_label = marker_label(line);
            }
            file.segments.push(Segment::Conflict { a: std::mem::take(&mut a), base: std::mem::take(&mut base), b: std::mem::take(&mut b) });
            part = 0;
        } else {
            match part {
                1 => a.push(line.to_string()),
                2 => base.push(line.to_string()),
                _ => b.push(line.to_string()),
            }
        }
    }
    // 짝이 맞지 않는 표시(끝이 없는 <<<<<<<)는 그냥 글로 둔다.
    if part != 0 {
        for line in pending {
            push_common(&mut file, line);
        }
    }
    file.segments.iter().any(|s| matches!(s, Segment::Conflict { .. })).then_some(file)
}

/// 글에 해결하지 않은 충돌 표시가 남았는가(`<<<<<<<` 와 짝이 되는 `>>>>>>>`).
pub fn has_markers(text: &str) -> bool {
    parse(text).is_some()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    Rebase,
    Merge,
    CherryPick,
    Revert,
}

impl Operation {
    fn verb(self) -> &'static str {
        match self {
            Operation::Rebase => "rebase",
            Operation::Merge => "merge",
            Operation::CherryPick => "cherry-pick",
            Operation::Revert => "revert",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Operation::Rebase => "Rebase",
            Operation::Merge => "병합",
            Operation::CherryPick => "Cherry-pick",
            Operation::Revert => "Revert",
        }
    }
}

/// git 폴더의 표시 파일로 진행 중인 작업을 안다. rebase 가 가장 먼저 — 병합 커밋을 다시 쌓다 멈추면 MERGE_HEAD 도 함께 있다.
pub fn detect(git_dir: &Path) -> Option<Operation> {
    if git_dir.join("rebase-merge").is_dir() {
        return Some(Operation::Rebase);
    }
    let apply = git_dir.join("rebase-apply");
    if apply.is_dir() {
        // git am 은 다루지 않는다.
        return (!apply.join("applying").exists()).then_some(Operation::Rebase);
    }
    if git_dir.join("MERGE_HEAD").exists() {
        return Some(Operation::Merge);
    }
    if git_dir.join("CHERRY_PICK_HEAD").exists() {
        return Some(Operation::CherryPick);
    }
    if git_dir.join("REVERT_HEAD").exists() {
        return Some(Operation::Revert);
    }
    // 여러 커밋 cherry-pick·revert 에서 충돌한 커밋을 직접 커밋한 뒤: 남은 목록(sequencer)만 있다.
    let todo = std::fs::read_to_string(git_dir.join("sequencer").join("todo")).ok()?;
    Some(if todo.trim_start().starts_with("revert") { Operation::Revert } else { Operation::CherryPick })
}

/// 충돌 한 파일을 어느 쪽으로 푸는가.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    /// 지금 브랜치(A, `--ours`).
    Ours,
    /// 들어오는 쪽(B, `--theirs`).
    Theirs,
    /// 작업 사본 그대로를 해결로 올린다(손으로 고친 뒤).
    AsIs,
}

/// 충돌 파일을 열 때 화면에 주는 것.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDocument {
    pub path: String,
    /// 텍스트 충돌이면 조각들. 바이너리·한쪽이 지운 충돌이면 None(한쪽 고르기만 된다).
    pub file: Option<ConflictFile>,
    /// 우리 쪽·들어오는 쪽이 파일을 지웠는가(DU·UD).
    pub ours_deleted: bool,
    pub theirs_deleted: bool,
    pub binary: bool,
    /// 작업 사본에서 충돌 표시를 지워 버려 인덱스의 세 판으로 다시 만들었다.
    pub recovered: bool,
}

impl Repository {
    pub fn operation(&self) -> Option<Operation> {
        detect(self.git_dir())
    }

    /// 충돌 파일 하나를 읽는다. 작업 사본에서 표시를 지워 버렸으면 인덱스의 세 판으로 표시를 다시 만든다.
    pub fn conflict(&self, path: &str) -> Result<ConflictDocument> {
        let st = self.status()?;
        let entry = st.unstaged.iter().find(|e| e.path == path && e.state == FileState::Conflicted);
        let (ours_deleted, theirs_deleted) = entry.map(|e| (e.index == 'D', e.worktree == 'D')).unwrap_or((false, false));
        let full = self.root().join(path);
        let bytes = std::fs::read(&full).unwrap_or_default();
        let binary = bytes.contains(&0);
        let mut file = None;
        let mut recovered = false;
        if !binary && !ours_deleted && !theirs_deleted {
            let text = String::from_utf8_lossy(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes)).into_owned();
            file = parse(&text);
            if file.is_none() {
                file = self.conflict_text_from_stages(path).and_then(|t| parse(&t));
                recovered = file.is_some();
            }
        }
        Ok(ConflictDocument { path: path.to_string(), file, ours_deleted, theirs_deleted, binary, recovered })
    }

    /// 인덱스의 세 판(:1 조상 :2 우리 :3 들어오는)을 `git merge-file` 로 다시 합쳐 충돌 표시가 든 글을 만든다.
    fn conflict_text_from_stages(&self, path: &str) -> Option<String> {
        let dir = std::env::temp_dir().join(format!("gitvcs-merge-{}", std::process::id()));
        std::fs::create_dir_all(&dir).ok()?;
        let result = (|| {
            let stage = |n: u32, name: &str| -> Option<std::path::PathBuf> {
                let out = self.git_run(&["show", &format!(":{n}:{path}")]).ok()?;
                let p = dir.join(name);
                std::fs::write(&p, out).ok()?;
                Some(p)
            };
            let ours = stage(2, "ours")?;
            let theirs = stage(3, "theirs")?;
            // 양쪽이 따로 새로 만든 파일(add/add)은 공통 조상이 없다 — 빈 파일로 본다.
            let base = stage(1, "base").unwrap_or_else(|| {
                let p = dir.join("base");
                let _ = std::fs::write(&p, "");
                p
            });
            let (o, b, t) = (ours.display().to_string(), base.display().to_string(), theirs.display().to_string());
            // 충돌이 있으면 그 개수를 종료 코드로 돌려준다(오류 아님).
            let _ = self.git_run(&["merge-file", "-L", "ours", "-L", "base", "-L", "theirs", &o, &b, &t]);
            std::fs::read_to_string(&ours).ok()
        })();
        let _ = std::fs::remove_dir_all(&dir);
        result.filter(|t| has_markers(t))
    }

    /// 한쪽으로 풀거나(우리·들어오는) 작업 사본 그대로를 해결로 올린다.
    pub fn resolve(&self, path: &str, side: Side) -> Result<()> {
        if side != Side::AsIs {
            let doc = self.conflict(path)?;
            let deleted = if side == Side::Ours { doc.ours_deleted } else { doc.theirs_deleted };
            if deleted {
                return self.git_run(&["rm", "--quiet", "--ignore-unmatch", "--", path]).map(|_| ());
            }
            self.git_run(&["checkout", if side == Side::Ours { "--ours" } else { "--theirs" }, "--", path])?;
        } else if std::fs::read_to_string(self.root().join(path)).map(|t| has_markers(&t)).unwrap_or(false) {
            return Err(GitError::new(format!("{path} 에 아직 충돌 표시(<<<<<<<)가 남아 있습니다.")));
        }
        // -A: 파일을 지워서 푼 경우도 해결로 올린다.
        self.git_run(&["add", "-A", "--", path]).map(|_| ())
    }

    /// 병합 편집기에서 만든 글을 파일에 쓰고 해결로 올린다.
    pub fn save_resolution(&self, path: &str, text: &str) -> Result<()> {
        if has_markers(text) {
            return Err(GitError::new("출력에 아직 충돌 표시(<<<<<<<)가 남아 있습니다. 모든 충돌을 고른 뒤 저장해 주세요."));
        }
        let relative = Path::new(path);
        if relative.is_absolute() || relative.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(GitError::new("저장소 밖의 경로입니다."));
        }
        std::fs::write(self.root().join(relative), text).map_err(|e| GitError::new(format!("{path} 를 쓰지 못했습니다: {e}")))?;
        self.git_run(&["add", "-A", "--", path]).map(|_| ())
    }

    /// 이어가기를 막는 까닭. 없으면 None.
    pub fn continue_blocker(&self) -> Result<Option<String>> {
        let Some(op) = self.operation() else {
            return Ok(Some("진행 중인 작업이 없습니다.".into()));
        };
        let st = self.status()?;
        if st.conflicted > 0 {
            return Ok(Some(format!("충돌 파일 {}개를 먼저 해결해 주세요.", st.conflicted)));
        }
        // rebase 는 Stage 하지 않은 변경이 있으면 엉뚱한 말로 거부한다 — 미리 알린다.
        if op == Operation::Rebase && st.unstaged.iter().any(|e| e.state != FileState::Untracked) {
            return Ok(Some("Stage 하지 않은 변경이 있습니다. Rebase 를 이어가려면 먼저 Stage 하거나 버려 주세요.".into()));
        }
        Ok(None)
    }

    /// 이어간다. 병합·cherry-pick·revert 는 Stage 한 내용으로 커밋하며 끝난다. 다음 커밋에서 또 충돌하면 오류로 알린다.
    pub fn continue_operation(&self) -> Result<String> {
        self.continue_with_message(None)
    }

    /// 이어간다. 병합·cherry-pick·revert 에 `message` 를 주면 그 메시지로 커밋한다(커밋 상자에서 고친 메시지).
    pub fn continue_with_message(&self, message: Option<&str>) -> Result<String> {
        if let Some(blocker) = self.continue_blocker()? {
            return Err(GitError::new(blocker));
        }
        let op = self.operation().expect("blocker 가 없으면 작업이 있다");
        if let Some(message) = message.filter(|m| !m.trim().is_empty())
            && op != Operation::Rebase
        {
            // MERGE_MSG 를 바꿔 두면 --continue 가 그 메시지로 커밋한다.
            std::fs::write(self.git_dir().join("MERGE_MSG"), format!("{}\n", message.trim_end()))
                .map_err(|e| GitError::new(format!("메시지를 쓰지 못했습니다: {e}")))?;
        }
        let out = self.git_run_with_env(&[op.verb(), "--continue"], &[("GIT_EDITOR", "true")]);
        self.explain_next_conflict(op, out)
    }

    pub fn skip_operation(&self) -> Result<String> {
        match self.operation() {
            Some(Operation::Rebase) => {
                let out = self.git_run(&["rebase", "--skip"]);
                self.explain_next_conflict(Operation::Rebase, out)
            }
            _ => Err(GitError::new("건너뛰기는 Rebase 중에만 할 수 있습니다.")),
        }
    }

    /// 취소해 시작 전 상태로 돌린다(rebase 의 autostash 한 변경도 돌아온다).
    pub fn abort_operation(&self) -> Result<()> {
        let op = self.operation().ok_or_else(|| GitError::new("진행 중인 작업이 없습니다."))?;
        self.git_run(&[op.verb(), "--abort"]).map(|_| ())
    }

    fn explain_next_conflict(&self, op: Operation, out: Result<String>) -> Result<String> {
        match out {
            Ok(text) => Ok(text),
            Err(e) if self.operation().is_some() && self.status().map(|s| s.conflicted > 0).unwrap_or(false) => {
                Err(GitError::new(format!("{} 을 이어가다 다음 커밋에서 또 충돌했습니다. 충돌을 풀고 다시 이어가 주세요.\n\n{}", op.display_name(), e.message)))
            }
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conflicts(file: &ConflictFile) -> Vec<&Segment> {
        file.segments.iter().filter(|s| matches!(s, Segment::Conflict { .. })).collect()
    }

    #[test]
    fn parses_two_way_conflict() {
        let text = "top\n<<<<<<< HEAD\nmine\n=======\ntheirs\ntheirs2\n>>>>>>> feature/x\nbottom\n";
        let f = parse(text).unwrap();
        assert_eq!(f.a_label, "HEAD");
        assert_eq!(f.b_label, "feature/x");
        assert_eq!(f.newline, "\n");
        assert!(f.ends_with_newline);
        assert_eq!(f.segments.len(), 3);
        assert_eq!(f.segments[0], Segment::Common { lines: vec!["top".into()] });
        assert_eq!(*conflicts(&f)[0], Segment::Conflict { a: vec!["mine".into()], base: vec![], b: vec!["theirs".into(), "theirs2".into()] });
    }

    #[test]
    fn parses_diff3_and_crlf() {
        let text = "<<<<<<< ours\r\na\r\n||||||| base\r\nbase\r\n=======\r\nb\r\n>>>>>>> theirs\r\nend";
        let f = parse(text).unwrap();
        assert_eq!(f.newline, "\r\n");
        assert!(!f.ends_with_newline);
        assert_eq!(*conflicts(&f)[0], Segment::Conflict { a: vec!["a".into()], base: vec!["base".into()], b: vec!["b".into()] });
        assert_eq!(f.segments[1], Segment::Common { lines: vec!["end".into()] });
    }

    #[test]
    fn unmatched_markers_are_text() {
        assert!(parse("a\n<<<<<<< HEAD\nb\n").is_none());
        assert!(parse("plain\n").is_none());
        // 표시처럼 보여도 여덟째 글자가 빈칸이 아니면 표시가 아니다.
        assert!(parse("<<<<<<<<\nx\n=======\ny\n>>>>>>>>\n").is_none());
        let f = parse("<<<<<<< A\nx\n=======\ny\n>>>>>>> B\n<<<<<<< dangling\nz\n").unwrap();
        assert_eq!(conflicts(&f).len(), 1);
        assert_eq!(f.segments[1], Segment::Common { lines: vec!["<<<<<<< dangling".into(), "z".into()] });
    }

    #[test]
    fn detects_operations() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path();
        assert_eq!(detect(g), None);
        std::fs::write(g.join("MERGE_HEAD"), "abc").unwrap();
        assert_eq!(detect(g), Some(Operation::Merge));
        std::fs::create_dir(g.join("rebase-merge")).unwrap();
        assert_eq!(detect(g), Some(Operation::Rebase));
        std::fs::remove_dir(g.join("rebase-merge")).unwrap();
        std::fs::remove_file(g.join("MERGE_HEAD")).unwrap();
        std::fs::create_dir(g.join("sequencer")).unwrap();
        std::fs::write(g.join("sequencer/todo"), "revert abc x\n").unwrap();
        assert_eq!(detect(g), Some(Operation::Revert));
        std::fs::write(g.join("CHERRY_PICK_HEAD"), "abc").unwrap();
        assert_eq!(detect(g), Some(Operation::CherryPick));
    }
}
