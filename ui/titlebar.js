// Windows 제목 막대: 운영체제 제목 막대를 없앤 창의 맨 위 한 줄(Fork 처럼 아이콘 없이).
// 왼쪽은 메뉴 단추(파일·편집·…), 가운데는 창 제목, 오른쪽은 최소화·최대화·닫기.
//
// - 메뉴 단추를 누르면 Rust 가 그 아래에 운영체제 팝업 메뉴를 띄운다(menuPopup) — 항목·단축키 글·켜고 끈 상태는 메뉴 막대와 같은 것(menu.rs).
// - 빈 곳을 끌면 창이 움직이고(운영체제가 끌기·스냅을 한다), 두 번 누르면 창을 키우거나 되돌린다.
// - 메뉴 이름은 Rust 에게 묻는다(menuTitles) — 메뉴 번호와 이름이 늘 맞는다.

import { el } from './util.js';
import { call, on } from './bridge.js';
import { scoped } from './i18n.js';

/** 이 모듈의 글(locales/en/titlebar.js 를 먼저 본다). */
const t = scoped('titlebar');

const SVG = 'http://www.w3.org/2000/svg';

/** Windows 창 단추 모양(10×10, 1px 선). */
const GLYPHS = {
  minimize: [['path', { d: 'M0 5.5h10' }]],
  maximize: [['rect', { x: 0.5, y: 0.5, width: 9, height: 9 }]],
  restore: [['path', { d: 'M2.5 2.5V0.5h7v7h-2' }], ['rect', { x: 0.5, y: 2.5, width: 7, height: 7 }]],
  close: [['path', { d: 'M0 0l10 10M10 0L0 10' }]],
};

function glyph(kind) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of GLYPHS[kind]) {
    const shape = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attrs)) shape.setAttribute(name, value);
    svg.append(shape);
  }
  return svg;
}

/** 제목 막대를 채우고 움직이게 한다. container 는 index.html 의 #titlebar. */
export function createTitlebar(container) {
  const menus = el('div', { class: 'titlebar-menus' });
  const title = el('div', { class: 'titlebar-title', text: document.title || 'Ramus' });
  const maximize = el('button', { class: 'titlebar-control', 'aria-label': t('최대화'), onclick: () => call('windowZoom').catch(() => {}) }, glyph('maximize'));
  const controls = el('div', { class: 'titlebar-controls' },
    el('button', { class: 'titlebar-control', 'aria-label': t('최소화'), onclick: () => call('windowMinimize').catch(() => {}) }, glyph('minimize')),
    maximize,
    el('button', { class: 'titlebar-control close', 'aria-label': t('닫기'), onclick: () => call('windowClose').catch(() => {}) }, glyph('close')));
  container.replaceChildren(menus, el('div', { class: 'titlebar-drag' }), title, controls);
  container.hidden = false;

  // 메뉴 단추: 누르는 순간(mousedown) 연다 — 운영체제 메뉴 막대처럼. 팝업이 닫히면 응답이 온다.
  let opening = false;
  const open = (button, index) => {
    if (opening) return;
    opening = true;
    button.classList.add('open');
    const rect = button.getBoundingClientRect();
    call('menuPopup', { index, x: rect.left, y: rect.bottom })
      .catch(() => {})
      .finally(() => {
        button.classList.remove('open');
        opening = false;
      });
  };
  call('menuTitles').then((titles) => {
    menus.replaceChildren(...titles.map((name, index) => el('button', {
      class: 'titlebar-menu',
      text: name,
      onmousedown: (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        open(event.currentTarget, index);
      },
    })));
  }).catch(() => {});

  // 빈 곳(막대 자체·끌기 여백·제목 글)을 끌면 창을 옮기고, 두 번 누르면 키우거나 되돌린다.
  // 끌기는 누른 채 실제로 움직였을 때 시작한다 — 누르자마자 시작하면 운영체제의 창 옮기기가 두 번째 누름을 가져가 dblclick 이 오지 않는다.
  const empty = (event) => event.target === container || event.target === title || event.target.classList?.contains('titlebar-drag');
  let pressed = null;
  container.addEventListener('mousedown', (event) => {
    pressed = event.button === 0 && event.detail === 1 && empty(event) ? { x: event.screenX, y: event.screenY } : null;
  });
  container.addEventListener('mousemove', (event) => {
    if (!pressed) return;
    if (!(event.buttons & 1)) { pressed = null; return; }
    if (Math.abs(event.screenX - pressed.x) + Math.abs(event.screenY - pressed.y) < 3) return;
    pressed = null;
    call('windowDrag').catch(() => {});
  });
  container.addEventListener('mouseup', () => { pressed = null; });
  container.addEventListener('dblclick', (event) => {
    if (empty(event)) call('windowZoom').catch(() => {});
  });

  on('title', (text) => { title.textContent = text || 'Ramus'; });
  on('window', (data) => {
    const maximized = !!data?.maximized;
    maximize.replaceChildren(glyph(maximized ? 'restore' : 'maximize'));
    maximize.setAttribute('aria-label', maximized ? t('이전 크기로') : t('최대화'));
  });
}
