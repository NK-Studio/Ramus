// 변경 목록의 숨기기 규칙. 보기에서만 감추는 것이라 git(.gitignore·인덱스)은 건드리지 않는다.
// 규칙은 경로 글자열의 목록이다 — 파일 경로와 폴더 경로를 가리지 않고, 경로 자신이나 위 폴더가 규칙에 있으면 숨긴다.
// 화면 요소를 건드리지 않아 node 로 시험한다(tests/ui/hidden.test.mjs).

/** 설정(ui 맵)에 남기는 키. 레포지토리 뿌리 경로마다 따로라 워크트리도 저마다 따로 가진다. */
export const hiddenKey = (repoPath) => `staging.hidden:${repoPath}`;

const under = (path, folder) => path.startsWith(`${folder}/`);
const covers = (rule, path) => rule === path || under(path, rule);

/** 숨긴 경로인가: 경로 자신이나 위 폴더가 규칙(Set)에 있다. */
export function isHidden(path, ruleSet) {
  if (!ruleSet.size) return false;
  if (ruleSet.has(path)) return true;
  for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) if (ruleSet.has(path.slice(0, i))) return true;
  return false;
}

/** 줄(파일·폴더)이 통째로 숨겨졌는가: 규칙에 걸렸거나, 폴더라면 그 아래 바뀐 파일이 하나도 빠짐없이 숨겨졌다. */
export function isAllHidden(path, ruleSet, entries) {
  if (isHidden(path, ruleSet)) return true;
  const inside = entries.filter((e) => under(e.path, path));
  return inside.length > 0 && inside.every((e) => isHidden(e.path, ruleSet));
}

/** 위 폴더가 이미 규칙에 있는 규칙과 겹친 규칙을 뺀다. */
function tidy(rules) {
  const unique = [...new Set(rules)];
  return unique.filter((rule) => !unique.some((other) => other !== rule && under(rule, other)));
}

/** 숨긴다: 경로들을 규칙에 더한다. 폴더를 숨기면 그 아래 있던 규칙은 필요 없으니 뺀다. */
export function hidePaths(rules, paths) {
  return tidy([...rules, ...paths]);
}

/**
 * keep(남길 경로들)을 뺀 나머지를 가리는 가장 얕은 경로들. base 가 있으면 그 폴더 아래만 본다.
 * 예: 파일이 a/b/x, a/b/y, a/c/z 이고 a/b/x 를 남기면 → a/b/y, a/c (a/c 는 폴더째).
 */
function siblings(entries, keep, base = '') {
  const out = new Set();
  for (const { path } of entries) {
    if (base && !under(path, base)) continue;
    if (keep.some((k) => covers(k, path))) continue;
    // 남길 경로로 내려가는 길에 있지 않은 첫 단계. 파일 자신까지 내려가면 그 파일 하나다.
    const parts = path.split('/');
    for (let depth = base ? base.split('/').length + 1 : 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/');
      if (keep.some((k) => covers(prefix, k))) continue;
      out.add(prefix);
      break;
    }
  }
  return [...out];
}

/**
 * 다시 보인다: 그 경로와 그 아래 규칙을 지운다. 위 폴더가 통째로 숨겨져 있었다면 그 규칙을 풀고,
 * 그 폴더 아래 나머지(같은 단계의 다른 폴더·파일)는 계속 숨기도록 규칙으로 바꿔 넣는다. entries: 지금 바뀐 파일 전부.
 */
export function showPath(rules, path, entries) {
  const kept = rules.filter((rule) => !covers(path, rule));
  const next = [];
  for (const rule of kept) {
    if (under(path, rule)) next.push(...siblings(entries, [path], rule));
    else next.push(rule);
  }
  return tidy(next);
}

/**
 * 이것만 보기: targets(파일·폴더 경로)만 남기고, 지금 보이는 나머지를 모두 숨긴다. 숨겨져 있던 target 은 먼저 다시 보인다.
 * 그때 있던 것만 숨기므로 나중에 다른 곳에 새로 생긴 변경은 보인다.
 */
export function soloRules(rules, entries, targets) {
  const base = targets.reduce((acc, target) => showPath(acc, target, entries), rules);
  const baseSet = new Set(base);
  const visible = entries.filter((e) => !isHidden(e.path, baseSet));
  return tidy([...base, ...siblings(visible, targets)]);
}
