// 앱 업데이트 매니페스트(manifest.json)를 만든다. 릴리스 워크플로가 GitHub 릴리스를 올린 뒤 부르고, 결과를 site/manifest.json 으로 main 에 커밋한다(Cloudflare Workers 가 배포).
// 앱(crates/ramus-core/src/update.rs)이 이 파일을 읽어 새 판을 알리고, 내려받기 페이지(site/index.html)도 이것을 그린다.
//
//   node scripts/update-manifest.mjs --version 1.6.4 --repo NK-Studio/Ramus --dist dist --notes notes.md \
//        --page https://ramus.pages.dev/ [--previous old-manifest.json] [--keep 3] --out site-out/manifest.json
//
// 이번 판을 맨 앞에 넣고 예전 매니페스트의 판들을 이어 붙여 --keep 개(기본 3: 최신 + 아래 두 판)만 남긴다.
// 남긴 판의 태그(v1.6.4 …)를 한 줄씩 <out 폴더>/keep.txt 에 쓴다 — 워크플로가 그 밖의 GitHub 릴리스를 지운다.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** 설치 파일 이름 끝 → 매니페스트 assets 의 키(앱의 update::asset_key 와 같아야 한다). */
export const ASSETS = [
  ['macos-arm64', '-macos-arm64.dmg'],
  ['windows-x64-setup', '-windows-x64-setup.exe'],
  ['windows-x64-zip', '-windows-x64.zip'],
];

/** "1.6.4" → [1, 6, 4]. */
const parts = (v) => String(v).replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** 예전 매니페스트에 이번 판을 넣고 새것부터 keep 개만 남긴다. */
export function mergeReleases(previous, release, keep) {
  const others = (previous?.releases ?? []).filter((r) => r?.version && compareVersions(r.version, release.version) !== 0);
  return [release, ...others].sort((a, b) => compareVersions(b.version, a.version)).slice(0, keep);
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? 'true' : argv[++i];
  }
  return out;
}

function main() {
  const a = args(process.argv.slice(2));
  for (const key of ['version', 'repo', 'dist', 'out']) if (!a[key]) throw new Error(`--${key} 가 필요합니다`);
  const version = a.version.replace(/^v/, '');
  const tag = `v${version}`;
  const keep = Math.max(1, Number.parseInt(a.keep ?? '3', 10));

  const assets = {};
  const files = readdirSync(a.dist);
  for (const [key, suffix] of ASSETS) {
    const file = files.find((f) => f.endsWith(suffix));
    if (!file) continue;
    const bytes = readFileSync(join(a.dist, file));
    assets[key] = {
      url: `https://github.com/${a.repo}/releases/download/${tag}/${encodeURIComponent(file)}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: statSync(join(a.dist, file)).size,
    };
  }
  if (!Object.keys(assets).length) throw new Error(`${a.dist} 에 설치 파일이 없습니다`);

  const notes = a.notes && existsSync(a.notes) ? readFileSync(a.notes, 'utf8').trim() : '';
  const date = a.date ?? new Date().toISOString().slice(0, 10);
  let previous = null;
  if (a.previous && existsSync(a.previous)) {
    try { previous = JSON.parse(readFileSync(a.previous, 'utf8')); } catch { previous = null; }
  }
  const manifest = {
    schema: 1,
    page: a.page ?? previous?.page ?? '',
    releases: mergeReleases(previous, { version, date, notes, assets }, keep),
  };

  mkdirSync(dirname(a.out), { recursive: true });
  writeFileSync(a.out, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dirname(a.out), 'keep.txt'), manifest.releases.map((r) => `v${r.version}\n`).join(''));
  console.log(`${basename(a.out)}: ${manifest.releases.map((r) => r.version).join(', ')}`);
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
