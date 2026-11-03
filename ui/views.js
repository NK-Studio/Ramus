// 사이드바 위 탭과 탭마다의 가운데 화면. 원본 Window/GitWindow(CreateViews)·Views/ForkChangesView·PendingChangesView·CommitHistoryView·
// Elements/BranchGraph/BranchGraphElement·Views/WorkspaceView·ChangesetsView 를 옮겼다.
//
// 탭: [그래프(GitKraken)/로컬 변경(Fork)/대기 중인 변경사항(Unity VCS)] · 브랜치 탐색기 · 워크스페이스 · 체인지 세트.

import { el, relativeTime, formatDate, initials, isComposing } from './util.js';
import { icon } from './icons.js';
import { createGraph, laneColor, laneRgb, authorRgb } from './graph.js';
import { fileList, viewSwitch, CHANGE_STATE, STATE_LABEL, stateIcon, fileIcon } from './files.js';
import { createDiffView } from './diff.js';
import { renderCommit } from './changes.js';
import { highlight, languageOf } from './syntax.js';
import { confirmDialog } from './dialogs.js';

const PERIODS = [
  { value: 7, label: '1주' },
  { value: 30, label: '1달' },
  { value: 90, label: '3달' },
  { value: 0, label: '전체' },
];
const MAIN_TAB = { gitkraken: '그래프', fork: '로컬 변경', unity: '대기 중인 변경사항' };

const rgb = (c) => `rgb(${c.map(Math.round).join(',')})`;

/**
 * ctx: { call, prefs, state, act, showError, actions(스테이징 API), diffApi, avatars, revealCommit(hash), compare(a, b, opts),
 *        fileHistory(path), graphPane, detail, diffView 요소, mergeView 요소, refsUi, onChange() }
 */
export function createViews(ctx) {
  const host = el('section', { class: 'view-host', hidden: true });
  ctx.graphPane.after(host);
  const tabs = el('div', { class: 'side-tabs' });
  let tab = ctx.prefs.get('tab') ?? 'main';
  let current = null; // { key, refresh(), dispose() }

  const layout = () => ctx.prefs.get('layout') ?? 'gitkraken';
  const explorerStyle = () => (layout() === 'gitkraken' ? 'unity' : ctx.prefs.get('explorer') ?? 'fork');

  function renderTabs() {
    const st = ctx.state.status;
    const changes = st ? new Set([...st.staged, ...st.unstaged].map((e) => e.path)).size : 0;
    const items = [
      ['main', MAIN_TAB[layout()], layout() === 'gitkraken' ? 'hierarchy' : 'pencil', changes],
      ['explorer', '브랜치 탐색기', 'branch', 0],
      ['workspace', '워크스페이스', 'folder', 0],
      ['changesets', '체인지 세트', 'history', 0],
    ];
    tabs.replaceChildren(...items.map(([key, label, glyph, count]) => el('button', {
      class: `side-tab${tab === key ? ' on' : ''}`, 'data-tip': label, 'data-tip-side': 'below',
      onclick: () => select(key),
    }, icon(glyph, 15), el('span', { class: 'side-tab-text', text: label }), count ? el('span', { class: 'side-tab-badge', text: count > 99 ? '99+' : count }) : null)));
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

  // ── Fork: 로컬 변경 ──

  function forkChanges(root) {
    const lists = el('div', { class: 'fork-lists detail' });
    const diffBox = el('div', { class: 'fork-diff' }, el('div', { class: 'fork-empty muted', text: '파일을 고르면 diff 가 보입니다.' }));
    const commitBox = el('div', { class: 'fork-commit' });
    root.append(el('div', { class: 'fork-layout' }, lists, el('div', { class: 'fork-right' }, diffBox, commitBox)));
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

  // ── Unity VCS: 대기 중인 변경사항 ──

  function pendingChanges(root) {
    const checked = new Set(ctx.prefs.get('pending.unchecked') ? [] : null);
    let unchecked = new Set();
    let selectedPath = null;
    let details = ctx.prefs.get('pending.details') ?? true;
    const message = el('textarea', { class: 'field pending-message', rows: 3, placeholder: '커밋 메시지' });
    message.value = ctx.state.draft.summary + (ctx.state.draft.description ? `\n\n${ctx.state.draft.description}` : '');
    message.addEventListener('input', () => {
      const [first, ...rest] = message.value.split('\n');
      ctx.state.draft.summary = first;
      ctx.state.draft.description = rest.join('\n').trim();
    });
    const listHost = el('div', { class: 'pending-list' });
    const diffHost = el('div', { class: 'pending-diff' });
    const info = el('aside', { class: 'pending-details' });
    const countLabel = el('span', { class: 'muted small' });
    const detailsButton = el('button', { class: `btn small${details ? ' on' : ''}`, text: '세부사항 표시', onclick: () => { details = !details; ctx.prefs.set('pending.details', details); draw(); } });
    const commitButton = el('button', { class: 'btn small primary', text: '커밋' });
    const revertButton = el('button', { class: 'btn small', text: '변경 되돌리기' });
    root.append(el('div', { class: 'pending-layout' },
      el('div', { class: 'pending-main' },
        el('div', { class: 'pending-actions' }, commitButton, revertButton, el('span', { class: 'spacer' }), detailsButton),
        message,
        el('div', { class: 'pending-split' }, listHost, el('div', { class: 'pending-sep' }), diffHost)),
      info));
    dock(ctx.diffViewEl, diffHost);
    dock(ctx.mergeViewEl, diffHost);

    const entries = () => {
      const st = ctx.state.status;
      if (!st) return [];
      const map = new Map();
      for (const e of [...st.staged, ...st.unstaged]) map.set(e.path, e);
      return [...map.values()];
    };
    const included = () => entries().filter((e) => !unchecked.has(e.path));

    function drawInfo() {
      info.hidden = !details;
      const entry = entries().find((e) => e.path === selectedPath);
      if (!entry) {
        info.replaceChildren(el('div', { class: 'muted small', text: '파일을 고르면 세부사항이 보입니다.' }));
        return;
      }
      const name = entry.path.split('/').pop();
      const rows = el('div', { class: 'info-table' },
        ...[['이름', name], ['경로', entry.path], ['상태', STATE_LABEL[entry.state]], ['크기', '…'], ['수정일', '…']].map(([k, v]) => el('div', { class: 'info-row' }, el('span', { class: 'muted', text: k }), el('span', { class: `info-${k}`, text: v }))));
      info.replaceChildren(el('div', { class: 'info-title' }, fileIcon(entry.path), el('span', { text: name })), rows,
        el('button', { class: 'btn small', text: '히스토리', disabled: entry.state === 'untracked', onclick: () => ctx.fileHistory(entry.path) }));
      ctx.call('workspace', { ignored: false }).then((list) => {
        const w = list.find((x) => x.path === entry.path);
        info.querySelector('.info-크기').textContent = w?.size != null ? `${w.size.toLocaleString('ko-KR')} B` : '—';
        info.querySelector('.info-수정일').textContent = w?.modified ? formatDate(w.modified, true) : '—';
      }).catch(() => {});
    }

    function draw() {
      detailsButton.classList.toggle('on', details);
      const all = entries();
      const on = included();
      countLabel.textContent = `변경 ${all.length}개 (선택 ${on.length})`;
      const allBox = el('input', { type: 'checkbox' });
      allBox.checked = on.length === all.length && all.length > 0;
      allBox.indeterminate = on.length > 0 && on.length < all.length;
      allBox.addEventListener('change', () => {
        unchecked = allBox.checked ? new Set() : new Set(all.map((e) => e.path));
        draw();
      });
      listHost.replaceChildren(
        el('div', { class: 'pending-head' }, el('label', { class: 'check' }, allBox, '모두 선택'), el('span', { class: 'spacer' }), countLabel),
        el('div', { class: 'pending-rows' }, all.length ? all.map((e) => {
          const box = el('input', { type: 'checkbox' });
          box.checked = !unchecked.has(e.path);
          box.addEventListener('change', () => {
            if (box.checked) unchecked.delete(e.path);
            else unchecked.add(e.path);
            draw();
          });
          return el('div', {
            class: `file-row${e.path === selectedPath ? ' active' : ''}`,
            onclick: (event) => {
              if (event.target === box) return;
              selectedPath = e.path;
              ctx.actions.openDiff(e, ctx.state.status.unstaged.includes(e) ? 'unstaged' : 'staged');
              draw();
            },
            oncontextmenu: (event) => { event.preventDefault(); ctx.actions.fileMenu(event, [e], ctx.state.status.unstaged.includes(e) ? 'unstaged' : 'staged'); },
          }, box, stateIcon(e.state), fileIcon(e.path), el('span', { class: 'file-name', text: e.path.split('/').pop() }), el('span', { class: 'file-dir', text: e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '' }));
        }) : el('div', { class: 'empty muted small', text: '바뀐 파일이 없습니다.' })));
      commitButton.disabled = !on.length;
      revertButton.disabled = !on.length;
      drawInfo();
    }

    commitButton.addEventListener('click', async () => {
      const text = message.value.trim();
      if (!text) {
        ctx.showError({ message: '커밋 메시지를 적어 주세요.', advice: { kind: 'unknown', cause: '커밋 메시지가 비어 있습니다.', fix: '위 칸에 메시지를 적어 주세요.' } });
        message.focus();
        return;
      }
      const paths = included().map((e) => e.path);
      // 고른 파일만 Stage 해서 커밋한다(나머지 Stage 는 푼다).
      const ok = await ctx.act('커밋하는 중…', async () => {
        await ctx.call('unstageAll');
        await ctx.call('stage', { paths });
        return ctx.call('commit', { message: text, amend: false });
      }, { success: (h) => `커밋했습니다: ${String(h).slice(0, 7)}` });
      if (ok !== undefined) {
        message.value = '';
        ctx.state.draft = { summary: '', description: '', amend: false };
      }
    });
    revertButton.addEventListener('click', () => ctx.actions.discardMany(included()));
    draw();
    return { refresh: draw, dispose: restoreDiffHosts };
  }

  // ── 탐색 화면 머리: 기간 · 모든 브랜치 · 찾기 · 요약 (CM-09) ──

  function explorerBar(onQuery, extra = []) {
    const period = el('select', { class: 'field small-select' }, PERIODS.map((p) => el('option', { value: p.value, text: p.label })));
    period.value = String(ctx.prefs.get('explorer.period') ?? 30);
    const all = el('input', { type: 'checkbox' });
    all.checked = ctx.prefs.get('explorer.all') ?? true;
    const summary = el('span', { class: 'muted small explorer-summary' });
    const query = () => ({ days: Number(period.value), all: all.checked });
    period.addEventListener('change', () => { ctx.prefs.set('explorer.period', Number(period.value)); onQuery(query()); });
    all.addEventListener('change', () => { ctx.prefs.set('explorer.all', all.checked); onQuery(query()); });
    const bar = el('div', { class: 'explorer-bar' }, el('span', { class: 'muted small', text: '기간' }), period, el('label', { class: 'check' }, all, '모든 브랜치'), extra, el('span', { class: 'spacer' }), summary);
    return { bar, query, summary, widen: () => { period.value = '0'; ctx.prefs.set('explorer.period', 0); onQuery(query()); } };
  }

  const sinceOf = (days) => (days ? Math.floor(Date.now() / 1000) - days * 86400 : 0);
  const summaryText = (h, max) => `커밋 ${h.commits.length.toLocaleString('ko-KR')}개 · 가지 ${h.graph.lanes.length}개${h.truncated ? ` (${max.toLocaleString('ko-KR')}개까지)` : ''}`;

  // ── Fork 모양 브랜치 탐색기(EX-01) ──

  function forkExplorer(root) {
    const MAX = ctx.prefs.get('graph.count') ?? 5000;
    const pane = el('section', { class: 'graph-pane explorer-graph' });
    const header = el('div', { class: 'graph-header' });
    const canvas = el('canvas');
    const rows = el('div', { class: 'graph-rows' });
    const sizer = el('div', { class: 'graph-sizer' }, canvas, rows);
    const scroll = el('div', { class: 'graph-scroll', tabindex: '0' }, sizer);
    pane.append(header, scroll);
    const bottom = el('div', { class: 'explorer-bottom' });
    const search = el('input', { class: 'field explorer-search', placeholder: '찾기 — 제목·작성자·SHA·브랜치', spellcheck: 'false' });
    let history = null;
    let matches = [];
    let at = -1;
    const graph = createGraph({
      pane, header, scroll, sizer, canvas, rows,
      prefs: { get: (k) => ctx.prefs.get(`explorer.${k}`), set: (k, v) => ctx.prefs.set(`explorer.${k}`, v) },
      avatars: ctx.avatars,
      onSelect: (key) => showBottom(key),
      onContextMenu: (key, event, commit, ref) => commit && (ref ? ctx.refsUi.refMenu(event, ref, commit) : ctx.refsUi.commitMenu(event, commit)),
      onRefActivate: (ref, commit) => ctx.refsUi.activateRef(ref, commit),
    });
    graph.setDetailColumns(true);
    const head = explorerBar((q) => load(q), [search]);
    root.append(head.bar, el('div', { class: 'explorer-split' }, pane, el('div', { class: 'splitter-h' }), bottom));
    async function load(q) {
      try {
        history = await ctx.call('explorerHistory', { since: sinceOf(q.days), all: q.all, maxCount: MAX, topDown: true });
        graph.setData(history, null);
        head.summary.textContent = summaryText(history, MAX);
        find();
      } catch (error) {
        ctx.showError(error);
      }
    }
    function find() {
      const q = search.value.trim().toLowerCase();
      matches = [];
      if (q && history) history.commits.forEach((c, i) => {
        if (c.subject.toLowerCase().includes(q) || c.authorName.toLowerCase().includes(q) || c.hash.startsWith(q) || c.refs.some((r) => r.name.toLowerCase().includes(q))) matches.push(i);
      });
      at = -1;
      // 탐색기에서는 안 맞는 커밋·선·글자를 흐린다.
      graph.setSearchMatches(q ? new Set(matches) : null);
      search.classList.toggle('no-match', !!q && !matches.length);
    }
    search.addEventListener('input', find);
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || isComposing(e) || !matches.length) return;
      at = (at + (e.shiftKey ? -1 : 1) + matches.length) % matches.length;
      const hash = history.commits[matches[at]].hash;
      graph.reveal(hash);
      graph.select(hash);
    });
    let bottomTab = ctx.prefs.get('explorer.bottomTab') ?? 'commit';
    let token = 0;
    async function showBottom(hash) {
      const my = ++token;
      if (!hash) {
        bottom.replaceChildren(el('div', { class: 'muted small fh-empty', text: '커밋을 고르세요.' }));
        return;
      }
      const tabsRow = el('div', { class: 'seg explorer-tabs' }, [['commit', 'Commit'], ['changes', 'Changes'], ['tree', 'File Tree']].map(([key, label]) => el('button', {
        class: bottomTab === key ? 'on' : '', text: label, onclick: () => { bottomTab = key; ctx.prefs.set('explorer.bottomTab', key); showBottom(hash); },
      })));
      const content = el('div', { class: 'explorer-content' }, el('div', { class: 'muted small fh-empty', text: '불러오는 중…' }));
      bottom.replaceChildren(tabsRow, content);
      const detail = await ctx.call('commitDetail', { hash }).catch((e) => { ctx.showError(e); return null; });
      if (!detail || my !== token) return;
      if (bottomTab === 'commit') commitTab(content, detail, (file) => { bottomTab = 'changes'; showBottom(hash).then(() => bottom.querySelector(`.file-row[data-path="${CSS.escape(file.path)}"]`)?.click()); });
      else if (bottomTab === 'changes') changesTab(content, detail);
      else treeTab(content, detail);
    }
    load(head.query());
    return { refresh: () => load(head.query()), dispose: () => {} };
  }

  function commitTab(content, detail, openFile) {
    const commit = ctx.state.history?.commits.find((c) => c.hash === detail.hash);
    const refs = commit?.refs.filter((r) => r.kind !== 'detachedHead').map((r) => r.name) ?? [];
    const line = (label, ...value) => el('div', { class: 'ct-row' }, el('span', { class: 'ct-label muted', text: label }), el('span', { class: 'ct-value' }, value));
    content.replaceChildren(el('div', { class: 'commit-tab' },
      line('작성자', `${detail.authorName} <${detail.authorEmail}>`, el('span', { class: 'muted', text: `  ${formatDate(detail.time, true)}` })),
      detail.committerName && detail.committerName !== detail.authorName ? line('커미터', detail.committerName) : null,
      refs.length ? line('참조', refs.map((r) => el('span', { class: 'ct-ref', text: r }))) : null,
      line('SHA', el('span', { class: 'mono', text: detail.hash })),
      line('부모', detail.parents.map((p) => el('button', { class: 'link mono', text: p.slice(0, 10), onclick: () => ctx.revealCommit(p) }))),
      el('pre', { class: 'ct-message', text: detail.message }),
      el('div', { class: 'ct-files' }, detail.files.map((f) => el('button', { class: 'ct-file link', onclick: () => openFile(f) }, stateIcon(CHANGE_STATE[f.status] ?? 'modified'), el('span', { text: f.path }))))));
  }

  function changesTab(content, detail) {
    const listBox = el('div', { class: 'ch-list' });
    const diffBox = el('div', { class: 'ch-diff diff-view embedded' });
    const diff = createDiffView(diffBox);
    const entries = detail.files.map((f) => ({ ...f, state: CHANGE_STATE[f.status] ?? 'modified' }));
    const added = entries.filter((e) => e.state === 'added').length;
    const removed = entries.filter((e) => e.state === 'deleted').length;
    const st = { selected: new Set(), anchor: null };
    const openFile = (f) => diff.open({ target: { kind: 'commit', hash: detail.hash, path: f.path, originalPath: f.originalPath ?? null }, mode: 'commit', title: f.path, api: { ...ctx.diffApi, close: () => diff.close() } });
    listBox.append(fileList({ entries, view: 'path', state: st, onOpen: openFile, onMenu: (event, files) => ctx.actions.commitFileMenu(event, detail, files), empty: '바뀐 파일이 없습니다.' }));
    content.replaceChildren(el('div', { class: 'ch-summary muted small', text: `파일 ${entries.length}개 · 추가 ${added} · 삭제 ${removed} · 수정 ${entries.length - added - removed}` }), el('div', { class: 'ch-body' }, listBox, diffBox));
    if (entries[0]) openFile(entries[0]);
  }

  async function treeTab(content, detail) {
    const files = await ctx.call('treeFiles', { revision: detail.hash }).catch(() => []);
    const listBox = el('div', { class: 'ch-list' });
    const view = el('div', { class: 'ft-view' }, el('div', { class: 'muted small fh-empty', text: '파일을 고르세요.' }));
    const collapsed = new Set(files.map((f) => f.split('/').slice(0, -1).join('/')).filter(Boolean));
    const st = { selected: new Set(), anchor: null };
    const draw = () => listBox.replaceChildren(fileList({
      entries: files.map((path) => ({ path, state: 'tracked' })), view: 'tree', state: st, collapsed,
      onToggleFolder: (p) => { if (collapsed.has(p)) collapsed.delete(p); else collapsed.add(p); draw(); },
      onOpen: async (f) => {
        try {
          const data = await ctx.call('fileBytes', { revision: detail.hash, path: f.path });
          if (data.mime.startsWith('image/')) {
            view.replaceChildren(el('div', { class: 'checker ft-image' }, el('img', { src: `data:${data.mime};base64,${data.base64}` })));
            return;
          }
          const bytes = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
          if (bytes.includes(0)) {
            view.replaceChildren(el('div', { class: 'muted fh-empty', text: `바이너리 파일 · ${data.size.toLocaleString('ko-KR')} B` }));
            return;
          }
          const text = new TextDecoder().decode(bytes);
          const colored = highlight(text, languageOf(f.path));
          const lines = text.split('\n');
          view.replaceChildren(el('div', { class: 'ft-code' }, lines.map((l, i) => {
            const code = el('span', { class: 'bl-code' });
            if (colored) code.innerHTML = colored[i] || '';
            else code.textContent = l;
            return el('div', { class: 'bl-row' }, el('span', { class: 'bl-ln', text: i + 1 }), code);
          })));
        } catch (error) {
          ctx.showError(error);
        }
      },
    }));
    draw();
    content.replaceChildren(el('div', { class: 'ch-body' }, listBox, view));
  }

  // ── Unity VCS 모양 가로 브랜치 탐색기(EX-02) ──

  function unityExplorer(root) {
    const MAX = ctx.prefs.get('graph.count') ?? 5000;
    const COL = 46;
    const ROWH = 64;
    const LEFT = 150;
    const TOP = 84;
    const canvas = el('canvas', { class: 'bx-canvas' });
    const wrap = el('div', { class: 'bx-wrap' }, canvas);
    const tip = el('div', { class: 'callout bx-tip', hidden: true });
    const detailBox = el('div', { class: 'bx-detail' });
    const head = explorerBar((q) => load(q), [
      el('button', { class: 'btn small', text: 'HEAD', 'data-tip': '지금 커밋으로', onclick: () => centerHead() }),
      el('button', { class: 'btn small', 'data-tip': '확대', onclick: () => zoomBy(1.25) }, icon('zoomIn', 14)),
      el('button', { class: 'btn small', 'data-tip': '축소', onclick: () => zoomBy(0.8) }, icon('zoomOut', 14)),
    ]);
    root.append(head.bar, el('div', { class: 'explorer-split' }, wrap, el('div', { class: 'splitter-h' }), detailBox), tip);
    let h = null;
    let n = 0;
    let lanes = [];
    let zoom = 1;
    let offset = { x: 0, y: 0 };
    let selected = null;
    let hover = -1;
    const colors = { bg: getComputedStyle(document.documentElement).getPropertyValue('--git-graph-bg').trim() };

    async function load(q) {
      try {
        h = await ctx.call('explorerHistory', { since: sinceOf(q.days), all: q.all, maxCount: MAX, topDown: false });
        n = h.commits.length;
        // 가지마다 첫·끝 칸(오래된 커밋이 0).
        lanes = h.graph.lanes.map((lane) => ({ ...lane, first: Infinity, last: -1 }));
        h.graph.nodes.forEach((node, i) => {
          const x = n - 1 - i;
          const lane = lanes[node.lane];
          lane.first = Math.min(lane.first, x);
          lane.last = Math.max(lane.last, x);
        });
        head.summary.textContent = summaryText(h, MAX);
        centerHead();
      } catch (error) {
        ctx.showError(error);
      }
    }

    const px = (x) => LEFT + x * COL * zoom + offset.x;
    const py = (row) => TOP + row * ROWH * zoom + offset.y;
    const nodeAt = (i) => ({ x: px(n - 1 - i), y: py(lanes[h.graph.nodes[i].lane].column) });

    function centerHead() {
      if (!h) return;
      const index = h.commits.findIndex((c) => c.hash === h.head);
      const x = n - 1 - Math.max(0, index);
      offset = { x: wrap.clientWidth / 2 - LEFT - x * COL * zoom, y: 0 };
      draw();
    }

    function zoomBy(factor, cx = wrap.clientWidth / 2) {
      const before = zoom;
      zoom = Math.min(3, Math.max(0.2, zoom * factor));
      offset.x = cx - ((cx - offset.x - LEFT) * zoom) / before - LEFT;
      draw();
    }

    function draw() {
      if (!h) return;
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const hh = wrap.clientHeight;
      canvas.width = w * dpr;
      canvas.height = hh * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${hh}px`;
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, hh);
      const css = getComputedStyle(document.documentElement);
      const text = css.getPropertyValue('--git-text').trim();
      const muted = css.getPropertyValue('--git-text-muted').trim();
      // 날짜 띠: 날마다 번갈아 깐다.
      let lastDay = '';
      let band = false;
      let lastLabelX = -Infinity;
      for (let i = n - 1; i >= 0; i--) {
        const day = formatDate(h.commits[i].time);
        const x = px(n - 1 - i);
        if (day !== lastDay) {
          band = !band;
          lastDay = day;
          // 날짜 글자는 겹치지 않을 만큼 떨어졌을 때만.
          if (x > -200 && x < w + 200 && x - lastLabelX > 78) {
            lastLabelX = x;
            g.fillStyle = muted;
            g.font = '11px -apple-system, sans-serif';
            g.fillText(day, x - 10, 16);
          }
        }
        if (band) {
          g.fillStyle = css.getPropertyValue('--git-graph-date-band').trim();
          g.fillRect(x - (COL * zoom) / 2, 24, COL * zoom, hh);
        }
      }
      // 가지 관.
      for (const lane of lanes) {
        if (lane.last < 0) continue;
        const y = py(lane.column);
        const x1 = px(lane.first) - 14 * zoom;
        const x2 = px(lane.last) + 14 * zoom;
        if (x2 < 0 || x1 > w || y < -ROWH || y > hh + ROWH) continue;
        const isSel = selected != null && h.graph.nodes[selected].lane === lanes.indexOf(lane);
        g.fillStyle = laneColor(lane, isSel ? 0.22 : 0.1);
        g.strokeStyle = laneColor(lane, isSel ? 1 : 0.6);
        g.lineWidth = isSel ? 2 : 1;
        g.beginPath();
        g.roundRect(x1, y - 16 * zoom, x2 - x1, 32 * zoom, 16 * zoom);
        g.fill();
        g.stroke();
      }
      // 선: 같은 가지는 곧은 선+화살촉, 병합은 초록 곡선, 갈라짐은 가지 색 곡선.
      for (const e of h.graph.edges) {
        const a = nodeAt(e.parent);
        const b = nodeAt(e.child);
        if (Math.max(a.x, b.x) < 0 || Math.min(a.x, b.x) > w) continue;
        const childLane = lanes[h.graph.nodes[e.child].lane];
        g.strokeStyle = e.merge ? 'rgb(107,199,140)' : laneColor(childLane);
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(a.x, a.y);
        if (Math.abs(a.y - b.y) < 1) g.lineTo(b.x, b.y);
        else g.bezierCurveTo((a.x + b.x) / 2, a.y, (a.x + b.x) / 2, b.y, b.x, b.y);
        g.stroke();
        if (Math.abs(a.y - b.y) < 1 && b.x - a.x > 24) {
          const mx = b.x - 12 * zoom;
          g.fillStyle = g.strokeStyle;
          g.beginPath();
          g.moveTo(mx + 5, b.y);
          g.lineTo(mx - 3, b.y - 4);
          g.lineTo(mx - 3, b.y + 4);
          g.fill();
        }
      }
      // 커밋 원·이름표.
      h.commits.forEach((c, i) => {
        const { x, y } = nodeAt(i);
        if (x < -40 || x > w + 40 || y < -40 || y > hh + 40) return;
        const lane = lanes[h.graph.nodes[i].lane];
        const r = 9 * Math.max(0.6, zoom);
        if (c.refs.some((ref) => ref.kind === 'tag')) {
          g.strokeStyle = 'rgb(84,219,153)';
          g.lineWidth = 3;
          g.beginPath();
          g.arc(x, y, r + 4, 0, Math.PI * 2);
          g.stroke();
        }
        g.fillStyle = i === hover || i === selected ? laneColor(lane) : colors.bg || '#191a1c';
        g.strokeStyle = laneColor(lane);
        g.lineWidth = 2.5;
        if (i === hover) { g.shadowColor = laneColor(lane); g.shadowBlur = 12; }
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.shadowBlur = 0;
        if (c.hash === h.head) {
          g.strokeStyle = css.getPropertyValue('--git-graph-head').trim();
          g.lineWidth = 2;
          g.beginPath();
          g.arc(x, y, r + 5, 0, Math.PI * 2);
          g.stroke();
        }
        const labels = c.refs.filter((ref) => ref.kind !== 'detachedHead');
        if (labels.length && zoom > 0.5) {
          g.font = '600 11px -apple-system, sans-serif';
          const shown = labels.slice(0, 3).map((ref) => ref.name).concat(labels.length > 3 ? [`+${labels.length - 3}`] : []);
          shown.forEach((name, k) => {
            const tw = g.measureText(name).width + 10;
            const ly = y - r - 10 - k * 17;
            g.fillStyle = laneColor(lane, 0.35);
            g.beginPath();
            g.roundRect(x - tw / 2, ly - 12, tw, 15, 4);
            g.fill();
            g.fillStyle = text;
            g.fillText(name, x - tw / 2 + 5, ly);
          });
        }
      });
      // 화면 왼쪽에 붙어 따라오는 가지 이름표.
      g.font = '600 12px -apple-system, sans-serif';
      for (const lane of lanes) {
        if (lane.last < 0) continue;
        const y = py(lane.column);
        if (y < -20 || y > hh + 20) continue;
        const label = lane.anonymous ? (lane.name.startsWith('(') ? 'master 에서 병합' : `${lane.name} 에서 병합`) : lane.name;
        const x = Math.max(6, Math.min(px(lane.first) - 14 * zoom, px(lane.last)));
        const tw = g.measureText(label).width + 14;
        g.fillStyle = colors.bg || '#191a1c';
        g.fillRect(x, y + 20 * zoom, tw, 17);
        g.fillStyle = rgb(laneRgb(lane));
        g.fillText(label, x + 6, y + 20 * zoom + 12);
      }
    }

    function hit(event) {
      if (!h) return -1;
      const r = canvas.getBoundingClientRect();
      const mx = event.clientX - r.left;
      const my = event.clientY - r.top;
      let best = -1;
      let dist = 14 * Math.max(0.6, zoom);
      h.commits.forEach((_, i) => {
        const p = nodeAt(i);
        const d = Math.hypot(p.x - mx, p.y - my);
        if (d < dist) {
          dist = d;
          best = i;
        }
      });
      return best;
    }

    wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        offset.x -= e.shiftKey ? e.deltaY : e.deltaX;
        offset.y -= e.shiftKey ? 0 : e.deltaY * 0;
        draw();
      } else zoomBy(e.deltaY < 0 ? 1.1 : 0.9, e.clientX - wrap.getBoundingClientRect().left);
    }, { passive: false });
    wrap.addEventListener('pointerdown', (e) => {
      const start = { x: e.clientX - offset.x, y: e.clientY - offset.y };
      let moved = false;
      wrap.setPointerCapture(e.pointerId);
      const move = (ev) => {
        moved = true;
        offset = { x: ev.clientX - start.x, y: ev.clientY - start.y };
        draw();
      };
      wrap.addEventListener('pointermove', move);
      wrap.addEventListener('pointerup', (ev) => {
        wrap.removeEventListener('pointermove', move);
        if (!moved) {
          const i = hit(ev);
          if (i >= 0) {
            selected = i;
            draw();
            ctx.call('commitDetail', { hash: h.commits[i].hash }).then((d) => renderCommit(detailBox, d, ctx.actions)).catch(ctx.showError);
          }
        }
      }, { once: true });
    });
    wrap.addEventListener('mousemove', (e) => {
      const i = hit(e);
      if (i !== hover) {
        hover = i;
        draw();
      }
      if (i < 0) {
        tip.hidden = true;
        return;
      }
      const c = h.commits[i];
      tip.hidden = false;
      tip.textContent = `${c.shortHash}  ${c.subject}\n${c.authorName} · ${formatDate(c.time, true)}`;
      tip.style.left = `${e.clientX + 14}px`;
      tip.style.top = `${e.clientY + 14}px`;
    });
    wrap.addEventListener('mouseleave', () => { tip.hidden = true; hover = -1; draw(); });
    wrap.addEventListener('dblclick', (e) => {
      const i = hit(e);
      if (i >= 0 && h.commits[i].parents.length) ctx.compare(`${h.commits[i].hash}^`, h.commits[i].hash, { title: `${h.commits[i].shortHash} 의 부모 ↔ ${h.commits[i].shortHash}` });
    });
    new ResizeObserver(() => draw()).observe(wrap);
    detailBox.append(el('div', { class: 'muted small fh-empty', text: '커밋을 누르면 정보가, 두 번 누르면 부모와의 비교가 열립니다.' }));
    load(head.query());
    return { refresh: () => load(head.query()), dispose: () => tip.remove() };
  }

  // ── 워크스페이스(EX-04) ──

  function workspaceView(root) {
    let showIgnored = ctx.prefs.get('workspace.ignored') ?? false;
    let changedOnly = ctx.prefs.get('workspace.changed') ?? false;
    let filter = '';
    let entries = [];
    let selected = null;
    const table = el('div', { class: 'ws-table' });
    const side = el('aside', { class: 'ws-side' });
    const search = el('input', { class: 'field explorer-search', placeholder: '필터 — 경로', spellcheck: 'false' });
    const ignored = el('input', { type: 'checkbox' });
    ignored.checked = showIgnored;
    const changed = el('input', { type: 'checkbox' });
    changed.checked = changedOnly;
    const count = el('span', { class: 'muted small' });
    root.append(el('div', { class: 'explorer-bar' }, search, el('label', { class: 'check' }, ignored, '무시한 파일 보기'), el('label', { class: 'check' }, changed, '변경만'), el('span', { class: 'spacer' }), count),
      el('div', { class: 'ws-layout' }, table, side));
    search.addEventListener('input', () => { filter = search.value.trim().toLowerCase(); draw(); });
    ignored.addEventListener('change', () => { showIgnored = ignored.checked; ctx.prefs.set('workspace.ignored', showIgnored); load(); });
    changed.addEventListener('change', () => { changedOnly = changed.checked; ctx.prefs.set('workspace.changed', changedOnly); draw(); });
    async function load() {
      try {
        entries = await ctx.call('workspace', { ignored: showIgnored });
        draw();
      } catch (error) {
        ctx.showError(error);
      }
    }
    const LIMIT = 3000;
    function draw() {
      const shown = entries.filter((e) => (!filter || e.path.toLowerCase().includes(filter)) && (!changedOnly || (e.state && e.state !== 'ignored')));
      count.textContent = `파일 ${shown.length.toLocaleString('ko-KR')}개${shown.length > LIMIT ? ` (앞 ${LIMIT}개만 보임 — 필터로 좁혀 주세요)` : ''}`;
      table.replaceChildren(el('div', { class: 'ws-row ws-head' }, el('span', { text: '항목' }), el('span', { text: '상태' }), el('span', { text: '크기' }), el('span', { text: '수정일' })),
        ...shown.slice(0, LIMIT).map((e) => el('div', {
          class: `ws-row${e.path === selected?.path ? ' active' : ''}${e.state === 'ignored' ? ' ignored' : ''}`,
          onclick: () => { selected = e; draw(); drawSide(); },
          ondblclick: () => e.state !== 'ignored' && ctx.call('openDefault', { path: e.path }).catch(ctx.showError),
        }, el('span', { class: 'ws-path' }, fileIcon(e.path), el('span', { text: e.path })),
        el('span', { class: `ws-state st-text-${e.state || 'clean'}`, text: e.state ? (STATE_LABEL[e.state] ?? '무시함') : '' }),
        el('span', { class: 'ws-size', text: e.size != null ? e.size.toLocaleString('ko-KR') : '' }),
        el('span', { class: 'ws-date', text: e.modified ? formatDate(e.modified, true) : '' }))));
    }
    async function drawSide() {
      if (!selected) {
        side.replaceChildren(el('div', { class: 'muted small fh-empty', text: '파일을 고르면 정보와 히스토리가 보입니다.' }));
        return;
      }
      const e = selected;
      const history = el('div', { class: 'ws-history' }, el('div', { class: 'muted small', text: '불러오는 중…' }));
      side.replaceChildren(el('div', { class: 'info-title' }, fileIcon(e.path), el('span', { text: e.path.split('/').pop() })),
        el('div', { class: 'info-table' }, [['경로', e.path], ['상태', e.state ? (STATE_LABEL[e.state] ?? '무시함') : '바뀌지 않음'], ['크기', e.size != null ? `${e.size.toLocaleString('ko-KR')} B` : '—'], ['수정일', e.modified ? formatDate(e.modified, true) : '—']]
          .map(([k, v]) => el('div', { class: 'info-row' }, el('span', { class: 'muted', text: k }), el('span', { text: v })))),
        el('div', { class: 'modal-label', text: '히스토리' }), history,
        el('button', { class: 'btn small', text: '파일 히스토리 열기', disabled: e.state === 'untracked' || e.state === 'ignored', onclick: () => ctx.fileHistory(e.path) }));
      if (e.state === 'untracked' || e.state === 'ignored') {
        history.replaceChildren(el('div', { class: 'muted small', text: '커밋한 적이 없는 파일입니다.' }));
        return;
      }
      const revs = await ctx.call('fileLog', { path: e.path, maxCount: 30 }).catch(() => []);
      history.replaceChildren(...(revs.length ? revs.map((r) => el('div', { class: 'ws-rev', onclick: () => ctx.revealCommit(r.commit.hash) },
        el('span', { class: 'mono muted', text: r.commit.shortHash }), el('span', { class: 'ws-rev-subject', text: r.commit.subject }), el('span', { class: 'muted small', text: relativeTime(r.commit.time) })))
        : [el('div', { class: 'muted small', text: '커밋이 없습니다.' })]));
    }
    load();
    drawSide();
    return { refresh: load };
  }

  // ── 체인지 세트(EX-05) ──

  function changesetsView(root) {
    const PAGE = 200;
    let all = ctx.prefs.get('changesets.all') ?? true;
    let commits = [];
    let more = true;
    let selected = null;
    const list = el('div', { class: 'cs-list' });
    const detail = el('aside', { class: 'cs-detail detail' });
    const allBox = el('input', { type: 'checkbox' });
    allBox.checked = all;
    allBox.addEventListener('change', () => { all = allBox.checked; ctx.prefs.set('changesets.all', all); reset(); });
    const count = el('span', { class: 'muted small' });
    root.append(el('div', { class: 'explorer-bar' }, el('label', { class: 'check' }, allBox, '모든 브랜치'), el('span', { class: 'spacer' }), count), el('div', { class: 'ws-layout' }, list, detail));
    async function page() {
      try {
        const h = await ctx.call('explorerHistory', { all, maxCount: PAGE, skip: commits.length, topDown: true });
        commits = commits.concat(h.commits);
        more = h.commits.length >= PAGE;
        draw();
      } catch (error) {
        ctx.showError(error);
      }
    }
    function reset() {
      commits = [];
      more = true;
      page();
    }
    function draw() {
      count.textContent = `커밋 ${commits.length.toLocaleString('ko-KR')}개`;
      list.replaceChildren(el('div', { class: 'ws-row cs-row ws-head' }, el('span', { text: '체인지 세트' }), el('span', { text: '설명' }), el('span', { text: '작성자' }), el('span', { text: '날짜' })),
        ...commits.map((c) => el('div', {
          class: `ws-row cs-row${c.hash === selected ? ' active' : ''}`,
          onclick: () => { selected = c.hash; draw(); ctx.call('commitDetail', { hash: c.hash }).then((d) => renderCommit(detail, d, ctx.actions)).catch(ctx.showError); },
          ondblclick: () => ctx.revealCommit(c.hash),
          oncontextmenu: (event) => { event.preventDefault(); ctx.refsUi.commitMenu(event, c); },
        }, el('span', { class: 'mono muted', text: c.shortHash }), el('span', { class: 'cs-subject', text: c.subject }), el('span', { text: c.authorName }), el('span', { class: 'muted', text: formatDate(c.time, true) }))),
        more ? el('button', { class: 'btn small cs-more', text: `더 보기 (${PAGE}개)`, onclick: page }) : null);
    }
    detail.append(el('div', { class: 'muted small fh-empty', text: '체인지 세트를 고르면 정보가 보입니다.' }));
    page();
    return { refresh: reset };
  }

  // 사이드바 맨 위에 탭을 붙인다.
  ctx.sidebar.prepend(tabs);
  renderTabs();
  setTimeout(() => select(tab, true));

  return {
    select,
    renderTabs,
    /** 저장소를 다시 읽은 뒤. */
    refresh() {
      renderTabs();
      if (current?.key.startsWith('main:')) current.refresh?.();
    },
    /** 배치·탐색기 모양이 바뀌었을 때. */
    relayout() {
      select(tab, true);
    },
    get tab() { return tab; },
    get usesGraph() { return tab === 'main' && layout() === 'gitkraken'; },
  };
}
