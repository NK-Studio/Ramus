//! GitKraken 처럼 커밋을 위(최신)에서 아래(과거)로 한 줄씩 놓는 세로 그래프의 열 배치.
//!
//! 커밋은 `git log --date-order` 순서(자식이 부모보다 먼저)로 받는다. 위에서부터 내려가며 "다음에 이 열에 올 커밋" 을 기억해 두고,
//! 커밋이 오면 그 커밋을 기다리던 첫 열에 놓는다. 첫 부모는 같은 열을 이어 쓰고, 다른 부모(병합)는 빈 열을 새로 받는다.
//! 열은 비워도 당기지 않는다 — 옆 가지 선이 줄마다 옮겨 다니지 않게.

use serde::Serialize;

use crate::log::Commit;

/// 한 커밋의 자리.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub row: usize,
    pub lane: usize,
    pub color: usize,
}

/// 자식에서 부모로 가는 선 하나. `points` 는 (줄, 열) — 위에서 아래로. 첫 점이 자식, 마지막 점이 부모(또는 목록 밖으로 나가는 끝).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub points: Vec<(usize, usize)>,
    pub color: usize,
    /// 병합 커밋의 두 번째 이후 부모로 가는 선.
    pub merge: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLayout {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub lane_count: usize,
}

/// 진행 중인 선: 어느 줄·열의 커밋에서 나와 어느 부모를 기다리는가.
struct Pending {
    parent: String,
    from: (usize, usize),
    color: usize,
    merge: bool,
}

pub fn layout(commits: &[Commit]) -> GraphLayout {
    // 열마다 지금 내려오는 선들(같은 부모를 기다리는 선이 한 열에 모일 수 있다).
    let mut lanes: Vec<Vec<Pending>> = Vec::new();
    let mut lane_color: Vec<usize> = Vec::new();
    let mut next_color = 0usize;
    let mut out = GraphLayout::default();

    let mut take_free_lane = |lanes: &mut Vec<Vec<Pending>>, lane_color: &mut Vec<usize>, skip: Option<usize>| -> usize {
        let free = lanes.iter().enumerate().position(|(i, l)| l.is_empty() && Some(i) != skip);
        let lane = free.unwrap_or_else(|| {
            lanes.push(Vec::new());
            lane_color.push(0);
            lanes.len() - 1
        });
        lane_color[lane] = next_color;
        next_color += 1;
        lane
    };

    for (row, commit) in commits.iter().enumerate() {
        // 이 커밋을 기다리던 첫 열. 없으면(가지 끝) 빈 열을 받는다.
        let lane = lanes.iter().position(|l| l.iter().any(|p| p.parent == commit.hash));
        let lane = match lane {
            Some(lane) => lane,
            None => take_free_lane(&mut lanes, &mut lane_color, None),
        };
        let color = lane_color[lane];
        out.nodes.push(GraphNode { row, lane, color });

        // 이 커밋을 기다리던 선을 모두 여기서 끝낸다: 자기 열을 따라 내려오다 이 줄에서 커밋으로 꺾인다.
        for (l, pending) in lanes.iter_mut().enumerate() {
            let (done, keep): (Vec<Pending>, Vec<Pending>) = pending.drain(..).partition(|p| p.parent == commit.hash);
            *pending = keep;
            for p in done {
                out.edges.push(finish_edge(p, l, row, lane));
            }
        }

        // 부모들로 선을 낸다.
        for (i, parent) in commit.parents.iter().enumerate() {
            if i == 0 {
                lanes[lane].push(Pending { parent: parent.clone(), from: (row, lane), color, merge: false });
                continue;
            }
            // 이미 다른 열이 이 부모를 기다리면 그 열로 합친다. 아니면 새 열.
            let target = lanes.iter().position(|l| l.iter().any(|p| p.parent == *parent));
            let target = match target {
                Some(t) => t,
                None => take_free_lane(&mut lanes, &mut lane_color, Some(lane)),
            };
            let merge_color = lane_color[target];
            lanes[target].push(Pending { parent: parent.clone(), from: (row, lane), color: merge_color, merge: true });
        }
        out.lane_count = out.lane_count.max(lanes.len());
        // 오른쪽 끝의 빈 열은 버린다(다음 가지가 너무 멀리 생기지 않게).
        while lanes.last().is_some_and(Vec::is_empty) {
            lanes.pop();
            lane_color.pop();
        }
    }

    // 목록 밖(아직 안 읽은 커밋)으로 나가는 선은 마지막 줄 아래까지 그린다.
    let end = commits.len();
    for (l, pending) in lanes.into_iter().enumerate() {
        for p in pending {
            out.edges.push(finish_edge(p, l, end, l));
        }
    }
    out.lane_count = out.lane_count.max(1);
    out
}

/// 선의 점들: 자식 → (다음 줄에서 자기 열로 꺾임) → 자기 열을 따라 → 부모 줄에서 부모 열로.
fn finish_edge(p: Pending, lane: usize, parent_row: usize, parent_lane: usize) -> GraphEdge {
    let (row, from_lane) = p.from;
    let mut points = vec![(row, from_lane)];
    if parent_row > row + 1 {
        if lane != from_lane {
            points.push((row + 1, lane));
        }
        if lane != parent_lane {
            points.push((parent_row - 1, lane));
        }
    }
    points.push((parent_row, parent_lane));
    points.dedup();
    GraphEdge { points, color: p.color, merge: p.merge }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(hash: &str, parents: &[&str]) -> Commit {
        Commit {
            hash: hash.into(),
            short_hash: hash.into(),
            parents: parents.iter().map(|p| p.to_string()).collect(),
            author_name: String::new(),
            author_email: String::new(),
            time: 0,
            refs: Vec::new(),
            subject: String::new(),
        }
    }

    fn lanes(g: &GraphLayout) -> Vec<usize> {
        g.nodes.iter().map(|n| n.lane).collect()
    }

    #[test]
    fn straight_line() {
        let g = layout(&[c("c", &["b"]), c("b", &["a"]), c("a", &[])]);
        assert_eq!(lanes(&g), vec![0, 0, 0]);
        assert_eq!(g.lane_count, 1);
        assert_eq!(g.edges.len(), 2);
        assert_eq!(g.edges[0].points, vec![(0, 0), (1, 0)]);
    }

    #[test]
    fn merge_and_branch() {
        //  m      (main, 병합)
        //  | f    (feature)
        //  b |
        //  |/
        //  a
        let g = layout(&[c("m", &["b", "f"]), c("f", &["a"]), c("b", &["a"]), c("a", &[])]);
        assert_eq!(lanes(&g), vec![0, 1, 0, 0]);
        assert_eq!(g.lane_count, 2);
        let merge = g.edges.iter().find(|e| e.merge).unwrap();
        assert_eq!(merge.points, vec![(0, 0), (1, 1)]);
        // feature 의 선은 자기 열을 따라 내려오다 a 에서 꺾인다.
        let f_to_a = g.edges.iter().find(|e| e.points[0] == (1, 1)).unwrap();
        assert_eq!(f_to_a.points, vec![(1, 1), (2, 1), (3, 0)]);
    }

    #[test]
    fn two_heads_share_parent() {
        // 두 가지 끝(x, y)이 같은 부모를 둔다.
        let g = layout(&[c("x", &["a"]), c("y", &["a"]), c("a", &[])]);
        assert_eq!(lanes(&g), vec![0, 1, 0]);
        assert_ne!(g.nodes[0].color, g.nodes[1].color);
    }

    #[test]
    fn freed_lane_is_reused() {
        // 가지가 끝나 빈 열은 다음 가지가 다시 쓴다.
        let g = layout(&[
            c("m2", &["m1", "f2"]),
            c("f2", &["m1"]),
            c("m1", &["r", "g"]),
            c("g", &["r"]),
            c("r", &[]),
        ]);
        assert_eq!(lanes(&g), vec![0, 1, 0, 1, 0]);
        assert_eq!(g.lane_count, 2);
    }

    #[test]
    fn edges_leaving_the_list_go_to_the_end() {
        let g = layout(&[c("b", &["a"])]);
        assert_eq!(g.edges.len(), 1);
        assert_eq!(g.edges[0].points, vec![(0, 0), (1, 0)]);
    }
}
