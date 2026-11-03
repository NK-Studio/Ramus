//! 커밋 그래프의 가지 배치. 원본 패키지 `Core/GitGraph.cs` 를 옮겼다.
//!
//! git 커밋에는 소속 브랜치가 없으므로, 정한 순서대로 브랜치 끝에서 첫 부모를 따라가며 아직 가지가 없는 커밋을 그 브랜치 가지에 넣는다.
//! 그래서 main 에서 갈라진 feature 는 갈라진 지점 이후만 feature 가지에 놓인다. 어느 브랜치에서도 첫 부모로 닿지 않는 커밋(병합 뒤 지워진
//! 브랜치)은 이름 없는 가지에 모으고, 병합 커밋 메시지에서 이름을 짐작한다.
//!
//! 세로 그래프(GitKraken)는 위(새 커밋)부터 차례로 열을 준다: 맨 위 끝 커밋의 브랜치가 맨 왼쪽 열과 줄기를 갖고, 작업 중 줄(WIP)이 있으면
//! 지금 브랜치가 맨 위 커밋처럼 먼저다. 가지마다 차지하는 기간이 겹치지 않으면 같은 열을 나눠 쓴다.
//!
//! 커밋은 `git log --date-order` 순서(자식이 늘 부모보다 앞)로 받는다. 안에서는 원본처럼 오래된 커밋부터 0 인 "칸"(column)으로 센다.

use std::collections::HashMap;

use regex::Regex;
use serde::Serialize;

use crate::log::{Commit, RefKind};

/// 병합 메시지에서 이름을 찾지 못한 가지의 이름.
pub const ANONYMOUS_LANE: &str = "(병합된 브랜치)";

/// 그래프를 만들 때 쓰는 브랜치 끝.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchTip {
    pub name: String,
    pub hash: String,
    pub remote: bool,
    pub current: bool,
    /// 유닉스 초(마지막 커밋 시각).
    pub time: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommitRefKind {
    /// 지금 체크아웃한 브랜치.
    Current,
    Local,
    Remote,
    Tag,
}

/// 그래프 줄의 이름표 하나.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRef {
    /// 동작에 쓰는 이름("origin/main", "v1.0").
    pub name: String,
    pub kind: CommitRefKind,
    /// 로컬(현재) 브랜치인데 같은 이름의 원격 브랜치도 이 커밋을 가리킨다 — 이름표 하나에 노트북과 구름을 함께.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub has_remote: bool,
}

impl CommitRef {
    /// 이름표에 보일 이름. 원격은 앞의 원격 이름을 뺀다("origin/feature/x" → "feature/x").
    pub fn display_name(&self) -> &str {
        if self.kind == CommitRefKind::Remote { without_remote(&self.name) } else { &self.name }
    }
}

/// "원격/브랜치" 에서 첫 마디를 뺀다. 마디가 하나면 그대로.
pub fn without_remote(name: &str) -> &str {
    match name.find('/') {
        Some(at) if at > 0 && at + 1 < name.len() => &name[at + 1..],
        _ => name,
    }
}

/// 가지 하나(브랜치 줄).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lane {
    pub name: String,
    /// 화면 열(0 = 맨 왼쪽). 기간이 겹치지 않는 가지끼리는 같은 열을 나눠 쓴다.
    pub column: usize,
    /// 색 번호(브랜치 이름에서 정한다). 화면이 팔레트 수로 나눈다.
    pub color: u32,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub remote: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub current: bool,
    /// 이름 있는 브랜치가 아니라 병합된 뒤 지워진 브랜치에서 온 가지.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub anonymous: bool,
    #[serde(skip)]
    first: usize,
    #[serde(skip)]
    last: usize,
}

/// 커밋 하나의 자리. 순서는 받은 커밋 순서(새 커밋이 앞)와 같다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    /// `lanes` 의 번호.
    pub lane: usize,
    /// 읽은 범위 밖의 첫 부모가 있다(아래로 짧은 흐린 선).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    /// 이 줄의 이름표: 지금 브랜치가 맨 앞, 나머지는 보이는 이름 순서.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub refs: Vec<CommitRef>,
}

/// 자식에서 부모로 가는 선. 둘 다 커밋 번호(새 커밋이 0).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub child: usize,
    pub parent: usize,
    /// 병합 커밋의 두 번째 이후 부모(다른 가지가 들어오는 선).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub merge: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLayout {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub lanes: Vec<Lane>,
    /// 열 수(적어도 1).
    pub lane_count: usize,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Options {
    /// 세로 그래프: 끝 커밋이 위에 있는 브랜치부터 열을 준다. false 면 main·지금 브랜치부터(가로 탐색기).
    pub top_down: bool,
    /// 지금 브랜치를 맨 위 커밋처럼 친다 — 작업 중 줄(WIP)이 그래프 맨 위에서 지금 브랜치에 이어질 때.
    pub head_first: bool,
}

/// 가지 색 번호. 브랜치 이름에서 정해 새 커밋·새 브랜치가 생겨도 같은 브랜치는 같은 색이다. 원격 "origin/x" 는 로컬 "x" 와 같은 색.
/// 원본(C#)의 32비트 문자열 해시와 같은 값을 낸다 — 두 앱에서 같은 저장소가 같은 색으로 보이게.
pub fn stable_color(name: &str, fallback: usize) -> u32 {
    if name.is_empty() {
        return fallback as u32;
    }
    let name = match name.strip_prefix("origin/") {
        Some(rest) => rest,
        None => name,
    };
    let mut hash: i32 = 17;
    for unit in name.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    (hash & 0x7fff_ffff) as u32
}

fn branch_priority(b: &BranchTip) -> u8 {
    let main = b.name == "main" || b.name == "master";
    if !b.remote && main {
        0
    } else if b.current {
        1
    } else if !b.remote {
        2
    } else if b.name.ends_with("/main") || b.name.ends_with("/master") {
        3
    } else {
        4
    }
}

struct Builder<'a> {
    commits: &'a [Commit],
    /// 해시 → 칸(오래된 커밋이 0).
    column_of: HashMap<&'a str, usize>,
    /// 칸마다 가지 번호.
    lane_of: Vec<Option<usize>>,
    lanes: Vec<Lane>,
}

impl<'a> Builder<'a> {
    fn n(&self) -> usize {
        self.commits.len()
    }

    /// 칸의 커밋.
    fn commit(&self, column: usize) -> &'a Commit {
        &self.commits[self.n() - 1 - column]
    }

    /// 끝 커밋부터 첫 부모를 따라가며 가지가 없는 커밋을 새 가지에 넣는다. 하나라도 넣으면 가지를 등록한다.
    fn walk_first_parents(&mut self, tip: &str, mut lane: Lane) {
        let index = self.lanes.len();
        let mut hash = Some(tip);
        lane.first = usize::MAX;
        let mut any = false;
        while let Some(h) = hash {
            let Some(&column) = self.column_of.get(h) else { break };
            if self.lane_of[column].is_some() {
                break;
            }
            self.lane_of[column] = Some(index);
            lane.first = lane.first.min(column);
            lane.last = lane.last.max(column);
            any = true;
            hash = self.commit(column).parents.first().map(String::as_str);
        }
        if any {
            lane.color = stable_color(&lane.name, index);
            self.lanes.push(lane);
        }
    }
}

fn new_lane(name: &str, remote: bool, current: bool, anonymous: bool) -> Lane {
    Lane { name: name.to_string(), column: 0, color: 0, remote, current, anonymous, first: usize::MAX, last: 0 }
}

/// 그래프를 만든다. `commits` 는 새 커밋이 앞(`git log --date-order`), `head` 는 HEAD 의 해시.
pub fn build(commits: &[Commit], branches: &[BranchTip], anonymous_name: &str, options: Options) -> GraphLayout {
    let n = commits.len();
    let mut b = Builder {
        commits,
        column_of: commits.iter().enumerate().map(|(row, c)| (c.hash.as_str(), n - 1 - row)).collect(),
        lane_of: vec![None; n],
        lanes: Vec::new(),
    };

    // 이름 있는 가지. 먼저 놓인 브랜치가 첫 부모를 따라가며 공통 조상(줄기)을 차지한다.
    let tip_column = |br: &BranchTip| b.column_of.get(br.hash.as_str()).map(|&c| c as i64).unwrap_or(-1);
    let mut ordered: Vec<&BranchTip> = branches.iter().filter(|br| !br.hash.is_empty()).collect();
    if options.top_down {
        ordered.sort_by_key(|br| (!(options.head_first && br.current && !br.remote), -tip_column(br), branch_priority(br)));
    } else {
        ordered.sort_by_key(|br| (branch_priority(br), -br.time));
    }
    for br in ordered {
        b.walk_first_parents(&br.hash, new_lane(&br.name, br.remote, br.current, false));
    }

    // 이름 없는 가지. 병합 커밋의 두 번째 부모 → 그 병합 커밋(이름을 병합 메시지에서 찾는다).
    let mut merged_into: HashMap<&str, usize> = HashMap::new();
    for column in 0..n {
        for parent in b.commit(column).parents.iter().skip(1) {
            merged_into.insert(parent.as_str(), column);
        }
    }
    let pattern = Regex::new(r"Merge (?:remote-tracking )?branch '([^']+)'").unwrap();
    // 새 커밋부터 보아야 병합된 가지의 끝에서 시작해 가지 전체가 한 줄에 들어간다.
    for column in (0..n).rev() {
        if b.lane_of[column].is_some() {
            continue;
        }
        let commit = b.commit(column);
        let name = merged_into
            .get(commit.hash.as_str())
            .and_then(|&m| pattern.captures(&b.commit(m).subject))
            .map(|c| c[1].to_string())
            .unwrap_or_else(|| anonymous_name.to_string());
        b.walk_first_parents(&commit.hash, new_lane(&name, false, false, true));
    }

    let lane_of: Vec<usize> = b.lane_of.iter().map(|l| l.unwrap_or(0)).collect();
    let column_of = &b.column_of;
    let mut lanes = b.lanes;

    // 선. 읽은 범위 밖의 첫 부모는 짧은 흐린 선으로만.
    let mut edges = Vec::new();
    let mut truncated = vec![false; n];
    for (row, commit) in commits.iter().enumerate() {
        for (p, parent) in commit.parents.iter().enumerate() {
            match column_of.get(parent.as_str()) {
                Some(&column) => edges.push(GraphEdge { child: row, parent: n - 1 - column, merge: p > 0 }),
                None if p == 0 => truncated[row] = true,
                None => {}
            }
        }
    }

    let lane_count = pack_columns(&mut lanes, &edges, &lane_of, n, options);

    let nodes = commits
        .iter()
        .enumerate()
        .map(|(row, commit)| {
            let column = n - 1 - row;
            let lane = lane_of[column];
            GraphNode { lane, truncated: truncated[row], refs: commit_refs(commit, &lanes[lane], column) }
        })
        .collect();
    GraphLayout { nodes, edges, lanes, lane_count }
}

/// 가지를 화면 열에 채운다. 정한 순서대로, 기간(+여백)이 겹치지 않는 가장 왼쪽 열에 놓는다. 열 수를 돌려준다.
fn pack_columns(lanes: &mut [Lane], edges: &[GraphEdge], lane_of: &[usize], n: usize, options: Options) -> usize {
    if lanes.is_empty() {
        return 1;
    }
    // 가지가 차지하는 기간. 갈라져 나온 부모·들어가는 병합 커밋 칸까지 친다 — 가지 선이 그 칸까지 그 열 위로 그어지므로,
    // 치지 않으면 짧은 가지가 같은 열을 나눠 써서 선이 남의 커밋을 뚫고 지나간다. 앞뒤로 한 칸 여유를 둔다.
    let mut spans: Vec<(i64, i64)> = lanes.iter().map(|l| (l.first as i64 - 1, l.last as i64 + 1)).collect();
    for edge in edges {
        let (child, parent) = (n - 1 - edge.child, n - 1 - edge.parent);
        let (lc, lp) = (lane_of[child], lane_of[parent]);
        if lc == lp {
            continue;
        }
        for lane in [lc, lp] {
            spans[lane] = (spans[lane].0.min(parent as i64), spans[lane].1.max(child as i64));
        }
    }
    let head_first = |l: &Lane| options.head_first && l.current && !l.remote;
    if options.top_down && options.head_first {
        // 작업 중 줄은 맨 위에 있고 지금 브랜치 끝까지 점선으로 이어진다 — 그 사이도 지금 브랜치 열이다.
        for (i, lane) in lanes.iter().enumerate() {
            if head_first(lane) {
                spans[i].1 = i64::MAX;
            }
        }
    }
    let mut order: Vec<usize> = (0..lanes.len()).collect();
    if options.top_down {
        order.sort_by_key(|&i| (!head_first(&lanes[i]), std::cmp::Reverse(lanes[i].last)));
    }
    let mut columns: Vec<Vec<usize>> = Vec::new();
    for i in order {
        let (start, end) = spans[i];
        let column = columns
            .iter()
            .position(|taken| !taken.iter().any(|&o| spans[o].0 <= end && start <= spans[o].1))
            .unwrap_or_else(|| {
                columns.push(Vec::new());
                columns.len() - 1
            });
        columns[column].push(i);
        lanes[i].column = column;
    }
    columns.len()
}

/// 줄에 보일 이름표(원본 `CommitRefs.Of`). 이 커밋이 끝인 가지 이름 + `%D` 의 다른 참조. 같은 이름의 로컬·원격은 하나로 합친다.
fn commit_refs(commit: &Commit, lane: &Lane, column: usize) -> Vec<CommitRef> {
    let tip = column == lane.last;
    let head_branch = commit.refs.iter().find(|r| r.kind == RefKind::Head).map(|r| r.name.as_str());
    let mut refs = Vec::new();
    if tip && !lane.anonymous {
        let kind = if lane.current { CommitRefKind::Current } else if lane.remote { CommitRefKind::Remote } else { CommitRefKind::Local };
        refs.push(CommitRef { name: lane.name.clone(), kind, has_remote: false });
    }
    for label in &commit.refs {
        let kind = match label.kind {
            RefKind::DetachedHead => continue,
            RefKind::Tag => CommitRefKind::Tag,
            _ if Some(label.name.as_str()) == head_branch => CommitRefKind::Current,
            RefKind::Remote => CommitRefKind::Remote,
            _ => CommitRefKind::Local,
        };
        // 가지 이름과 같은 브랜치는 가지 끝 이름표로 이미 나왔다.
        if kind != CommitRefKind::Tag && tip && label.name == lane.name {
            continue;
        }
        refs.push(CommitRef { name: label.name.clone(), kind, has_remote: false });
    }
    merge_remotes(&mut refs);
    refs.sort_by_key(|r| r.display_name().to_lowercase());
    if let Some(at) = refs.iter().position(|r| r.kind == CommitRefKind::Current) {
        let current = refs.remove(at);
        refs.insert(0, current);
    }
    refs
}

/// 로컬·현재 브랜치마다 같은 이름의 원격 참조를 지우고 그 로컬 이름표에 `has_remote` 를 켠다.
fn merge_remotes(refs: &mut Vec<CommitRef>) {
    let locals: Vec<String> =
        refs.iter().filter(|r| matches!(r.kind, CommitRefKind::Local | CommitRefKind::Current)).map(|r| r.name.clone()).collect();
    for local in locals {
        let before = refs.len();
        refs.retain(|r| !(r.kind == CommitRefKind::Remote && without_remote(&r.name) == local));
        if refs.len() != before
            && let Some(r) = refs.iter_mut().find(|r| r.name == local && r.kind != CommitRefKind::Remote)
        {
            r.has_remote = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::parse_refs;

    // 원본 Tests/Editor/GitGraphTests.cs 를 옮겼다. 커밋은 오래된 것부터 적고 build 에서 뒤집는다.

    fn commit(hash: &str, parents: &[&str]) -> Commit {
        with(hash, "", &format!("commit {hash}"), parents)
    }

    fn with(hash: &str, refs: &str, subject: &str, parents: &[&str]) -> Commit {
        Commit {
            hash: hash.into(),
            short_hash: hash.into(),
            parents: parents.iter().map(|p| p.to_string()).collect(),
            author_name: "tester".into(),
            author_email: "tester@example.com".into(),
            time: 0,
            refs: parse_refs(refs, &["origin".into()]),
            subject: subject.into(),
        }
    }

    fn branch(name: &str, hash: &str) -> BranchTip {
        BranchTip { name: name.into(), hash: hash.into(), remote: false, current: false, time: 0 }
    }

    fn remote(name: &str, hash: &str, days: i64) -> BranchTip {
        BranchTip { remote: true, time: days, ..branch(name, hash) }
    }

    fn local(name: &str, hash: &str, current: bool, days: i64) -> BranchTip {
        BranchTip { current, time: days, ..branch(name, hash) }
    }

    struct Built {
        g: GraphLayout,
        hashes: Vec<String>,
    }

    impl Built {
        fn row(&self, hash: &str) -> usize {
            self.hashes.iter().position(|h| h == hash).unwrap()
        }
        fn lane(&self, hash: &str) -> &Lane {
            &self.g.lanes[self.g.nodes[self.row(hash)].lane]
        }
        fn named(&self, name: &str) -> &Lane {
            self.g.lanes.iter().find(|l| l.name == name).unwrap()
        }
        fn node(&self, hash: &str) -> &GraphNode {
            &self.g.nodes[self.row(hash)]
        }
    }

    fn build_opts(oldest_first: Vec<Commit>, branches: &[BranchTip], options: Options) -> Built {
        let commits: Vec<Commit> = oldest_first.into_iter().rev().collect();
        let hashes = commits.iter().map(|c| c.hash.clone()).collect();
        Built { g: build(&commits, branches, ANONYMOUS_LANE, options), hashes }
    }

    fn build_(oldest_first: Vec<Commit>, branches: &[BranchTip]) -> Built {
        build_opts(oldest_first, branches, Options::default())
    }

    #[test]
    fn main_lane_takes_shared_history_before_current_branch() {
        // A ─ B ─ C (main)
        //      └─ F1 ─ F2 (feature, 현재·더 최근)
        let b = build_(
            vec![commit("A", &[]), commit("B", &["A"]), commit("F1", &["B"]), commit("F2", &["F1"]), commit("C", &["B"])],
            &[local("feature", "F2", true, 10), local("main", "C", false, 1)],
        );
        assert_eq!(b.g.lanes[0].name, "main");
        for h in ["A", "B", "C"] {
            assert_eq!(b.lane(h).name, "main");
        }
        assert_eq!(b.lane("F1").name, "feature");
        assert_eq!(b.lane("F2").name, "feature");
        let feature = b.named("feature");
        assert!(feature.current && !feature.anonymous);
        assert_eq!((feature.first, feature.last), (2, 3));
        assert_eq!(b.named("main").column, 0);
        assert_eq!(feature.column, 1);
    }

    #[test]
    fn master_is_preferred_over_other_local_branches() {
        let b = build_(vec![commit("A", &[]), commit("B", &["A"]), commit("X", &["B"])], &[local("aaa", "X", false, 10), local("master", "B", false, 1)]);
        assert_eq!(b.g.lanes[0].name, "master");
        assert_eq!(b.lane("A").name, "master");
        assert_eq!(b.lane("X").name, "aaa");
    }

    #[test]
    fn remote_main_does_not_steal_local_main_commits() {
        let b = build_(vec![commit("A", &[]), commit("B", &["A"]), commit("C", &["B"])], &[remote("origin/main", "C", 10), local("main", "B", false, 1)]);
        assert_eq!(b.lane("B").name, "main");
        assert_eq!(b.lane("A").name, "main");
        assert_eq!(b.lane("C").name, "origin/main");
        assert!(b.lane("C").remote);
    }

    #[test]
    fn branch_without_new_commits_has_no_lane() {
        let b = build_(vec![commit("A", &[]), commit("B", &["A"])], &[branch("main", "B"), remote("origin/main", "A", 0)]);
        assert_eq!(b.g.lanes.len(), 1);
        assert_eq!(b.g.lanes[0].name, "main");
    }

    #[test]
    fn branch_without_hash_is_ignored() {
        let b = build_(vec![commit("A", &[])], &[branch("main", "")]);
        assert_eq!(b.g.lanes.len(), 1);
        assert!(b.g.lanes[0].anonymous);
    }

    #[test]
    fn deleted_merged_branch_name_is_guessed_from_merge_message() {
        let cases = [
            ("Merge branch 'feature/old'", "feature/old"),
            ("Merge branch 'hotfix' into main", "hotfix"),
            ("Merge remote-tracking branch 'origin/dev'", "origin/dev"),
            ("Merge pull request #12 from someone/topic", ANONYMOUS_LANE),
        ];
        for (subject, expected) in cases {
            // A ─ B ───── M (main)
            //  └ X1 ─ X2 ┘ (지워진 브랜치)
            let b = build_(
                vec![commit("A", &[]), commit("X1", &["A"]), commit("X2", &["X1"]), commit("B", &["A"]), with("M", "", subject, &["B", "X2"])],
                &[branch("main", "M")],
            );
            assert_eq!(b.lane("X2"), b.lane("X1"));
            assert!(b.lane("X2").anonymous);
            assert_eq!(b.lane("X2").name, expected, "{subject}");
            assert_eq!(b.g.lanes.len(), 2);
            let (m, x2, bb) = (b.row("M"), b.row("X2"), b.row("B"));
            assert!(b.g.edges.iter().any(|e| e.child == m && e.parent == x2 && e.merge));
            assert!(b.g.edges.iter().any(|e| e.child == m && e.parent == bb && !e.merge));
        }
    }

    #[test]
    fn unmerged_orphan_commit_gets_default_name() {
        let b = build_(vec![commit("A", &[]), commit("Z", &["A"]), commit("B", &["A"])], &[branch("main", "B")]);
        assert!(b.lane("Z").anonymous);
        assert_eq!(b.lane("Z").name, ANONYMOUS_LANE);
    }

    #[test]
    fn non_overlapping_lanes_share_column() {
        let b = build_(
            vec![
                commit("A", &[]), commit("a1", &["A"]), commit("a2", &["a1"]), commit("B", &["A"]), commit("C", &["B"]),
                commit("D", &["C"]), commit("b1", &["D"]), commit("b2", &["b1"]), commit("E", &["D"]),
            ],
            &[branch("main", "E"), local("feature/a", "a2", false, 2), local("feature/b", "b2", false, 1)],
        );
        assert_eq!(b.named("feature/a").column, 1);
        assert_eq!(b.named("feature/b").column, 1);
        assert_eq!(b.g.lane_count, 2);
    }

    #[test]
    fn lanes_within_margin_do_not_share_column() {
        let b = build_(
            vec![commit("A", &[]), commit("a1", &["A"]), commit("a2", &["a1"]), commit("B", &["A"]), commit("c1", &["B"]), commit("c2", &["c1"]), commit("C", &["B"])],
            &[branch("main", "C"), local("feature/a", "a2", false, 2), local("feature/c", "c2", false, 1)],
        );
        assert_eq!(b.named("feature/a").column, 1);
        assert_eq!(b.named("feature/c").column, 2);
        assert_eq!(b.g.lane_count, 3);
    }

    #[test]
    fn first_parent_outside_range_is_truncated() {
        let b = build_(vec![commit("A", &["old"]), commit("B", &["A"]), commit("M", &["B", "gone"]), commit("R", &[])], &[branch("main", "M")]);
        assert!(b.node("A").truncated);
        assert!(!b.node("M").truncated && !b.node("B").truncated && !b.node("R").truncated);
        assert_eq!(b.g.edges.len(), 2);
    }

    #[test]
    fn refs_skip_lane_name_at_tip_and_merge_remotes() {
        let b = build_(
            vec![
                commit("A", &[]),
                with("B", "origin/main, tag: v0.1", "b", &["A"]),
                with("C", "HEAD -> main, origin/HEAD, tag: v1.0, release, origin/release", "c", &["B"]),
            ],
            &[local("main", "C", true, 0), remote("origin/main", "B", 0)],
        );
        let names = |h: &str| b.node(h).refs.iter().map(|r| (r.name.as_str(), r.kind, r.has_remote)).collect::<Vec<_>>();
        assert_eq!(names("C"), vec![("main", CommitRefKind::Current, false), ("release", CommitRefKind::Local, true), ("v1.0", CommitRefKind::Tag, false)]);
        assert_eq!(names("B"), vec![("origin/main", CommitRefKind::Remote, false), ("v0.1", CommitRefKind::Tag, false)]);
        assert!(b.node("A").refs.is_empty());
    }

    #[test]
    fn lane_name_before_tip_is_kept() {
        let b = build_(vec![commit("A", &[]), with("B", "main", "b", &["A"]), commit("C", &["B"])], &[branch("main", "C")]);
        assert_eq!(b.node("B").refs.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["main"]);
    }

    #[test]
    fn detached_head_is_not_labeled() {
        let b = build_(vec![commit("A", &[]), with("B", "HEAD", "b", &["A"])], &[branch("main", "A")]);
        assert!(b.node("B").refs.is_empty());
    }

    #[test]
    fn top_down_head_first_puts_current_lane_in_first_column() {
        let top = Options { top_down: true, head_first: true };
        let b = build_opts(
            vec![commit("A", &[]), commit("B", &["A"]), commit("C", &["B"]), commit("D", &["C"]), commit("E", &["D"]), commit("F", &["D"])],
            &[local("master", "B", false, 1), local("current", "E", true, 5), local("feature", "F", false, 4)],
            top,
        );
        assert_eq!(b.named("current").column, 0);
        assert_eq!(b.lane("C").name, "current");
        assert_ne!(b.named("feature").column, 0);
    }

    #[test]
    fn top_down_head_first_keeps_column_free_above_current_tip() {
        let top = Options { top_down: true, head_first: true };
        let b = build_opts(
            vec![commit("A", &[]), commit("B", &["A"]), commit("C", &["B"]), commit("D", &["B"]), commit("E", &["D"])],
            &[local("current", "C", true, 3), local("develop", "E", false, 1)],
            top,
        );
        assert_eq!(b.named("current").column, 0);
        assert_ne!(b.named("develop").column, 0);
    }

    #[test]
    fn top_down_topmost_tip_takes_first_column_and_trunk() {
        let b = build_opts(
            vec![commit("A", &[]), commit("B", &["A"]), commit("C", &["B"]), commit("D", &["C"]), commit("E", &["B"])],
            &[local("current", "D", true, 2), local("feature", "E", false, 1)],
            Options { top_down: true, head_first: false },
        );
        assert_eq!(b.named("feature").column, 0);
        assert_eq!(b.lane("B").name, "feature");
        assert_eq!(b.named("current").column, 1);
    }

    #[test]
    fn color_follows_branch_name_and_remote_shares_it() {
        assert_eq!(stable_color("origin/main", 0), stable_color("main", 5));
        assert_ne!(stable_color("upstream/main", 0), stable_color("main", 0));
        assert_eq!(stable_color("", 3), 3);
        // 원본 C# 의 해시와 같은 값(17*31+'a' = 624).
        assert_eq!(stable_color("a", 0), 624);
    }
}
