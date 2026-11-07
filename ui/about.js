// "Ramus 정보" 창. PyCharm 의 정보 창처럼: 왼쪽에 큰 앱 아이콘, 오른쪽에 이름·버전, 빌드 표식, 실행 환경(git·웹뷰·운영체제),
// 아래에 [닫기][복사하고 닫기]. 내용은 Rust 의 about 명령(commands.rs)이 준다 — 빌드 표식은 build.rs 가 묻은 것.
import { el } from './util.js';
import { call } from './bridge.js';

/** 앱 아이콘(assets/icon/ramus.svg)과 같은 모양: 둥근 흰 타일 위 검정 가지 표식. 200 단위 타일, 48 단위 표식. */
const TILE = 'M44 0H156C192 0 200 8 200 44V156C200 192 192 200 156 200H44C8 200 0 192 0 156V44C0 8 8 0 44 0Z';
const GLYPH = '<path d="M17 14.5V33.5"/><path d="M17 30c0-8 14-6 14-13.5"/><circle cx="17" cy="10" r="4.5"/><circle cx="17" cy="38" r="4.5"/><circle cx="31" cy="12" r="4.5"/>';

function appIcon() {
  const box = el('div', { class: 'about-icon', 'aria-hidden': 'true' });
  box.innerHTML =
    '<svg viewBox="0 0 200 200">' +
      '<defs><linearGradient id="about-tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f1f1f3"/></linearGradient></defs>' +
      `<path d="${TILE}" fill="url(#about-tile)"/>` +
      `<path d="${TILE}" fill="none" stroke="#000" stroke-opacity="0.08" stroke-width="2"/>` +
      `<g transform="translate(20.8 20.8) scale(3.3)" fill="none" stroke="#111" stroke-width="3.2" stroke-linecap="round">${GLYPH}</g>` +
    '</svg>';
  return box;
}

/** "YYYY-MM-DD" → "2026년 11월 7일". 못 읽으면 원문. */
function koreanDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!m) return iso ?? '';
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
}

const OS_NAME = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };
/** 웹뷰 엔진 이름 + 버전: macOS 는 WebKit, Windows 는 WebView2(Edge), 리눅스는 WebKitGTK. */
function webviewLabel(info) {
  if (!info.webview) return '';
  const engine = info.platform === 'windows' ? 'WebView2' : info.platform === 'macos' ? 'WebKit' : 'WebKitGTK';
  return `${engine} ${info.webview}`;
}

/** 정보창을 띄운다. 이미 떠 있으면 아무것도 하지 않는다. */
export async function showAbout() {
  if (document.querySelector('.modal.about')) return;
  const info = await call('about').catch(() => ({}));
  const version = info.version ?? '';
  // `git --version` 은 "git version 2.55.0"(Windows 는 뒤에 ".windows.1") — 앞머리를 "Git" 으로 줄인다.
  const git = info.git ? info.git.replace(/^git version\s*/i, 'Git ') : '';
  const env = [git, webviewLabel(info), [OS_NAME[info.platform] ?? info.platform, info.arch].filter(Boolean).join(' ')].filter(Boolean);
  const build = info.build_hash ? `빌드 #${info.build_hash}, ${koreanDate(info.build_date)}에 빌드됨` : '';
  const plain = [`Ramus ${version}`, info.build_hash ? `빌드 #${info.build_hash}, ${info.build_date}` : '', ...env].filter(Boolean).join('\n');

  const line = (text, className = '') => el('div', { class: className, text });
  const text = el('div', { class: 'about-text' },
    el('div', { class: 'about-title', text: `Ramus ${version}` }),
    build ? el('div', { class: 'about-group' }, line(build)) : null,
    env.length ? el('div', { class: 'about-group' }, env.map((t) => line(t))) : null);

  const backdrop = el('div', { class: 'modal-backdrop' });
  const box = el('div', { class: 'modal card about', role: 'dialog', 'aria-label': 'Ramus 정보' });
  const close = () => {
    if (!backdrop.isConnected) return;
    document.removeEventListener('keydown', onKey, true);
    backdrop.classList.add('leaving');
    setTimeout(() => backdrop.remove(), 260);
  };
  const onKey = (event) => {
    if (event.key === 'Escape' || event.key === 'Esc') { event.preventDefault(); event.stopPropagation(); close(); }
  };
  const copyClose = el('button', { class: 'btn card-ok default', text: '복사하고 닫기', onclick: () => { navigator.clipboard?.writeText(plain); close(); } });
  const actions = el('div', { class: 'modal-actions' }, el('button', { class: 'btn card-cancel', text: '닫기', onclick: close }), copyClose);
  box.append(el('div', { class: 'about-body' }, appIcon(), text), actions);
  backdrop.append(box);
  backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  copyClose.focus();
}
