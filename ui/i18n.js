// 화면 글의 언어. 코드에는 한국어 원문을 그대로 쓰고 t('원문') 으로 감싼다 — 한국어면 원문 그대로, 영어면 locales/en 표에서 찾는다.
// 표에 없는 원문은 한국어로 남는다(tests/ui/i18n.test.mjs 가 빠진 원문을 찾아 준다).
//
// 자리 표시: t('커밋 {n}개', { n }) 처럼 {이름} 을 쓴다. 영어 표의 값이 { one, other } 이면 vars.n 이 1 일 때 one 을 쓴다.
// 조사: 한국어 원문의 '{name}을' 같은 자리에는 josa(name, '을', '를') 를 넘긴다 — 영어에서는 josa 가 이름만 돌려준다.
//
// 언어는 켤 때 한 번 정한다: Rust 가 넘긴 window.__boot.language(설정 파일의 ui.language). 설정에서 바꾸면 화면을 다시 읽는다
// (그 사이에는 sessionStorage 가 새 값을 들고 있다 — 다시 읽어도 __boot 는 켤 때 값 그대로라서).

import EN, { BY_MODULE } from './locales/en.js';

export const LANGUAGES = [
  { value: 'ko', label: '한국어' },
  { value: 'en', label: 'English' },
];

const SESSION_KEY = 'ramus.language';

function detect() {
  const w = globalThis.window;
  let chosen = null;
  try {
    chosen = w?.sessionStorage?.getItem(SESSION_KEY) ?? null;
  } catch {
    chosen = null;
  }
  chosen ??= w?.__boot?.language ?? null;
  return LANGUAGES.some((l) => l.value === chosen) ? chosen : 'ko';
}

/** 지금 화면 언어('ko' | 'en'). */
export const lang = detect();
export const isEn = lang === 'en';
/** 날짜·숫자 형식에 쓸 로캘. */
export const locale = isEn ? 'en-US' : 'ko-KR';

if (globalThis.document?.documentElement) document.documentElement.lang = lang;

const fill = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars && vars[name] != null ? String(vars[name]) : whole)) : text);

function lookup(table, ko, vars) {
  if (!isEn) return fill(ko, vars);
  let text = table?.[ko] ?? EN[ko];
  if (text == null) return fill(ko, vars);
  if (typeof text === 'object') text = vars?.n === 1 || vars?.n === '1' ? text.one : text.other;
  return fill(text, vars);
}

/** 원문(한국어)을 지금 언어로. vars 는 {이름} 자리에 넣을 값. 모든 표를 합친 것에서 찾는다. */
export function t(ko, vars) {
  return lookup(null, ko, vars);
}

/** 그 모듈의 표(locales/en/<모듈>.js)를 먼저 보는 t. 모듈 맨 위에서 `const t = scoped('refs');` 로 쓴다. */
export function scoped(module) {
  const table = BY_MODULE[module];
  return (ko, vars) => lookup(table, ko, vars);
}

/** index.html 처럼 글을 그대로 쓴 마크업의 글 조각과 data-tip·placeholder·aria-label·title 을 지금 언어로 바꾼다. */
export function translateStatic(root) {
  if (!isEn || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.trim();
    if (text && EN[text] != null) node.nodeValue = node.nodeValue.replace(text, t(text));
  }
  for (const element of root.querySelectorAll('[data-tip], [placeholder], [aria-label], [title]')) {
    for (const name of ['data-tip', 'placeholder', 'aria-label', 'title']) {
      const value = element.getAttribute(name);
      if (value && EN[value] != null) element.setAttribute(name, t(value));
    }
  }
}

/** 설정에서 언어를 바꿨다: 다음 읽기에 쓸 값을 남기고 화면을 다시 읽는다. */
export function switchLanguage(next) {
  if (next === lang) return false;
  try {
    globalThis.window?.sessionStorage?.setItem(SESSION_KEY, next);
  } catch {
    // 저장이 막혀도 설정 파일에는 남았으니 다음에 켤 때 바뀐다.
  }
  globalThis.location?.reload();
  return true;
}
