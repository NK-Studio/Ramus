// 화면 글 번역 시험. 저장소 뿌리에서 `node tests/ui/i18n.test.mjs` 로 돌린다.
//  1. t('원문') 의 원문이 모두 영어 표(ui/locales/en)에 있는지.
//  2. t() 로 감싸지 않은 한국어 글이 화면 코드에 남지 않았는지(주석은 빼고). 일부러 남기는 줄은 끝에 `// i18n-ignore`.
//  3. 영어 표의 {이름} 자리가 원문과 같은지, 영어 값에 한글이 남지 않았는지.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import EN from '../../ui/locales/en.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ui = join(root, 'ui');
const HANGUL = /[\uac00-\ud7a3]/;

/** JS 를 훑어 문자열 조각을 꺼낸다: { kind: 'str'|'tpl', text, line, before } — before 는 여는 따옴표 앞의 코드 몇 글자. */
function strings(src) {
  const out = [];
  let i = 0;
  let line = 1;
  let lastSignificant = '';
  const stack = []; // 템플릿 ${ } 깊이
  const push = (kind, text, start, startLine) => out.push({ kind, text, line: startLine, before: src.slice(Math.max(0, start - 60), start) });
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); for (let k = i; k < end; k++) if (src[k] === '\n') line++; i = end + 2; continue; }
    if (c === '"' || c === "'") {
      const start = i; const startLine = line; i++;
      let text = '';
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') { text += src[i] + src[i + 1]; i += 2; continue; } if (src[i] === '\n') line++; text += src[i]; i++; }
      i++;
      push('str', text, start, startLine);
      lastSignificant = 'a';
      continue;
    }
    if (c === '`' || (c === '}' && stack.length && stack[stack.length - 1] === 0)) {
      if (c === '}') stack.pop();
      const start = i; const startLine = line; i++;
      let text = '';
      let opened = false;
      while (i < src.length) {
        if (src[i] === '\\') { text += src[i] + src[i + 1]; i += 2; continue; }
        if (src[i] === '`') { i++; break; }
        if (src[i] === '$' && src[i + 1] === '{') { i += 2; stack.push(0); opened = true; break; }
        if (src[i] === '\n') line++;
        text += src[i]; i++;
      }
      push('tpl', text, start, startLine);
      lastSignificant = opened ? '(' : 'a';
      continue;
    }
    if (c === '{' && stack.length) { stack[stack.length - 1]++; }
    if (c === '}' && stack.length) { stack[stack.length - 1]--; }
    if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]|^$/.test(lastSignificant)) {
      // 정규식 글자
      i++;
      let inClass = false;
      while (i < src.length) { const d = src[i]; if (d === '\\') { i += 2; continue; } if (d === '[') inClass = true; else if (d === ']') inClass = false; else if (d === '/' && !inClass) break; else if (d === '\n') break; i++; }
      i++;
      while (/[a-z]/.test(src[i] ?? '')) i++;
      lastSignificant = 'a';
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = /[\w$)\]]/.test(c) ? 'a' : c;
    i++;
  }
  return out;
}

const files = readdirSync(ui).filter((f) => f.endsWith('.js') && f !== 'i18n.js');
const missing = [];
const unwrapped = [];
const dynamic = [];
for (const file of files) {
  const src = readFileSync(join(ui, file), 'utf8');
  const lines = src.split('\n');
  for (const s of strings(src)) {
    if (!HANGUL.test(s.text)) continue;
    if (/\/\/\s*i18n-ignore/.test(lines[s.line - 1] ?? '')) continue;
    const call = /(?:^|[^\w$.])t\(\s*$/.test(s.before);
    const josaArg = /josa\([^()]*,\s*$/.test(s.before) || /josa\([^()]*,\s*['"][^'"]*['"],\s*$/.test(s.before);
    if (josaArg) continue;
    if (call && s.kind === 'tpl') { dynamic.push(`${file}:${s.line} ${s.text}`); continue; }
    if (!call) { unwrapped.push(`${file}:${s.line} ${s.text.slice(0, 80)}`); continue; }
    const key = s.text.replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    if (!(key in EN)) missing.push(`${file}:${s.line} ${key}`);
  }
}

// index.html 은 글을 그대로 쓰고 app.js 가 켤 때 data-i18n 자리를 바꾼다.
const html = readFileSync(join(ui, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
for (const m of html.matchAll(/>([^<>]*[\uac00-\ud7a3][^<>]*)</g)) {
  const key = m[1].trim();
  if (!(key in EN)) missing.push(`index.html ${key}`);
}

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const badValues = [];
for (const [ko, en] of Object.entries(EN)) {
  const values = typeof en === 'object' ? [en.one, en.other] : [en];
  for (const v of values) {
    if (typeof v !== 'string') { badValues.push(`${ko} → 값이 글이 아님`); continue; }
    if (HANGUL.test(v)) badValues.push(`${ko} → 영어에 한글: ${v}`);
    if (placeholders(v) !== placeholders(ko) && !(typeof en === 'object' && v === en.one && placeholders(ko).includes('n'))) badValues.push(`${ko} → 자리 표시 다름: ${v}`);
  }
}

const report = (title, list) => (list.length ? `${title} (${list.length})\n  ${(process.env.I18N_FULL ? list : list.slice(0, 60)).join('\n  ')}${!process.env.I18N_FULL && list.length > 60 ? '\n  …' : ''}` : '');
const problems = [report('영어 표에 없는 원문', missing), report('t() 로 감싸지 않은 한국어', unwrapped), report('t() 에 템플릿 글(${})을 넘김 — {이름} 자리로', dynamic), report('영어 표의 값 문제', badValues)].filter(Boolean);
try {
  assert.equal(problems.length, 0, problems.join('\n\n'));
  console.log(`ok - i18n: 원문 ${Object.keys(EN).length}개, 파일 ${files.length}개`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
