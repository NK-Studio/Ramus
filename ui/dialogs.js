// 확인 창·입력 창·우클릭 메뉴. 웹뷰의 confirm()/prompt() 는 플랫폼마다 모양·동작이 달라 직접 그린다.

import { el } from './util.js';

function overlay(onClose) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) onClose();
  });
  document.body.append(backdrop);
  return backdrop;
}

/**
 * 입력 칸이 있는 창. 고르면 {이름: 값}, 취소하면 null.
 * fields: [{name, label, value, type: 'text'|'password'|'checkbox'|'select'|'textarea', placeholder, options:[{value,label}], hint}]
 */
export function formDialog({ title, message, fields = [], ok = '확인', cancel = '취소', danger = false, validate }) {
  return new Promise((resolve) => {
    const inputs = {};
    const error = el('div', { class: 'modal-error', hidden: true });
    const close = (value) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const values = () => Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.type === 'checkbox' ? input.checked : input.value]));
    const submit = () => {
      const v = values();
      const problem = validate?.(v);
      if (problem) {
        error.textContent = problem;
        error.hidden = false;
        return;
      }
      close(v);
    };
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
        return el('label', { class: 'check modal-check' }, input, f.label, f.hint ? el('span', { class: 'muted small', text: ` ${f.hint}` }) : null);
      } else {
        input = el('input', { class: 'field', type: f.type || 'text', placeholder: f.placeholder || '', autocomplete: 'off', spellcheck: 'false' });
        input.value = f.value ?? '';
      }
      inputs[f.name] = input;
      return el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: f.label }), input,
        f.hint ? el('span', { class: 'muted small', text: f.hint }) : null);
    });
    const okButton = el('button', { class: `btn ${danger ? 'danger-strong' : 'primary'}`, text: ok, onclick: submit });
    const dialog = el('div', { class: 'modal', role: 'dialog' },
      el('div', { class: 'modal-title', text: title }),
      message ? el('div', { class: 'modal-message', text: message }) : null,
      rows,
      error,
      el('div', { class: 'modal-actions' },
        cancel ? el('button', { class: 'btn', text: cancel, onclick: () => close(null) }) : null,
        okButton));
    const backdrop = overlay(() => close(null));
    backdrop.append(dialog);
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(null);
      } else if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement) && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const first = dialog.querySelector('input:not([type=checkbox]), textarea, select');
    (first || okButton).focus();
    if (first?.select) first.select();
  });
}

/** 예/아니오 창. */
export async function confirmDialog({ title, message, ok = '확인', danger = false }) {
  return (await formDialog({ title, message, ok, danger })) !== null;
}

let openMenu = null;

/** 우클릭 메뉴. items: [{label, action, danger, disabled} | '-'] */
export function showMenu(x, y, items) {
  openMenu?.();
  const menu = el('div', { class: 'menu' }, items.map((item) => item === '-'
    ? el('div', { class: 'menu-sep' })
    : el('button', {
      class: `menu-item${item.danger ? ' danger' : ''}`,
      disabled: item.disabled,
      onclick: () => {
        close();
        item.action();
      },
    }, item.label)));
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  const onDown = (event) => {
    if (!menu.contains(event.target)) close();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  function close() {
    menu.remove();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    openMenu = null;
  }
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  });
  openMenu = close;
}
