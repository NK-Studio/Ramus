// 사이드바 위 탭과 탭마다의 가운데 화면. 원본 Window/GitWindow(CreateViews)·Views/ForkChangesView·PendingChangesView·CommitHistoryView·
// BranchExplorerView·Elements/BranchGraph/BranchGraphElement·Views/WorkspaceView·ChangesetsView 를 옮겼다.
//
// 탭: [그래프(GitKraken)/로컬 변경(Fork)/대기 중인 변경사항(Unity VCS)] · 브랜치 탐색기 · 워크스페이스 · 체인지 세트.
// 칸 경계는 모두 끌 수 있고(원본 TwoPaneSplitView) 크기를 기억한다.

import { el, formatDate, initials, isComposing } from './util.js';
import { icon } from './icons.js';
import { createGraph, authorRgb } from './graph.js';
import { fileList, selectedEntries, viewSwitch, CHANGE_STATE, STATE_LABEL, stateIcon, fileIcon } from './files.js';
import { createDiffView } from './diff.js';
import { renderCommit, stripComments } from './changes.js';
import { menuBelow, showMenu } from './dialogs.js';
import { splitter } from './tools.js';
import { createBranchGraph, buildModel } from './branchgraph.js';

/** 원본 explorer.range* (기본은 지난 1개월). */
const PERIODS = [
  { value: 7, label: '지난 1주' },
  { value: 30, label: '지난 1개월' },
  { value: 90, label: '지난 3개월' },
  { value: 0, label: '전체' },
];
const MAIN_TAB = { gitkraken: '그래프', fork: '로컬 변경', unity: '대기 중인 변경사항' };
const EXPLORER_STYLES = { fork: 'Fork', unity: 'Unity VCS' };
/** 멈춘 작업 이름(원본 inprogress.kind.*) · 끝내는 버튼이 커밋인지(병합·체리픽·revert). */
const OP_KIND = { merge: '병합', rebase: 'rebase', cherryPick: '체리픽', revert: 'revert' };
const FULL_COMMIT = new Set(['merge', 'cherryPick', 'revert']);

const rgb = (c) => `rgb(${c.map(Math.round).join(',')})`;
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 커밋 목록 한 줄(원본 CommitList 칸: 해시 · 메시지 · 작성자 · 날짜). */
function commitRow(c, { active = false, onclick, ondblclick, oncontextmenu } = {}) {
  return el('div', { class: `cl-row${active ? ' active' : ''}`, 'data-hash': c.hash, 'data-tip': `${c.subject}\n${c.authorName} · ${formatDate(c.time, true)}`, onclick, ondblclick, oncontextmenu },
    el('span', { class: 'cl-hash', text: c.shortHash }),
    el('span', { class: 'cl-subject', text: c.subject }),
    el('span', { class: 'cl-author', text: c.authorName }),
    el('span', { class: 'cl-date', text: formatDate(c.time, true) }));
}
const commitHeader = () => el('div', { class: 'cl-row cl-head' }, el('span', { class: 'cl-hash', text: '해시' }), el('span', { class: 'cl-subject', text: '메시지' }), el('span', { class: 'cl-author', text: '작성자' }), el('span', { class: 'cl-date', text: '날짜' }));

/**
 * ctx: { call, prefs, state, act, showError, actions(스테이징 API), diffApi, avatars, revealCommit(hash), compare(a, b, opts),
 *        fileHistory(path), graphPane, detail, diffView 요소, mergeView 요소, refsUi, sidebar, renderStagingInto, onChange() }
 */
export function createViews(ctx) {
  const host = el('section', { class: 'view-host', hidden: true });
  ctx.graphPane.after(host);
  const tabs = el('div', { class: 'side-tabs' });
  let tab = ctx.prefs.get('tab') ?? 'main';
  let current = null; // { key, refresh(), refsChanged(), dispose(), reveal(hash) }
  let lastRefs = null;
  /** 지금 HEAD·브랜치·태그를 한 줄로(바뀌었는지 비교용). */
  const refsSignature = () => {
    const r = ctx.state.refs;
    if (!r) return '';
    const b = (x) => `${x.name}@${x.hash}${x.current ? '*' : ''}`;
    return [ctx.state.history?.head ?? '', ...(r.local ?? []).map(b), ...(r.remote ?? []).map(b), ...(r.tags ?? []).map((t) => `${t.name}@${t.hash}`)].join('|');
  };

  const layout = () => ctx.prefs.get('layout') ?? 'gitkraken';
  const explorerStyle = () => (layout() === 'gitkraken' ? 'unity' : ctx.prefs.get('explorer') ?? 'fork');
  const busy = () => !!ctx.state.busy;

  /** 사이드바 위 탭 목록(원본 SidebarTab: 22px 줄 · 제목 · 오른쪽 개수 배지). */
  function renderTabs() {
    const st = ctx.state.status;
    const changes = st ? new Set([...st.staged, ...st.unstaged].map((e) => e.path)).size : 0;
    const items = [
      ['main', MAIN_TAB[layout()], changes],
      ['explorer', '브랜치 탐색기', 0],
      ['workspace', '워크스페이스', 0],
      ['changesets', '체인지 세트', 0],
    ];
    tabs.replaceChildren(...items.map(([key, label, count]) => el('div', {
      class: `side-tab${tab === key ? ' on' : ''}`, role: 'tab',
      onclick: () => select(key),
    }, el('span', { class: 'side-tab-text', text: label }), count ? el('span', { class: 'side-tab-badge', text: count }) : null)));
  }

  /** 지금 탭·배치에 맞는 화면을 보인다. */
  function select(key, force = false) {
    if (key === tab && !force && current?.key === `${key}:${layout()}:${explorerStyle()}`) return;
    tab = key;
    ctx.prefs.set('tab', key);
    current?.dispose?.();
    current = null;
    // GitKraken 그래프 탭이면 기존 그래프·오른쪽 패널, 나머지는 view-host 를 쓴다.
    const graphTab = key === 'main' && layout() === 'gitkraken';
    restoreDiffHosts();
    host.hidden = graphTab;
    host.classList.remove('merging');
    ctx.graphPane.hidden = !graphTab;
    for (const node of [ctx.detail, document.querySelector('.splitter[data-split="detail"]')]) node.classList.toggle('view-hidden', !graphTab);
    host.replaceChildren();
    if (!graphTab) {
      const id = `${key}:${layout()}:${explorerStyle()}`;
      const build = key === 'main' ? (layout() === 'fork' ? forkChanges : pendingChanges)
        : key === 'explorer' ? (explorerStyle() === 'fork' ? forkExplorer : unityExplorer)
          : key === 'workspace' ? workspaceView : changesetsView;
      current = { key: id, ...build(host) };
    }
    renderTabs();
    ctx.onChange?.(key);
  }

  /** diff·병합 편집기 요소를 원래 자리(그래프 칸)로 돌려놓는다. */
  function restoreDiffHosts() {
    for (const node of [ctx.diffViewEl, ctx.mergeViewEl]) {
      if (node.parentElement !== ctx.graphPane) ctx.graphPane.append(node);
      node.classList.remove('docked');
    }
  }

  function dock(node, into) {
    into.append(node);
    node.classList.add('docked');
  }

  // ── Fork: 로컬 변경(원본 ForkChangesView: 가운데 Unstaged/Staged 380 | 오른쪽 위 diff·아래 커밋) ──

  function forkChanges(root) {
    const lists = el('div', { class: 'fork-lists detail' });
    const diffBox = el('div', { class: 'fork-diff' }, el('div', { class: 'fork-empty muted', text: '파일을 고르면 diff 가 보입니다.' }));
    const commitBox = el('div', { class: 'fork-commit' });
    root.append(el('div', { class: 'fork-layout' }, lists, splitter({ pane: lists, prefs: ctx.prefs, key: 'fork.split', size: 380, min: 200, rest: 240 }), el('div', { class: 'fork-right' }, diffBox, commitBox)));
    dock(ctx.diffViewEl, diffBox);
    dock(ctx.mergeViewEl, diffBox);
    const refresh = () => {
      ctx.renderStagingInto(lists);
      const box = lists.querySelector('.commit-box');
      if (box) commitBox.replaceChildren(box);
    };
    refresh();
    return { refresh, dispose: restoreDiffHosts };
  }

  // ── Unity VCS: 대기 중인 변경사항(원본 PendingChangesView) ──
  // 맨 위 동작 줄·커밋 메시지, 그 아래 [목록(위)·diff(아래)] | 세부사항(340). 고른(체크한) 파일만 커밋한다.

  function pendingChanges(root) {
    const st = { selected: new Set(), anchor: null };
    const collapsed = new Set();
    let unchecked = new Set(ctx.prefs.get('pending.unchecked') ?? []);
    let selectedPath = null;
    let details = ctx.prefs.get('pending.details') ?? false;
    let view = ctx.prefs.get('pending.view') ?? 'path';
    let filter = '';
    let filterOpen = false;
    const template = () => (typeof ctx.state.template === 'string' ? ctx.state.template.replace(/\r\n/g, '\n').trimEnd() : '');

    const message = el('textarea', { class: 'field pending-message', rows: 3, placeholder: '커밋 메시지', spellcheck: 'false' });
    const draft = ctx.state.draft.summary + (ctx.state.draft.description ? `\n\n${ctx.state.draft.description}` : '');
    message.value = draft || template();
    message.addEventListener('input', () => {
      const [first, ...rest] = message.value.split('\n');
      ctx.state.draft.summary = first;
      ctx.state.draft.description = rest.join('\n').trim();
      updateActions();
    });
    // 칸을 다 지우고 다른 곳을 누르면 템플릿을 다시 채운다(Fork 와 같다).
    message.addEventListener('blur', () => { if (!message.value.trim() && template()) message.value = template(); });
    const toCommit = () => (template() ? stripComments(message.value) : message.value.trim());

    const commitButton = el('button', { class: 'btn small primary', onclick: () => onCommit() });
    const discardButton = el('button', { class: 'btn small', text: '변경 되돌리기', onclick: () => ctx.actions.discardMany(included()) });
    const abortButton = el('button', { class: 'btn small danger', onclick: () => ctx.actions.abortOperation() });
    const skipButton = el('button', { class: 'btn small', text: '건너뛰기', 'data-tip': 'Rebase 에서 지금 멈춘 커밋을 빼고 다음으로 갑니다.', onclick: () => ctx.actions.skipOperation() });
    const detailsButton = el('button', { class: 'btn small', text: '세부사항 표시', onclick: () => { details = !details; ctx.prefs.set('pending.details', details); applyDetails(); } });
    const authorNotice = el('div', { class: 'notice warning pending-author', text: 'user.name / user.email 이 설정되지 않아 커밋할 수 없습니다.' });

    const selectAll = el('input', { type: 'checkbox' });
    const summary = el('span', { class: 'pending-summary' });
    const filterInput = el('input', { class: 'field pending-filter', placeholder: '찾기', spellcheck: 'false', 'data-tip': '경로에 이 글자가 든 변경만 보입니다. 모두 선택 체크박스는 보이는 항목에만 적용됩니다. Esc 로 지우고 닫습니다.' });
    const filterButton = el('button', { class: 'dbar-btn', 'data-tip': '찾기 (⌘/Ctrl+F)', onclick: () => openFilter() }, icon('search', 14));
    const modeHost = el('span');
    const listHost = el('div', { class: 'pending-list' });
    const diffHost = el('div', { class: 'pending-diff' }, el('div', { class: 'fork-empty muted', text: '파일을 고르면 diff 가 보입니다.' }));
    const info = el('aside', { class: 'pending-details ws-side' });
    const main = el('div', { class: 'pending-main' },
      el('div', { class: 'pending-head' }, el('label', { class: 'check' }, selectAll), summary, el('span', { class: 'spacer' }), filterButton, filterInput, modeHost),
      el('div', { class: 'pending-split' }, listHost, splitter({ pane: listHost, axis: 'y', prefs: ctx.prefs, key: 'pending.listHeight', size: 220, min: 60, rest: 80 }), diffHost));
    const detailsSplit = splitter({ pane: info, prefs: ctx.prefs, key: 'pending.detailsWidth', size: 340, min: 200, rest: 300, after: true });
    root.append(el('div', { class: 'pending-view' },
      el('div', { class: 'pending-actions' }, commitButton, discardButton, abortButton, skipButton, el('span', { class: 'spacer' }), detailsButton),
      el('div', { class: 'pending-commit' }, message, authorNotice),
      el('div', { class: 'pending-layout' }, main, detailsSplit, info)));
    dock(ctx.diffViewEl, diffHost);
    dock(ctx.mergeViewEl, diffHost);

    const entries = () => {
      const s = ctx.state.status;
      if (!s) return [];
      const map = new Map();
      for (const e of [...s.staged, ...s.unstaged]) map.set(e.path, e);
      return [...map.values()];
    };
    const shown = () => entries().filter((e) => !filter || e.path.toLowerCase().includes(filter));
    const included = () => entries().filter((e) => !unchecked.has(e.path));
    const modeOf = (e) => (ctx.state.status.unstaged.includes(e) ? 'unstaged' : 'staged');
    const saveChecks = () => ctx.prefs.set('pending.unchecked', [...unchecked]);

    function applyDetails() {
      detailsButton.classList.toggle('on', details);
      info.hidden = !details;
      detailsSplit.hidden = !details;
    }

    function openFilter() {
      filterOpen = true;
      filterInput.hidden = false;
      filterButton.hidden = true;
      filterInput.focus();
    }
    function closeFilter() {
      filter = '';
      filterInput.value = '';
      filterOpen = false;
      filterInput.hidden = true;
      filterButton.hidden = false;
      draw();
    }
    filterInput.hidden = true;
    filterInput.addEventListener('input', () => { filter = filterInput.value.trim().toLowerCase(); draw(); });
    filterInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !isComposing(event)) {
        event.preventDefault();
        event.stopPropagation();
        closeFilter();
      }
    });
    filterInput.addEventListener('blur', () => { if (!filterInput.value) closeFilter(); });
    root.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        event.stopPropagation();
        openFilter();
      }
    });
    selectAll.addEventListener('change', () => {
      for (const e of filter ? shown() : entries()) {
        if (selectAll.checked) unchecked.delete(e.path);
        else unchecked.add(e.path);
      }
      saveChecks();
      draw();
    });

    /** 오른쪽 세부사항(워크스페이스 탭과 같은 모양): 정보 · 히스토리(두 번 누르면 비교) · 고른 커밋 메시지. */
    let infoKey = null;
    function drawInfo() {
      const entry = entries().find((e) => e.path === selectedPath);
      // 같은 파일·상태면 다시 읽지 않는다(체크를 바꿀 때마다 히스토리를 다시 읽지 않게).
      const key = entry ? `${entry.path}:${entry.state}` : '';
      if (key === infoKey) return;
      infoKey = key;
      if (!entry) {
        info.replaceChildren(el('div', { class: 'ws-empty', text: '파일이나 폴더를 고르면 정보와 히스토리가 여기에 나옵니다.' }));
        return;
      }
      fileDetails(info, { path: entry.path, state: entry.state });
    }

    function updateActions() {
      const s = ctx.state.status;
      const op = s?.operation ?? null;
      const identity = ctx.state.repo?.identity;
      const hasAuthor = !identity || (!!identity.name && !!identity.email);
      authorNotice.hidden = hasAuthor;
      const on = included().length;
      discardButton.disabled = busy() || !on;
      abortButton.hidden = !op;
      skipButton.hidden = op !== 'rebase';
      if (op) {
        // 멈춘 작업을 마치는 버튼(커밋 상자와 같다). 병합 커밋은 체크와 상관없이 인덱스 전체로 한다.
        commitButton.textContent = FULL_COMMIT.has(op) ? `${OP_KIND[op]} 마치기` : `${OP_KIND[op]} 이어가기`;
        commitButton.dataset.tip = FULL_COMMIT.has(op) ? `적은 메시지로 커밋해 ${OP_KIND[op]}을(를) 마칩니다.` : `해결한 결과로 ${OP_KIND[op]}을(를) 이어갑니다(git ${op === 'rebase' ? 'rebase' : op} --continue).`;
        commitButton.disabled = busy() || !hasAuthor || (s.conflicted ?? 0) > 0 || (FULL_COMMIT.has(op) && !toCommit());
        abortButton.textContent = `${OP_KIND[op]} 중단`;
        abortButton.dataset.tip = `${OP_KIND[op]}을(를) 중단하고 시작 전 상태로 돌립니다.`;
        abortButton.disabled = busy();
        skipButton.disabled = busy();
        return;
      }
      delete commitButton.dataset.tip;
      commitButton.textContent = `커밋 (${on})`;
      commitButton.disabled = busy() || !hasAuthor || !on || !toCommit();
    }

    function draw() {
      // 밖에서 바꾼 커밋 초안(stash 를 적용하면 그 메시지가 제목에 들어간다)을 칸에 옮긴다. 쓰는 중이면 건드리지 않는다.
      const wanted = ctx.state.draft.summary + (ctx.state.draft.description ? `\n\n${ctx.state.draft.description}` : '');
      if (wanted && document.activeElement !== message && message.value !== wanted) message.value = wanted;
      const all = entries();
      const visible = shown();
      const on = included();
      const shownOn = visible.filter((e) => !unchecked.has(e.path));
      summary.textContent = filter
        ? `검색 결과 ${visible.length}개 (선택 ${shownOn.length}) · 전체 변경 ${all.length}개 (선택 ${on.length})`
        : `변경 ${all.length}개 (선택 ${on.length})`;
      selectAll.checked = visible.length > 0 && shownOn.length === visible.length;
      selectAll.indeterminate = shownOn.length > 0 && shownOn.length < visible.length;
      modeHost.replaceChildren(viewSwitch(view, (v) => { view = v; ctx.prefs.set('pending.view', v); draw(); }));
      const list = fileList({
        entries: visible, view, state: st, collapsed,
        keyOf: (e) => e.path, activeKey: selectedPath,
        onToggleFolder: (p) => { if (collapsed.has(p)) collapsed.delete(p); else collapsed.add(p); draw(); },
        onOpen: (e) => {
          selectedPath = e.path;
          ctx.actions.openDiff(e, modeOf(e));
          for (const row of list.querySelectorAll('.file-row[data-path]')) row.classList.toggle('active', row.dataset.path === e.path);
          drawInfo();
        },
        onMenu: (event, files) => ctx.actions.fileMenu(event, files, modeOf(files[0])),
        onFolderMenu: (event, folder, files) => ctx.actions.folderMenu?.(event, folder, files, 'unstaged', {
          expandAll: () => { collapsed.clear(); draw(); },
          collapseAll: () => { for (const row of list.querySelectorAll('.file-row.folder')) collapsed.add(row.dataset.folder); draw(); },
        }),
        empty: filter ? '찾는 변경이 없습니다.' : '바뀐 파일이 없습니다.',
      });
      // 줄마다 커밋에 넣을지 체크(원본 FileBrowser.IsChecked). 폴더 체크는 그 안의 파일 전부.
      for (const row of list.querySelectorAll('.file-row[data-path]')) {
        const path = row.dataset.path;
        const box = el('input', { type: 'checkbox', class: 'row-check' });
        box.checked = !unchecked.has(path);
        box.addEventListener('click', (event) => event.stopPropagation());
        box.addEventListener('change', () => {
          // 고른 줄이 여럿이면 함께 바꾼다(원본 SpaceAction). 고른 폴더는 그 아래 파일 전부로 센다.
          const picked = selectedEntries(st, visible).map((e) => e.path);
          const targets = picked.includes(path) && picked.length > 1 ? picked : [path];
          for (const p of targets) {
            if (box.checked) unchecked.delete(p);
            else unchecked.add(p);
          }
          saveChecks();
          draw();
        });
        row.prepend(box);
      }
      for (const row of list.querySelectorAll('.file-row.folder')) {
        const prefix = `${row.dataset.folder}/`;
        const inside = visible.filter((e) => e.path.startsWith(prefix));
        const count = inside.filter((e) => !unchecked.has(e.path)).length;
        const box = el('input', { type: 'checkbox', class: 'row-check' });
        box.checked = inside.length > 0 && count === inside.length;
        box.indeterminate = count > 0 && count < inside.length;
        box.addEventListener('click', (event) => event.stopPropagation());
        box.addEventListener('change', () => {
          // 이 폴더가 여럿 고른 것 중 하나면 고른 것 전부를 함께 바꾼다.
          const picked = selectedEntries(st, visible);
          const group = st.folders?.has(row.dataset.folder) && picked.length > inside.length ? picked : inside;
          for (const e of group) {
            if (box.checked) unchecked.delete(e.path);
            else unchecked.add(e.path);
          }
          saveChecks();
          draw();
        });
        row.prepend(box);
      }
      list.addEventListener('keydown', (event) => {
        // Space: 고른 줄들을 한꺼번에 체크·해제한다.
        if (event.key !== ' ' || !st.selected.size) return;
        const targets = [...st.selected];
        const allOn = targets.every((p) => !unchecked.has(p));
        for (const p of targets) {
          if (allOn) unchecked.add(p);
          else unchecked.delete(p);
        }
        saveChecks();
        draw();
        listHost.querySelector('.file-list')?.focus();
      });
      listHost.replaceChildren(list);
      updateActions();
      drawInfo();
    }

    async function onCommit() {
      const op = ctx.state.status?.operation;
      if (op && !FULL_COMMIT.has(op)) {
        ctx.actions.continueOperation();
        return;
      }
      const text = toCommit();
      if (!text) return;
      if (op) {
        // 병합·체리픽·revert 는 인덱스 전체를 적은 메시지로 커밋해 마친다.
        await ctx.actions.continueOperation(text);
        if (!ctx.state.status?.operation) message.value = template();
        return;
      }
      const paths = included().map((e) => e.path);
      const stagedOff = (ctx.state.status?.staged ?? []).filter((e) => unchecked.has(e.path)).map((e) => e.path);
      // 고른 파일만 커밋한다. 안 고른 Stage 는 그 경로만 푼다(경로 없는 reset 은 병합 상태까지 지운다).
      const ok = await ctx.act('커밋하는 중…', async () => {
        if (stagedOff.length) await ctx.call('unstage', { paths: stagedOff });
        await ctx.call('stage', { paths });
        return ctx.call('commit', { message: text, amend: false });
      }, { success: (h) => `커밋했습니다: ${String(h).slice(0, 7)}` });
      if (ok !== undefined) {
        message.value = template();
        ctx.state.draft = { summary: '', description: '', amend: false };
        updateActions();
      }
    }

    applyDetails();
    draw();
    return { refresh: draw, dispose: restoreDiffHosts };
  }

  /** 파일 정보 + 히스토리(원본 workspace__side). 히스토리 줄을 고르면 메시지를, 두 번 누르면 그 커밋 비교를 연다. */
  async function fileDetails(box, { path, state, isFolder = false, size, created, modified, stateText }) {
    const name = path.split('/').pop();
    const row = (k, v) => el('div', { class: 'info-row' }, el('span', { class: 'muted', text: k }), el('span', { text: v }));
    const rows = el('div', { class: 'info-table' }, row('경로', path), row('상태', stateText ?? (state ? `변경됨 · ${STATE_LABEL[state] ?? state}` : '제어됨')));
    const sizeRow = isFolder ? null : row('크기', '…');
    const createdRow = row('만든 날짜', '…');
    const modifiedRow = row('수정한 날짜', '…');
    rows.append(...[sizeRow, createdRow, modifiedRow].filter(Boolean));
    const message = el('div', { class: 'ws-message' });
    const history = el('div', { class: 'ws-history' });
    box.replaceChildren(el('div', { class: 'info-title' }, isFolder ? icon('folder', 16) : fileIcon(path), el('span', { text: name })), rows,
      isFolder ? null : el('div', { class: 'ws-history-title', text: '히스토리' }), isFolder ? null : history, isFolder ? null : message);
    const fill = (w) => {
      sizeRow?.lastChild && (sizeRow.lastChild.textContent = w?.size != null ? formatSize(w.size) : '');
      createdRow.lastChild.textContent = w?.created ? formatDate(w.created, true) : '';
      modifiedRow.lastChild.textContent = w?.modified ? formatDate(w.modified, true) : '';
    };
    if (size !== undefined || modified !== undefined) fill({ size, created, modified });
    else ctx.call('workspace', { ignored: false }).then((list) => fill(list.find((x) => x.path === path))).catch(() => fill(null));
    if (isFolder) return;
    if (state === 'untracked' || state === 'ignored' || state === 'added') {
      history.replaceChildren(el('div', { class: 'ws-empty', text: '커밋된 적이 없는 파일이라 히스토리가 없습니다.' }));
      return;
    }
    history.replaceChildren(el('div', { class: 'ws-empty', text: '불러오는 중…' }));
    const revs = await ctx.call('fileLog', { path, maxCount: 200 }).catch(() => []);
    if (!box.isConnected) return;
    if (!revs.length) {
      history.replaceChildren(el('div', { class: 'ws-empty', text: '커밋된 적이 없는 파일이라 히스토리가 없습니다.' }));
      return;
    }
    let active = null;
    history.replaceChildren(...revs.map((r) => {
      const node = commitRow(r.commit, {
        onclick: () => {
          active?.classList.remove('active');
          active = node;
          node.classList.add('active');
          message.textContent = r.commit.subject;
        },
        ondblclick: () => ctx.compare(`${r.commit.hash}^`, r.commit.hash, { title: `커밋 ${r.commit.shortHash}` }),
      });
      return node;
    }));
  }

  /** 원본 WorkspaceView.FormatSize: 512 bytes, 1.5 KB, 3.25 MB. */
  function formatSize(bytes) {
    if (bytes == null || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} bytes`;
    const units = ['KB', 'MB', 'GB'];
    let n = bytes / 1024;
    let u = 0;
    while (n >= 1024 && u < units.length - 1) {
      n /= 1024;
      u++;
    }
    return `${+n.toFixed(2)} ${units[u]}`;
  }

  // ── 탐색 화면 머리(원본 branch-explorer__toolbar): 기간 · 요약 | 찾기 · [다음] · 탐색기 모양 ──

  function explorerBar(onQuery, { onSearch, onNext, extra = [] } = {}) {
    const period = el('select', { class: 'field small-select' }, PERIODS.map((p) => el('option', { value: p.value, text: p.label })));
    period.value = String(ctx.prefs.get('explorer.period') ?? 30);
    const summary = el('span', { class: 'muted small explorer-summary' });
    const query = () => ({ days: Number(period.value) });
    period.addEventListener('change', () => { ctx.prefs.set('explorer.period', Number(period.value)); onQuery(query()); });
    const search = el('input', { class: 'field explorer-search', placeholder: '찾기 — 제목·작성자·SHA·브랜치', spellcheck: 'false' });
    search.value = ctx.prefs.get('explorer.search') ?? '';
    const next = el('button', { class: 'btn small', text: '다음', 'data-tip': '검색에 맞는 다음 커밋으로 이동 (Enter)', disabled: !search.value.trim(), onclick: () => onNext?.(1) });
    search.addEventListener('input', () => {
      ctx.prefs.set('explorer.search', search.value);
      next.disabled = !search.value.trim();
      onSearch?.(search.value.trim().toLowerCase());
    });
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || isComposing(event)) return;
      event.preventDefault();
      onNext?.(event.shiftKey ? -1 : 1);
    });
    const style = layout() === 'gitkraken' ? null : el('button', {
      class: 'btn small explorer-style', 'data-tip': '브랜치 탐색기 모양',
      onclick: (event) => menuBelow(event.currentTarget, Object.entries(EXPLORER_STYLES).map(([key, label]) => ({
        label, checked: explorerStyle() === key, action: () => { ctx.prefs.set('explorer', key); select(tab, true); },
      }))),
    }, el('span', { text: EXPLORER_STYLES[explorerStyle()] }), icon('chevronDown', 12));
    const bar = el('div', { class: 'explorer-bar' }, period, summary, el('span', { class: 'spacer' }), extra, search, next, style);
    return {
      bar, query, summary, search: () => search.value.trim().toLowerCase(),
      widen: () => { period.value = '0'; ctx.prefs.set('explorer.period', 0); return query(); },
    };
  }

  const sinceOf = (days) => (days ? Math.floor(Date.now() / 1000) - days * 86400 : 0);
  const summaryText = (h, max) => `커밋 ${h.commits.length.toLocaleString('ko-KR')}개 · 줄 ${h.graph.lanes.length}개${h.truncated ? ` (최근 ${max.toLocaleString('ko-KR')}개까지)` : ''}`;

  // ── Fork 모양 브랜치 탐색기(EX-01, 원본 CommitHistoryView): 위 커밋 목록, 아래(340) [커밋 · 변경 · 파일 트리] ──
  // 목록은 GitKraken 그래프와 같은 모듈(createGraph)에 작성자·해시·날짜 칸을 붙인 것(원본 CommitGraphList detailColumns). 작업 중 줄은 없다.
  // 원본처럼 고른 줄을 다시 눌러도 선택을 풀지 않고(아래 칸이 늘 있다), 이름표를 두 번 눌러도 전환하지 않으며, 우클릭은 늘 커밋 메뉴다.

  function forkExplorer(root) {
    const MAX = 5000;
    const pane = el('section', { class: 'graph-pane explorer-graph' });
    const header = el('div', { class: 'graph-header' });
    const canvas = el('canvas', { class: 'graph-canvas' });
    const rows = el('div', { class: 'graph-rows' });
    const sizer = el('div', { class: 'graph-sizer' }, canvas, rows);
    const scroll = el('div', { class: 'graph-scroll', tabindex: '0' }, sizer);
    pane.append(header, scroll);
    const bottom = el('div', { class: 'chx-detail' });
    const errorNotice = el('div', { class: 'chx-notice error', hidden: true });
    const emptyNotice = el('div', { class: 'chx-notice', hidden: true, text: '아직 커밋이 없습니다.' });
    let history = null;
    let loading = null;
    let pendingReveal = null;
    let searchCursor = -1;
    const graph = createGraph({
      pane, header, scroll, sizer, canvas, rows,
      // 칸 폭·순서는 탐색기 따로(explorer.graph.*), 아바타 켜고 끄기는 메인 그래프와 같은 설정.
      prefs: {
        get: (k) => ctx.prefs.get(k === 'graph.avatars' ? k : `explorer.${k}`),
        set: (k, v) => ctx.prefs.set(k === 'graph.avatars' ? k : `explorer.${k}`, v),
      },
      avatars: ctx.avatars,
      toggleOff: false,
      onSelect: (key) => detail.show(key),
      onContextMenu: (key, event, commit) => {
        if (!commit) return;
        const parent = commit.parents[0];
        const inList = parent && history?.commits.some((c) => c.hash === parent);
        ctx.refsUi.commitMenu(event, commit, { goToParent: inList ? () => selectCommit(parent) : null });
      },
      // 이름표를 두 번 누르면 메인 그래프처럼 전환한다: 로컬은 체크아웃, 원격은 같은 이름 로컬로(없으면 추적 브랜치), 태그는 그 커밋.
      onRefActivate: (ref, commit) => ctx.refsUi.activateRef(ref, commit),
    });
    graph.setDetailColumns(true);
    const head = explorerBar((q) => load(q), { onSearch: () => { searchCursor = -1; }, onNext: (step) => next(step) });
    const split = el('div', { class: 'explorer-split' }, pane, splitter({ pane: bottom, axis: 'y', prefs: ctx.prefs, key: 'explorer.bottomHeight', size: 340, min: 160, rest: 120, after: true }), bottom);
    root.append(head.bar, errorNotice, emptyNotice, split);
    const detail = commitDetailPane(bottom, {
      selectCommit: (hash) => selectCommit(hash),
      commitOf: (hash) => history?.commits.find((c) => c.hash === hash) ?? null,
      refsOf: (hash) => refsOf(hash),
    });

    /** 목록에서 그 커밋을 고르고 보이게 한다(원본 CommitGraphList.SelectCommit). 목록에 없으면 false. */
    function selectCommit(hash) {
      if (!graph.reveal(hash)) return false;
      graph.select(hash);
      return true;
    }

    /** 상세에 보일 참조(원본 CommitRefs.Of(node, mergeRemotes: false)): 합쳐 둔 같은 이름의 원격도 따로 늘어놓는다. */
    function refsOf(hash) {
      const index = history?.commits.findIndex((c) => c.hash === hash) ?? -1;
      if (index < 0) return [];
      const commit = history.commits[index];
      const out = [];
      for (const ref of history.graph.nodes[index]?.refs ?? []) {
        out.push({ name: ref.name, kind: ref.kind });
        if (!ref.hasRemote) continue;
        for (const r of commit.refs ?? []) {
          if (r.kind === 'remote' && r.name.slice(r.name.indexOf('/') + 1) === ref.name) out.push({ name: r.name, kind: 'remote' });
        }
      }
      const display = (r) => (r.kind === 'remote' ? r.name.slice(r.name.indexOf('/') + 1) : r.name).toLowerCase();
      out.sort((a, b) => display(a).localeCompare(display(b)));
      const current = out.findIndex((r) => r.kind === 'current');
      if (current > 0) out.unshift(...out.splice(current, 1));
      return out;
    }

    function load(q) {
      head.summary.textContent = '불러오는 중…';
      loading = (async () => {
        try {
          history = await ctx.call('explorerHistory', { since: sinceOf(q.days), all: true, maxCount: MAX, topDown: true });
          errorNotice.hidden = true;
        } catch (error) {
          // 원본처럼 읽기 실패는 목록 위 빨간 안내 줄로(빈 목록).
          history = { commits: [], graph: { nodes: [], lanes: [], edges: [], laneCount: 1 }, head: null, truncated: false };
          errorNotice.textContent = error?.message ?? String(error);
          errorNotice.hidden = false;
        }
        const hasCommits = !!history.head || history.commits.length > 0;
        emptyNotice.hidden = hasCommits || !errorNotice.hidden;
        split.hidden = !hasCommits && errorNotice.hidden;
        const shown = detail.shown;
        graph.setData(history, null);
        // 보던 커밋이 새 목록에 없으면 안내로(원본 Load: SelectCommit 실패 → ShowPlaceholder).
        if (shown && graph.selected !== shown) detail.show(null);
        head.summary.textContent = summaryText(history, MAX);
        searchCursor = -1;
        if (pendingReveal) reveal(pendingReveal);
      })();
      return loading;
    }

    /** 검색창 Enter·[다음]: 위(최신)부터 제목·작성자·해시가 검색어를 담은 다음 커밋을 고른다(원본 FocusNextMatch). */
    function next(step) {
      const needle = head.search();
      const commits = history?.commits ?? [];
      if (!needle || !commits.length) return;
      const count = commits.length;
      for (let i = 1; i <= count; i++) {
        const index = ((searchCursor < 0 ? (step > 0 ? -1 : count) : searchCursor) + step * i + count * 2) % count;
        const c = commits[index];
        if (c.subject.toLowerCase().includes(needle) || c.authorName.toLowerCase().includes(needle) || c.hash.startsWith(needle)) {
          searchCursor = index;
          selectCommit(c.hash);
          return;
        }
      }
      ctx.notify?.(`'${needle}' 에 맞는 커밋이 없습니다.`);
    }

    /** 그 커밋으로 가서 고른다. 읽은 범위 밖이면 기간을 "전체" 로 넓혀 다시 읽는다(원본 TryReveal). */
    async function reveal(hash) {
      pendingReveal = hash;
      if (!history) return;
      if (selectCommit(hash)) {
        pendingReveal = null;
        return;
      }
      if (Number(ctx.prefs.get('explorer.period') ?? 30) !== 0) {
        await load(head.widen());
        return;
      }
      pendingReveal = null;
    }

    load(head.query());
    // refsChanged: 브랜치·태그·HEAD 가 바뀌었을 때만 다시 읽는다(전환하면 ✓ 지금 브랜치 강조가 옮겨 간다).
    return { refresh: () => load(head.query()), refsChanged: () => load(head.query()), dispose: () => detail.dispose(), reveal };
  }

  /**
   * Fork 탐색기 아래 칸(원본 CommitHistoryView 의 commit-history__detail): 위 [커밋][변경][파일 트리] 단추, 아래 고른 칸.
   * 커밋을 안 골랐으면 단추만 두고 안내 한 줄. 커밋을 바꾸면 세 칸을 모두 그 커밋으로 묶는다(파일 트리는 그 칸을 열 때 읽는다).
   * hooks: { selectCommit(hash), commitOf(hash), refsOf(hash) }
   */
  function commitDetailPane(host, hooks) {
    const MAX_FILE_ROWS = 500;
    const MAX_CHARS = 1000000;
    const LINE_HEIGHT = 18;
    const PAGES = [['commit', '커밋'], ['changes', '변경'], ['tree', '파일 트리']];
    // 원본처럼 고른 칸은 화면이 떠 있는 동안만 기억한다(처음은 늘 [커밋]).
    let page = 'commit';
    let shown = null; // 고른 커밋 해시
    let commit = null; // 목록의 커밋(제목·작성자·부모)
    let files = []; // commitDetail.files 에 상태를 붙인 것
    let detailData = null;
    let treeHash = null;
    let pendingTreePath = null;
    let token = 0;

    const tabButtons = PAGES.map(([key, label]) => el('button', { class: 'chx-tab', text: label, onclick: () => selectPage(key) }));
    const placeholder = el('div', { class: 'chx-placeholder', text: '커밋을 고르면 메시지와 바뀐 파일이 여기에 나옵니다.' });

    // 커밋 칸: 한 스크롤 안에 작성자·커미터, 참조·SHA·부모, 메시지, 바뀐 파일.
    const author = el('div', { class: 'chx-person' });
    const committer = el('div', { class: 'chx-person', hidden: true });
    const refsValue = el('div', { class: 'chx-field-value' });
    const refsField = el('div', { class: 'chx-field' }, el('span', { class: 'chx-field-label', text: '참조' }), refsValue);
    const sha = el('span', { class: 'chx-sha', 'data-tip': '누르면 전체 해시를 복사합니다.', onclick: () => shown && navigator.clipboard?.writeText(shown) });
    const parentsValue = el('div', { class: 'chx-field-value' });
    const parentsField = el('div', { class: 'chx-field' }, el('span', { class: 'chx-field-label', text: '부모' }), parentsValue);
    const subject = el('div', { class: 'chx-subject' });
    const body = el('div', { class: 'chx-body' });
    const commitFiles = el('div', { class: 'chx-file-list' });
    const commitPage = el('div', { class: 'chx-page chx-info' },
      el('div', { class: 'chx-people' }, author, committer),
      refsField,
      el('div', { class: 'chx-field' }, el('span', { class: 'chx-field-label', text: 'SHA' }), el('div', { class: 'chx-field-value' }, sha)),
      parentsField,
      el('div', { class: 'chx-message' }, subject, body),
      commitFiles);

    // 변경 칸: 머리 한 줄, 왼쪽 바뀐 파일(320) | 오른쪽 diff.
    const changesHeader = el('div', { class: 'chx-header-line' });
    const changesSummary = el('div', { class: 'chx-summary' });
    const changesMode = el('span', { class: 'chx-tools' });
    const changesFiles = el('div', { class: 'chx-files' });
    const changesSide = el('div', { class: 'chx-side' }, el('div', { class: 'chx-list-header' }, changesSummary, el('span', { class: 'spacer' }), changesMode), changesFiles);
    const diffBox = el('div', { class: 'chx-viewer diff-view embedded' });
    const diff = createDiffView(diffBox);
    const changesPage = el('div', { class: 'chx-page' }, changesHeader,
      el('div', { class: 'chx-split' }, changesSide, splitter({ pane: changesSide, prefs: ctx.prefs, key: 'explorer.changesWidth', size: 320, min: 180, rest: 160 }), diffBox));

    // 파일 트리 칸: 머리 한 줄, 왼쪽 그 커밋의 모든 파일 | 오른쪽 내용.
    const treeHeader = el('div', { class: 'chx-header-line' });
    const treeFiles = el('div', { class: 'chx-files' });
    const treeSide = el('div', { class: 'chx-side' }, treeFiles);
    const contentPath = el('div', { class: 'chx-content-path' });
    const contentNotice = el('div', { class: 'chx-placeholder', hidden: true });
    const contentScroll = el('div', { class: 'chx-content', hidden: true });
    const treePage = el('div', { class: 'chx-page' }, treeHeader,
      el('div', { class: 'chx-split' }, treeSide, splitter({ pane: treeSide, prefs: ctx.prefs, key: 'explorer.treeWidth', size: 320, min: 180, rest: 160 }),
        el('div', { class: 'chx-viewer' }, contentPath, contentNotice, contentScroll)));

    const pages = { commit: commitPage, changes: changesPage, tree: treePage };
    host.replaceChildren(el('div', { class: 'chx-tabs' }, tabButtons), placeholder, commitPage, changesPage, treePage);

    // 변경 칸 목록 상태
    const changesState = { selected: new Set(), anchor: null };
    const changesCollapsed = new Set();
    let changesView = ctx.prefs.get('explorer.changesView') ?? 'path';
    // 파일 트리 칸 목록 상태
    let treePaths = [];
    const treeState = { selected: new Set(), anchor: null };
    let treeCollapsed = new Set();
    let contentKey = null;

    function selectPage(key) {
      page = key;
      PAGES.forEach(([k], i) => tabButtons[i].classList.toggle('on', k === key));
      for (const [k, node] of Object.entries(pages)) node.hidden = !(shown && k === key);
      placeholder.hidden = !!shown;
      if (key === 'tree') loadTree();
    }

    function showPlaceholder() {
      shown = null;
      commit = null;
      files = [];
      detailData = null;
      treeHash = null;
      diff.close();
      selectPage(page);
    }

    async function show(hash) {
      if (!hash || hash === 'wip') {
        showPlaceholder();
        return;
      }
      if (hash === shown) return;
      const my = ++token;
      shown = hash;
      commit = hooks.commitOf(hash);
      detailData = null;
      treeHash = null;
      files = [];
      changesState.selected.clear();
      changesState.anchor = null;
      diff.close();
      selectPage(page);
      // 목록에 있는 것으로 먼저 채우고, 메시지·파일·커미터는 읽은 뒤에.
      if (commit) {
        bindPerson(author, '작성자', commit.authorName, commit.authorEmail, commit.time, commit.hash);
        committer.hidden = true;
        sha.textContent = commit.hash;
        bindParents(commit.parents);
        setMessage(commit.subject);
        bindHeaderLine(changesHeader, commit);
        bindHeaderLine(treeHeader, commit);
      }
      bindRefs(hooks.refsOf(hash));
      bindFiles();
      const data = await ctx.call('commitDetail', { hash }).catch((error) => { ctx.showError(error); return null; });
      if (!data || my !== token) return;
      detailData = data;
      if (!commit) {
        commit = { hash: data.hash, shortHash: data.hash.slice(0, 7), subject: data.message.split('\n')[0], authorName: data.authorName, authorEmail: data.authorEmail, time: data.time, parents: data.parents };
        bindPerson(author, '작성자', data.authorName, data.authorEmail, data.time, data.hash);
        sha.textContent = data.hash;
        bindParents(data.parents);
        bindHeaderLine(changesHeader, commit);
        bindHeaderLine(treeHeader, commit);
      }
      setMessage(data.message);
      // 작성자와 같은 사람·같은 시각이면(대부분의 커밋) 커미터 칸을 따로 두지 않는다.
      const same = !data.committerName
        || (data.committerEmail === data.authorEmail && data.committerName === data.authorName && Math.abs((data.committerTime ?? data.time) - data.time) < 1);
      committer.hidden = same;
      if (!same) bindPerson(committer, '커미터', data.committerName, data.committerEmail, data.committerTime, null);
      files = data.files.map((f) => ({ ...f, state: CHANGE_STATE[f.status] ?? 'modified' }));
      bindFiles();
      if (page === 'tree') loadTree();
    }

    // ── 커밋 칸 ──

    function avatarBox(name, email, hash, small) {
      const box = el('span', { class: `chx-avatar${small ? ' small' : ''}`, style: { background: rgb(authorRgb(name)) }, text: initials(name) });
      if (ctx.avatars?.url && email) {
        ctx.avatars.url(email, hash).then((url) => {
          if (!url) return;
          box.textContent = '';
          box.style.background = `center / cover no-repeat url("${url}")`;
        }).catch(() => {});
      }
      return box;
    }

    /** "작성자" 머리, 아바타 36, 이름 · 이메일, 날짜(원본 BindPerson). */
    function bindPerson(node, caption, name, email, time, hash) {
      node.replaceChildren(
        el('div', { class: 'chx-person-caption', text: caption }),
        el('div', { class: 'chx-person-row' }, avatarBox(name, email, hash, false),
          el('div', { class: 'chx-person-text' },
            el('div', { class: 'chx-person-name-line' }, el('span', { class: 'chx-person-name', text: name }), el('span', { class: 'chx-person-email', text: email })),
            el('div', { class: 'chx-person-date', text: formatDate(time, true) }))));
    }

    function bindRefs(refs) {
      refsField.hidden = !refs.length;
      refsValue.replaceChildren(...refs.map((r) => el('span', { class: `chx-ref ${r.kind}`, text: r.name })));
    }

    function bindParents(parents) {
      parentsField.hidden = !parents.length;
      parentsValue.replaceChildren(...parents.map((p) => el('span', { class: 'chx-parent', text: p.slice(0, 7), 'data-tip': '그래프에서 이 커밋 보기', onclick: () => hooks.selectCommit(p) })));
    }

    function setMessage(message) {
      const lines = message.replace(/\r\n/g, '\n').split('\n');
      subject.textContent = lines[0] ?? '';
      const rest = lines.slice(1).join('\n').trim();
      body.textContent = rest;
      body.hidden = !rest;
    }

    function bindFiles() {
      // 커밋 칸: [상태][아이콘][경로][→] 의 평평한 목록. 누르면 변경 칸에서 그 파일 diff, 우클릭은 파일 메뉴.
      commitFiles.replaceChildren(...files.slice(0, MAX_FILE_ROWS).map((f) => el('div', {
        class: 'chx-file',
        onclick: () => openInChanges(f),
        oncontextmenu: (event) => { event.preventDefault(); fileMenu(event, [f]); },
      }, stateIcon(f.state), fileIcon(f.path), el('span', { class: 'chx-file-path', text: f.originalPath ? `${f.originalPath} → ${f.path}` : f.path }), el('span', { class: 'chx-file-arrow', text: '→' }))));
      if (files.length > MAX_FILE_ROWS) commitFiles.append(el('div', { class: 'chx-file-more', text: `… 파일 ${files.length - MAX_FILE_ROWS}개 더 — Changes 탭에서 보기`, onclick: () => selectPage('changes') }));
      commitFiles.hidden = !files.length;
      bindSummary();
      drawChanges();
    }

    function fileMenu(event, picked) {
      if (!detailData) return;
      ctx.actions.commitFileMenu(event, detailData, picked, { showInTree: (path) => showInFileTree(path) });
    }

    // ── 변경 칸 ──

    /** "✎ 2 수정  + 1 추가  − 1 삭제  → 1 이름 변경" — 종류마다 상태 색(원본 BindSummary). */
    function bindSummary() {
      const count = (state) => files.filter((f) => f.state === state).length;
      changesSummary.replaceChildren(...[['modified', '✎', '수정'], ['added', '+', '추가'], ['deleted', '−', '삭제'], ['renamed', '→', '이름 변경']]
        .filter(([state]) => count(state))
        .map(([state, sign, label]) => el('span', { class: `chx-count ${state}`, text: `${sign} ${count(state)} ${label}` })));
    }

    const openDiff = (f) => diff.open({
      target: { kind: 'commit', hash: shown, path: f.path, originalPath: f.originalPath ?? null },
      mode: 'commit', title: f.path, api: { ...ctx.diffApi, close: () => diff.close() },
    });

    function drawChanges() {
      changesMode.replaceChildren(viewSwitch(changesView, (v) => { changesView = v; ctx.prefs.set('explorer.changesView', v); drawChanges(); }));
      changesFiles.replaceChildren(fileList({
        entries: files, view: changesView, state: changesState, collapsed: changesCollapsed,
        onToggleFolder: (p) => { if (changesCollapsed.has(p)) changesCollapsed.delete(p); else changesCollapsed.add(p); drawChanges(); },
        onSetCollapsed: (paths) => { changesCollapsed.clear(); for (const p of paths) changesCollapsed.add(p); drawChanges(); },
        onOpen: openDiff,
        onMenu: (event, picked) => fileMenu(event, picked),
        empty: detailData ? '바뀐 파일이 없습니다.' : '불러오는 중…',
      }));
    }

    /** 커밋 칸에서 고른 파일: 변경 칸으로 넘어가 그 파일 diff 를 보고, 왼쪽 목록에서도 그 파일을 펼쳐 고른다(원본 OpenInChanges). */
    function openInChanges(f) {
      selectPage('changes');
      changesState.selected.clear();
      changesState.selected.add(f.path);
      changesState.anchor = f.path;
      for (let i = f.path.indexOf('/'); i > 0; i = f.path.indexOf('/', i + 1)) changesCollapsed.delete(f.path.slice(0, i));
      drawChanges();
      openDiff(f);
      requestAnimationFrame(() => changesFiles.querySelector(`.file-row[data-path="${CSS.escape(f.path)}"]`)?.scrollIntoView({ block: 'nearest' }));
    }

    function bindHeaderLine(node, c) {
      node.replaceChildren(avatarBox(c.authorName, c.authorEmail, c.hash, true),
        el('span', { class: 'chx-h-author', text: c.authorName }),
        el('span', { class: 'chx-h-hash', text: c.shortHash ?? c.hash.slice(0, 7) }),
        el('span', { class: 'chx-h-date', text: formatDate(c.time, true) }),
        el('span', { class: 'chx-h-subject', text: c.subject }));
    }

    // ── 파일 트리 칸 ──

    async function loadTree() {
      if (!shown || treeHash === shown) return;
      const hash = shown;
      treeHash = hash;
      treePaths = [];
      drawTree();
      showContent(null, null);
      let paths;
      try {
        paths = await ctx.call('treeFiles', { revision: hash });
      } catch (error) {
        if (treeHash === hash) showContent(null, error?.message ?? String(error));
        return;
      }
      if (treeHash !== hash) return;
      treePaths = paths;
      treeState.selected.clear();
      treeState.anchor = null;
      treeCollapsed = new Set(paths.flatMap((p) => {
        const parts = p.split('/').slice(0, -1);
        return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
      }));
      drawTree();
      revealPendingTreePath();
    }

    function drawTree() {
      treeFiles.replaceChildren(fileList({
        entries: treePaths.map((path) => ({ path, state: 'tracked' })), view: 'tree', state: treeState, collapsed: treeCollapsed,
        onToggleFolder: (p) => { if (treeCollapsed.has(p)) treeCollapsed.delete(p); else treeCollapsed.add(p); drawTree(); },
        onSetCollapsed: (paths) => { treeCollapsed = new Set(paths); drawTree(); },
        onOpen: (f) => showFile(f.path),
        onMenu: (event, picked, clicked) => treeMenu(event, (clicked ?? picked[0]).path, false),
        onFolderMenu: (event, folder) => treeMenu(event, folder.path, true),
        empty: treeHash ? '불러오는 중…' : '파일이 없습니다.',
      }));
    }

    /** 파일 트리 칸으로 넘어가 그 파일을 펼쳐 고른다(트리를 아직 안 읽었으면 읽은 뒤, 원본 ShowInFileTree). */
    function showInFileTree(path) {
      pendingTreePath = path;
      selectPage('tree');
      if (treeHash === shown && treePaths.length) revealPendingTreePath();
    }

    function revealPendingTreePath() {
      const path = pendingTreePath;
      if (!path || !treePaths.includes(path)) return;
      pendingTreePath = null;
      for (let i = path.indexOf('/'); i > 0; i = path.indexOf('/', i + 1)) treeCollapsed.delete(path.slice(0, i));
      treeState.selected = new Set([path]);
      treeState.anchor = path;
      drawTree();
      treeFiles.querySelector(`.file-row[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'center' });
      showFile(path);
    }

    /** 파일 트리 우클릭(원본 PopulateTreeMenu). 여는 항목은 작업 폴더에 지금 그 파일이 있을 때만 켠다. */
    async function treeMenu(event, path, folder) {
      event.preventDefault();
      const info = await ctx.call('pathInfo', { path }).catch(() => ({ exists: false }));
      const fm = ctx.state.platform === 'windows' ? '탐색기' : 'Finder';
      const exists = !!info.exists;
      if (folder) {
        showMenu(event.clientX, event.clientY, [
          { label: `${fm} 에서 열기`, disabled: !exists, action: () => ctx.call('openFolder', { path: `${ctx.state.repo.path}/${path}` }).catch(ctx.showError) },
          '-',
          { label: '폴더 경로 복사', action: () => navigator.clipboard?.writeText(path) },
        ]);
        return;
      }
      showMenu(event.clientX, event.clientY, [
        { label: '외부 편집기로 열기', disabled: !exists, action: () => ctx.call('openInEditor', { path, line: 1, editor: ctx.prefs.get('editor') ?? '' }).catch(ctx.showError) },
        { label: '기본 프로그램으로 열기', disabled: !exists, action: () => ctx.call('openDefault', { path }).catch(ctx.showError) },
        { label: `${fm} 에서 보기`, disabled: !exists, action: () => ctx.call('reveal', { path }).catch(ctx.showError) },
        '-',
        { label: '파일 히스토리', action: () => ctx.fileHistory?.(path) },
        { label: '파일 Blame', disabled: !exists || !ctx.blame, action: () => ctx.blame?.(path, shown) },
        '-',
        { label: '이 버전을 다른 이름으로 저장…', disabled: !shown, action: () => ctx.actions.saveVersion(shown, path) },
        '-',
        { label: '파일 경로 복사', action: () => navigator.clipboard?.writeText(path) },
      ]);
    }

    async function showFile(path) {
      if (!shown) return;
      const key = contentKey = `${shown}:${path}`;
      contentPath.textContent = path;
      showContent(null, '불러오는 중…');
      try {
        const data = await ctx.call('fileBytes', { revision: shown, path });
        if (contentKey !== key) return;
        if (data.mime.startsWith('image/')) {
          contentNotice.hidden = true;
          contentScroll.hidden = false;
          contentScroll.onscroll = null;
          contentScroll.replaceChildren(el('div', { class: 'checker chx-image' }, el('img', { src: `data:${data.mime};base64,${data.base64}` })));
          return;
        }
        const bytes = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
        if (bytes.includes(0)) {
          showContent(null, '이진 파일이라 내용을 보이지 않습니다.');
          return;
        }
        let text = new TextDecoder().decode(bytes);
        const truncated = text.length > MAX_CHARS;
        if (truncated) text = text.slice(0, MAX_CHARS);
        showContent(text.split(/\r\n|\n|\r/), truncated ? `파일이 커서 앞의 ${MAX_CHARS.toLocaleString('en-US')}자만 보입니다.` : null);
      } catch (error) {
        if (contentKey === key) showContent(null, error?.message ?? String(error));
      }
    }

    /** lines 가 null 이면 내용을 비운다. notice 는 내용 위(또는 대신) 보일 안내(원본 ShowContent). */
    function showContent(lines, notice) {
      if (!lines && notice == null) {
        contentPath.textContent = '';
        contentKey = null;
      }
      contentNotice.textContent = notice ?? '';
      contentNotice.hidden = notice == null;
      contentScroll.hidden = !lines;
      contentScroll.onscroll = null;
      contentScroll.replaceChildren();
      if (!lines) return;
      const width = 62 + lines.reduce((m, l) => Math.max(m, l.length), 0) * 7.3 + 20;
      const sizer = el('div', { class: 'vrows', style: { height: `${lines.length * LINE_HEIGHT}px`, minWidth: `${width}px` } });
      contentScroll.append(sizer);
      const drawRows = () => {
        const first = Math.max(0, Math.floor(contentScroll.scrollTop / LINE_HEIGHT) - 20);
        const last = Math.min(lines.length, Math.ceil((contentScroll.scrollTop + contentScroll.clientHeight) / LINE_HEIGHT) + 20);
        const html = [];
        // 탭은 공백 넷으로(글꼴마다 탭 폭이 달라 줄이 어긋나지 않게).
        for (let i = first; i < last; i++) html.push(`<div class="chx-line" style="top:${i * LINE_HEIGHT}px"><span class="chx-ln">${i + 1}</span><span class="chx-text">${esc(lines[i].replace(/\t/g, '    '))}</span></div>`);
        sizer.innerHTML = html.join('');
      };
      contentScroll.onscroll = () => requestAnimationFrame(drawRows);
      requestAnimationFrame(drawRows);
    }

    selectPage(page);
    return {
      show,
      get shown() { return shown; },
      dispose: () => diff.close(),
    };
  }

  // ── Unity VCS 모양 가로 브랜치 탐색기(EX-02, 원본 BranchExplorerView) ──
  // 그리기·조작은 branchgraph.js(원본 BranchGraphElement), 오른쪽 380 인스펙터, 그래프 오른쪽 아래 [HEAD][확대][축소].

  function unityExplorer(root) {
    const MAX = 5000;
    let h = null;
    let loading = false;
    let pendingReveal = null;
    let searchCursor = -1;
    let detailToken = 0;
    const detailBox = el('div', { class: 'bx-detail' });
    const placeholder = () => detailBox.replaceChildren(el('div', { class: 'ws-empty', text: '커밋을 고르면 메시지와 바뀐 파일이 여기에 나옵니다.' }));
    let shownHash = null;
    const graph = createBranchGraph({
      avatars: ctx.avatars,
      avatarsOn: () => ctx.prefs.get('graph.avatars') !== false,
      zoom: ctx.prefs.get('explorer.zoom') ?? 1,
      onSelect: (node) => select(node),
      // 커밋을 두 번 누르면 그 커밋과 부모를 비교하는 창을 연다(원본 NodeChosen → GitCompareWindow.OpenCommit).
      onChoose: (node) => {
        const c = node.commit;
        if (c.parents.length) ctx.compare(`${c.hash}^`, c.hash, { title: `커밋 ${c.shortHash}` });
      },
      onContextMenu: (event, node) => {
        const parent = parentNodeOf(node);
        ctx.refsUi?.commitMenu?.(event, node.commit, { goToParent: parent ? () => { select(parent); graph.focusNode(parent); } : null });
      },
      onViewport: ({ zoom }) => ctx.prefs.set('explorer.zoom', zoom),
    });
    const overlay = el('div', { class: 'bx-overlay' },
      el('button', { class: 'bx-overlay-btn', 'data-tip': 'HEAD 로 이동', onclick: () => graph.focusNode(graph.findHead()) }, icon('home', 18)),
      el('button', { class: 'bx-overlay-btn', 'data-tip': '확대', onclick: () => graph.zoomBy(1.25) }, icon('zoomIn', 18)),
      el('button', { class: 'bx-overlay-btn', 'data-tip': '축소', onclick: () => graph.zoomBy(1 / 1.25) }, icon('zoomOut', 18)));
    const wrap = el('div', { class: 'bx-wrap' }, graph.element, overlay);
    const head = explorerBar((q) => load(q), {
      onSearch: (q) => { searchCursor = -1; graph.setSearch(q); },
      onNext: (step) => focusNextMatch(step),
    });
    graph.setSearch(head.search());
    root.append(head.bar, el('div', { class: 'bx-split' }, wrap, splitter({ pane: detailBox, prefs: ctx.prefs, key: 'explorer.detailWidth', size: 380, min: 220, rest: 240, after: true }), detailBox));
    placeholder();

    async function load(q) {
      loading = true;
      head.summary.textContent = '불러오는 중…';
      try {
        h = await ctx.call('explorerHistory', { since: sinceOf(q.days), all: true, maxCount: MAX, topDown: false });
      } catch (error) {
        loading = false;
        head.summary.textContent = '';
        ctx.showError(error);
        return;
      }
      loading = false;
      const model = buildModel(h);
      // 커밋이 하나도 없는 레포지토리는 원본 common.noCommits, 기간 안에 없으면 explorer.emptyRange.
      graph.setGraph(model, h.head ? '이 기간에 커밋이 없습니다. 기간을 늘려 보세요.' : '아직 커밋이 없습니다.');
      if (shownHash && !model.nodeByHash.has(shownHash)) {
        shownHash = null;
        placeholder();
        graph.setSelected(null);
      }
      head.summary.textContent = summaryText(h, MAX);
      searchCursor = -1;
      tryReveal();
    }

    function select(node) {
      graph.setSelected(node.commit.hash);
      if (shownHash === node.commit.hash) return;
      shownHash = node.commit.hash;
      const my = ++detailToken;
      ctx.call('commitDetail', { hash: node.commit.hash }).then((d) => {
        if (my === detailToken) renderCommit(detailBox, d, ctx.actions);
      }).catch(ctx.showError);
    }

    /** 첫 부모의 노드. 기간 밖이라 그래프에 없으면 null. */
    function parentNodeOf(node) {
      const parent = node.commit.parents[0];
      return parent ? graph.graph?.nodeByHash.get(parent) ?? null : null;
    }

    /** 최신 커밋부터 거꾸로 돌며 다음 일치 항목으로 이동·선택한다(Shift+Enter 는 반대로). */
    function focusNextMatch(step) {
      const model = graph.graph;
      if (!model || !model.nodes.length) return;
      const count = model.nodes.length;
      const base = searchCursor < 0 ? (step > 0 ? count : -1) : searchCursor;
      for (let k = 1; k <= count; k++) {
        const index = (((base - step * k) % count) + count) % count;
        const node = model.nodes[index];
        if (graph.matches(node)) {
          searchCursor = index;
          select(node);
          graph.focusNode(node);
          return;
        }
      }
      ctx.notify?.(`'${head.search()}' 에 맞는 커밋이 없습니다.`);
    }

    /** 그 커밋을 가운데에 두고 고른다. 읽은 기간 밖이면 "전체" 로 넓혀 다시 읽는다. */
    function reveal(hash) {
      pendingReveal = hash;
      tryReveal();
    }
    async function tryReveal() {
      if (!pendingReveal || loading || !graph.graph) return;
      const node = graph.graph.nodeByHash.get(pendingReveal);
      if (node) {
        pendingReveal = null;
        select(node);
        graph.focusNode(node);
        return;
      }
      if (Number(ctx.prefs.get('explorer.period') ?? 30) !== 0) {
        await load(head.widen());
        return;
      }
      // 전체 기간에서도 없으면(읽는 커밋 수 상한 밖) 포기한다.
      pendingReveal = null;
    }

    load(head.query());
    return { refresh: () => load(head.query()), dispose: () => graph.dispose(), reveal };
  }

  // ── 워크스페이스(EX-04, 원본 WorkspaceView): 폴더 트리 표(항목 · 상태 · 크기 · 수정한 날짜) | 정보·히스토리(340) ──

  function workspaceView(root) {
    const ROW = 22;
    let showIgnored = ctx.prefs.get('workspace.ignored') ?? true;
    let changedOnly = ctx.prefs.get('workspace.changed') ?? false;
    let filter = '';
    let entries = [];
    let byPath = new Map();
    let rows = [];
    let selected = null;
    const expanded = new Set(ctx.prefs.get('workspace.expanded') ?? []);
    const table = el('div', { class: 'ws-table', tabindex: '0' });
    const side = el('aside', { class: 'ws-side' });
    const search = el('input', { class: 'field explorer-search', placeholder: '필터 — 경로', spellcheck: 'false' });
    const ignored = el('label', { class: 'check' }, el('input', { type: 'checkbox' }), '무시 항목 보기');
    const changed = el('label', { class: 'check' }, el('input', { type: 'checkbox' }), '변경만 보기');
    ignored.firstChild.checked = showIgnored;
    changed.firstChild.checked = changedOnly;
    const count = el('span', { class: 'muted small' });
    root.append(el('div', { class: 'explorer-bar' }, search, ignored, changed, count),
      el('div', { class: 'ws-layout' }, el('div', { class: 'ws-main' }, el('div', { class: 'ws-row ws-head' }, el('span', { text: '항목' }), el('span', { text: '상태' }), el('span', { text: '크기', class: 'ws-size' }), el('span', { text: '수정한 날짜' })), table),
        splitter({ pane: side, prefs: ctx.prefs, key: 'workspace.sideWidth', size: 340, min: 200, rest: 300, after: true }), side));
    search.addEventListener('input', () => { filter = search.value.trim().toLowerCase(); build(); });
    ignored.firstChild.addEventListener('change', () => { showIgnored = ignored.firstChild.checked; ctx.prefs.set('workspace.ignored', showIgnored); load(); });
    changed.firstChild.addEventListener('change', () => { changedOnly = changed.firstChild.checked; ctx.prefs.set('workspace.changed', changedOnly); build(); });

    // 폴더 상태(원본 GitWorkspaceScan.Classify): 무시 > 안에 변경 있음 > 추적 중 > 비공개.
    const folders = new Map(); // path → { changed, tracked, ignored, untracked }
    const isChange = (s) => s && s !== 'ignored';
    function index() {
      folders.clear();
      byPath = new Map(entries.map((e) => [e.path, e]));
      for (const e of entries) {
        const parts = e.path.split('/');
        for (let i = 1; i < parts.length; i++) {
          const p = parts.slice(0, i).join('/');
          const f = folders.get(p) ?? { changed: false, tracked: false, ignored: true, count: 0 };
          if (isChange(e.state)) f.changed = true;
          if (!e.state || (e.state !== 'untracked' && e.state !== 'ignored')) f.tracked = true;
          if (e.state !== 'ignored') f.ignored = false;
          folders.set(p, f);
        }
      }
    }
    const stateOf = (path, isFolder) => {
      if (isFolder) {
        const f = folders.get(path);
        return f?.ignored ? 'Ignored' : f?.changed ? 'Changed' : f?.tracked ? 'Tracked' : 'Untracked';
      }
      const s = byPath.get(path)?.state;
      return s === 'ignored' ? 'Ignored' : s === 'untracked' ? 'Untracked' : s ? 'Changed' : 'Tracked';
    };
    const STATE_TEXT = { Changed: '변경됨', Tracked: '제어됨', Untracked: '비공개', Ignored: '무시 항목' };
    const stateText = (path, isFolder) => {
      const s = stateOf(path, isFolder);
      const change = !isFolder && s === 'Changed' ? byPath.get(path)?.state : null;
      return change ? `${STATE_TEXT[s]} · ${STATE_LABEL[change] ?? change}` : STATE_TEXT[s];
    };

    async function load() {
      try {
        entries = await ctx.call('workspace', { ignored: showIgnored });
        index();
        const tracked = entries.filter((e) => e.state !== 'untracked' && e.state !== 'ignored').length;
        const changes = entries.filter((e) => isChange(e.state)).length;
        count.textContent = `추적 파일 ${tracked.toLocaleString('ko-KR')}개 · 변경 ${changes.toLocaleString('ko-KR')}개`;
        build();
      } catch (error) {
        ctx.showError(error);
      }
    }

    /** 펼친 폴더만 따라 내려가며 보일 줄을 만든다. 필터 중이면 맞는 파일을 경로째 보인다. */
    function build() {
      const keep = (e) => (!changedOnly || isChange(e.state) || e.state === 'untracked');
      rows = [];
      if (filter) {
        for (const e of entries) if (keep(e) && e.path.toLowerCase().includes(filter)) rows.push({ path: e.path, name: e.path, depth: 0, folder: false });
      } else {
        const children = new Map(); // folder → { folders:Set, files:[] }
        const node = (p) => children.get(p) ?? children.set(p, { folders: new Set(), files: [] }).get(p);
        for (const e of entries) {
          if (!keep(e)) continue;
          const parts = e.path.split('/');
          for (let i = 0; i < parts.length - 1; i++) node(parts.slice(0, i).join('/')).folders.add(parts.slice(0, i + 1).join('/'));
          node(parts.slice(0, -1).join('/')).files.push(e.path);
        }
        const walk = (p, depth) => {
          const n = children.get(p);
          if (!n) return;
          for (const f of [...n.folders].sort((a, b) => a.localeCompare(b))) {
            rows.push({ path: f, name: f.split('/').pop(), depth, folder: true });
            if (expanded.has(f)) walk(f, depth + 1);
          }
          for (const f of n.files.sort((a, b) => a.localeCompare(b))) rows.push({ path: f, name: f.split('/').pop(), depth, folder: false });
        };
        walk('', 0);
      }
      view.setCount(rows.length);
    }

    function toggle(path) {
      if (expanded.has(path)) expanded.delete(path);
      else expanded.add(path);
      ctx.prefs.set('workspace.expanded', [...expanded]);
      build();
    }

    function choose(row) {
      selected = row;
      view.refresh();
      if (!row) {
        side.replaceChildren(el('div', { class: 'ws-empty', text: '파일이나 폴더를 고르면 정보와 히스토리가 여기에 나옵니다.' }));
        return;
      }
      const e = byPath.get(row.path);
      fileDetails(side, { path: row.path, state: e?.state ?? '', isFolder: row.folder, size: e?.size ?? null, created: e?.created ?? null, modified: e?.modified ?? null, stateText: stateText(row.path, row.folder) });
    }

    function menu(event, row) {
      event.preventDefault();
      choose(row);
      if (row.folder) {
        const inside = (ctx.state.status ? [...ctx.state.status.unstaged] : []).filter((e) => e.path.startsWith(`${row.path}/`));
        ctx.actions.folderMenu?.(event, { path: row.path }, inside, 'unstaged', {});
        return;
      }
      const s = stateOf(row.path, false);
      // 바뀌지 않은 추적 파일은 히스토리·blame 이 있는 파일로 다룬다(원본과 같다).
      const entry = { path: row.path, state: byPath.get(row.path)?.state || (s === 'Tracked' ? 'modified' : 'untracked') };
      const items = [...(s !== 'Ignored' ? ctx.actions.workingFileItems?.(entry) ?? [] : []), ...(ctx.actions.commonFileItems?.(entry, false) ?? [])];
      if (items.length) showMenu(event.clientX, event.clientY, items);
    }

    const view = (() => {
      const sizer = el('div', { class: 'vrows' });
      table.append(sizer);
      let frame = 0;
      const draw = () => {
        sizer.style.height = `${rows.length * ROW}px`;
        const first = Math.max(0, Math.floor(table.scrollTop / ROW) - 20);
        const last = Math.min(rows.length, Math.ceil((table.scrollTop + table.clientHeight) / ROW) + 20);
        const out = [];
        for (let i = first; i < last; i++) {
          const row = rows[i];
          const e = byPath.get(row.path);
          const s = stateOf(row.path, row.folder);
          out.push(el('div', {
            class: `ws-row${i % 2 ? ' alt' : ''}${selected?.path === row.path ? ' active' : ''} ws-${s.toLowerCase()}`,
            style: { top: `${i * ROW}px` },
            onclick: () => choose(row),
            ondblclick: () => (row.folder ? toggle(row.path) : ctx.call('openDefault', { path: row.path }).catch(ctx.showError)),
            oncontextmenu: (event) => menu(event, row),
          },
          el('span', { class: 'ws-path', style: { paddingLeft: `${row.depth * 16}px` } },
            row.folder ? el('span', { class: `side-chev${expanded.has(row.path) ? ' open' : ''}`, onclick: (event) => { event.stopPropagation(); toggle(row.path); } }, icon('chevronRight', 12)) : el('span', { class: 'ws-chev-gap' }),
            row.folder ? icon('folder', 16, 'folder-icon') : fileIcon(row.path), el('span', { text: row.name })),
          el('span', { class: 'ws-state', text: stateText(row.path, row.folder) }),
          el('span', { class: 'ws-size', text: row.folder ? '' : formatSize(e?.size) }),
          el('span', { class: 'ws-date', text: e?.modified ? formatDate(e.modified, true) : '' })));
        }
        sizer.replaceChildren(...out);
      };
      table.addEventListener('scroll', () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); });
      new ResizeObserver(() => draw()).observe(table);
      return { refresh: draw, setCount: () => draw() };
    })();

    // 탐색기·트리처럼 → ← 로 폴더를 펼치고 접고, ↑↓ 로 옮긴다.
    table.addEventListener('keydown', (event) => {
      const i = rows.findIndex((r) => r.path === selected?.path);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = rows[Math.max(0, Math.min(rows.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)))];
        if (next) choose(next);
      } else if (selected?.folder && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
        event.preventDefault();
        if ((event.key === 'ArrowRight') !== expanded.has(selected.path)) toggle(selected.path);
      } else if (event.key === 'Enter' && selected) {
        event.preventDefault();
        if (selected.folder) toggle(selected.path);
        else ctx.call('openDefault', { path: selected.path }).catch(ctx.showError);
      }
    });
    load();
    choose(null);
    return { refresh: load };
  }

  // ── 체인지 세트(EX-05, 원본 ChangesetsView): 커밋 목록 200개씩 · 아래 상세(260) ──

  function changesetsView(root) {
    const PAGE = 200;
    let all = ctx.prefs.get('changesets.all') ?? false;
    let commits = [];
    let more = true;
    let loading = false;
    let selected = null;
    const list = el('div', { class: 'cs-list' });
    const detail = el('div', { class: 'cs-detail detail' });
    const allBox = el('label', { class: 'check' }, el('input', { type: 'checkbox' }), '모든 브랜치');
    allBox.firstChild.checked = all;
    allBox.firstChild.addEventListener('change', () => { all = allBox.firstChild.checked; ctx.prefs.set('changesets.all', all); reset(); });
    const count = el('span', { class: 'muted small' });
    const moreButton = el('button', { class: 'btn small', text: `${PAGE}개 더`, onclick: () => page() });
    root.append(el('div', { class: 'explorer-bar' }, allBox, count, el('span', { class: 'spacer' }), moreButton),
      el('div', { class: 'cs-layout' }, el('div', { class: 'cs-main' }, commitHeader(), list), splitter({ pane: detail, axis: 'y', prefs: ctx.prefs, key: 'changesets.detailHeight', size: 260, min: 80, rest: 100, after: true }), detail));
    async function page() {
      if (loading) return;
      loading = true;
      drawSummary();
      try {
        const h = await ctx.call('explorerHistory', { all, maxCount: PAGE, skip: commits.length, topDown: true });
        commits = commits.concat(h.commits);
        more = h.commits.length >= PAGE;
      } catch (error) {
        ctx.showError(error);
      }
      loading = false;
      draw();
    }
    function reset() {
      commits = [];
      more = true;
      page();
    }
    function drawSummary() {
      count.textContent = loading ? '불러오는 중…' : `커밋 ${commits.length.toLocaleString('ko-KR')}개${more ? '+' : ''}`;
      // 더 읽을 것이 없으면 숨긴다(꺼진 버튼은 눌러도 되는 것처럼 보였다).
      moreButton.hidden = !more;
      moreButton.disabled = loading;
    }
    function show(c) {
      selected = c.hash;
      for (const row of list.querySelectorAll('.cl-row')) row.classList.toggle('active', row.dataset.hash === c.hash);
      ctx.call('commitDetail', { hash: c.hash }).then((d) => renderCommit(detail, d, ctx.actions)).catch(ctx.showError);
    }
    function draw() {
      drawSummary();
      list.replaceChildren(...(commits.length ? commits.map((c) => commitRow(c, {
        active: c.hash === selected,
        onclick: () => show(c),
        oncontextmenu: (event) => { event.preventDefault(); ctx.refsUi.commitMenu(event, c); },
      })) : [el('div', { class: 'ws-empty', text: loading ? '불러오는 중…' : '아직 커밋이 없습니다.' })]));
    }
    detail.append(el('div', { class: 'ws-empty', text: '커밋을 고르면 메시지와 바뀐 파일이 여기에 나옵니다.' }));
    page();
    return {
      refresh: reset,
      reveal: (hash) => {
        const c = commits.find((x) => x.hash === hash);
        if (!c) return false;
        show(c);
        list.querySelector(`.cl-row[data-hash="${hash}"]`)?.scrollIntoView({ block: 'center' });
        return true;
      },
    };
  }

  // 사이드바 맨 위에 탭을 붙인다.
  ctx.sidebar.prepend(tabs);
  renderTabs();
  setTimeout(() => select(tab, true));

  return {
    select,
    renderTabs,
    /** 레포지토리를 다시 읽은 뒤. */
    refresh() {
      renderTabs();
      if (current?.key.startsWith('main:')) current.refresh?.();
      // 따로 읽는 그래프(브랜치 탐색기)는 참조가 바뀌었을 때만 다시 읽는다 — 파일 변경마다 읽으면 무겁다.
      const sig = refsSignature();
      if (sig !== lastRefs && lastRefs !== null) current?.refsChanged?.();
      lastRefs = sig;
    },
    /** 배치·탐색기 모양이 바뀌었을 때. */
    relayout() {
      select(tab, true);
    },
    /** 지금 탭(브랜치 탐색기·체인지 세트)에서 그 커밋으로 가서 고른다. 읽은 범위 밖이면 더 읽는다. */
    reveal(hash) {
      return current?.reveal?.(hash) ?? false;
    },
    /** 병합 편집기를 여는 동안 Fork·Unity VCS 배치의 목록·커밋 칸·세부사항을 접는다(원본 SetMergeFullScreen). */
    setMergeFullScreen(on) {
      host.classList.toggle('merging', !!on);
    },
    get tab() { return tab; },
    get usesGraph() { return tab === 'main' && layout() === 'gitkraken'; },
  };
}
