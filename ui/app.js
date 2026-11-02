// 앱 전체의 흐름: 시작 화면 ↔ 저장소 화면, 새로고침, 작업(Stage·커밋·푸시) 뒤 다시 읽기.

import { call, on } from './bridge.js';
import { el, relativeTime } from './util.js';
import { createGraph, laneColor } from './graph.js';
import { renderStaging, renderCommit, diffKey } from './changes.js';
import { createDiffView } from './diff.js';
import { confirmDialog, showMenu } from './dialogs.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: { theme: 'dark', recent: [] },
  repo: null,
  status: null,
  history: null,
  draft: { summary: '', description: '', amend: false, pushAfter: false },
  refreshing: false,
  /** 지금 열린 diff 의 키(diffKey). 목록에서 그 줄을 고른 것으로 보인다. */
  diffKey: null,
  fetching: false,
  autoFetchError: null,
};

const diffView = createDiffView($('diff-view'));

const graph = createGraph({
  scroll: $('graph-scroll'),
  sizer: $('graph-sizer'),
  canvas: $('graph-canvas'),
  rows: $('graph-rows'),
  onSelect: showDetail,
});

// ── 알림 ─────────────────────────────────────────────

function toast(message, kind = 'info', hint) {
  const node = el('div', { class: `toast ${kind}` },
    el('div', { class: 'toast-text', text: message }),
    hint ? el('div', { class: 'toast-hint', text: hint }) : null,
    el('button', { class: 'toast-close', title: '닫기', onclick: () => node.remove(), text: '×' }));
  $('toasts').append(node);
  if (kind !== 'error') setTimeout(() => node.remove(), 4000);
}

/** git 실패를 보여 준다. 회사망 SSL·로그인 실패면 무엇을 하면 되는지 함께. */
function showError(error) {
  const message = error?.message ?? String(error);
  let hint;
  if (error?.ssl) hint = 'SSL 인증서 문제입니다. 회사망이라면 설정의 SSL 인증서(다음 단계)에서 회사 루트 인증서를 지정하거나 schannel 을 켜 주세요.';
  else if (error?.auth) hint = '서버가 로그인을 거절했습니다. 터미널에서 한 번 git push 로 로그인해 두면 다음부터 됩니다(로그인 창은 다음 단계).';
  toast(message, 'error', hint);
}

async function busy(text, work) {
  $('busy-text').textContent = text;
  $('busy').hidden = false;
  try {
    return await work();
  } finally {
    $('busy').hidden = true;
  }
}

// ── 테마 ─────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  graph.redraw();
}

$('act-theme').addEventListener('click', async () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  state.settings.theme = next;
  await call('setSettings', { theme: next }).catch(showError);
});

// ── 시작 화면 ─────────────────────────────────────────

function showStart() {
  state.repo = null;
  $('main').hidden = true;
  $('start').hidden = false;
  const list = $('recent-list');
  const recent = state.settings.recent || [];
  $('recent-empty').hidden = recent.length > 0;
  list.replaceChildren(...recent.map((r) => el('li', { class: 'recent-item', title: r.path, onclick: () => openRepo(r.path) },
    el('div', { class: 'recent-icon', text: r.name.slice(0, 1).toUpperCase() }),
    el('div', { class: 'recent-text' }, el('div', { class: 'recent-name', text: r.name }), el('div', { class: 'recent-path muted small', text: r.path })),
    el('div', { class: 'recent-time muted small', text: relativeTime(r.openedAt) }),
    el('button', {
      class: 'recent-remove', title: '목록에서 빼기 (폴더는 지우지 않음)', text: '×',
      onclick: async (event) => {
        event.stopPropagation();
        state.settings = await call('removeRecent', { path: r.path });
        showStart();
      },
    }))));
}

async function pickRepo() {
  try {
    const repo = await call('pickRepo');
    if (repo) await enterRepo(repo);
  } catch (error) {
    showError(error);
  }
}

async function openRepo(path) {
  try {
    await enterRepo(await busy('저장소를 여는 중…', () => call('openRepo', { path })));
  } catch (error) {
    showError(error);
  }
}

$('start-open').addEventListener('click', pickRepo);
$('repo-button').addEventListener('click', async () => {
  await call('closeRepo').catch(showError);
  const init = await call('init').catch(() => null);
  if (init) state.settings = init.settings;
  showStart();
});

// ── 저장소 화면 ───────────────────────────────────────

async function enterRepo(repo) {
  state.repo = repo;
  state.fingerprint = null;
  state.draft = { summary: '', description: '', amend: false, pushAfter: false };
  $('start').hidden = true;
  $('main').hidden = false;
  $('repo-name').textContent = repo.name;
  $('repo-button').title = `${repo.path}\n다른 저장소 열기`;
  graph.select(null, false);
  closeDiff();
  state.autoFetchError = null;
  await refresh();
  updateFetchInfo();
  graph.select(graph.hasWip ? 'wip' : state.history.commits[0]?.hash ?? null);
}

// 새로고침 중에 또 요청이 오면(작업이 끝남·창 포커스) 버리지 않고 끝난 뒤 한 번 더 읽는다 — 먼저 읽은 상태가 작업 전 것일 수 있다.
let refreshPromise = null;
let refreshAgain = false;

function refresh() {
  if (!state.repo) return Promise.resolve();
  if (refreshPromise) {
    refreshAgain = true;
    return refreshPromise;
  }
  refreshPromise = (async () => {
    do {
      refreshAgain = false;
      await refreshOnce();
    } while (refreshAgain && state.repo);
    refreshPromise = null;
  })();
  return refreshPromise;
}

async function refreshOnce() {
  state.refreshing = true;
  try {
    const [status, history] = await Promise.all([call('status'), call('history')]);
    // 파일을 더 고쳐도 상태(M)는 그대로일 수 있으니, 열린 diff 는 늘 다시 읽는다(같으면 다시 그리지 않는다).
    // 그 파일이 목록에서 사라졌으면(모두 Stage·커밋·버림) diff 를 닫는다.
    const target = diffView.target;
    if (target && target.kind !== 'commit') {
      const list = target.kind === 'staged' ? status.staged : status.unstaged;
      if (list.some((e) => e.path === target.path)) diffView.reload();
      else closeDiff();
    }
    // 바뀐 것이 없으면 다시 그리지 않는다. 창에 포커스가 올 때도 새로고침하므로, 다시 그리면 그 클릭으로 누르던 버튼이 사라지고
    // 입력란 포커스도 잃는다.
    const fingerprint = JSON.stringify([status, history.head, history.commits.length, history.commits.map((c) => c.hash + c.refs.map((r) => r.name).join())]);
    if (fingerprint === state.fingerprint) return;
    state.fingerprint = fingerprint;
    state.status = status;
    state.history = history;
    renderToolbar();
    renderSidebar();
    graph.setData(history, status);
    $('graph-empty').hidden = history.commits.length > 0;
    if (graph.selected === 'wip' || graph.selected == null) showDetail(graph.selected ?? (graph.hasWip ? 'wip' : null), false);
  } catch (error) {
    showError(error);
  } finally {
    state.refreshing = false;
  }
}

function renderToolbar() {
  const branch = state.status.branch;
  $('branch-name').textContent = branch.detached ? 'HEAD (분리됨)' : branch.name;
  const pushBadge = $('push-badge');
  pushBadge.hidden = !branch.ahead;
  pushBadge.textContent = `${branch.ahead}`;
  const pullBadge = $('pull-badge');
  pullBadge.hidden = !branch.behind;
  pullBadge.textContent = `${branch.behind}`;
  $('act-push').title = branch.upstream ? `푸시 → ${branch.upstream}` : '푸시 (원격에 새 브랜치로 올림)';
  $('act-pull').title = `풀 (${PULL_MODES[state.settings.pullMode] ?? ''})${branch.upstream ? ` ← ${branch.upstream}` : ''}`;
  const noRemote = (state.repo?.remotes ?? []).length === 0;
  for (const id of ['act-fetch', 'act-pull', 'act-pull-mode']) $(id).disabled = noRemote;
}

/** 왼쪽 목록: 그래프에 보이는 브랜치·태그(브랜치 작업은 다음 단계). */
function renderSidebar() {
  const groups = { local: [], remote: [], tag: [] };
  const seen = new Set();
  state.history.commits.forEach((commit, index) => {
    for (const ref of commit.refs) {
      const kind = ref.kind === 'head' ? 'local' : ref.kind;
      if (!groups[kind] || seen.has(kind + ref.name)) continue;
      seen.add(kind + ref.name);
      groups[kind].push({ ...ref, hash: commit.hash, color: laneColor(state.history.graph.nodes[index].color) });
    }
  });
  if (!state.status.branch.hasCommits) groups.local.push({ kind: 'head', name: state.status.branch.name, hash: null, color: laneColor(0) });
  const group = (title, items) => el('div', { class: 'side-group' },
    el('div', { class: 'side-title' }, title, el('span', { class: 'count', text: items.length })),
    items.map((ref) => el('div', {
      class: `side-item${ref.kind === 'head' ? ' current' : ''}`, title: ref.name,
      onclick: () => ref.hash && revealCommit(ref.hash),
    }, el('span', { class: 'side-dot', style: { background: ref.color } }), el('span', { class: 'side-name', text: ref.name }),
    ref.kind === 'head' ? el('span', { class: 'side-check', text: '✓' }) : null)));
  $('sidebar').replaceChildren(
    group('로컬', groups.local),
    group('원격', groups.remote),
    group('태그', groups.tag));
}

function revealCommit(hash) {
  const index = state.history.commits.findIndex((c) => c.hash === hash);
  if (index < 0) return;
  const row = index + (graph.hasWip ? 1 : 0);
  const scroll = $('graph-scroll');
  scroll.scrollTop = Math.max(0, row * 32 - scroll.clientHeight / 3);
  graph.select(hash);
}

let detailToken = 0;
async function showDetail(key, fetch = true) {
  const container = $('detail');
  const token = ++detailToken;
  if (key === 'wip' || (key == null && state.status)) {
    renderStaging(container, state.status, state.draft, actions);
    return;
  }
  if (!key || !fetch) return;
  try {
    const detail = await call('commitDetail', { hash: key });
    if (token === detailToken) renderCommit(container, detail, actions);
  } catch (error) {
    showError(error);
  }
}

// 작업 뒤에는 항상 다시 읽는다 — 터미널에서 한 일도 함께 보인다.
async function act(label, work, { success, done } = {}) {
  try {
    const result = await busy(label, work);
    if (done) done(result);
    if (success) toast(success(result), 'success');
    return result;
  } catch (error) {
    showError(error);
    return undefined;
  } finally {
    await refresh();
  }
}

// ── diff ─────────────────────────────────────────────

const diffApi = {
  load: (target) => call('diff', { target }),
  async applyLines(action, target, fingerprint, lines) {
    if (action === 'discard' && !(await confirmDialog({
      title: '고른 줄 버리기',
      message: `${target.path} 에서 고른 변경 ${lines.length}줄을 버립니다. 되돌릴 수 없습니다.`,
      ok: '버리기', danger: true,
    }))) return false;
    const label = { stage: 'Stage', unstage: 'Unstage', discard: '버리기' }[action];
    const ok = await act(`${label} 하는 중…`, () => call('applyLines', { action, path: target.path, untracked: !!target.untracked, fingerprint, lines }).then(() => true));
    // 실패(그 사이 파일이 바뀜 등)해도 diff 를 다시 읽는다.
    diffView.reload();
    return ok === true;
  },
  stageFile: async (target) => { await actions.stage([target.path]); closeDiff(); },
  unstageFile: async (target) => { await actions.unstage([target.path]); closeDiff(); },
  discardFile: async (target) => {
    const entry = state.status.unstaged.find((e) => e.path === target.path);
    if (entry && await actions.discard(entry)) closeDiff();
  },
  close: () => closeDiff(),
  setLayout: (layout) => {
    state.settings.diffLayout = layout;
    call('setSettings', { diffLayout: layout }).catch(showError);
  },
};

function openDiffView(key, target, mode, title) {
  state.diffKey = key;
  $('diff-view').hidden = false;
  diffView.open({ target, mode, title, layout: state.settings.diffLayout || 'inline', api: diffApi });
  for (const row of document.querySelectorAll('.file-row')) row.classList.remove('active');
  showDetail(graph.selected, false);
}

function closeDiff() {
  if (!diffView.isOpen) return;
  diffView.close();
  state.diffKey = null;
  $('diff-view').hidden = true;
  showDetail(graph.selected, false);
}

const actions = {
  openDiff(entry, mode) {
    const target = mode === 'staged'
      ? { kind: 'staged', path: entry.path, originalPath: entry.originalPath ?? null }
      : { kind: 'unstaged', path: entry.path, untracked: entry.state === 'untracked' };
    openDiffView(diffKey(mode, entry.path), target, mode, entry.path);
  },
  openCommitDiff(hash, file) {
    openDiffView(diffKey(`commit-${hash}`, file.path), { kind: 'commit', hash, path: file.path, originalPath: file.originalPath ?? null }, 'commit', file.path);
    showDetail(hash);
  },
  activeDiffKey: () => state.diffKey,
  async discard(entry) {
    const what = entry.state === 'untracked' ? '새 파일을 지웁니다' : 'Stage 한 것을 포함해 마지막 커밋 상태로 되돌립니다';
    if (!(await confirmDialog({ title: '변경 버리기', message: `${entry.path}\n\n이 파일의 ${what}. 되돌릴 수 없습니다.`, ok: '버리기', danger: true }))) return false;
    if (state.diffKey?.endsWith(`:${entry.path}`)) closeDiff();
    return (await act('버리는 중…', () => call('discard', { paths: [entry.path] }).then(() => true))) === true;
  },
  fileMenu(event, entry, mode) {
    showMenu(event.clientX, event.clientY, [
      mode === 'unstaged'
        ? { label: 'Stage', action: () => actions.stage([entry.path]) }
        : { label: 'Unstage', action: () => actions.unstage([entry.path]) },
      { label: 'diff 보기', action: () => actions.openDiff(entry, mode) },
      '-',
      { label: '경로 복사', action: () => navigator.clipboard?.writeText(entry.path) },
      { label: state.repo && document.documentElement.dataset.platform === 'windows' ? '탐색기에서 보기' : 'Finder 에서 보기', action: () => call('reveal', { path: entry.path }).catch(showError) },
      '-',
      { label: '변경 버리기…', danger: true, disabled: mode !== 'unstaged', action: () => actions.discard(entry) },
    ]);
  },
  stage: (paths) => act('Stage 하는 중…', () => call('stage', { paths })),
  unstage: (paths) => act('Unstage 하는 중…', () => call('unstage', { paths })),
  stageAll: () => act('모두 Stage 하는 중…', () => call('stageAll')),
  unstageAll: () => act('모두 Unstage 하는 중…', () => call('unstageAll')),
  lastMessage: () => call('lastMessage').catch(() => ''),
  identity: () => state.repo?.identity ?? { name: '', email: '' },
  async commit(message, amend, pushAfter) {
    const hash = await act(amend ? 'Amend 하는 중…' : '커밋하는 중…', () => call('commit', { message, amend }), {
      // 다시 그리기 전에 입력란을 비운다.
      done: () => { state.draft = { summary: '', description: '', amend: false, pushAfter }; },
      success: (h) => `커밋했습니다: ${String(h).slice(0, 7)}`,
    });
    if (hash === undefined) return;
    if (pushAfter) await push();
    else showDetail(graph.hasWip ? 'wip' : null);
    if (!graph.hasWip) graph.select(state.history.commits[0]?.hash ?? null);
  },
};

async function push() {
  await act('푸시하는 중…', () => call('push'), { success: () => '푸시했습니다.' });
}

// ── 페치·풀 ───────────────────────────────────────────

const PULL_MODES = { ffOnly: '앞으로 감기만', merge: '병합', rebase: 'Rebase' };

async function fetchNow() {
  state.fetching = true;
  updateFetchInfo();
  try {
    await act('페치하는 중…', () => call('fetch'), { success: () => '페치했습니다.' });
    state.autoFetchError = null;
  } finally {
    state.fetching = false;
    updateFetchInfo();
  }
}

async function pull() {
  await act(`풀 하는 중… (${PULL_MODES[state.settings.pullMode]})`, () => call('pull'), { success: () => '풀 했습니다.' });
  updateFetchInfo();
}

/** 도구 막대 오른쪽의 "페치: 3분 전". 자동 페치가 실패했으면 그 이유를 띄운다. */
async function updateFetchInfo() {
  const info = $('fetch-info');
  if (!state.repo) return;
  if (state.fetching) {
    info.textContent = '페치 중…';
    return;
  }
  const at = await call('lastFetch').catch(() => null);
  info.textContent = state.autoFetchError ? '⚠ 자동 페치 실패' : at ? `페치: ${relativeTime(at)}` : '';
  info.title = state.autoFetchError ?? (state.settings.autoFetchMinutes ? `${state.settings.autoFetchMinutes}분마다 자동 페치` : '자동 페치 꺼짐');
  info.classList.toggle('warning-text', !!state.autoFetchError);
}

$('act-fetch').addEventListener('click', fetchNow);
$('act-pull').addEventListener('click', pull);
$('act-pull-mode').addEventListener('click', (event) => {
  const rect = event.currentTarget.getBoundingClientRect();
  showMenu(rect.left, rect.bottom + 4, Object.entries(PULL_MODES).map(([mode, label]) => ({
    label: `${state.settings.pullMode === mode ? '✓ ' : '\u2003'}${label}${mode === 'ffOnly' ? ' (기본)' : ''}`,
    action: async () => {
      state.settings = await call('setSettings', { pullMode: mode });
      renderToolbar();
    },
  })));
});
setInterval(updateFetchInfo, 30000);

on('changed', () => refresh());
on('fetching', () => {
  state.fetching = true;
  updateFetchInfo();
});
on('fetched', (result) => {
  state.fetching = false;
  state.autoFetchError = result.ok ? null : result.error?.message ?? '알 수 없는 오류';
  updateFetchInfo();
  refresh();
});

$('act-push').addEventListener('click', push);
$('act-refresh').addEventListener('click', refresh);
window.addEventListener('focus', refresh);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && diffView.isOpen && !document.querySelector('.modal-backdrop, .menu')) {
    closeDiff();
    return;
  }
  if (event.key === 'F5' || ((event.metaKey || event.ctrlKey) && event.key === 'r')) {
    event.preventDefault();
    refresh();
  }
});

// ── 칸 나누기 끌기 ─────────────────────────────────────

for (const splitter of document.querySelectorAll('.splitter')) {
  splitter.addEventListener('pointerdown', (event) => {
    const target = splitter.dataset.split === 'sidebar' ? $('sidebar') : $('detail');
    const startX = event.clientX;
    const startWidth = target.getBoundingClientRect().width;
    const sign = splitter.dataset.split === 'sidebar' ? 1 : -1;
    splitter.setPointerCapture(event.pointerId);
    const move = (e) => {
      target.style.width = `${Math.max(160, Math.min(640, startWidth + sign * (e.clientX - startX)))}px`;
      graph.redraw();
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', () => splitter.removeEventListener('pointermove', move), { once: true });
  });
}

// ── 시작 ─────────────────────────────────────────────

(async () => {
  try {
    const init = await call('init');
    state.settings = init.settings;
    document.documentElement.dataset.platform = init.platform;
    applyTheme(init.settings.theme);
    if (init.repo) await enterRepo(init.repo);
    else showStart();
  } catch (error) {
    showError(error);
    showStart();
  }
})();
