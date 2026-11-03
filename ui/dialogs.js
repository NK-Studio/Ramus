// 카드(확인·입력·고르기)·오류 대화상자·드로어·우클릭 메뉴. 원본 Window/GitConfirmDialog·GitPromptDialog·GitPickDialog·GitErrorDialog,
// Elements/SideDrawer·GitContextMenu 를 옮겼다. 웹뷰의 confirm()/prompt() 는 플랫폼마다 모양·동작이 달라 직접 그린다.

import { el, isComposing } from './util.js';
import { icon } from './icons.js';

const stack = [];

/** 막 + 카드. 위험한 확인은 막을 눌러도 닫히지 않는다. */
function card({ className = '', glyph, tone = 'accent', title, onCancel, sticky = false }) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const box = el('div', { class: `modal card ${className}`, role: 'dialog' });
  const head = el('div', { class: 'card-head' },
    glyph ? el('span', { class: `card-badge tone-${tone}` }, icon(glyph, 18)) : null,
    el('div', { class: 'modal-title', text: title }),
    el('button', { class: 'card-close', 'data-tip': '닫기 (Esc)', onclick: () => onCancel() }, icon('close', 14)));
  box.append(head);
  backdrop.append(box);
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop && !sticky) onCancel();
  });
  document.body.append(backdrop);
  stack.push(backdrop);
  const remove = () => {
    backdrop.remove();
    stack.splice(stack.indexOf(backdrop), 1);
  };
  return { box, remove };
}

/**
 * 입력 칸이 있는 카드. 고르면 {이름: 값}, 취소하면 null.
 * fields: [{name, label, value, type: 'text'|'password'|'checkbox'|'select'|'textarea', placeholder, options:[{value,label}], hint, icon}]
 * validate(values) 는 쓰는 동안 불린다 — 문제가 있으면 카드 안 한 줄에 보이고 확인을 끈다.
 */
export function formDialog({ title, message, fields = [], ok = '확인', cancel = '취소', danger = false, validate, glyph, tone, className, extra }) {
  return new Promise((resolve) => {
    const inputs = {};
    // 문제 줄은 늘 자리를 잡아 카드가 흔들리지 않는다.
    const problem = el('div', { class: 'modal-error' }, ' ');
    let closed = false;
    const close = (value) => {
      if (closed) return;
      closed = true;
      remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const { box, remove } = card({ className, glyph: glyph ?? (danger ? 'warning' : null), tone: tone ?? (danger ? 'danger' : 'accent'), title, onCancel: () => close(null), sticky: danger });
    const values = () => Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.type === 'checkbox' ? input.checked : input.value]));
    const okButton = el('button', { class: `btn ${danger ? 'danger-strong' : 'primary'}`, text: ok });
    const check = () => {
      const text = validate?.(values());
      problem.textContent = text || ' ';
      okButton.disabled = !!text;
      return text;
    };
    const submit = () => {
      if (check()) return;
      close(values());
    };
    okButton.addEventListener('click', submit);
    const rows = fields.map((f) => {
      let input;
      if (f.type === 'select') {
        input = el('select', { class: 'field' }, (f.options || []).map((o) => el('option', { value: o.value, text: o.label })));
        input.value = f.value ?? '';
      } else if (f.type === 'textarea') {
        input = el('textarea', { class: 'field', rows: f.rows || 4, placeholder: f.placeholder || '' });
        input.value = f.value ?? '';
      } else if (f.type === 'checkbox') {
        input = el('input', { type: 'checkbox' });
        input.checked = !!f.value;
        inputs[f.name] = input;
        input.addEventListener('change', check);
        return el('label', { class: 'check modal-check' }, input, f.label, f.hint ? el('span', { class: 'muted small', text: ` ${f.hint}` }) : null);
      } else {
        input = el('input', { class: 'field', type: f.type || 'text', placeholder: f.placeholder || '', autocomplete: 'off', spellcheck: 'false' });
        input.value = f.value ?? '';
      }
      inputs[f.name] = input;
      input.addEventListener('input', check);
      input.addEventListener('change', check);
      const control = f.icon ? el('div', { class: 'field-with-icon' }, icon(f.icon, 16), input) : input;
      return el('label', { class: 'modal-field' }, f.label ? el('span', { class: 'modal-label', text: f.label }) : null, control,
        f.hint ? el('span', { class: 'muted small', text: f.hint }) : null);
    });
    // 취소는 왼쪽, 확인은 오른쪽(강조색).
    box.append(
      message ? el('div', { class: 'modal-message', text: message }) : null,
      ...rows,
      extra ?? null,
      validate ? problem : null,
      el('div', { class: 'modal-actions' },
        cancel ? el('button', { class: 'btn', text: cancel, onclick: () => close(null) }) : null,
        okButton));
    const onKey = (event) => {
      if (stack[stack.length - 1] !== box.parentElement) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(null);
      } else if (event.key === 'Enter' && !isComposing(event)) {
        const multiline = event.target instanceof HTMLTextAreaElement;
        if (multiline && !(event.metaKey || event.ctrlKey)) return;
        // 위험한 확인은 Enter 가 취소다(입력 칸이 없을 때).
        if (danger && !fields.length) {
          event.preventDefault();
          close(null);
          return;
        }
        event.preventDefault();
        submit();
      }
    };
    document.addEventListener('keydown', onKey, true);
    check();
    const first = box.querySelector('input:not([type=checkbox]), textarea, select');
    if (first) {
      first.focus();
      if (first.select) first.select();
      check();
    } else if (!danger) okButton.focus();
    else box.querySelector('.modal-actions .btn')?.focus();
  });
}

/** 예/아니오 카드. 위험하면 빨간 확인, Enter 기본값은 취소, 막을 눌러도 닫히지 않는다. */
export async function confirmDialog({ title, message, ok = '확인', danger = false, glyph, tone }) {
  return (await formDialog({ title, message, ok, danger, glyph: glyph ?? (danger ? 'warning' : 'info'), tone })) !== null;
}

/** 세 갈래 카드: 확인·다른 쪽·취소. 'ok' | 'alt' | null. */
export function choiceDialog({ title, message, ok, alt, glyph = 'info', tone = 'accent' }) {
  return new Promise((resolve) => {
    const close = (value) => {
      remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const { box, remove } = card({ glyph, tone, title, onCancel: () => close(null) });
    const okButton = el('button', { class: 'btn primary', text: ok, onclick: () => close('ok') });
    box.append(el('div', { class: 'modal-message', text: message }),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', text: '취소', onclick: () => close(null) }),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', text: alt, onclick: () => close('alt') }),
        okButton));
    const onKey = (event) => {
      if (event.key === 'Escape') close(null);
      else if (event.key === 'Enter' && !isComposing(event)) close('ok');
    };
    document.addEventListener('keydown', onKey, true);
    okButton.focus();
  });
}

/** 여러 개 중 하나 고르기(↑↓·Enter). options: [{value, label, hint}]. 고른 value 또는 null. */
export function pickDialog({ title, message, options, value, ok = '확인', glyph = 'info' }) {
  return new Promise((resolve) => {
    let index = Math.max(0, options.findIndex((o) => o.value === value));
    const close = (v) => {
      remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const { box, remove } = card({ glyph, title, onCancel: () => close(null) });
    const list = el('div', { class: 'pick-list', role: 'listbox' });
    const draw = () => list.replaceChildren(...options.map((o, i) => el('div', {
      class: `pick-item${i === index ? ' on' : ''}`,
      onclick: () => { index = i; draw(); },
      ondblclick: () => close(o.value),
    }, el('span', { class: 'pick-radio' }), el('div', {}, el('div', { text: o.label }), o.hint ? el('div', { class: 'muted small', text: o.hint }) : null))));
    draw();
    box.append(message ? el('div', { class: 'modal-message', text: message }) : null, list,
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', text: '취소', onclick: () => close(null) }),
        el('button', { class: 'btn primary', text: ok, onclick: () => close(options[index].value) })));
    const onKey = (event) => {
      if (event.key === 'Escape') close(null);
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        index = (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        draw();
      } else if (event.key === 'Enter' && !isComposing(event)) close(options[index].value);
    };
    document.addEventListener('keydown', onKey, true);
  });
}

// ── 오류 대화상자 ──

const COPY_FEEDBACK_MS = 1200;

/**
 * git 실패를 "설명 / git 원문" 으로 보인다. 고른 쪽은 기억한다(prefs). 회사망 SSL 이면 [SSL 설정 열기], 충돌이면 빨간 오류 대신 안내와 [충돌 보기].
 * actions: { openSsl(), showConflicts(), prefs }
 */
export function errorDialog(error, { openSsl, showConflicts, prefs, title } = {}) {
  return new Promise((resolve) => {
    const advice = error?.advice ?? { kind: 'unknown', cause: '', fix: '' };
    const conflict = advice.kind === 'conflict';
    const raw = error?.message ?? String(error);
    let mode = prefs?.get('error.mode') ?? 'friendly';
    const close = () => {
      remove();
      document.removeEventListener('keydown', onKey, true);
      resolve();
    };
    const { box, remove } = card({
      className: 'error-card',
      glyph: conflict ? 'warning' : 'warning',
      tone: conflict ? 'warning' : 'danger',
      title: title ?? (conflict ? '충돌이 났습니다' : '작업을 끝내지 못했습니다'),
      onCancel: close,
    });
    const body = el('div', { class: 'error-body' });
    const seg = el('div', { class: 'seg' });
    const draw = () => {
      seg.replaceChildren(
        el('button', { class: mode === 'friendly' ? 'on' : '', text: '설명', onclick: () => setMode('friendly') }),
        el('button', { class: mode === 'raw' ? 'on' : '', text: 'git 원문', onclick: () => setMode('raw') }));
      body.replaceChildren(...(mode === 'friendly' && advice.cause
        ? [el('div', { class: 'error-line' }, el('span', { class: 'error-tag', text: '원인' }), el('span', { text: advice.cause })),
          el('div', { class: 'error-line' }, el('span', { class: 'error-tag fix', text: '해결' }), el('span', { text: advice.fix }))]
        : [el('pre', { class: 'error-raw', text: raw })]));
    };
    const setMode = (m) => {
      mode = m;
      prefs?.set('error.mode', m);
      draw();
    };
    const copy = el('button', {
      class: 'btn', text: '모두 복사',
      onclick: () => {
        navigator.clipboard?.writeText(advice.cause ? `${advice.cause}\n${advice.fix}\n\n${raw}` : raw);
        copy.textContent = '복사됨';
        setTimeout(() => { copy.textContent = '모두 복사'; }, COPY_FEEDBACK_MS);
      },
    });
    draw();
    box.append(seg, body,
      el('div', { class: 'modal-actions' },
        copy,
        el('span', { class: 'spacer' }),
        error?.ssl && openSsl ? el('button', { class: 'btn', text: 'SSL 설정 열기', onclick: () => { close(); openSsl(); } }) : null,
        conflict && showConflicts ? el('button', { class: 'btn primary', text: '충돌 보기', onclick: () => { close(); showConflicts(); } }) : null,
        el('button', { class: `btn${conflict && showConflicts ? '' : ' primary'}`, text: '닫기', onclick: close })));
    const onKey = (event) => {
      if (event.key === 'Escape' || (event.key === 'Enter' && !isComposing(event))) {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKey, true);
  });
}

// ── 드로어 ──

let openDrawerState = null;

/**
 * 사이드바 옆에서 밀려 나오는 입력 칸. 한 번에 하나(바꿔 끼울 때는 움직임 없이). build(body, close) 가 내용을 채운다.
 * anchor 는 드로어가 붙을 왼쪽 경계 요소(사이드바).
 */
export function openDrawer({ glyph, title, anchor, build, width = 360 }) {
  const swap = !!openDrawerState;
  openDrawerState?.close(true);
  const rect = anchor.getBoundingClientRect();
  const panel = el('aside', { class: `drawer${swap ? ' no-anim' : ''}`, style: { left: `${rect.right}px`, top: `${rect.top}px`, height: `${rect.height}px`, width: `${width}px` } },
    el('div', { class: 'drawer-head' }, glyph ? icon(glyph, 18) : null, el('div', { class: 'drawer-title', text: title }),
      el('button', { class: 'card-close', 'data-tip': '닫기 (Esc)', onclick: () => close() }, icon('close', 14))));
  const body = el('div', { class: 'drawer-body' });
  panel.append(body);
  document.body.append(panel);
  const onKey = (event) => {
    if (event.key === 'Escape' && !document.querySelector('.modal-backdrop, .menu')) {
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  function close(immediate = false) {
    if (openDrawerState?.panel !== panel) return;
    openDrawerState = null;
    document.removeEventListener('keydown', onKey, true);
    if (immediate) panel.remove();
    else {
      panel.classList.add('closing');
      setTimeout(() => panel.remove(), 160);
    }
  }
  openDrawerState = { panel, close };
  build(body, close);
  body.querySelector('input, textarea, select')?.focus();
  return close;
}

export const closeDrawer = () => openDrawerState?.close();

/**
 * 검색되는 고르기 칸: 글자 칸·구분선·⌄, 걸러진 목록이 아래를 덮어 펼쳐진다(↑↓·Enter).
 * items: [{value, label, hint, icon}]
 */
export function searchSelect({ items, value, placeholder = '', onChange }) {
  let current = value;
  const input = el('input', { class: 'ss-input', placeholder, spellcheck: 'false', autocomplete: 'off' });
  const list = el('div', { class: 'ss-list', hidden: true });
  const wrap = el('div', { class: 'search-select' }, input, el('span', { class: 'ss-sep' }), el('span', { class: 'ss-caret' }, icon('chevronDown', 14)), list);
  let active = 0;
  let shown = [];
  const labelOf = (v) => items.find((i) => i.value === v)?.label ?? v ?? '';
  input.value = labelOf(current);
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = items.filter((i) => !q || i.label.toLowerCase().includes(q) || labelOf(current).toLowerCase() === q);
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren(...(shown.length ? shown.map((i, k) => el('div', {
      class: `ss-item${k === active ? ' on' : ''}${i.value === current ? ' chosen' : ''}`,
      onpointerdown: (e) => { e.preventDefault(); choose(i); },
    }, i.icon ? icon(i.icon, 14) : null, el('span', { text: i.label }), i.hint ? el('span', { class: 'muted small', text: i.hint }) : null))
      : [el('div', { class: 'ss-empty muted small', text: '없습니다' })]));
  };
  const open = () => { list.hidden = false; draw(); };
  const choose = (item) => {
    current = item.value;
    input.value = item.label;
    list.hidden = true;
    onChange?.(item.value);
  };
  input.addEventListener('focus', () => { input.select(); open(); });
  input.addEventListener('input', () => { active = 0; open(); });
  input.addEventListener('blur', () => { list.hidden = true; input.value = labelOf(current); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) open();
      active = Math.max(0, Math.min(shown.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)));
      draw();
    } else if (event.key === 'Enter' && !isComposing(event) && !list.hidden && shown[active]) {
      event.preventDefault();
      event.stopPropagation();
      choose(shown[active]);
    } else if (event.key === 'Escape' && !list.hidden) {
      event.stopPropagation();
      list.hidden = true;
    }
  });
  wrap.querySelector('.ss-caret').addEventListener('pointerdown', (e) => { e.preventDefault(); input.focus(); });
  return { element: wrap, get value() { return current; }, set(v) { current = v; input.value = labelOf(v); } };
}

// ── 우클릭 메뉴 ──

let openMenu = null;

/**
 * 우클릭 메뉴. items: [{label, action, danger, disabled, checked, submenu:[…], hint} | '-']
 * 하위 메뉴(›), 체크 표시, 키보드(↑↓·Enter·→·←·Esc).
 */
export function showMenu(x, y, items) {
  openMenu?.();
  const menus = [];

  function build(entries, left, top, parentItem) {
    const usable = entries.filter((e) => e !== '-' && !e.disabled);
    const menu = el('div', { class: 'menu', role: 'menu' });
    const buttons = [];
    for (const item of entries) {
      if (item === '-') {
        menu.append(el('div', { class: 'menu-sep' }));
        continue;
      }
      const button = el('button', {
        class: `menu-item${item.danger ? ' danger' : ''}${item.submenu ? ' has-sub' : ''}`,
        disabled: item.disabled,
      },
      el('span', { class: 'menu-check' }, item.checked ? icon('check', 14) : null),
      el('span', { class: 'menu-label', text: item.label }),
      item.hint ? el('span', { class: 'menu-hint', text: item.hint }) : null,
      item.submenu ? el('span', { class: 'menu-arrow' }, icon('chevronRight', 12)) : null);
      button.item = item;
      button.addEventListener('mouseenter', () => focus(menu, buttons.indexOf(button), true));
      button.addEventListener('click', () => activate(menu, button));
      buttons.push(button);
      menu.append(button);
    }
    menu.buttons = buttons;
    menu.active = -1;
    menu.parentItem = parentItem;
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(left, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(4, Math.min(top, window.innerHeight - rect.height - 8))}px`;
    menus.push(menu);
    if (!usable.length) menu.classList.add('empty');
    return menu;
  }

  function closeFrom(menu) {
    while (menus.length && menus[menus.length - 1] !== menu) menus.pop().remove();
  }

  function openSub(menu, button) {
    closeFrom(menu);
    if (!button.item.submenu || button.disabled) return null;
    const r = button.getBoundingClientRect();
    const sub = build(button.item.submenu, r.right - 2, r.top - 5, button);
    const sr = sub.getBoundingClientRect();
    if (sr.right > window.innerWidth - 4) sub.style.left = `${r.left - sr.width + 2}px`;
    return sub;
  }

  function focus(menu, index, hover = false) {
    menu.active = index;
    menu.buttons.forEach((b, i) => b.classList.toggle('active', i === index));
    const button = menu.buttons[index];
    if (hover && button) {
      clearTimeout(menu.timer);
      menu.timer = setTimeout(() => { if (button.item.submenu) openSub(menu, button); else closeFrom(menu); }, 120);
    }
  }

  function activate(menu, button) {
    if (button.disabled) return;
    if (button.item.submenu) {
      const sub = openSub(menu, button);
      if (sub) focus(sub, sub.buttons.findIndex((b) => !b.disabled));
      return;
    }
    close();
    button.item.action?.();
  }

  build(items, x, y, null);

  const onDown = (event) => {
    if (!menus.some((m) => m.contains(event.target))) close();
  };
  const onKey = (event) => {
    const menu = menus[menus.length - 1];
    const move = (delta) => {
      const n = menu.buttons.length;
      let i = menu.active;
      for (let k = 0; k < n; k++) {
        i = (i + delta + n) % n;
        if (!menu.buttons[i].disabled) break;
      }
      focus(menu, i);
    };
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (menus.length > 1) menus.pop().remove();
      else close();
    } else if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'ArrowRight' && menu.buttons[menu.active]?.item.submenu) {
      event.preventDefault();
      activate(menu, menu.buttons[menu.active]);
    } else if (event.key === 'ArrowLeft' && menus.length > 1) {
      event.preventDefault();
      menus.pop().remove();
    } else if (event.key === 'Enter' && menu.buttons[menu.active]) {
      event.preventDefault();
      activate(menu, menu.buttons[menu.active]);
    }
  };
  function close() {
    menus.splice(0).forEach((m) => m.remove());
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    openMenu = null;
  }
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
  });
  openMenu = close;
}

/** 버튼 아래로 메뉴를 연다. */
export function menuBelow(button, items) {
  const rect = button.getBoundingClientRect();
  showMenu(rect.left, rect.bottom + 4, items);
}
