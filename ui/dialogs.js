// 카드(확인·입력·고르기)·오류 대화상자·드로어·우클릭 메뉴. 원본 Window/GitConfirmDialog·GitPromptDialog·GitPickDialog·GitErrorDialog,
// Elements/SideDrawer·GitContextMenu 를 옮겼다. 웹뷰의 confirm()/prompt() 는 플랫폼마다 모양·동작이 달라 직접 그린다.

import { el, isComposing } from './util.js';
import { icon } from './icons.js';

const stack = [];

/** 빈 칸(null·false)은 빼고 붙인다 — 기본 append 는 null 을 "null" 글자로 바꿔 넣는다. */
const put = (parent, ...nodes) => parent.append(...nodes.filter((n) => n != null && n !== false));

/**
 * 막 + 카드(원본 branch-dialog). 머리: 강조색 원 배지(그림 또는 글자 하나) · 제목(그 아래 안내 한 줄) · 오른쪽 위 ✕.
 * 막을 눌러도 닫지 않는다 — 쓰던 이름을 실수로 잃지 않게(원본 GitBranchDialog). 닫기는 ✕·취소·Esc 로만.
 */
function card({ className = '', glyph, mark, tone = 'accent', title, hint, onCancel, closeTip = '닫기', close = true }) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const box = el('div', { class: `modal card ${className}`, role: 'dialog' });
  const badge = glyph || mark
    ? el('span', { class: `card-badge tone-${tone}` }, mark ? el('span', { class: 'card-mark', text: mark }) : icon(glyph, 26))
    : null;
  const head = el('div', { class: 'card-head' }, badge,
    el('div', { class: 'card-titles' }, el('div', { class: 'modal-title', text: title }), hint ? el('div', { class: 'card-hint', text: hint }) : null));
  // × 는 Tab 으로 가지 않는다 — Enter 대상 표시와 어긋나지 않게(원본 close.focusable = false). 마우스·Esc 로만.
  if (close) box.append(el('button', { class: 'card-close', tabindex: '-1', 'data-tip': closeTip, onclick: () => onCancel() }, icon('close', 14)));
  box.append(head);
  backdrop.append(box);
  document.body.append(backdrop);
  stack.push(backdrop);
  // 두 번 불려도(Enter 와 클릭이 겹침) 다른 카드를 빼지 않게 한 번만 지운다.
  const remove = () => {
    if (!backdrop.isConnected) return;
    backdrop.remove();
    stack.splice(stack.indexOf(backdrop), 1);
  };
  return { box, remove };
}

/** 카드의 주 버튼(원본 branch-dialog__create: 옅은 강조색 + 테두리, 마우스를 올리면 채움). 위험하면 같은 모양의 빨강. */
const cardOk = (text, danger = false) => el('button', { class: `btn card-ok${danger ? ' danger' : ''}`, text });
/** Esc(오래된 이름 'Esc'·keyCode 27 포함). */
const isEscape = (event) => event.key === 'Escape' || event.key === 'Esc' || event.keyCode === 27;

/**
 * Enter 가 누를 버튼을 채운 모양(.default)으로 보인다. 처음은 확인, Tab 으로 다른 버튼에 옮기면 표시와 Enter 대상이 함께 옮겨 간다
 * (원본 GitConfirmDialog.SetEnterTarget). 지금 대상 버튼을 돌려주는 함수를 돌려준다.
 */
function enterTarget(actions, okButton) {
  let target = okButton;
  const mark = (button) => {
    target = button;
    for (const b of actions.querySelectorAll('button')) b.classList.toggle('default', b === button);
  };
  actions.addEventListener('focusin', (event) => {
    if (event.target instanceof HTMLButtonElement) mark(event.target);
  });
  mark(okButton);
  return () => target;
}
/** 카드의 무채색 버튼(취소·다른 쪽). */
const cardButton = (text, onclick) => el('button', { class: 'btn card-cancel', text, onclick });

/**
 * 입력 칸이 있는 카드. 고르면 {이름: 값}, 취소하면 null.
 * fields: [{name, label, value, type: 'text'|'password'|'checkbox'|'select'|'textarea'|'static', placeholder, options:[{value,label}], hint, icon, text}]
 * ('static' 은 고칠 수 없는 한 줄 — 브랜치 카드의 "만들 위치:" 처럼 이름표 + 그림 + 굵은 글.)
 * 글 칸이 있으면 원본 GitPromptDialog 처럼 안내(message)를 제목 아래에, 없으면 원본 확인 카드처럼 제목 시작선에 맞춰 아래에 둔다.
 * validate(values) 는 쓰는 동안 불린다 — 문제가 있으면 카드 안 한 줄에 보이고 확인을 끈다. 첫 글 칸이 비어 있으면 문구 없이 확인만 끈다.
 * 버튼은 원본처럼 [확인][취소] 를 오른쪽에 붙인다.
 */
export function formDialog({ title, message, fields = [], ok = '확인', cancel = '취소', danger = false, validate, glyph, tone, className = '', extra, alert = false }) {
  return new Promise((resolve) => {
    const inputs = {};
    const hasText = fields.some((f) => f.type !== 'checkbox' && f.type !== 'static');
    // 문제 줄은 늘 자리를 잡아 카드가 흔들리지 않는다.
    const problem = el('div', { class: 'modal-error' }, ' ');
    let closed = false;
    const close = (value) => {
      if (closed) return;
      closed = true;
      remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const { box, remove } = card({
      className: `${hasText ? 'prompt' : 'confirm'}${alert ? ' alert' : ''} ${className}`.trim(),
      close: !alert,
      glyph: glyph ?? (danger ? 'warning' : 'info'), tone, title,
      hint: hasText ? message : null,
      onCancel: () => close(null),
      closeTip: cancel || '닫기',
    });
    const values = () => Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.type === 'checkbox' ? input.checked : input.value]));
    const okButton = cardOk(ok, danger);
    let firstText = null;
    const check = () => {
      const text = validate?.(values());
      // 비어 있을 때는 알리지 않는다 — 아직 쓰기 전이다(원본 BranchNameProblem.Empty). 확인만 끈다.
      const blank = firstText && !firstText.value.trim();
      problem.textContent = (blank ? '' : text) ||' ';
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
      if (f.type === 'static') {
        return el('div', { class: 'modal-field' }, f.label ? el('span', { class: 'modal-label', text: f.label }) : null,
          el('div', { class: 'card-static' }, f.icon ? icon(f.icon, 15) : null, el('span', { class: 'card-static-text', text: f.text ?? '' })));
      }
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
      if (!firstText && input.tagName !== 'SELECT') firstText = input;
      inputs[f.name] = input;
      input.addEventListener('input', check);
      input.addEventListener('change', check);
      const control = f.icon ? el('div', { class: 'field-with-icon' }, icon(f.icon, 16), input) : input;
      return el('label', { class: 'modal-field' }, f.label ? el('span', { class: 'modal-label', text: f.label }) : null, control,
        f.hint ? el('span', { class: 'muted small', text: f.hint }) : null);
    });
    // 원본처럼 [확인][취소] 를 오른쪽에 붙인다. 경고창(Fork 모양)은 macOS 처럼 [취소][확인] 을 같은 폭으로.
    const cancelButton = cancel ? cardButton(cancel, () => close(null)) : null;
    const actions = el('div', { class: 'modal-actions' });
    put(actions, ...(alert ? [cancelButton, okButton] : [okButton, cancelButton]));
    const target = enterTarget(actions, okButton);
    put(box,
      !hasText && message ? el('div', { class: 'modal-message', text: message }) : null,
      ...rows,
      extra ?? null,
      validate ? problem : null,
      actions);
    const onKey = (event) => {
      if (stack[stack.length - 1] !== box.parentElement) return;
      if (isEscape(event)) {
        event.preventDefault();
        event.stopPropagation();
        close(null);
      } else if (event.key === 'Enter' && !isComposing(event)) {
        const multiline = event.target instanceof HTMLTextAreaElement;
        if (multiline && !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        event.stopPropagation();
        // Enter 는 채운 버튼(기본은 확인, Tab 으로 옮겼으면 그 버튼)이다 — 위험한 확인(버리기·지우기)도 확인이 기본이다(빨강으로 구분).
        const button = target();
        if (button && button !== okButton) button.click();
        else submit();
      } else if (event.key !== 'Tab' && !box.contains(event.target)) {
        // 떠 있는 동안 밑의 목록·단축키가 키를 받지 않게 한다(Tab 은 버튼 사이를 옮겨 다닌다).
        event.stopPropagation();
      }
    };
    // 창 단계에서 가장 먼저 받는다 — 다른 곳(diff 닫기 등)이 Esc·Enter 를 먼저 쓰지 않게.
    window.addEventListener('keydown', onKey, true);
    check();
    const first = box.querySelector('input:not([type=checkbox]), textarea, select');
    if (first) {
      first.focus();
      if (first.select) first.select();
      check();
    } else okButton.focus();
  });
}

/** 예/아니오 카드. 위험하면 빨간 확인. Enter 는 채운 버튼(기본은 확인, Tab 으로 옮기면 그 버튼). alert 면 Fork(macOS 경고창) 모양. cancel 로 취소 버튼 글을 바꾼다(예: "원격은 남기기"). */
export async function confirmDialog({ title, message, ok = '확인', cancel = '취소', danger = false, glyph, tone, alert = false, extra, className }) {
  return (await formDialog({ title, message, ok, cancel, danger, glyph: glyph ?? (danger ? 'warning' : 'info'), tone, alert, extra, className })) !== null;
}

/**
 * 로컬 변경이 덮어써질까 봐 git 이 멈췄을 때: 짧은 안내 한 줄 + 덮어써질 파일 목록(스크롤, 이름 굵게·폴더 흐리게) + [Stash 하고 다시 {작업}].
 * git 원문을 그대로 늘어놓지 않는다. 고르면 true.
 */
export async function overwriteDialog({ title, op, files = [], untracked = false }) {
  const what = untracked ? '추적하지 않는 파일' : '커밋하지 않은 수정';
  const count = files.length ? ` ${files.length}개` : '';
  const message = `${what}${count}${files.length ? '가' : '이'} 덮어써질 수 있어 멈췄습니다. Stash 해 두고 다시 하면 그대로 이어집니다.`;
  const list = files.length ? el('div', { class: 'overwrite-files' }, files.map((path) => {
    const at = path.lastIndexOf('/');
    const dir = at < 0 ? '' : path.slice(0, at + 1);
    const name = at < 0 ? path : path.slice(at + 1);
    return el('div', { class: 'overwrite-file', 'data-tip': path },
      icon('file', 14), el('span', { class: 'overwrite-name', text: name }), dir ? el('span', { class: 'overwrite-dir', text: dir }) : null);
  })) : null;
  return (await formDialog({ title, message, glyph: 'stash', ok: `Stash 하고 다시 ${op}`, className: 'overwrite', extra: list })) !== null;
}

/** 세 갈래 카드(원본 ChooseAsync): [확인][다른 쪽][취소]. 'ok' | 'alt' | null. */
export function choiceDialog({ title, message, ok, alt, cancel = '취소', glyph = 'info', tone = 'accent' }) {
  return new Promise((resolve) => {
    let closed = false;
    const close = (value) => {
      if (closed) return;
      closed = true;
      remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const { box, remove } = card({ className: 'confirm', glyph, tone, title, onCancel: () => close(null), closeTip: cancel });
    const okButton = cardOk(ok);
    okButton.addEventListener('click', () => close('ok'));
    const actions = el('div', { class: 'modal-actions' }, okButton, cardButton(alt, () => close('alt')), cardButton(cancel, () => close(null)));
    box.append(el('div', { class: 'modal-message', text: message }), actions);
    const target = enterTarget(actions, okButton);
    const onKey = (event) => {
      if (stack[stack.length - 1] !== box.parentElement) return;
      if (isEscape(event)) {
        event.preventDefault();
        event.stopPropagation();
        close(null);
      } else if (event.key === 'Enter' && !isComposing(event)) {
        event.preventDefault();
        event.stopPropagation();
        target().click();
      } else if (event.key !== 'Tab' && !box.contains(event.target)) {
        event.stopPropagation();
      }
    };
    // 창 단계에서 가장 먼저 받는다 — 다른 곳(diff 닫기 등)이 Esc·Enter 를 먼저 쓰지 않게.
    window.addEventListener('keydown', onKey, true);
    okButton.focus();
  });
}

/**
 * 여러 개 중 하나 고르기(원본 GitPickDialog). 항목을 한 번 누르면 바로 고르고 닫는다. ↑↓(끝에서 멈춤)·Enter, Esc·[취소].
 * options: [{value, label, hint}]. 고른 value 또는 null. (ok 는 예전 호출과 맞추려고 받기만 한다.)
 */
export function pickDialog({ title, message, options, value, glyph = 'info' }) {
  return new Promise((resolve) => {
    let index = Math.max(0, options.findIndex((o) => o.value === value));
    let closed = false;
    const close = (v) => {
      if (closed) return;
      closed = true;
      remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const { box, remove } = card({ className: 'confirm pick', glyph, title, onCancel: () => close(null), closeTip: '취소' });
    const list = el('div', { class: 'pick-list', role: 'listbox' });
    const buttons = options.map((o, i) => el('button', {
      class: 'pick-item',
      onclick: () => close(o.value),
      onmouseenter: () => select(i, false),
    }, el('span', { class: 'pick-label', text: o.label }), o.hint ? el('span', { class: 'pick-hint', text: o.hint }) : null));
    const select = (i, focus = true) => {
      if (!buttons.length) return;
      index = Math.max(0, Math.min(buttons.length - 1, i));
      buttons.forEach((b, k) => b.classList.toggle('on', k === index));
      if (focus) buttons[index].focus();
    };
    list.append(...buttons);
    put(box, message ? el('div', { class: 'modal-message', text: message }) : null, list,
      el('div', { class: 'modal-actions' }, cardButton('취소', () => close(null))));
    const onKey = (event) => {
      if (stack[stack.length - 1] !== box.parentElement) return;
      if (event.key === 'Escape') close(null);
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        select(index + (event.key === 'ArrowDown' ? 1 : -1));
      } else if (event.key === 'Enter' && !isComposing(event)) {
        event.preventDefault();
        if (options[index]) close(options[index].value);
      }
    };
    document.addEventListener('keydown', onKey, true);
    select(index);
  });
}

// ── 오류 대화상자 ──

const COPY_FEEDBACK_MS = 1200;

/** 알아보지 못한 오류는 설명 쪽에도 git 이 남긴 앞 몇 줄을 함께 보인다(원본 UnknownPreviewLines). */
const UNKNOWN_PREVIEW_LINES = 3;

/**
 * git 실패를 "설명 / git 원문" 으로 보인다(원본 GitErrorDialog). 빨간 원에 "!". 고른 쪽은 기억한다(prefs).
 * 설명: 원인(굵게) · (알아보지 못한 오류면 원문 앞 3줄) · 해결. 두 보기를 겹쳐 두어 바꿀 때 카드 높이가 오르내리지 않는다.
 * [전체 복사] 는 git 원문 쪽에서만 보인다(자리는 지킨다). 회사망 SSL 이면 [SSL 설정 열기].
 * 충돌은 실패가 아니라 해결을 기다리는 단계라 빨간 오류 대신 안내 카드와 [충돌 보기]·[닫기].
 * actions: { openSsl(), showConflicts(), prefs, title }
 */
export function errorDialog(error, { openSsl, showConflicts, prefs, title } = {}) {
  const advice = error?.advice ?? { kind: 'unknown', cause: '', fix: '' };
  const raw = String(error?.message ?? error).trim();
  if (advice.kind === 'conflict' && showConflicts) {
    const files = advice.files ?? [];
    const head = files.length ? `자동으로 합치지 못한 파일이 ${files.length}개 있습니다.` : '자동으로 합치지 못한 파일이 있습니다.';
    return confirmDialog({
      title: '충돌을 해결해야 합니다', glyph: 'branch', ok: '충돌 보기', cancel: '닫기',
      message: `${head}\n파일을 고치거나 한쪽을 고른 뒤 Stage 하고, 위쪽 띠에서 이어가세요.${files.length ? `\n\n${files.slice(0, 10).join('\n')}` : ''}`,
    }).then((show) => {
      if (show) showConflicts();
    });
  }
  return new Promise((resolve) => {
    let mode = prefs?.get('error.mode') ?? 'friendly';
    const close = () => {
      remove();
      document.removeEventListener('keydown', onKey, true);
      resolve();
    };
    const { box, remove } = card({ className: 'confirm error-card', mark: '!', tone: 'error', title: title ?? '작업을 끝내지 못했습니다', onCancel: close });
    const preview = raw.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(0, UNKNOWN_PREVIEW_LINES).join('\n');
    const friendly = el('div', { class: 'error-view' },
      advice.cause ? el('div', { class: 'error-cause', text: advice.cause }) : null,
      advice.kind === 'unknown' || !advice.cause ? el('pre', { class: 'error-raw', text: preview }) : null,
      advice.fix ? el('div', { class: 'error-fix', text: advice.fix }) : null);
    const developer = el('div', { class: 'error-view' }, el('pre', { class: 'error-raw', text: raw }));
    const seg = el('div', { class: 'seg error-modes' });
    const copy = el('button', {
      class: 'btn card-cancel error-copy', text: '전체 복사',
      onclick: () => {
        navigator.clipboard?.writeText(raw);
        copy.textContent = '복사됨';
        setTimeout(() => { copy.textContent = '전체 복사'; }, COPY_FEEDBACK_MS);
      },
    });
    const draw = () => {
      seg.replaceChildren(
        el('button', { class: mode === 'friendly' ? 'on' : '', text: '설명', onclick: () => setMode('friendly') }),
        el('button', { class: mode === 'raw' ? 'on' : '', text: 'git 원문', onclick: () => setMode('raw') }));
      friendly.classList.toggle('hidden', mode !== 'friendly');
      developer.classList.toggle('hidden', mode === 'friendly');
      copy.style.visibility = mode === 'friendly' ? 'hidden' : '';
    };
    const setMode = (m) => {
      mode = m;
      prefs?.set('error.mode', m);
      draw();
    };
    draw();
    const okButton = cardOk('확인');
    okButton.addEventListener('click', close);
    box.append(seg, el('div', { class: 'error-stack' }, friendly, developer),
      el('div', { class: 'modal-actions' },
        copy,
        (error?.ssl || advice.kind === 'ssl') && openSsl ? cardButton('SSL 설정 열기', () => { close(); openSsl(); }) : null,
        okButton));
    const onKey = (event) => {
      if (stack[stack.length - 1] !== box.parentElement) return;
      if (event.key === 'Escape' || (event.key === 'Enter' && !isComposing(event))) {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKey, true);
    okButton.focus();
  });
}

// ── 드로어 ──

let openDrawerState = null;

/** 드로어가 미끄러져 들어오고 나가는 시간(ms). 원본 side-drawer 의 transition 0.4s ease-out-circ. */
const DRAWER_SLIDE_MS = 400;

/**
 * 사이드바 옆에서 밀려 나오는 입력 칸(원본 SideDrawer). 사이드바 오른쪽 가장자리 뒤에서 제 폭만큼 끝까지 미끄러져 나온다.
 * 한 번에 하나(바꿔 끼울 때는 움직임 없이). build(body, close) 가 내용을 채운다. anchor 는 드로어가 붙을 왼쪽 경계 요소(사이드바).
 */
export function openDrawer({ glyph, title, anchor, build, width = 480 }) {
  const swap = !!openDrawerState;
  openDrawerState?.close(true);
  const rect = anchor.getBoundingClientRect();
  // 원본은 본문이 서랍을 잘라 사이드바 위로 그려지지 않는다. 같은 자리를 잘라 보이는 틀에 담는다(틀은 포인터를 받지 않는다).
  const room = Math.max(0, window.innerWidth - rect.right);
  const clip = el('div', { class: 'drawer-clip', style: { left: `${rect.right}px`, top: `${rect.top}px`, height: `${rect.height}px`, width: `${room}px` } });
  const panel = el('aside', { class: `drawer${swap ? ' no-anim' : ''}`, style: { width: `${Math.min(width, room)}px` } },
    el('div', { class: 'drawer-head' }, glyph ? icon(glyph, 20, 'drawer-glyph') : null, el('div', { class: 'drawer-title', text: title }),
      el('button', { class: 'card-close', 'data-tip': '닫기', onclick: () => close() }, icon('close', 14))));
  const body = el('div', { class: 'drawer-body' });
  panel.append(body);
  clip.append(panel);
  document.body.append(clip);
  const onKey = (event) => {
    if (event.key === 'Escape' && !document.querySelector('.modal-backdrop, .menu')) {
      // 서랍 안 고르기 칸의 목록이 열려 있으면 그 Esc 는 목록을 닫는 데 쓴다(원본 IsInOpenSelect).
      if (event.target instanceof Element && event.target.closest('.search-select.open')) return;
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  function close(immediate = false) {
    if (openDrawerState?.panel !== panel) return;
    openDrawerState = null;
    document.removeEventListener('keydown', onKey, true);
    if (immediate) clip.remove();
    else {
      panel.classList.add('closing');
      setTimeout(() => clip.remove(), DRAWER_SLIDE_MS);
    }
  }
  openDrawerState = { panel, close };
  build(body, close);
  // build 가 이미 포커스를 정했으면(예: PR 만들기의 제목 칸) 그대로 둔다 — 고르기 칸은 포커스만 받아도 목록을 펼친다.
  if (!body.contains(document.activeElement)) body.querySelector('input, textarea, select')?.focus();
  return close;
}

export const closeDrawer = () => openDrawerState?.close();

/** 드로어의 주 버튼: 폭을 다 쓰는 초록 버튼(원본 side-drawer__primary). 드로어에는 취소 버튼을 두지 않는다(✕·Esc). */
export const drawerPrimary = (text, onclick) => el('button', { class: 'btn drawer-primary', text, onclick });

/** 드로어 안 이름표 + 칸 한 묶음(원본 SideDrawer.Caption + Field). */
export const drawerField = (caption, control) => el('div', { class: 'drawer-field' }, caption ? el('span', { class: 'drawer-caption', text: caption }) : null, control);

/** 드로어의 문제 한 줄. 문제가 없으면 숨는다(원본 SideDrawer.Problem). set(text) 로 바꾼다. */
export function drawerProblem() {
  const node = el('div', { class: 'drawer-problem', hidden: true });
  node.set = (text) => {
    node.textContent = text ?? '';
    node.hidden = !text;
  };
  return node;
}

/**
 * 검색되는 고르기 칸: 글자 칸·구분선·⌄, 걸러진 목록이 아래를 덮어 펼쳐진다(↑↓·Enter).
 * items: [{value, label, hint, icon, image}] — image 는 작은 둥근 그림(아바타) 주소. 고른 항목의 그림은 글자 칸 앞에도 보인다.
 * clearable 이면 고른 값 옆 ✕ 로 비운다(onChange(null)). 돌려준 것의 setItems·setDisabled 로 목록·켜짐을 바꾼다.
 */
export function searchSelect({ items, value, placeholder = '', onChange, clearable = false }) {
  let current = value;
  let all = items;
  const input = el('input', { class: 'ss-input', placeholder, spellcheck: 'false', autocomplete: 'off' });
  const list = el('div', { class: 'ss-list', hidden: true });
  const prefix = el('span', { class: 'ss-prefix', hidden: true });
  const clear = clearable ? el('span', { class: 'ss-clear', 'data-tip': '비우기', hidden: true }, icon('close', 12)) : null;
  const wrap = el('div', { class: 'search-select' }, prefix, input, clear, el('span', { class: 'ss-sep' }), el('span', { class: 'ss-caret' }, icon('chevronDown', 14)), list);
  let active = 0;
  let shown = [];
  const itemOf = (v) => all.find((i) => i.value === v);
  const labelOf = (v) => itemOf(v)?.label ?? v ?? '';
  const avatar = (src) => el('img', { class: 'ss-image', src, alt: '', onerror: (e) => { e.target.style.visibility = 'hidden'; } });
  const sync = () => {
    input.value = labelOf(current);
    const image = itemOf(current)?.image;
    prefix.replaceChildren(...(image ? [avatar(image)] : []));
    prefix.hidden = !image;
    if (clear) clear.hidden = current == null || current === '';
  };
  sync();
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = all.filter((i) => !q || i.label.toLowerCase().includes(q) || labelOf(current).toLowerCase() === q);
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren(...(shown.length ? shown.map((i, k) => el('div', {
      class: `ss-item${k === active ? ' on' : ''}${i.value === current ? ' chosen' : ''}`,
      onpointerdown: (e) => { e.preventDefault(); choose(i); },
    }, i.image ? avatar(i.image) : i.icon ? icon(i.icon, 14) : null, el('span', { text: i.label }), i.hint ? el('span', { class: 'muted small', text: i.hint }) : null))
      : [el('div', { class: 'ss-empty muted small', text: '없습니다' })]));
    list.querySelector('.ss-item.on')?.scrollIntoView({ block: 'nearest' });
  };
  // 목록이 열려 있으면 바깥 상자에 open — 드로어가 그 Esc 를 목록 닫기에 양보한다.
  const setOpen = (on) => {
    list.hidden = !on;
    wrap.classList.toggle('open', on);
  };
  // 아래에 자리가 모자라면(카드·드로어 아래끝에 가까우면) 위로 펼친다.
  const open = () => {
    setOpen(true);
    draw();
    const r = wrap.getBoundingClientRect();
    const bound = wrap.closest('.modal, .drawer-body')?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    const need = Math.min(list.scrollHeight, 240) + 4;
    wrap.classList.toggle('up', bound.bottom - r.bottom < need && r.top - bound.top > bound.bottom - r.bottom);
  };
  const choose = (item) => {
    current = item.value;
    sync();
    setOpen(false);
    onChange?.(item.value);
  };
  input.addEventListener('focus', () => { input.select(); open(); });
  input.addEventListener('input', () => { active = 0; open(); });
  input.addEventListener('blur', () => { setOpen(false); sync(); });
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
      setOpen(false);
    }
  });
  wrap.querySelector('.ss-caret').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (input.disabled) return;
    if (document.activeElement === input && !list.hidden) setOpen(false);
    else if (document.activeElement === input) open();
    else input.focus();
  });
  clear?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    current = null;
    sync();
    setOpen(false);
    onChange?.(null);
  });
  return {
    element: wrap,
    get value() { return current; },
    set(v) { current = v; sync(); },
    setItems(next) { all = next; if (!list.hidden) draw(); sync(); },
    setDisabled(off) { input.disabled = off; wrap.classList.toggle('disabled', off); if (off) setOpen(false); },
  };
}

// ── 우클릭 메뉴 ──

let openMenu = null;

/**
 * 메뉴의 "다른 항목" 보조키: macOS 는 Option(Finder 처럼), Windows·Linux 는 Shift.
 * (Windows 에서 Alt 는 창 메뉴 막대로 키를 가져가고, 탐색기의 영구 삭제도 Shift+Delete 다.)
 */
export function altModifier(event) {
  return document.documentElement.dataset.platform === 'macos' ? !!event?.altKey : !!event?.shiftKey;
}

/**
 * 우클릭 메뉴. items: [{label, action, danger, disabled, checked, submenu:[…], hint, alt} | '-']
 * 하위 메뉴(›), 체크 표시, 키보드(↑↓·Enter·→·←·Esc).
 * alt: 보조키(altModifier)를 누르고 있는 동안 그 자리에 대신 보일 항목({label, action, danger, disabled}).
 * 메뉴가 떠 있는 동안 키를 누르고 떼면 바로 바뀐다. `alt` 옵션은 메뉴를 열 때 이미 누르고 있었는지.
 */
export function showMenu(x, y, items, { alt: altHeld = false } = {}) {
  openMenu?.();
  const menus = [];
  let altOn = altHeld;
  const variant = (item) => (altOn && item.alt ? item.alt : item);

  function build(entries, left, top, parentItem) {
    const usable = entries.filter((e) => e !== '-' && !e.disabled);
    // 체크 표시를 쓰는 항목이 없으면 왼쪽 체크 칸을 접는다(JetBrains 팝업처럼 글자가 왼쪽에 붙는다).
    const checks = entries.some((e) => e !== '-' && e.checked !== undefined);
    const menu = el('div', { class: `menu${checks ? '' : ' no-check'}`, role: 'menu' });
    const buttons = [];
    for (const item of entries) {
      if (item === '-') {
        menu.append(el('div', { class: 'menu-sep' }));
        continue;
      }
      const shown = variant(item);
      const button = el('button', {
        class: `menu-item${shown.danger ? ' danger' : ''}${item.submenu ? ' has-sub' : ''}`,
        disabled: shown.disabled,
      },
      el('span', { class: 'menu-check' }, item.checked ? icon('check', 14) : null),
      el('span', { class: 'menu-label', text: shown.label }),
      item.hint ? el('span', { class: 'menu-hint', text: item.hint }) : null,
      item.submenu ? el('span', { class: 'menu-arrow' }, icon('chevronRight', 12)) : null);
      button.base = item;
      button.item = shown;
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

  /** 보조키 상태가 바뀌면 alt 가 있는 항목을 그 자리에서 바꿔 보인다(크기가 달라지지 않게 글자·색·켜짐만). */
  function applyAlt(on) {
    if (on === altOn) return;
    altOn = on;
    for (const menu of menus) {
      for (const button of menu.buttons) {
        if (!button.base.alt) continue;
        const shown = variant(button.base);
        button.item = shown;
        button.disabled = !!shown.disabled;
        button.classList.toggle('danger', !!shown.danger);
        button.querySelector('.menu-label').textContent = shown.label;
      }
    }
  }
  const onModifier = (event) => applyAlt(altModifier(event));

  const onDown = (event) => {
    if (!menus.some((m) => m.contains(event.target))) close();
  };
  const onKey = (event) => {
    onModifier(event);
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
    document.removeEventListener('keyup', onModifier, true);
    document.removeEventListener('pointermove', onModifier, true);
    window.removeEventListener('blur', close);
    openMenu = null;
  }
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onModifier, true);
    // 메뉴 밖에서 키를 떼고 돌아와도 맞게, 마우스가 움직일 때도 보조키 상태를 다시 본다.
    document.addEventListener('pointermove', onModifier, true);
    window.addEventListener('blur', close);
  });
  openMenu = close;
}

/** 버튼 아래로 메뉴를 연다. */
export function menuBelow(button, items, options) {
  const rect = button.getBoundingClientRect();
  showMenu(rect.left, rect.bottom + 4, items, options);
}
