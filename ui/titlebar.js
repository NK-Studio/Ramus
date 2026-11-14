// Windows 제목 막대: 운영체제 제목 막대를 없앤 창의 맨 위 한 줄(Fork 처럼 아이콘 없이).
// 왼쪽은 메뉴 단추(파일·편집·…), 가운데는 창 제목, 오른쪽은 최소화·최대화·닫기.
//
// - 메뉴 단추를 누르면 Rust 가 그 아래에 운영체제 팝업 메뉴를 띄운다(menuPopup) — 항목·단축키 글·켜고 끈 상태는 메뉴 막대와 같은 것(menu.rs).
// - 빈 곳을 끌면 창이 움직이고(운영체제가 끌기·스냅을 한다), 두 번 누르면 창을 키우거나 되돌린다.
// - 메뉴 이름과 접근 키는 Rust 에게 묻는다(menuTitles) — 메뉴 번호와 이름이 늘 맞는다.
// - 키보드: Alt 를 눌렀다 떼면 메뉴 막대로 들어가고, Alt+글자는 그 메뉴를 바로 연다(아래 "키보드").

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

/**
 * 메뉴 이름에 접근 키를 표시한다: 이름에 그 글자가 있으면(File 의 F) 밑줄, 없으면(파일) 뒤에 "(F)" — Windows 한국어 앱처럼.
 * 둘 다 Alt 를 누르거나 메뉴 막대에 들어온 동안만 보인다(.show-keys).
 */
function accessLabel(name, key) {
  const at = name.toUpperCase().indexOf(key.toUpperCase());
  if (at < 0) return [name, el('span', { class: 'titlebar-key', text: `(${key.toUpperCase()})` })];
  return [name.slice(0, at), el('span', { class: 'titlebar-key-letter', text: name[at] }), name.slice(at + 1)];
}

/** 제목 막대를 채우고 움직이게 한다. container 는 index.html 의 #titlebar. */
export function createTitlebar(container) {
  const menus = el('div', { class: 'titlebar-menus' });
  const maximize = el('button', { class: 'titlebar-control', 'aria-label': t('최대화'), onclick: () => call('windowZoom').catch(() => {}) }, glyph('maximize'));
  const controls = el('div', { class: 'titlebar-controls' },
    el('button', { class: 'titlebar-control', 'aria-label': t('최소화'), onclick: () => call('windowMinimize').catch(() => {}) }, glyph('minimize')),
    maximize,
    el('button', { class: 'titlebar-control close', 'aria-label': t('닫기'), onclick: () => call('windowClose').catch(() => {}) }, glyph('close')));
  container.replaceChildren(menus, el('div', { class: 'titlebar-drag' }), controls);
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
  let keys = [];
  call('menuTitles').then((titles) => {
    keys = titles.map((entry) => entry.key.toUpperCase());
    menus.replaceChildren(...titles.map(({ title: name, key }, index) => el('button', {
      class: 'titlebar-menu',
      tabindex: -1,
      onmousedown: (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        leaveKeyboard();
        open(event.currentTarget, index);
      },
    }, ...accessLabel(name, key))));
  }).catch(() => {});

  // ── 키보드: 운영체제 메뉴 막대처럼 ──
  // Alt 를 눌렀다 떼면 메뉴 막대로 들어간다(첫 메뉴가 골라진다): ←→ 로 옮기고 Enter·Space·↓ 나 접근 키 글자로 연다, Esc·Alt 로 나온다.
  // Alt+글자(파일 F·편집 E·보기 V·레포지토리 R·창 W·도움말 H)는 그 메뉴를 바로 연다. Alt 를 누르는 동안 접근 키를 드러낸다.
  const buttons = () => [...menus.children];
  let focused = -1; // 메뉴 막대에 들어와 고른 메뉴 번호(-1: 들어오지 않았다)
  let altAlone = false; // Alt 만 눌렀다(사이에 다른 키·누름이 없었다)
  const showKeys = (on) => container.classList.toggle('show-keys', on);
  const highlight = (index) => {
    focused = index;
    buttons().forEach((button, i) => button.classList.toggle('focused', i === index));
    showKeys(index >= 0);
  };
  function leaveKeyboard() {
    if (focused >= 0) highlight(-1);
    showKeys(false);
  }
  const openByKey = (index) => {
    const button = buttons()[index];
    if (!button) return;
    leaveKeyboard();
    const rect = button.getBoundingClientRect();
    if (opening) return;
    opening = true;
    button.classList.add('open');
    call('menuPopup', { index, x: rect.left, y: rect.bottom, keyboard: true })
      .catch(() => {})
      .finally(() => {
        button.classList.remove('open');
        opening = false;
      });
  };
  // 자판 자리(code)로 찾는다 — 한글 입력 상태여도 Alt+R 은 R 이다. code 가 없으면(일부 합성 키) 글자로.
  const keyIndex = (event) => {
    const letter = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^[a-z]$/i.test(event.key) ? event.key.toUpperCase() : '';
    return letter ? keys.indexOf(letter) : -1;
  };
  const swallow = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  // 앞 단계(capture)에서 받는다 — 메뉴 막대에 들어온 동안 다른 키 처리(app.js 등)가 받지 않게.
  window.addEventListener('keydown', (event) => {
    if (!event.isTrusted || opening || event.isComposing) return;
    if (event.key === 'Alt') {
      if (!event.repeat) altAlone = !event.ctrlKey && !event.shiftKey && !event.metaKey;
      if (altAlone) showKeys(true);
      swallow(event);
      return;
    }
    altAlone = false;
    if (event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
      const index = keyIndex(event);
      if (index >= 0) {
        swallow(event);
        openByKey(index);
        return;
      }
      if (focused < 0) showKeys(false);
      return;
    }
    if (focused < 0) return;
    const count = buttons().length;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      highlight((focused + (event.key === 'ArrowRight' ? 1 : count - 1)) % count);
    } else if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      openByKey(focused);
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      leaveKeyboard();
    } else if (keyIndex(event) >= 0) {
      openByKey(keyIndex(event));
    } else {
      // 모르는 키: 메뉴 막대에서 나오고 그 키는 먹는다(운영체제 메뉴 막대처럼 다른 곳에 새지 않게).
      leaveKeyboard();
    }
    swallow(event);
  }, true);
  window.addEventListener('keyup', (event) => {
    if (event.key !== 'Alt') return;
    const alone = altAlone;
    altAlone = false;
    if (alone && !opening) {
      swallow(event);
      if (focused >= 0) leaveKeyboard();
      else highlight(0);
    } else if (focused < 0) {
      showKeys(false);
    }
  }, true);
  // 마우스를 누르거나 창이 포커스를 잃으면 메뉴 막대에서 나온다.
  window.addEventListener('mousedown', () => { altAlone = false; leaveKeyboard(); }, true);
  window.addEventListener('blur', () => { altAlone = false; leaveKeyboard(); });

  // 빈 곳(막대 자체·끌기 여백)을 끌면 창을 옮기고, 두 번 누르면 키우거나 되돌린다.
  // 끌기는 누른 채 실제로 움직였을 때 시작한다 — 누르자마자 시작하면 운영체제의 창 옮기기가 두 번째 누름을 가져가 dblclick 이 오지 않는다.
  const empty = (event) => event.target === container || event.target.classList?.contains('titlebar-drag');
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

  on('window', (data) => {
    const maximized = !!data?.maximized;
    maximize.replaceChildren(glyph(maximized ? 'restore' : 'maximize'));
    maximize.setAttribute('aria-label', maximized ? t('이전 크기로') : t('최대화'));
  });
}
