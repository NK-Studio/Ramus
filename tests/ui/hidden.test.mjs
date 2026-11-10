// ui/hidden.js 시험: 변경 목록의 숨기기 규칙. 저장소 뿌리에서 `node tests/ui/hidden.test.mjs` 로 돌린다.
import assert from 'node:assert/strict';
import { hiddenKey, isHidden, isAllHidden, hidePaths, showPath, soloRules } from '../../ui/hidden.js';

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push([name, null]);
  } catch (error) {
    results.push([name, error]);
  }
}

const entries = (...paths) => paths.map((path) => ({ path }));
const visible = (rules, files) => files.filter((e) => !isHidden(e.path, new Set(rules))).map((e) => e.path);
const sorted = (xs) => [...xs].sort();

const FILES = entries(
  'Assets/3rdParty/I2/Localization/PlayMaker.meta',
  'Assets/3rdParty/I2/Localization/Tests.meta',
  'Assets/3rdParty/Other/readme.md',
  'Assets/AddressableAssets/a.asset',
  'Assets/Scripts/Player.cs',
  'Packages/manifest.json',
  'README.md',
);

test('key_IsPerRepository', () => {
  assert.equal(hiddenKey('/work/repo'), 'staging.hidden:/work/repo');
  assert.notEqual(hiddenKey('/work/repo'), hiddenKey('/work/repo-worktree'));
});

test('isHidden_MatchesFileAndFolderRules', () => {
  const rules = new Set(['Assets/3rdParty', 'README.md']);
  assert.equal(isHidden('README.md', rules), true);
  assert.equal(isHidden('Assets/3rdParty/I2/Localization/Tests.meta', rules), true);
  assert.equal(isHidden('Assets/Scripts/Player.cs', rules), false);
  assert.equal(isHidden('README.md', new Set()), false);
});

test('isHidden_FolderRuleDoesNotMatchNamePrefix', () => {
  // a/b 를 숨겨도 이름 앞부분만 같은 a/bc 는 숨기지 않는다.
  const rules = new Set(['a/b']);
  assert.equal(isHidden('a/b/x.txt', rules), true);
  assert.equal(isHidden('a/bc/x.txt', rules), false);
  assert.equal(isHidden('a/b.txt', rules), false);
});

test('isAllHidden_FolderWithEveryFileHidden', () => {
  const rules = new Set(['Assets/3rdParty/I2', 'Assets/3rdParty/Other/readme.md']);
  // 폴더 규칙은 없지만 아래 파일이 모두 숨겨진 폴더.
  assert.equal(isAllHidden('Assets/3rdParty', rules, FILES), true);
  assert.equal(isAllHidden('Assets/3rdParty/Other', rules, FILES), true);
  assert.equal(isAllHidden('Assets', rules, FILES), false);
  assert.equal(isAllHidden('Assets/Scripts/Player.cs', rules, FILES), false);
});

test('hide_FolderRuleAbsorbsRulesBelow', () => {
  const rules = hidePaths(['Assets/3rdParty/I2/Localization/Tests.meta', 'README.md'], ['Assets/3rdParty']);
  assert.deepEqual(sorted(rules), ['Assets/3rdParty', 'README.md']);
});

test('hide_SkipsPathsAlreadyCovered', () => {
  const rules = hidePaths(['Assets/3rdParty'], ['Assets/3rdParty/Other/readme.md', 'Assets/3rdParty']);
  assert.deepEqual(rules, ['Assets/3rdParty']);
});

test('show_RemovesRuleAndRulesBelow', () => {
  const rules = showPath(['Assets/3rdParty/I2', 'Assets/3rdParty/Other/readme.md', 'README.md'], 'Assets/3rdParty', FILES);
  assert.deepEqual(rules, ['README.md']);
});

test('show_OneFileUnderHiddenFolderKeepsSiblingsHidden', () => {
  const target = 'Assets/3rdParty/I2/Localization/Tests.meta';
  const rules = showPath(['Assets/3rdParty'], target, FILES);
  // 같은 폴더의 다른 파일과, 길 옆의 다른 폴더(Other)는 계속 숨긴다.
  assert.deepEqual(sorted(rules), ['Assets/3rdParty/I2/Localization/PlayMaker.meta', 'Assets/3rdParty/Other']);
  assert.deepEqual(visible(rules, FILES).filter((p) => p.startsWith('Assets/3rdParty/')), [target]);
});

test('show_FolderUnderHiddenFolder', () => {
  const rules = showPath(['Assets'], 'Assets/3rdParty/I2', FILES);
  assert.deepEqual(sorted(rules), ['Assets/3rdParty/Other', 'Assets/AddressableAssets', 'Assets/Scripts']);
});

test('show_PathThatIsNotHiddenChangesNothing', () => {
  assert.deepEqual(showPath(['README.md'], 'Assets/Scripts', FILES), ['README.md']);
});

test('solo_HidesShallowestSiblingsOnly', () => {
  const rules = soloRules([], FILES, ['Assets/3rdParty/I2']);
  // 폴더는 폴더째, 파일은 파일 하나로 — 가장 얕은 단계에서 가린다.
  assert.deepEqual(sorted(rules), ['Assets/3rdParty/Other', 'Assets/AddressableAssets', 'Assets/Scripts', 'Packages', 'README.md']);
  assert.deepEqual(visible(rules, FILES), ['Assets/3rdParty/I2/Localization/PlayMaker.meta', 'Assets/3rdParty/I2/Localization/Tests.meta']);
});

test('solo_KeepsSeveralTargets', () => {
  const rules = soloRules([], FILES, ['Assets/Scripts/Player.cs', 'README.md']);
  assert.deepEqual(visible(rules, FILES), ['Assets/Scripts/Player.cs', 'README.md']);
});

test('solo_KeepsEarlierRulesAndRevealsHiddenTarget', () => {
  // README.md 는 이미 숨겨져 있었고, 숨겨진 폴더 안의 파일을 "이것만 보기" 한다.
  const target = 'Assets/3rdParty/Other/readme.md';
  const rules = soloRules(['README.md', 'Assets/3rdParty'], FILES, [target]);
  assert.deepEqual(visible(rules, FILES), [target]);
  assert.ok(rules.includes('README.md'));
});

test('solo_NewChangesElsewhereStayVisible', () => {
  const rules = soloRules([], FILES, ['Assets/Scripts']);
  const later = [...FILES, ...entries('Docs/new.md', 'Assets/Scripts/Enemy.cs', 'Packages/lock.json')];
  // 그때 없던 곳(Docs)의 새 변경은 보이고, 폴더째 숨긴 곳(Packages)의 새 변경은 숨는다.
  assert.deepEqual(visible(rules, later), ['Assets/Scripts/Player.cs', 'Docs/new.md', 'Assets/Scripts/Enemy.cs']);
});

let failed = 0;
for (const [name, error] of results) {
  if (error) {
    failed++;
    console.log(`FAIL ${name}\n  ${String(error.message).split('\n').join('\n  ')}`);
  } else {
    console.log(`ok   ${name}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} 통과`);
if (failed) process.exitCode = 1;
