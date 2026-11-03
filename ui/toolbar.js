// 위 도구 막대. 원본 Window/GitToolbar.cs·GitBranchPicker.cs·GitRepositoryPicker.cs 를 옮겼다.
// [저장소 ▾][브랜치 ▾] | [실행 취소][다시 실행] | [페치][풀 ▾][푸시] | [브랜치][스태시][팝] | 진행 상태 글자 | [터미널][새로고침][⋮]

import { el, relativeTime, isComposing } from './util.js';
import { icon } from './icons.js';

const NARROW = 840;

const badgeText = (n) => (n > 99 ? '99+' : String(n));

/**
 * ctx: { undo(), redo(), fetch(), pull(), pullMenu(button), push(), newBranch(), stash(), pop(), terminal(), refresh(), windowMenu(button),
 *        checkout(branch, remote), openRepo(path), fetchProblem() }
 */
export function createToolbar(container, ctx) {
  const action = (id, glyph, label, onClick, extra = {}) => {
    const button = el('button', { class: 'tb-btn', id, 'data-tip': extra.tip ?? null, onclick: onClick },
      el('span', { class: 'tb-icon' }, icon(glyph, 20)),
      el('span', { class: 'tb-text', text: label }),
      el('span', { class: 'tb-badge', hidden: true }));
    return button;
  };

  const repoButton = el('button', { class: 'tb-picker', id: 'repo-button', 'data-tip': '저장소와 서브모듈 중에서 열 저장소를 고릅니다.' },
    el('span', { class: 'tb-caption', text: '저장소' }),
    el('span', { class: 'tb-value' }, el('span', { class: 'tb-name', id: 'repo-name' }), el('span', { class: 'tb-caret' }, icon('caret', 14))));
  const branchButton = el('button', { class: 'tb-picker', id: 'branch-button', 'data-tip': '브랜치를 검색해 전환합니다.' },
    el('span', { class: 'tb-caption', text: '브랜치' }),
    el('span', { class: 'tb-value' }, el('span', { class: 'tb-name', id: 'branch-name' }), el('span', { class: 'tb-caret' }, icon('caret', 14))));

  const undo = action('act-undo', 'undo', '실행 취소', () => ctx.undo());
  const redo = action('act-redo', 'redo', '다시 실행', () => ctx.redo());
  const fetch = action('act-fetch', 'fetch', '페치', () => (fetch.classList.contains('problem') ? ctx.fetchProblem() : ctx.fetch()), { tip: '원격의 새 커밋을 받아 옵니다(작업 트리는 그대로).' });
  const pull = action('act-pull', 'pull', '풀', () => ctx.pull());
  const pullCaret = el('button', { class: 'tb-split-caret', id: 'act-pull-mode', 'data-tip': '풀 방식 고르기', onclick: (e) => ctx.pullMenu(e.currentTarget) }, icon('chevronDown', 12));
  const push = action('act-push', 'push', '푸시', () => ctx.push());
  const branch = action('act-branch', 'branch', '브랜치', () => ctx.newBranch(), { tip: '지금 위치(HEAD)에서 새 브랜치를 만듭니다.' });
  const stash = action('act-stash', 'stash', '스태시', () => ctx.stash(), { tip: '작업 중인 변경(새 파일 포함)을 stash 에 넣고 작업 트리를 비웁니다.' });
  const pop = action('act-pop', 'pop', '팝', () => ctx.pop());
  const terminal = action('act-terminal', 'terminal', '터미널', () => ctx.terminal(), { tip: '저장소 폴더에서 터미널을 엽니다.' });
  const refresh = action('act-refresh', 'refresh', '새로고침', () => ctx.refresh(), { tip: '저장소 상태를 다시 읽습니다 (F5)' });
  const more = el('button', { class: 'tb-more', id: 'act-more', 'data-tip': '메뉴', onclick: (e) => ctx.windowMenu(e.currentTarget) }, icon('moreVert', 18));
  const status = el('div', { class: 'tb-status', id: 'tb-status' }, el('span', { class: 'spinner', hidden: true }), el('span', { class: 'tb-status-text' }));

  container.replaceChildren(
    repoButton, branchButton,
    el('div', { class: 'tb-sep' }), undo, redo,
    el('div', { class: 'tb-sep' }), fetch, el('div', { class: 'tb-split' }, pull, pullCaret), push,
    el('div', { class: 'tb-sep' }), branch, stash, pop,
    status,
    terminal, refresh, more);

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
  let lastFetch = null;
  let fetchState = { fetching: false, error: null, auth: false };

  function renderStatus() {
    const spinner = status.querySelector('.spinner');
    const label = status.querySelector('.tb-status-text');
    spinner.hidden = !busyText && !fetchState.fetching;
    if (busyText) label.textContent = busyText;
    else if (fetchState.fetching) label.textContent = '페치하는 중…';
    else if (fetchState.error) label.textContent = '자동 페치 실패';
    else label.textContent = lastFetch ? `마지막 Fetch: ${relativeTime(lastFetch)}` : '';
    label.classList.toggle('warning-text', !!fetchState.error && !busyText);
    status.dataset.tip = fetchState.error ?? '';
  }

  // ── 브랜치 고르기 팝업 ──

  let popup = null;

  function closePopup() {
    popup?.close();
  }

  function openPopup(button, build) {
    if (popup?.button === button) return closePopup();
    closePopup();
    const panel = el('div', { class: 'tb-popup' });
    document.body.append(panel);
    const rect = button.getBoundingClientRect();
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.bottom + 4}px`;
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

  function branchPicker(state) {
    openPopup(branchButton, (panel, close) => {
      const refs = state.refs ?? { local: [], remote: [] };
      const search = el('input', { class: 'field tb-search', placeholder: '검색', spellcheck: 'false' });
      const list = el('div', { class: 'tb-list' });
      let active = 0;
      let rows = [];
      const draw = () => {
        const q = search.value.trim().toLowerCase();
        const current = refs.local.filter((b) => b.current);
        const locals = refs.local.filter((b) => !b.current).sort((a, b) => b.time - a.time);
        const items = [
          ...current.map((b) => ({ b, remote: false, current: true })),
          ...locals.map((b) => ({ b, remote: false })),
          ...refs.remote.map((b) => ({ b, remote: true })),
        ].filter((i) => !q || i.b.name.toLowerCase().includes(q));
        active = Math.min(active, Math.max(0, items.length - 1));
        rows = items;
        const nodes = [];
        let lastGroup = null;
        items.forEach((item, index) => {
          const group = item.current ? '현재' : item.remote ? '원격' : '로컬';
          if (group !== lastGroup) {
            nodes.push(el('div', { class: 'tb-list-head', text: group }));
            lastGroup = group;
          }
          nodes.push(el('div', {
            class: `tb-item${item.current ? ' current' : ''}${index === active ? ' on' : ''}`,
            onclick: () => choose(item),
            onmouseenter: () => { active = index; mark(); },
          }, icon(item.remote ? 'cloud' : 'laptop', 16), el('span', { class: 'tb-item-name', text: item.b.name }),
          item.current ? icon('check', 14, 'tb-item-check') : null));
        });
        list.replaceChildren(...(nodes.length ? nodes : [el('div', { class: 'tb-empty muted', text: '일치하는 브랜치가 없습니다' })]));
      };
      const mark = () => list.querySelectorAll('.tb-item').forEach((n, i) => n.classList.toggle('on', i === active));
      const choose = (item) => {
        close();
        if (!item.current) ctx.checkout(item.b.name, item.remote);
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

  function repoPicker(state) {
    openPopup(repoButton, (panel, close) => {
      const repo = state.repo;
      const items = [];
      if (repo.superproject) items.push({ name: repo.superproject.split(/[\\/]/).pop(), path: repo.superproject, hint: '상위 저장소', glyph: 'folder' });
      items.push({ name: repo.name, path: repo.path, hint: repo.superproject ? '서브모듈 (지금)' : '프로젝트 저장소', current: true, glyph: repo.superproject ? 'submodule' : 'folder' });
      for (const s of state.submodules ?? []) {
        const path = `${repo.path}/${s.path}`;
        items.push({ name: s.path, path, hint: s.state === 'uninitialized' ? '(받지 않음)' : '서브모듈', disabled: s.state === 'uninitialized', glyph: 'submodule' });
      }
      panel.append(el('div', { class: 'tb-list' }, items.map((item) => el('div', {
        class: `tb-item${item.current ? ' current' : ''}${item.disabled ? ' disabled' : ''}`,
        onclick: () => {
          if (item.disabled || item.current) return;
          close();
          ctx.openRepo(item.path);
        },
      }, icon(item.glyph, 16), el('span', { class: 'tb-item-name', text: item.name }), el('span', { class: 'muted small', text: item.hint }),
      item.current ? icon('check', 14, 'tb-item-check') : null))));
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
      repoButton.querySelector('.tb-caption').textContent = state.repo?.superproject ? '서브모듈' : '저장소';
      repoButton.querySelector('.tb-name').textContent = state.repo?.name ?? '';
      branchButton.querySelector('.tb-name').textContent = br.detached ? 'HEAD (분리됨)' : br.name;

      const u = state.undo ?? {};
      disable(undo, !u.undo, u.undo ? `실행 취소: ${u.undo} (⌘/Ctrl+Z)` : '되돌릴 작업이 없습니다.');
      disable(redo, !u.redo, u.redo ? `다시 실행: ${u.redo} (⌘/Ctrl+Shift+Z)` : '다시 할 작업이 없습니다.');

      const noRemote = !(state.refs?.remotes?.length);
      const busyOp = !!st.operation;
      const blocked = '진행 중인 작업을 먼저 끝내세요. 위 띠에서 이어가거나 중단할 수 있습니다.';
      disable(fetch, noRemote, fetchState.auth ? '자동 페치가 계정 문제로 실패했습니다. 눌러서 계정을 고르거나 로그인하세요.' : noRemote ? '원격이 없습니다.' : '원격의 새 커밋을 받아 옵니다(작업 트리는 그대로).');
      fetch.classList.toggle('problem', fetchState.auth);
      setBadge(fetch, fetchState.auth ? '!' : 0, 'danger');
      disable(pull, noRemote || busyOp, busyOp ? blocked : noRemote ? '원격이 없습니다.' : `원격의 새 커밋을 받아 현재 브랜치에 합칩니다. 받을 커밋 ${br.behind}개. (${state.pullModeLabel})`);
      pullCaret.disabled = noRemote || busyOp;
      const pushOff = busyOp || br.detached || !br.hasCommits;
      disable(push, pushOff, busyOp ? blocked : br.detached ? '브랜치가 아닌 커밋을 보고 있어 푸시할 수 없습니다.' : !br.hasCommits ? '아직 커밋이 없습니다.' : `현재 브랜치를 원격에 올립니다. 올릴 커밋 ${br.ahead}개.`);
      setBadge(push, br.ahead);
      setBadge(pull, br.behind);
      const stashes = state.refs?.stashes.length ?? 0;
      disable(pop, !stashes, stashes ? `가장 최근 stash 를 작업 트리에 되돌립니다. stash ${stashes}개.` : 'stash 가 없습니다.');
      setBadge(pop, stashes);
      disable(stash, st.staged.length + st.unstaged.length === 0);
      disable(branch, !br.hasCommits);
      renderStatus();
    },
    setBusy(text) {
      busyText = text ?? '';
      renderStatus();
    },
    setFetch(next) {
      fetchState = { ...fetchState, ...next };
      if (lastState) this.render(lastState);
    },
    setLastFetch(at) {
      lastFetch = at;
      renderStatus();
    },
    openBranchPicker: () => lastState && branchPicker(lastState),
    closePopup,
  };
}
