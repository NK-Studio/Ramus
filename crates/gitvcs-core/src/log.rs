//! 히스토리 조회. 출력 구분자로 제어 문자(0x1E 레코드, 0x1F 필드)를 써서 커밋 메시지의 어떤 글자와도 섞이지 않게 한다.

use serde::Serialize;

pub const LOG_FORMAT: &str = "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// 유닉스 초.
    pub time: i64,
    pub refs: Vec<RefLabel>,
    pub subject: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    /// HEAD 가 가리키는 로컬 브랜치(`HEAD -> main`).
    Head,
    Local,
    Remote,
    Tag,
    /// 브랜치 없이 떨어진 HEAD.
    DetachedHead,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub kind: RefKind,
    pub name: String,
}

/// `%D` ("HEAD -> main, origin/main, tag: v1.0") 를 이름표로 나눈다. `remotes` 는 `git remote` 의 이름들 — 원격 브랜치를 알아본다.
pub fn parse_refs(decoration: &str, remotes: &[String]) -> Vec<RefLabel> {
    let mut labels = Vec::new();
    for part in decoration.split(", ").map(str::trim).filter(|p| !p.is_empty()) {
        if let Some(name) = part.strip_prefix("HEAD -> ") {
            labels.push(RefLabel { kind: RefKind::Head, name: name.to_string() });
        } else if part == "HEAD" {
            labels.push(RefLabel { kind: RefKind::DetachedHead, name: "HEAD".into() });
        } else if let Some(name) = part.strip_prefix("tag: ") {
            labels.push(RefLabel { kind: RefKind::Tag, name: name.to_string() });
        } else if remotes.iter().any(|r| part.len() > r.len() && part.starts_with(r.as_str()) && part.as_bytes()[r.len()] == b'/') {
            // origin/HEAD 는 원격의 기본 브랜치 표시일 뿐이라 그리지 않는다.
            if !part.ends_with("/HEAD") {
                labels.push(RefLabel { kind: RefKind::Remote, name: part.to_string() });
            }
        } else {
            labels.push(RefLabel { kind: RefKind::Local, name: part.to_string() });
        }
    }
    labels
}

pub fn parse_commits(output: &str, remotes: &[String]) -> Vec<Commit> {
    output
        .split('\x1e')
        .filter_map(|record| {
            let record = record.trim_start_matches(['\n', '\r']);
            if record.is_empty() {
                return None;
            }
            let f: Vec<&str> = record.splitn(8, '\x1f').collect();
            if f.len() < 8 {
                return None;
            }
            Some(Commit {
                hash: f[0].to_string(),
                short_hash: f[1].to_string(),
                parents: f[2].split_whitespace().map(str::to_string).collect(),
                author_name: f[3].to_string(),
                author_email: f[4].to_string(),
                time: f[5].trim().parse().unwrap_or(0),
                refs: parse_refs(f[6], remotes),
                subject: f[7].trim_end().to_string(),
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// A, M, D, R, C, T 중 하나.
    pub status: char,
    pub path: String,
    pub original_path: Option<String>,
}

/// `--name-status -z` 출력. 이름 변경은 "R100\0옛경로\0새경로\0".
pub fn parse_name_status(output: &str) -> Vec<FileChange> {
    let parts: Vec<&str> = output.split('\0').collect();
    let mut files = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        let code = parts[i].trim();
        i += 1;
        let Some(status) = code.chars().next() else { continue };
        if (status == 'R' || status == 'C') && i + 1 < parts.len() {
            files.push(FileChange { status, path: parts[i + 1].to_string(), original_path: Some(parts[i].to_string()) });
            i += 2;
        } else if i < parts.len() {
            files.push(FileChange { status, path: parts[i].to_string(), original_path: None });
            i += 1;
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remotes() -> Vec<String> {
        vec!["origin".into(), "upstream".into()]
    }

    #[test]
    fn parses_refs() {
        let refs = parse_refs("HEAD -> main, origin/main, origin/HEAD, tag: v1.0, feature/x, upstream/dev", &remotes());
        assert_eq!(
            refs,
            vec![
                RefLabel { kind: RefKind::Head, name: "main".into() },
                RefLabel { kind: RefKind::Remote, name: "origin/main".into() },
                RefLabel { kind: RefKind::Tag, name: "v1.0".into() },
                RefLabel { kind: RefKind::Local, name: "feature/x".into() },
                RefLabel { kind: RefKind::Remote, name: "upstream/dev".into() },
            ]
        );
        // 원격 이름으로 시작하지만 '/' 가 없으면 로컬 브랜치.
        assert_eq!(parse_refs("originals", &remotes())[0].kind, RefKind::Local);
        assert_eq!(parse_refs("HEAD", &remotes())[0].kind, RefKind::DetachedHead);
        assert!(parse_refs("", &remotes()).is_empty());
    }

    #[test]
    fn parses_commits() {
        let out = "aaaa\x1faa\x1fbbbb cccc\x1f김한용\x1fme@x.com\x1f1700000000\x1fHEAD -> main\x1fMerge: 한글 제목 | with \x1f chars\x1e\n\
                   bbbb\x1fbb\x1f\x1fA\x1fa@x\x1f1600000000\x1f\x1froot\x1e\n";
        let c = parse_commits(out, &remotes());
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].parents, vec!["bbbb", "cccc"]);
        assert_eq!(c[0].author_name, "김한용");
        assert_eq!(c[0].time, 1700000000);
        assert_eq!(c[0].subject, "Merge: 한글 제목 | with \x1f chars");
        assert_eq!(c[0].refs[0].kind, RefKind::Head);
        assert!(c[1].parents.is_empty());
        assert!(c[1].refs.is_empty());
    }

    #[test]
    fn parses_name_status() {
        let out = "M\0a.txt\0R100\0old.txt\0new.txt\0D\0한글.txt\0";
        let f = parse_name_status(out);
        assert_eq!(f.len(), 3);
        assert_eq!(f[1].status, 'R');
        assert_eq!(f[1].path, "new.txt");
        assert_eq!(f[1].original_path.as_deref(), Some("old.txt"));
        assert_eq!(f[2].path, "한글.txt");
    }
}
