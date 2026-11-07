// 위 도구 막대. 원본 Window/GitToolbar.cs·GitBranchPicker.cs·GitRepositoryPicker.cs·Layouts/GitWindow.uxml 을 옮겼다.
// [레포지토리 ▾][브랜치 ▾] (빈칸) [실행 취소|다시 실행] [페치|풀 ▾|푸시] [브랜치] [스태시|팝] (빈칸) 진행 상태 글자 [터미널|새로고침] [⋮]
// 가운데 묶음은 양쪽 빈칸 사이에 놓이고, 묶음 사이는 왼쪽 1px 선이다(첫 묶음은 선 없음).

import { el, isComposing } from './util.js';
import { icon } from './icons.js';
import { onProgress, progressText } from './progress.js';

/** 이 폭보다 좁으면 버튼 글자와 진행 상태 글자를 숨긴다(원본 CompactWidth). */
const NARROW = 840;

const badgeText = (n) => (n > 99 ? '99+' : String(n));

/** 원본 GitToolbar.FetchAgeText: "마지막 Fetch: 3분 전" / "아직 Fetch 하지 않아 …". at 은 초. */
function fetchAgeText(at) {
  if (!at) return '아직 Fetch 하지 않아 받을 커밋 수를 모릅니다.';
  const minutes = Math.floor((Date.now() / 1000 - at) / 60);
  if (minutes < 1) return '마지막 Fetch: 방금';
  if (minutes < 60) return `마지막 Fetch: ${minutes}분 전`;
  if (minutes < 60 * 24) return `마지막 Fetch: ${Math.floor(minutes / 60)}시간 전`;
  return `마지막 Fetch: ${Math.floor(minutes / 60 / 24)}일 전`;
}

/** 원본 GitDisplay.FormatBranch: "main → origin/main  ↑1  ↓2". */
function formatBranch(br) {
  if (!br) return '-';
  if (!br.hasCommits) return `${br.name} (아직 커밋 없음)`;
  let text = br.detached ? 'HEAD (detached)' : br.name;
  if (br.upstream) text += ` → ${br.upstream}`;
  if (br.ahead > 0) text += `  ↑${br.ahead}`;
  if (br.behind > 0) text += `  ↓${br.behind}`;
  return text;
}

/**
 * ctx: { undo(), redo(), fetch(), pull(), pullMenu(button), push(), newBranch(), stash(), pop(), terminal(), refresh(), windowMenu(button),
 *        checkout(branch, remote), openRepo(path), fetchProblem() }
 * state.busy 면(작업이 도는 중) 원본처럼 동작 버튼을 모두 끈다.
 */
export function createToolbar(container, ctx) {
  /** 아이콘(위)·글자(아래)·숫자 배지 버튼. png 면 원본 Icons/*.png 그림을 글자색으로 물들인다(실행 취소·다시 실행). */
  const action = (id, glyph, label, onClick, extra = {}) => {
    const art = extra.png
      ? el('span', { class: 'png-icon tb-png', style: { '--png': `url(icons/${extra.png}.png)` } })
      : icon(glyph, 20);
    const button = el('button', { class: 'tb-btn', id, 'data-tip': extra.tip ?? null, onclick: onClick },
      el('span', { class: 'tb-icon' }, art),
      el('span', { class: 'tb-text', text: label }),
      el('span', { class: 'tb-badge', hidden: true }));
    return button;
  };

  // 레포지토리·브랜치: 위에 작은 이름표, 아래 이름 + ▾(펼치면 뒤집힌다). 마우스를 올리면 이름 + ▾ 만 밝힌다.
  const repoButton = el('button', { class: 'tb-picker', id: 'repo-button', 'data-tip': '프로젝트 레포지토리와 서브모듈 중에서 열 레포지토리를 고릅니다.' },
    el('span', { class: 'tb-name', id: 'repo-name' }), el('span', { class: 'tb-caret' }, icon('caret', 12)));
  const branchButton = el('button', { class: 'tb-picker', id: 'branch-button', 'data-tip': '사이드바에서 브랜치 찾기' },
    el('span', { class: 'tb-name', id: 'branch-name' }), el('span', { class: 'tb-caret' }, icon('caret', 12)));
  const repoCaption = el('span', { class: 'tb-caption', text: '레포지토리' });
  const repoContext = el('div', { class: 'tb-context' }, repoCaption, repoButton);
  const branchContext = el('div', { class: 'tb-context branch' }, el('span', { class: 'tb-caption', text: '브랜치' }), branchButton);

  const undo = action('act-undo', 'undo', '실행 취소', () => ctx.undo(), { png: 'Undo' });
  const redo = action('act-redo', 'redo', '다시 실행', () => ctx.redo(), { png: 'Redo' });
  const fetch = action('act-fetch', 'fetch', '페치', () => (fetch.classList.contains('problem') ? ctx.fetchProblem() : ctx.fetch()), { tip: '원격의 새 커밋을 받아 옵니다(작업 트리는 그대로).' });
  const pull = action('act-pull', 'pull', '풀', () => ctx.pull());
  const pullCaret = el('button', { class: 'tb-split-caret', id: 'act-pull-mode', 'data-tip': '풀 방식 고르기', onclick: (e) => ctx.pullMenu(e.currentTarget) }, icon('chevronDown', 12));
  const push = action('act-push', 'push', '푸시', () => ctx.push());
  const branch = action('act-branch', 'branch', '브랜치', () => ctx.newBranch(), { tip: '지금 위치(HEAD)에서 새 브랜치를 만듭니다.' });
  const stash = action('act-stash', 'stash', '스태시', () => ctx.stash(), { tip: '작업 중인 변경(새 파일 포함)을 stash 에 넣고 작업 트리를 비웁니다.' });
  const pop = action('act-pop', 'pop', '팝', () => ctx.pop());
  const terminal = action('act-terminal', 'terminal', '터미널', () => ctx.terminal(), { tip: '레포지토리 폴더에서 터미널을 엽니다.' });
  const refresh = action('act-refresh', 'reload', '새로고침', () => ctx.refresh(), { tip: '레포지토리 상태와 지금 보고 있는 탭을 다시 읽습니다.' });
  const more = el('button', { class: 'tb-more', id: 'act-more', 'data-tip': '메뉴', onclick: (e) => ctx.windowMenu(e.currentTarget) }, icon('moreVert', 18));
  const status = el('div', { class: 'tb-status', id: 'tb-status' }, el('span', { class: 'spinner', hidden: true }), el('span', { class: 'tb-status-text' }));
  const group = (...children) => el('div', { class: 'tb-group' }, children);
  // 작업이 도는 동안 도구 막대 아래 가장자리에 흐르는 막대(진행률을 알면 그만큼 찬다).
  const bar = el('div', { class: 'tb-progress' }, el('div', { class: 'tb-progress-fill' }));

  container.replaceChildren(
    repoContext, branchContext,
    el('div', { class: 'tb-spacer' }),
    el('div', { class: 'tb-group first' }, undo, redo),
    group(fetch, el('div', { class: 'tb-split' }, pull, pullCaret), push),
    group(branch),
    group(stash, pop),
    el('div', { class: 'tb-spacer' }),
    el('div', { class: 'tb-side' }, status),
    group(terminal, refresh),
    more,
    bar);

  new ResizeObserver(() => container.classList.toggle('narrow', container.clientWidth < NARROW)).observe(container);

  const setBadge = (button, count, kind = '') => {
    const badge = button.querySelector('.tb-badge');
    badge.hidden = !count;
    badge.textContent = typeof count === 'number' ? badgeText(count) : count || '';
    badge.className = `tb-badge ${kind}`;
  };
  const disable = (button, off, why) => {
    button.disabled = !!off;
    if (why !== undefined) button.dataset.tip = why;
  };

  let busyText = '';
  let progress = null;
  let running = null;
  let lastFetch = null;
  let fetchState = { fetching: false, error: null, auth: false };
  let warned = null;

  /** 진행 글로 어느 버튼의 작업인지 안다: "풀 하는 중…", "푸시하는 중…", "페치하는 중…", "'origin' 에서 Fetch 하는 중…". */
  function runningButton(text) {
    if (/^풀\s/.test(text)) return pull;
    if (/^푸시/.test(text)) return push;
    if (/^페치|Fetch 하는/.test(text)) return fetch;
    return null;
  }

  // git 이 알리는 진행(받기 45% 등)은 작업이 도는 동안에만 보인다.
  onProgress((p) => {
    if (!busyText) return;
    progress = p;
    renderStatus();
  });

  const shortLabel = (text) => text.replace(/\s*\(.*\)\s*$/, '').replace(/\s*(하는\s*)?중…?$/, '').trim() || text;

  function renderStatus() {
    const spinner = status.querySelector('.spinner');
    const label = status.querySelector('.tb-status-text');
    spinner.hidden = !busyText && !fetchState.fetching;
    const fill = bar.firstChild;
    bar.classList.toggle('known', progress?.percent != null);
    fill.style.width = progress?.percent != null ? `${progress.percent}%` : '';
    status.dataset.tip = busyText ? [busyText, progressText(progress)].filter(Boolean).join('\n') : '';
    // 진행률을 알면 작업 이름은 줄이고("풀 하는 중… (앞으로 감기만)" → "풀") 숫자를 앞에 보인다. 전체 글은 마우스를 올리면.
    if (busyText) label.textContent = progress ? `${shortLabel(busyText)} — ${progressText(progress)}` : busyText;
    else if (fetchState.fetching) label.textContent = '페치하는 중…';
    // 쉬고 있을 때는 아무 글도 두지 않는다(마지막 Fetch 시각은 Fetch·Pull 버튼 설명에 있다).
    // 자동 Fetch 실패도 글로 띄우지 않는다(원본 AutoFetch: 콘솔에만 남기고, 계정 문제면 Fetch 버튼의 ! 배지).
    else label.textContent = '';
    if (fetchState.error && fetchState.error !== warned) console.warn(`[Git] 자동 fetch 실패 — ${fetchState.error}`);
    warned = fetchState.error;
  }

  // ── 브랜치 고르기 팝업 ──

  let popup = null;

  function closePopup() {
    popup?.close();
  }

  /** 목록 상자 최소 폭. 칸이 더 넓으면 칸 폭을 따른다(원본 GitBranchPicker.MinWidth). */
  const POPUP_MIN_WIDTH = 320;

  function openPopup(button, build) {
    if (popup?.button === button) return closePopup();
    closePopup();
    const panel = el('div', { class: 'tb-popup', tabindex: '-1' });
    document.body.append(panel);
    // 칸(이름표 + 이름) 바로 아래, 칸 폭 이상. 창 밖으로 나가지 않게 왼쪽을 맞춘다.
    const anchor = button.parentElement.getBoundingClientRect();
    const width = Math.max(POPUP_MIN_WIDTH, anchor.width);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(4, Math.min(anchor.left, window.innerWidth - width - 4))}px`;
    panel.style.top = `${anchor.bottom + 2}px`;
    button.classList.add('open');
    const onDown = (event) => {
      if (!panel.contains(event.target) && !button.contains(event.target)) close();
    };
    function close() {
      panel.remove();
      button.classList.remove('open');
      document.removeEventListener('pointerdown', onDown, true);
      popup = null;
    }
    document.addEventListener('pointerdown', onDown, true);
    popup = { button, close };
    build(panel, close);
  }

  /**
   * 브랜치 고르기(원본 GitBranchPicker): 검색칸 아래 현재 → 로컬 → 원격(각각 최근 커밋 순). 무리 머리 줄 없이 로컬은 브랜치, 원격은 구름 그림.
   * 공백으로 나눈 낱말이 모두 들어간 이름만 남긴다. 줄 28px, 12줄까지 보이고 나머지는 스크롤.
   */
  function branchPicker(state) {
    openPopup(branchButton, (panel, close) => {
      const refs = state.refs ?? { local: [], remote: [] };
      const search = el('input', { class: 'field tb-search', placeholder: '검색', spellcheck: 'false' });
      const list = el('div', { class: 'tb-list' });
      let active = 0;
      let rows = [];
      const byTime = (a, b) => b.time - a.time;
      const draw = () => {
        const terms = search.value.toLowerCase().split(' ').filter(Boolean);
        const current = refs.local.filter((b) => b.current);
        const locals = refs.local.filter((b) => !b.current).sort(byTime);
        const remotes = refs.remote.filter((b) => !b.name.endsWith('/HEAD')).sort(byTime);
        const items = [
          ...current.map((b) => ({ b, remote: false, current: true })),
          ...locals.map((b) => ({ b, remote: false })),
          ...remotes.map((b) => ({ b, remote: true })),
        ].filter((i) => terms.every((t) => i.b.name.toLowerCase().includes(t)));
        active = Math.min(active, Math.max(0, items.length - 1));
        rows = items;
        list.replaceChildren(...(items.length ? items.map((item, index) => el('div', {
          class: `tb-item${item.current ? ' current' : ''}${item.remote ? ' remote' : ''}${index === active ? ' on' : ''}`,
          onclick: () => choose(item),
          onmouseenter: () => { active = index; mark(); },
        }, icon(item.remote ? 'cloud' : 'branch', 15), el('span', { class: 'tb-item-name', text: item.b.name })))
          : [el('div', { class: 'tb-empty muted', text: '일치하는 브랜치가 없습니다' })]));
      };
      const mark = () => list.querySelectorAll('.tb-item').forEach((n, i) => n.classList.toggle('on', i === active));
      // 지금 브랜치거나 다른 작업이 도는 중이면 닫기만 한다(원본 Pick).
      const choose = (item) => {
        close();
        if (!item.current && !state.busy) ctx.checkout(item.b.name, item.remote);
      };
      search.addEventListener('input', () => { active = 0; draw(); });
      search.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') close();
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          active = Math.max(0, Math.min(rows.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)));
          mark();
          list.querySelectorAll('.tb-item')[active]?.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter' && !isComposing(event) && rows[active]) choose(rows[active]);
      });
      panel.append(el('div', { class: 'tb-search-wrap' }, icon('search', 14), search), list);
      draw();
      search.focus();
    });
  }

  /** 레포지토리 고르기(원본 GitRepositoryPicker): 이 레포지토리와 서브모듈. 받지 않은 서브모듈은 꺼짐. ↑↓·Enter·Esc. */
  function repoPicker(state) {
    openPopup(repoButton, (panel, close) => {
      const repo = state.repo;
      const items = [];
      if (repo.superproject) items.push({ name: repo.superproject.split(/[\\/]/).pop(), path: repo.superproject, hint: '프로젝트 레포지토리', glyph: 'folder' });
      items.push({ name: repo.name, path: repo.path, hint: repo.superproject ? '서브모듈 (지금)' : '프로젝트 레포지토리', current: true, glyph: repo.superproject ? 'submodule' : 'folder' });
      for (const s of state.submodules ?? []) {
        const path = `${repo.path}/${s.path}`;
        items.push({ name: s.path.split('/').pop(), path, hint: s.state === 'uninitialized' ? `${s.path} (받지 않음)` : s.path, disabled: s.state === 'uninitialized', glyph: 'submodule' });
      }
      let active = Math.max(0, items.findIndex((i) => i.current));
      const pick = (item) => {
        if (item.disabled) return;
        close();
        if (!item.current) ctx.openRepo(item.path);
      };
      const nodes = items.map((item, index) => el('div', {
        class: `tb-item${item.current ? ' current' : ''}${item.disabled ? ' disabled' : ''}`,
        onclick: () => pick(item),
        onmouseenter: () => { if (!item.disabled) { active = index; mark(); } },
      }, icon(item.glyph, 15), el('span', { class: 'tb-item-name', text: item.name }), el('span', { class: 'tb-item-hint', text: item.hint })));
      const mark = () => nodes.forEach((n, i) => n.classList.toggle('on', i === active));
      const step = (delta) => {
        for (let i = active + delta; i >= 0 && i < items.length; i += delta) {
          if (!items[i].disabled) {
            active = i;
            break;
          }
        }
        mark();
      };
      panel.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') close();
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          step(event.key === 'ArrowDown' ? 1 : -1);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          pick(items[active]);
        }
      });
      panel.append(el('div', { class: 'tb-list' }, nodes));
      mark();
      panel.focus();
    });
  }

  let lastState = null;
  branchButton.addEventListener('click', () => lastState && branchPicker(lastState));
  repoButton.addEventListener('click', () => lastState && repoPicker(lastState));

  return {
    render(state) {
      lastState = state;
      const st = state.status;
      if (!st) return;
      const br = st.branch;
      // 서브모듈을 열었으면 칸 이름도 "서브모듈" 로 바꿔, 프로젝트 레포지토리가 아님을 바로 알게 한다.
      repoCaption.textContent = state.repo?.superproject ? '서브모듈' : '레포지토리';
      repoButton.querySelector('.tb-name').textContent = state.repo?.name ?? '-';
      repoButton.dataset.tip = state.repo?.path ?? '';
      branchButton.querySelector('.tb-name').textContent = br.detached ? 'HEAD (detached)' : br.name;
      branchButton.dataset.tip = formatBranch(br);

      // 작업이 도는 동안은 모두 끈다(원본 idle). 끝나고 화면이 새 상태로 바뀐 뒤 다시 켠다.
      const idle = !state.busy;
      const u = state.undo ?? {};
      disable(undo, !idle || !u.undo, u.undo ? `실행 취소: ${u.undo}` : '되돌릴 작업이 없습니다.');
      disable(redo, !idle || !u.redo, u.redo ? `다시 실행: ${u.redo}` : '다시 할 작업이 없습니다.');

      const noRemote = !(state.refs?.remotes?.length);
      // 병합·리베이스가 충돌로 멈춘 동안 Pull·Push 를 하면 진행 중인 작업이 꼬인다. 끝내거나 중단할 때까지 막는다.
      const inProgress = !!st.operation;
      const blocked = inProgress ? '병합·리베이스가 진행 중입니다. 위쪽 띠에서 이어가거나 중단한 뒤 쓸 수 있습니다.' : null;
      disable(fetch, !idle || noRemote, fetchState.auth ? '자동 fetch 가 계정 문제로 실패했습니다. 눌러서 Fetch 하면 이 레포지토리에 쓸 계정을 고를 수 있습니다.' : noRemote ? '원격이 없습니다.' : '원격의 새 커밋을 받아 옵니다(작업 트리는 그대로).');
      fetch.classList.toggle('problem', fetchState.auth);
      setBadge(fetch, fetchState.auth ? '!' : 0, 'danger');
      // 받을 커밋 수는 마지막 fetch 기준이다. 0 이 "확인했더니 없음" 인지 "아직 안 봄" 인지 알 수 있게 언제 봤는지 붙인다.
      disable(pull, !idle || noRemote || !br.upstream || inProgress,
        blocked ?? (noRemote ? '원격이 없습니다.' : `원격 커밋을 받아 현재 브랜치에 합칩니다.\n${fetchAgeText(lastFetch)}`));
      pullCaret.disabled = !idle;
      disable(push, !idle || inProgress || br.detached || !br.hasCommits, blocked ?? `현재 브랜치를 원격에 올립니다. 올릴 커밋 ${br.ahead}개.`);
      setBadge(push, br.ahead);
      setBadge(pull, br.behind);
      const stashes = state.refs?.stashes.length ?? 0;
      disable(pop, !idle || !stashes, `가장 최근 stash 를 작업 트리에 되돌립니다. stash ${stashes}개.`);
      setBadge(pop, stashes);
      disable(stash, !idle || st.staged.length + st.unstaged.length === 0);
      disable(branch, !idle || !br.hasCommits);
      disable(terminal, !state.repo);
      renderStatus();
    },
    setBusy(text) {
      busyText = text ?? '';
      progress = null;
      // 누른 동작 버튼(페치·풀·푸시)은 아이콘 자리에 도는 표시를 둔다.
      running?.classList.remove('running');
      running = runningButton(busyText);
      running?.classList.add('running');
      container.classList.toggle('working', !!busyText);
      renderStatus();
    },
    setFetch(next) {
      fetchState = { ...fetchState, ...next };
      if (lastState) this.render(lastState);
    },
    setLastFetch(at) {
      lastFetch = at;
      if (lastState) this.render(lastState);
      else renderStatus();
    },
    openBranchPicker: () => lastState && branchPicker(lastState),
    closePopup,
  };
}
