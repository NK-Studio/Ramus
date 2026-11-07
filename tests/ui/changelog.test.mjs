// ChangeLog.md 맨 위 버전이 Cargo.toml 의 버전과 같은지, 그 항목이 비어 있지 않은지 확인한다.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('../../', import.meta.url);
const cargo = readFileSync(new URL('Cargo.toml', root), 'utf8');
const log = readFileSync(new URL('ChangeLog.md', root), 'utf8');

const version = cargo.match(/^version = "(.+)"/m)?.[1];
assert.ok(version, 'Cargo.toml 에서 version 을 못 찾음');

const top = [...log.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)][0];
assert.ok(top, 'ChangeLog.md 에 버전 항목이 없음');
assert.equal(top[1], version, `ChangeLog.md 맨 위 버전(${top[1]})이 Cargo.toml(${version})과 다름`);

const body = log.slice(top.index + top[0].length).split(/^## \[/m)[0].trim();
assert.ok(body.length > 0, `ChangeLog.md 의 ${version} 항목이 비어 있음`);
assert.ok(/^## \[Unreleased\]/m.test(log), 'ChangeLog.md 에 [Unreleased] 가 없음');

console.log(`changelog ok (${version})`);
