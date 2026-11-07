// 공통 창 틀(sheet) 부품: Clone · 레포지토리 만들기 · 설정이 같이 쓴다(스타일은 app.css 의 .sheet-*).
// 머리(제목 · 오른쪽 모드 토글) / 본문 / 바닥(왼쪽 안내 글 · 오른쪽 취소·주 버튼).

import { el } from './util.js';
import { icon } from './icons.js';

/** 머리: 제목과 오른쪽 것(모드 토글 등). */
export function sheetHead(title, ...right) {
  return el('div', { class: 'sheet-head' }, el('div', { class: 'modal-title', text: title }), ...right);
}

/** 본문. */
export function sheetBody(...children) {
  return el('div', { class: 'sheet-body' }, ...children);
}

/** 바닥 왼쪽 안내 글. say(글, 막힌 까닭이면 true) — 모자란 것은 흐린 글, 막힌 까닭은 빨간 글. */
export function sheetMessage() {
  const node = el('div', { class: 'sheet-message', role: 'status' });
  node.say = (text, error = false) => {
    node.textContent = text ?? '';
    node.classList.toggle('error', !!text && error);
    node.title = text ?? '';
  };
  return node;
}

/** 바닥: 왼쪽 안내 글 + 오른쪽 버튼들(취소, 주 버튼 순). */
export function sheetFoot(message, ...buttons) {
  return el('div', { class: 'sheet-foot' }, message, ...buttons);
}

/**
 * 제목 옆 모드 토글. items: [{value, label, icon}], onPick(value). 돌려준 set(value) 로 고른 것을 바꾼다(onPick 은 부르지 않는다).
 */
export function sheetModes(items, onPick) {
  const buttons = items.map((item) => el('button', {
    class: 'sheet-mode', type: 'button', role: 'tab', 'data-mode': item.value,
    onclick: () => onPick(item.value),
  }, item.icon ? icon(item.icon, 14) : null, item.label));
  const node = el('div', { class: 'sheet-modes', role: 'tablist' }, ...buttons);
  return {
    node,
    set(value) {
      for (const b of buttons) {
        const on = b.dataset.mode === value;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      }
    },
    setDisabled(off) {
      for (const b of buttons) b.disabled = off;
    },
  };
}

/** 창 높이를 바꾸는 내용 교체(모드 전환·진행 화면)를 부드럽게 잇는다(바뀌기 전 높이 → 바뀐 뒤 높이). */
export function morph(dialog, change) {
  const from = dialog.offsetHeight;
  change();
  const to = dialog.offsetHeight;
  if (from !== to && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    dialog.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 520, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
  }
}
