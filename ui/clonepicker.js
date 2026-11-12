// Clone 창의 GitHub 목록: 로그인한 계정이 볼 수 있는 레포지토리(내 것·협업·조직)를 최근 push 순으로 보이고,
// 찾기 칸과 소유자 드롭다운으로 좁혀 하나를 고른다. 이 PC 에 이미 받아 둔 것은 "이미 받음" 으로 표시한다(Rust githubCloneList).
//
// 레포지토리가 많은 계정도 기다리지 않게:
// 1) 지난번에 다 읽은 목록(디스크 캐시, githubCloneCache)을 창을 열자마자 보인다. 읽은 지 FRESH_MS 가 안 됐으면 다시 읽지 않고,
//    지났으면 뒤에서 조용히 새로 읽어 다 읽으면 한 번에 바꾼다(아래 줄의 새로고침 버튼만 돈다). 버튼으로 언제든 새로 읽는다.
// 2) 캐시가 없으면 100개씩 읽는 쪽이 올 때마다 목록을 늘려 보인다(첫 쪽부터 고를 수 있다).
// 3) 계정 목록은 목록 읽기와 따로 부른다.

import { el, relativeTime, formatDate, githubAvatar } from './util.js';
import { icon } from './icons.js';
import { scoped } from './i18n.js';

/** 이 모듈의 글(locales/en/clonepicker.js 를 먼저 본다). */
const t = scoped('clonepicker');

/** 한 번에 보일 레포지토리 수의 끝(100개씩 10쪽). 넘으면 앞쪽(최근 push 순)만 보인다. */
const MAX_REPOS = 1000;
/** 이보다 최근에 읽은 목록이면 창을 열 때 다시 읽지 않는다. */
const FRESH_MS = 10 * 60 * 1000;

/** 같은 실행 안에서 창을 다시 열면 지난 목록을 먼저 보인다. 계정마다 따로: key → {account, repos, truncated} */
const caches = new Map(); // key → {account, repos, truncated, at(읽은 때, ms)}
/** 지난번에 본 계정 — 다시 열면 그 계정으로. */
let lastAccount = null;
/** 지난번에 읽은 계정 목록 [{source, login}] — 메뉴를 바로 열 수 있게. */
let knownAccounts = null;
const accountKey = (a) => (a ? `${a.source}:${a.login.toLowerCase()}` : '');
const SOURCE_HINT = { app: t('앱 로그인') };
/** 남이 만든 fork 는 뺀다(조직 레포를 팀원들이 fork 해 둔 것이 원본 옆에 줄줄이 뜨지 않게). 내 계정의 fork 는 남긴다. */
const withoutForeignForks = (repos, who) => (repos ?? []).filter((r) => !r.fork || (r.owner ?? '').toLowerCase() === (who?.login ?? '').toLowerCase());

/** 마우스를 올려 두고 카드가 뜰 때까지(카드가 이미 떠 있으면 줄을 옮길 때 바로 바뀐다). */
const CARD_DELAY_MS = 500;

/** GitHub 크기(KB) → 사람이 읽는 크기. */
function formatSize(kb) {
  if (kb == null) return null;
  if (kb < 1024) return `${kb} KB`;
  const mb = kb / 1024;
  return mb < 1024 ? `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

/** 찾기 칸에 붙여 넣은 글이 레포지토리 주소처럼 보이는지(그러면 URL 쪽으로 넘긴다). */
const LOOKS_LIKE_URL = /^(https?:\/\/|ssh:\/\/|git@|[\w.-]+@[\w.-]+:)/i;

/**
 * login: github.login(Device Flow). onSelect(repo|null): 고른 것이 바뀜. onActivate(): 두 번 누르기·Enter(바로 받기).
 * onUrl(text): 찾기 칸에 주소를 붙여 넣음.
 */
export function githubPicker({ call, login, onSelect, onActivate, onUrl }) {
  let account = lastAccount; // 목록을 읽을(받을) 계정 {source, login}. null 이면 Rust 가 기본 계정을 고른다.
  let accounts = knownAccounts;
  let data = caches.get(accountKey(account)) ?? null; // {account, repos, truncated}
  let signedIn = data ? true : null;
  let loading = false;
  let growing = false; // 캐시 없이 쪽마다 늘려 보이는 중(더 올 것이 있다)
  let error = null;
  let query = '';
  let owner = '';
  let selected = null; // fullName
  let shown = []; // 지금 걸러 보이는 목록(위아래 키로 옮겨 다닌다)
  let disposed = false;

  const search = el('input', { class: 'field', placeholder: t('레포지토리 찾기 — 이름·설명·소유자'), autocomplete: 'off', spellcheck: 'false' });
  const searchBox = el('label', { class: 'cgh-search' }, icon('search', 14), search);
  // 소유자 고르기(전체 · 내 계정 · 그 밖의 소유자): 위에 찾기 칸이 있는 드롭다운.
  const ownerButton = el('button', { class: 'cgh-select', type: 'button', 'data-tip': t('소유자로 좁히기'), onclick: () => toggleOwnerPopover() });
  const accountButton = el('button', { class: 'cgh-account', type: 'button', 'data-tip': t('목록을 읽고 받을 GitHub 계정'), onclick: () => toggleAccountPopover() });
  const list = el('div', { class: 'cgh-list', role: 'listbox', 'aria-label': t('GitHub 레포지토리') });
  const note = el('div', { class: 'cgh-note muted small' });
  const node = el('div', { class: 'cgh' }, el('div', { class: 'cgh-bar' }, searchBox, ownerButton, accountButton), list, note);

  const current = () => data?.repos.find((r) => r.fullName === selected) ?? null;
  const ownerOf = (r) => r.owner ?? r.fullName.split('/')[0];
  const me = () => (data?.account ?? account)?.login ?? '';

  function select(fullName, { scroll = false } = {}) {
    if (selected === fullName) return;
    selected = fullName;
    for (const row of list.querySelectorAll('.cgh-row')) {
      const on = row.dataset.name === fullName;
      row.classList.toggle('on', on);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on && scroll) row.scrollIntoView({ block: 'nearest' });
    }
    onSelect(current());
  }

  function matches(r) {
    if (owner && ownerOf(r).toLowerCase() !== owner.toLowerCase()) return false;
    if (!query) return true;
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = `${r.fullName} ${r.description ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }

  const badge = (text, kind = '') => el('span', { class: `cgh-badge ${kind}`, text });

  function row(r) {
    const on = r.fullName === selected;
    return el('div', {
      class: `cgh-row${on ? ' on' : ''}${r.archived ? ' archived' : ''}`, role: 'option', 'aria-selected': on ? 'true' : 'false', 'data-name': r.fullName,
      onclick: () => select(r.fullName),
      ondblclick: () => { hideCard(); select(r.fullName); onActivate(); },
      onpointerenter: (event) => hoverRow(r, event.currentTarget),
    },
      el('span', { class: 'cgh-icon' }, icon(r.private ? 'lock' : 'github', 14)),
      el('div', { class: 'cgh-main' },
        el('div', { class: 'cgh-title' },
          el('span', { class: 'cgh-owner', text: `${ownerOf(r)} / ` }),
          el('span', { class: 'cgh-name', text: r.name }),
          r.fork ? badge('fork') : null,
          r.archived ? badge(t('보관됨')) : null,
          r.local ? badge(t('이미 받음'), 'local') : null),
        r.description ? el('div', { class: 'cgh-desc', text: r.description }) : null));
  }

  // ── 마우스를 올린 줄의 자세한 카드 ──
  // 줄에서 뺀 것(전체 설명·마지막 push·크기·기본 브랜치·별·받아 둔 위치)을 보인다. Clone 창 오른쪽 바깥에 띄우고,
  // 자리가 없으면 줄 아래에 겹쳐 띄운다. 카드는 마우스를 받지 않는다(목록을 가리거나 붙잡지 않게).

  const card = el('div', { class: 'cgh-card', role: 'tooltip', hidden: true });
  let cardTimer = 0;
  let cardFor = null; // 카드가 보이는 레포지토리 fullName

  function cardBody(r) {
    const pushed = r.pushedAt ? Date.parse(r.pushedAt) / 1000 : null;
    const facts = [
      [t('공개 범위'), r.private ? t('비공개') : t('공개')],
      r.fork ? [t('원본'), r.parent?.fullName ?? 'fork'] : null,
      r.archived ? [t('상태'), t('보관됨(읽기 전용)')] : null,
      pushed ? [t('마지막 push'), `${relativeTime(pushed)} · ${formatDate(pushed, true)}`] : null,
      r.sizeKb != null ? [t('크기'), formatSize(r.sizeKb)] : null,
      r.defaultBranch ? [t('기본 브랜치'), r.defaultBranch] : null,
      r.stars ? [t('별'), r.stars.toLocaleString()] : null,
      r.local ? [t('이 PC'), el('span', { class: 'cgh-card-path', text: r.local })] : null,
    ].filter(Boolean);
    return [
      el('div', { class: 'cgh-card-head' },
        icon(r.private ? 'lock' : 'github', 14),
        el('span', { class: 'cgh-card-owner', text: `${ownerOf(r)} / ` }),
        el('span', { class: 'cgh-card-name', text: r.name })),
      el('div', { class: `cgh-card-desc${r.description ? '' : ' none'}`, text: r.description || t('설명이 없습니다.') }),
      el('div', { class: 'cgh-card-facts' }, ...facts.flatMap(([label, value]) => [
        el('span', { class: 'cgh-card-label', text: label }),
        el('span', { class: 'cgh-card-value' }, value),
      ])),
    ];
  }

  function placeCard(rowEl) {
    const row = rowEl.getBoundingClientRect();
    const dialog = node.closest('.modal')?.getBoundingClientRect() ?? node.getBoundingClientRect();
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const clampTop = (top) => Math.max(8, Math.min(top, window.innerHeight - height - 8));
    if (window.innerWidth - dialog.right >= width + 20) {
      card.style.left = `${dialog.right + 12}px`;
      card.style.top = `${clampTop(row.top)}px`;
    } else {
      // 오른쪽에 자리가 없으면 줄 아래(아래가 모자라면 위)에 겹쳐 띄운다.
      card.style.left = `${Math.max(8, Math.min(row.left + 28, window.innerWidth - width - 8))}px`;
      card.style.top = `${row.bottom + 4 + height > window.innerHeight - 8 ? Math.max(8, row.top - height - 4) : row.bottom + 4}px`;
    }
  }

  function showCard(r, rowEl) {
    if (disposed || !rowEl.isConnected || node.hidden) return;
    if (!card.isConnected) document.body.append(card);
    cardFor = r.fullName;
    card.replaceChildren(...cardBody(r));
    const appearing = card.hidden;
    card.hidden = false;
    placeCard(rowEl);
    if (appearing && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      card.animate([{ opacity: 0, transform: 'translateY(2px)' }, { opacity: 1, transform: 'none' }], { duration: 120, easing: 'ease-out' });
    }
  }

  function hoverRow(r, rowEl) {
    clearTimeout(cardTimer);
    if (!card.hidden) {
      if (cardFor !== r.fullName) showCard(r, rowEl);
      return;
    }
    cardTimer = setTimeout(() => showCard(r, rowEl), CARD_DELAY_MS);
  }

  function hideCard() {
    clearTimeout(cardTimer);
    card.hidden = true;
    cardFor = null;
  }

  list.addEventListener('pointerleave', hideCard);
  list.addEventListener('scroll', hideCard, { passive: true });
  list.addEventListener('pointerdown', () => clearTimeout(cardTimer));

  // ── 계정 ──

  const avatarOf = (login, small = false) => githubAvatar(login, { size: small ? 'small' : undefined });

  function drawAccount() {
    const who = data?.account ?? account;
    accountButton.hidden = signedIn === false || !who;
    accountPop?.redraw();
    if (!who) return;
    accountButton.replaceChildren(avatarOf(who.login), el('span', { class: 'cgh-account-name', text: who.login }), icon('chevronDown', 12));
  }

  // 계정 드롭다운: 열려 있는 동안 계정 목록이 도착하면 그 자리에서 다시 그린다.
  let accountPop = null; // {close, redraw}

  function toggleAccountPopover() {
    hideCard();
    popover?.close();
    if (accountPop) {
      accountPop.close();
      return;
    }
    const items = el('div', { class: 'cgh-pop-list', role: 'listbox' });
    // .menu: 열려 있는 동안 Esc 가 Clone 창이 아니라 이 드롭다운을 닫는다(screens.js modal).
    const pop = el('div', { class: 'menu cgh-pop cgh-pop-accounts', role: 'dialog', 'aria-label': t('GitHub 계정 고르기'), tabindex: '-1' }, items);
    let entries = [];
    let active = -1;
    const draw = () => {
      const who = data?.account ?? account;
      const now = accountKey(who);
      const list = accounts ?? (who ? [who] : []);
      entries = list.map((a) => ({ account: a, chosen: accountKey(a) === now }));
      // 앱으로 로그인한 계정이 없으면 여기서 로그인할 수 있게.
      if (accounts && !list.some((a) => a.source === 'app')) entries.push({ login: true });
      if (active < 0) active = Math.max(0, entries.findIndex((e) => e.chosen));
      active = Math.min(active, entries.length - 1);
      items.replaceChildren(...[...entries.map((e, k) => el('div', {
        class: `cgh-pop-item${k === active ? ' active' : ''}${e.chosen ? ' chosen' : ''}${e.login ? ' action' : ''}`, role: 'option',
        onpointerdown: (event) => { event.preventDefault(); choose(e); },
        onpointermove: () => { if (active !== k) { active = k; draw(); } },
      }, ...(e.login
        ? [el('span', { class: 'cgh-pop-check' }, icon('github', 13)), el('span', { class: 'cgh-pop-label', text: t('GitHub 로 로그인…') })]
        : [el('span', { class: 'cgh-pop-check' }, e.chosen ? icon('check', 13) : null), avatarOf(e.account.login, true),
          el('span', { class: 'cgh-pop-label', text: e.account.login }),
          el('span', { class: 'cgh-pop-hint', text: SOURCE_HINT[e.account.source] ?? e.account.source })]))),
      // 아직 다른 계정을 찾는 중이면 맨 아래에 알린다 — 다 찾으면 이 줄이 계정들로 바뀐다.
      accounts ? null : el('div', { class: 'cgh-pop-loading muted small' }, el('span', { class: 'cgh-spinner small' }), t('다른 계정을 찾는 중…'))].filter(Boolean));
    };
    const choose = (e) => {
      close();
      if (e.login) login.dialog();
      else if (!e.chosen) switchAccount(e.account);
      search.focus();
    };
    const onOutside = (event) => {
      if (!pop.contains(event.target) && !accountButton.contains(event.target)) close();
    };
    function close() {
      pop.remove();
      document.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('resize', close);
      accountPop = null;
    }
    pop.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        active = Math.max(0, Math.min(entries.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)));
        draw();
      } else if (event.key === 'Enter' && entries[active]) {
        event.preventDefault();
        event.stopPropagation();
        choose(entries[active]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        accountButton.focus();
      }
    });
    const rect = accountButton.getBoundingClientRect();
    const width = Math.max(rect.width, 240);
    // 오른쪽 끝을 버튼에 맞춘다(버튼이 창 오른쪽에 있다).
    pop.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    pop.style.top = `${rect.bottom + 4}px`;
    pop.style.width = `${width}px`;
    document.body.append(pop);
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('resize', close);
    accountPop = { close, redraw: draw };
    draw();
    pop.focus();
  }

  async function loadAccounts() {
    const result = await call('githubCloneAccounts').catch(() => null);
    if (disposed || !result) return;
    accounts = knownAccounts = result.accounts ?? [];
    accountPop?.redraw();
  }

  function switchAccount(next) {
    account = lastAccount = next;
    data = caches.get(accountKey(next)) ?? null;
    owner = '';
    if (selected) {
      selected = null;
      onSelect(null);
    }
    drawAll();
    load();
  }

  // ── 소유자 드롭다운(위에 찾기 칸) ──

  /** 소유자마다 레포지토리 수와, 보일 차례(내 계정 먼저, 그다음 많은 순·이름 순). */
  function owners() {
    const counts = new Map();
    for (const r of data?.repos ?? []) counts.set(ownerOf(r), (counts.get(ownerOf(r)) ?? 0) + 1);
    const mine = me();
    const order = [...counts.keys()].sort((a, b) => (a === mine ? -1 : b === mine ? 1 : counts.get(b) - counts.get(a) || a.localeCompare(b)));
    return { mine, counts, order };
  }

  const ownerLabel = (o, mine) => (o === mine ? t('{owner} (나)', { owner: o }) : o);

  function drawOwners() {
    popover?.redraw();
    const { mine, counts, order } = owners();
    ownerButton.hidden = signedIn === false || order.length < 2;
    if (ownerButton.hidden) return;
    ownerButton.classList.toggle('on', !!owner);
    ownerButton.replaceChildren(
      el('span', { class: 'cgh-select-label', text: owner ? ownerLabel(owner, mine) : t('모든 소유자') }),
      el('span', { class: 'cgh-count', text: String(owner ? counts.get(owner) ?? 0 : data.repos.length) }),
      icon('chevronDown', 12));
  }

  let popover = null; // {node, close}

  function toggleOwnerPopover() {
    hideCard();
    accountPop?.close();
    if (popover) {
      popover.close();
      return;
    }
    // 열려 있는 동안 목록이 새로 들어오면(뒤에서 새로 읽기·쪽 늘림) 소유자와 개수도 다시 센다.
    const entriesNow = () => {
      const { mine, counts, order } = owners();
      return [{ value: '', label: t('모든 소유자'), count: data?.repos.length ?? 0 }, ...order.map((o) => ({ value: o, label: ownerLabel(o, mine), count: counts.get(o) }))];
    };
    let entries = entriesNow();
    const input = el('input', { class: 'field', placeholder: t('소유자 찾기'), autocomplete: 'off', spellcheck: 'false' });
    const items = el('div', { class: 'cgh-pop-list', role: 'listbox' });
    // .menu: 열려 있는 동안 Esc 가 Clone 창이 아니라 이 드롭다운을 닫는다(screens.js modal).
    const pop = el('div', { class: 'menu cgh-pop', role: 'dialog', 'aria-label': t('소유자 고르기') },
      el('label', { class: 'cgh-pop-search' }, icon('search', 13), input), items);
    let visible = entries;
    let active = Math.max(0, entries.findIndex((e) => e.value === owner));

    const draw = () => {
      entries = entriesNow();
      const q = input.value.trim().toLowerCase();
      visible = q ? entries.filter((e) => e.value && e.value.toLowerCase().includes(q)) : entries;
      active = Math.min(active, Math.max(0, visible.length - 1));
      items.replaceChildren(...(visible.length
        ? visible.map((e, k) => el('div', {
          class: `cgh-pop-item${k === active ? ' active' : ''}${e.value === owner ? ' chosen' : ''}${!e.value ? ' all' : ''}`, role: 'option',
          onpointerdown: (event) => { event.preventDefault(); choose(e); },
          onpointermove: () => { if (active !== k) { active = k; draw(); } },
        }, el('span', { class: 'cgh-pop-check' }, e.value === owner ? icon('check', 13) : null), el('span', { class: 'cgh-pop-label', text: e.label }), el('span', { class: 'cgh-count', text: String(e.count) })))
        : [el('div', { class: 'cgh-pop-empty muted small', text: t('찾는 소유자가 없습니다.') })]));
      items.querySelector('.cgh-pop-item.active')?.scrollIntoView({ block: 'nearest' });
    };
    const choose = (e) => {
      owner = e.value;
      close();
      drawOwners();
      drawList();
      search.focus();
    };
    const onOutside = (event) => {
      if (!pop.contains(event.target) && !ownerButton.contains(event.target)) close();
    };
    function close() {
      pop.remove();
      document.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('resize', close);
      popover = null;
    }
    input.addEventListener('input', () => { active = 0; draw(); });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        active = Math.max(0, Math.min(visible.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)));
        draw();
      } else if (event.key === 'Enter' && !event.isComposing && visible[active]) {
        event.preventDefault();
        event.stopPropagation();
        choose(visible[active]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        ownerButton.focus();
      }
    });

    const rect = ownerButton.getBoundingClientRect();
    const width = Math.max(rect.width, 260);
    pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    pop.style.top = `${rect.bottom + 4}px`;
    pop.style.width = `${width}px`;
    pop.style.maxHeight = `${Math.max(160, Math.min(380, window.innerHeight - rect.bottom - 16))}px`;
    document.body.append(pop);
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('resize', close);
    popover = { node: pop, close, redraw: draw };
    draw();
    input.focus();
  }

  // ── 목록 ──

  function loginBox() {
    const running = login.running;
    const waiting = login.step === 'waiting';
    return el('div', { class: 'cgh-empty' },
      el('div', { class: 'cgh-empty-mark' }, icon('github', 28)),
      el('div', { class: 'cgh-empty-title', text: t('GitHub 에 연결하면 내 레포지토리를 골라 받을 수 있습니다') }),
      el('div', { class: 'muted small', text: t('내 계정·협업 중인·속한 조직의 레포지토리를 최근 push 순으로 보여 줍니다.') }),
      !running ? el('button', { class: 'btn primary cgh-signin', type: 'button', onclick: () => login.dialog() }, icon('github', 14), t('GitHub 로 로그인')) : null,
      running && !waiting ? el('div', { class: 'muted small', text: t('GitHub 에 로그인 코드를 요청하는 중…') }) : null,
      waiting ? el('div', { class: 'muted small', text: t('열린 GitHub 페이지에 코드 {code} 를 넣고 승인하면 자동으로 이어집니다.', { code: login.code ?? '' }) }) : null,
      login.step === 'failed' ? el('div', { class: 'cgh-error', text: t('로그인하지 못했습니다: {error}', { error: login.error }) }) : null);
  }

  function drawList() {
    searchBox.hidden = signedIn === false;
    if (signedIn === false) {
      ownerButton.hidden = true;
      shown = [];
      list.replaceChildren(loginBox());
      note.textContent = '';
      return;
    }
    if (!data) {
      shown = [];
      list.replaceChildren(error
        ? el('div', { class: 'cgh-empty' },
          el('div', { class: 'cgh-error', text: t('레포지토리 목록을 읽지 못했습니다: {error}', { error }) }),
          el('button', { class: 'btn', type: 'button', text: t('다시 시도'), onclick: load }))
        : el('div', { class: 'cgh-empty' }, el('span', { class: 'cgh-spinner' }), el('div', { class: 'muted small', text: t('GitHub 에서 레포지토리 목록을 읽는 중…') })));
      note.textContent = '';
      return;
    }
    // 쪽이 더 와서 다시 그려도 보던 자리에 머문다. 카드가 가리키던 줄은 새로 만들어지니 카드를 닫는다.
    hideCard();
    const scroll = list.scrollTop;
    shown = data.repos.filter(matches);
    list.replaceChildren(...(shown.length
      ? shown.map(row)
      : [el('div', { class: 'cgh-empty' }, el('div', { class: 'muted small', text: growing ? t('더 읽는 중…') : data.repos.length ? t('찾는 레포지토리가 없습니다.') : t('이 계정에서 볼 수 있는 레포지토리가 없습니다.') }))]));
    list.scrollTop = scroll;
    // 아래 줄: 개수 · 읽은 때 · 새로고침 버튼. 뒤에서 새로 읽는 동안에는 글을 띄우지 않고 버튼만 돈다.
    const refreshing = loading && !growing;
    note.replaceChildren(...[
      el('span', { text: shown.length === data.repos.length ? t('{n}개', { n: data.repos.length }) : t('{total}개 중 {shown}개', { total: data.repos.length, shown: shown.length }) }),
      data.truncated ? el('span', { text: `\u00a0· ${t('최근 push 순으로 {n}개까지만 보입니다', { n: data.repos.length })}` }) : null,
      growing ? el('span', { class: 'cgh-refreshing' }, el('span', { class: 'cgh-spinner small' }), t('더 읽는 중')) : null,
      !growing && data.at ? el('span', { class: 'cgh-age', text: `\u00a0· ${t('{time} 읽음', { time: relativeTime(data.at / 1000) })}` }) : null,
      error ? el('span', { class: 'cgh-error', text: `\u00a0· ${t('새로 읽지 못했습니다: {error}', { error })}` }) : null,
      growing ? null : el('button', {
        class: `cgh-refresh${refreshing ? ' spinning' : ''}`, type: 'button', disabled: refreshing,
        'data-tip': refreshing ? t('GitHub 에서 새로 읽는 중…') : t('GitHub 에서 목록 새로 읽기'), 'aria-label': t('목록 새로 읽기'),
        onclick: () => load({ force: true }),
      }, icon('reload', 14)),
    ].filter(Boolean));
    // 고른 것이 걸러져(또는 새 목록에서) 사라졌으면 고르지 않은 것으로.
    if (selected && !shown.some((r) => r.fullName === selected)) {
      selected = null;
      onSelect(null);
    } else if (selected) {
      onSelect(current()); // 새 목록의 것(이미 받음 등)으로
    }
  }

  function drawAll() {
    drawAccount();
    drawOwners();
    drawList();
  }

  function signOut() {
    signedIn = false;
    data = null;
    loading = growing = false;
    caches.clear();
    lastAccount = account = null;
    drawAll();
  }

  let loadRun = 0;
  /** force: 새로고침 버튼·로그인 직후처럼 금방 읽은 목록이어도 다시 읽는다. */
  async function load({ force = false } = {}) {
    const run = ++loadRun;
    // 읽는 동안 다른 계정으로 바꿨거나 창을 닫았으면 이 결과는 버린다.
    const stale = () => disposed || run !== loadRun;
    loading = true;
    growing = false;
    error = null;
    drawAll();

    // 1) 지난번 목록(디스크) — 메모리에 없을 때만.
    if (!data) {
      const cached = await call('githubCloneCache', { account }).catch(() => null);
      if (stale()) return;
      if (cached && !cached.signedIn) {
        signOut();
        return;
      }
      if (cached?.repos) {
        signedIn = true;
        account = cached.account;
        data = { account: cached.account, repos: withoutForeignForks(cached.repos, cached.account), truncated: !!cached.truncated, at: Number(cached.savedAt) || 0 };
        caches.set(accountKey(cached.account), data);
        drawAll();
      }
    }

    // 금방 읽은 목록이면 여기서 끝(다시 읽지 않는다).
    if (!force && data?.at && Date.now() - data.at < FRESH_MS) {
      loading = false;
      drawAll();
      return;
    }

    // 2) 한 쪽(100개)씩 새로 읽는다. 보이는 목록이 없으면 쪽이 올 때마다 늘려 보이고, 있으면 다 읽은 뒤 한 번에 바꾼다.
    growing = !data;
    let who = account;
    let repos = [];
    let after = null;
    try {
      do {
        const page = await call('githubCloneList', { account: who, after });
        if (stale()) return;
        if (!page?.signedIn) {
          signOut();
          return;
        }
        signedIn = true;
        who = page.account;
        repos = repos.concat(withoutForeignForks(page.repos, page.account));
        after = page.next ?? null;
        if (growing) {
          account = who;
          data = { account: who, repos, truncated: false, at: 0 };
          drawAll();
        }
      } while (after && repos.length < MAX_REPOS);
    } catch (e) {
      if (stale()) return;
      error = e?.message ?? String(e);
      loading = growing = false;
      drawAll();
      return;
    }
    loading = growing = false;
    account = lastAccount = who;
    data = { account: who, repos, truncated: !!after, at: Date.now() };
    caches.set(accountKey(who), data);
    drawAll();
    call('githubCloneCacheSave', { account: who, repos, truncated: !!after }).catch(() => {});
  }

  search.addEventListener('input', () => {
    const text = search.value.trim();
    if (LOOKS_LIKE_URL.test(text)) {
      search.value = '';
      query = '';
      drawList();
      onUrl(text);
      return;
    }
    query = text;
    drawList();
  });
  search.addEventListener('keydown', (event) => {
    hideCard();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!shown.length) return;
      const at = shown.findIndex((r) => r.fullName === selected);
      const next = at < 0 ? (event.key === 'ArrowDown' ? 0 : shown.length - 1) : Math.max(0, Math.min(shown.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)));
      select(shown[next].fullName, { scroll: true });
    } else if (event.key === 'Enter' && selected) {
      event.preventDefault();
      onActivate();
    }
  });

  // 이 창에서(또는 다른 곳에서) 로그인을 마치면 목록을 읽는다. 로그인을 마친 횟수(completed)가 늘었는지로 가른다.
  let completed = login.completed;
  const off = login.on(() => {
    // 창을 Esc 로 닫았으면(dispose 를 거치지 않음) 여기서 떼어 낸다.
    if (disposed || !node.isConnected) {
      off();
      return;
    }
    if (login.completed !== completed) {
      completed = login.completed;
      // 방금 로그인한 앱 계정으로 읽는다(Rust 는 계정을 안 고르면 앱 로그인을 먼저 쓴다).
      account = lastAccount = null;
      data = null;
      loadAccounts();
      load({ force: true });
    } else if (signedIn === false) drawList();
  });

  drawAll();
  loadAccounts();
  load();

  return {
    node,
    selected: current,
    /** 받을 때 쓸 계정 {source, login}(목록을 읽은 그 계정). */
    account: () => data?.account ?? null,
    focus: () => (signedIn === false ? list.querySelector('button') ?? search : search).focus(),
    /** 카드를 닫는다(쪽 바꾸기·받기 시작 등). */
    hideCard,
    dispose: () => {
      disposed = true;
      off?.();
      popover?.close();
      accountPop?.close();
      hideCard();
      card.remove();
    },
  };
}
