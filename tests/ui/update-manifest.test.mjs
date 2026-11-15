// 업데이트 매니페스트 만들기(scripts/update-manifest.mjs) 시험. 저장소 뿌리에서 `node tests/ui/update-manifest.test.mjs`.
import assert from 'node:assert/strict';
import { compareVersions, mergeReleases, ASSETS } from '../../scripts/update-manifest.mjs';

assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
assert.equal(compareVersions('v1.6.3', '1.6.3'), 0);
assert.ok(compareVersions('1.6.3', '1.6.4') < 0);

const old = { releases: [{ version: '1.6.3' }, { version: '1.6.2' }, { version: '1.6.0' }] };
assert.deepEqual(mergeReleases(old, { version: '1.6.4' }, 3).map((r) => r.version), ['1.6.4', '1.6.3', '1.6.2']);
// 같은 판을 다시 올리면 바꿔 끼운다.
assert.deepEqual(mergeReleases(old, { version: '1.6.3', notes: 'new' }, 3).map((r) => [r.version, r.notes ?? '']), [['1.6.3', 'new'], ['1.6.2', ''], ['1.6.0', '']]);
assert.deepEqual(mergeReleases(null, { version: '1.0.0' }, 3).map((r) => r.version), ['1.0.0']);

// 앱(update.rs 의 asset_key)이 찾는 키가 있어야 한다.
const keys = ASSETS.map(([key]) => key);
assert.ok(keys.includes('macos-arm64') && keys.includes('windows-x64-setup'));

console.log('update-manifest ok');
