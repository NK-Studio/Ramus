// ui/repocache.js 시험: 레포지토리별 보관(LRU)과 전환 문. 저장소 뿌리에서 `node tests/ui/repocache.test.mjs` 로 돌린다.
import assert from 'node:assert/strict';
import { createRepoCache, createSwitchGate, isRepoBound } from '../../ui/repocache.js';

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push([name, null]);
  } catch (error) {
    results.push([name, error]);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

await test('cache_KeepsMostRecentlyUsed', () => {
  const cache = createRepoCache({ limit: 2 });
  cache.set('/a', { n: 1 });
  cache.set('/b', { n: 2 });
  // /a 를 꺼내 쓰면 /b 가 더 오래된 것이 된다.
  assert.equal(cache.get('/a').n, 1);
  cache.set('/c', { n: 3 });
  assert.deepEqual(cache.paths, ['/a', '/c']);
  assert.equal(cache.get('/b'), null);
  assert.equal(cache.size, 2);
});

await test('cache_SetReplacesAndUpdatePatchesOnlyExisting', () => {
  const cache = createRepoCache();
  cache.set('/a', { snap: 1, draft: 'x' });
  cache.set('/a', { snap: 2, draft: 'y' });
  assert.equal(cache.size, 1);
  assert.equal(cache.update('/a', { snap: 3 }), true);
  assert.deepEqual(cache.get('/a'), { snap: 3, draft: 'y' });
  // 닫은 탭(없는 것)은 늦게 온 snapshot 으로 되살리지 않는다.
  assert.equal(cache.update('/zzz', { snap: 9 }), false);
  assert.equal(cache.has('/zzz'), false);
  cache.delete('/a');
  assert.equal(cache.size, 0);
});

await test('isRepoBound_GlobalCommandsAreNot', () => {
  for (const cmd of ['init', 'openRepo', 'closeRepo', 'getSettings', 'setUi', 'avatar', 'clone', 'pick', '__devResult']) assert.equal(isRepoBound(cmd), false, cmd);
  for (const cmd of ['snapshot', 'diff', 'stage', 'commit', 'commitDetail', 'push', 'githubRepo', 'lastFetch']) assert.equal(isRepoBound(cmd), true, cmd);
});

await test('gate_DefersSendsUntilSwitchSettles', async () => {
  const gate = createSwitchGate();
  gate.set('/a');
  const sent = [];
  gate.run((path) => sent.push(path));
  assert.deepEqual(sent, ['/a']);
  let finish;
  const request = new Promise((resolve) => { finish = resolve; });
  gate.begin('/b', request);
  assert.equal(gate.switching, true);
  assert.equal(gate.path, '/b');
  gate.run((path) => sent.push(path));
  assert.deepEqual(sent, ['/a'], '전환 중에는 보내지 않는다');
  // 응답의 path(레포지토리 루트)로 맞춘다 — 하위 폴더를 골라 열었을 때.
  finish({ path: '/b/root' });
  await tick();
  assert.deepEqual(sent, ['/a', '/b/root']);
  assert.equal(gate.switching, false);
  assert.equal(gate.path, '/b/root');
});

await test('gate_FailedSwitchRestoresPreviousPath', async () => {
  const gate = createSwitchGate();
  gate.set('/a');
  const sent = [];
  gate.begin('/b', Promise.reject(new Error('없는 폴더')));
  gate.run((path) => sent.push(path));
  await tick();
  assert.equal(gate.path, '/a');
  assert.deepEqual(sent, ['/a'], '실패하면 이전 레포지토리로 보낸다');
});

await test('gate_ConsecutiveSwitchesWaitForTheLast', async () => {
  const gate = createSwitchGate();
  gate.set('/a');
  const sent = [];
  let finishB;
  let finishC;
  gate.begin('/b', new Promise((resolve) => { finishB = resolve; }));
  gate.run((path) => sent.push(path));
  gate.begin('/c', new Promise((resolve) => { finishC = resolve; }));
  finishB({ path: '/b' });
  await tick();
  assert.deepEqual(sent, [], '/b 가 끝나도 /c 전환이 남아 있으면 기다린다');
  finishC({ path: '/c' });
  await tick();
  assert.deepEqual(sent, ['/c']);
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
