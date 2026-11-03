// 앱 전체의 흐름: 시작 화면 ↔ 저장소 화면, 새로고침, 작업 뒤 다시 읽기, 도구 막대·사이드바·그래프·오른쪽 패널을 잇는다.

import { call, on } from './bridge.js';
import { el, relativeTime, josa, isComposing } from './util.js';
import { icon } from './icons.js';
import { createGraph, createAvatars, laneColor } from './graph.js';
import { renderStaging, renderCommit, renderCommitSkeleton, diffKey, openStagingFilter } from './changes.js';
import { createDiffView } from './diff.js';
import { confirmDialog, choiceDialog, pickDialog, formDialog, errorDialog, showMenu, menuBelow, closeDrawer } from './dialogs.js';
import { createRefs } from './refs.js';
import { createSidebar } from './sidebar.js';
import { createToolbar } from './toolbar.js';
import { createMergeView } from './merge.js';
import { cloneDialog, loginDialog, settingsDialog, renderTabs } from './screens.js';
import { installTooltips } from './tooltip.js';
import { createTools } from './tools.js';
import { createViews } from './views.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: { theme: 'dark', recent: [], ui: {} },
  platform: 'macos',
  version: '',
  repo: null,
  status: null,
  history: null,
  refs: null,
  remotes: [],
  worktrees: [],
  submodules: [],
  undo: {},
  template: null,
  mergeMessage: null,
  draft: { summary: '', description: '', amend: false },
  /** 지금 열린 diff 의 키(diffKey). 목록에서 그 줄을 고른 것으로 보인다. */
  diffKey: null,
  /** 한 번에 읽는 커밋 수. 그래프 끝에 닿으면 늘린다. */
  maxCount: 5000,
  get pullModeLabel() { return PULL_MODES[state.settings.pullMode] ?? ''; },
};

/** 화면만 쓰는 설정(칸 폭·순서·접힘 등). 설정 파일의 ui 에 저장한다. */
const prefs = {
  get: (key) => state.settings.ui?.[key],
  set(key, value) {
    state.settings.ui = { ...(state.settings.ui ?? {}), [key]: value };
    call('setUi', { key, value }).catch(() => {});
  },
};

installTooltips();

const avatars = createAvatars((email, hash) => call('avatar', { email, hash }));

/** 파일 히스토리·Blame·편집기·이미지 diff — 아래 toolsUi 가 채운다. */
const tools = {};
const diffView = createDiffView($('diff-view'));
const mergeView = createMergeView($('merge-view'));

// ── 알림 ─────────────────────────────────────────────

/** 가벼운 알림(성공·안내). 실패는 오류 대화상자로 보인다. */
function toast(message, kind = 'info') {
  const node = el('div', { class: `toast ${kind}` },
    el('div', { class: 'toast-text', text: message }),
    el('button', { class: 'toast-close', 'data-tip': '닫기', onclick: () => node.remove() }, icon('close', 12)));
  $('toasts').append(node);
  setTimeout(() => node.remove(), kind === 'warning' ? 7000 : 4000);
}

/** git 실패를 오류 대화상자로 보인다(설명 / git 원문, 원인·해결, SSL 이면 설정, 충돌이면 충돌 보기). */
function showError(error) {
  return errorDialog(error, {
    prefs,
    openSsl: () => openSettings('ssl'),
    showConflicts: () => {
      graph.select('wip');
      showDetail('wip');
    },
  });
}

// ── 그래프·사이드바·도구 막대 ─────────────────────────

const graph = createGraph({
  pane: document.querySelector('.graph-pane'),
  header: $('graph-header'),
  scroll: $('graph-scroll'),
  sizer: $('graph-sizer'),
  canvas: $('graph-canvas'),
  rows: $('graph-rows'),
  prefs,
  avatars,
  onSelect: (key) => showDetail(key),
  onContextMenu: (key, event, commit, ref) => {
    if (!commit) return;
    if (ref) refsUi.refMenu(event, ref, commit);
    else refsUi.commitMenu(event, commit);
  },
  onRefActivate: (ref, commit) => refsUi.activateRef(ref, commit),
  onWipSubject: (text) => {
    state.draft.summary = text;
    const field = $('commit-summary');
    if (field && field.value !== text) {
      field.value = text;
      field.dispatchEvent(new Event('input'));
    }
  },
  onNeedMore: () => loadMore(),
});
avatars.onLoad(() => graph.redraw());

const refsUi = createRefs({
  call,
  act: (...a) => act(...a),
  state,
  prefs,
  graph,
  reveal: (hash) => revealCommit(hash),
  showCommit: (hash, title) => showCommitDetail(hash, title),
  openRepo: (path) => openRepo(path),
  notify: (text) => toast(text, 'info'),
  showError,
  inlineBranches: () => true,
  beforeInlineBranch: () => {
    closeDiff();
    closeMerge();
  },
  sidebarElement: () => $('sidebar'),
  pull: () => pull(),
  fetch: () => fetchNow(),
  compare: (from, to, options) => toolsUi.compare(from, to, options),
});

const sidebar = createSidebar($('sidebar'), {
  state,
  prefs,
  menus: refsUi.menus,
  activate: (target) => refsUi.activate(target),
  add: (section) => refsUi.add(section),
  reveal: (hash) => revealCommit(hash),
  laneColorOf: (hash) => {
    const lane = graph.laneOfHash(hash);
    return lane ? laneColor(lane) : 'var(--git-text-muted)';
  },
});

const toolbar = createToolbar($('toolbar'), {
  undo: () => undoRedo('undo'),
  redo: () => undoRedo('redo'),
  fetch: () => fetchNow(),
  fetchProblem: () => fetchNow(),
  pull: () => pull(),
  pullMenu: (button) => menuBelow(button, Object.entries(PULL_MODES).map(([mode, label]) => ({
    label: `${label}${mode === 'ffOnly' ? ' (기본)' : ''}`,
    checked: state.settings.pullMode === mode,
    action: async () => {
      state.settings = await call('setSettings', { pullMode: mode });
      render();
    },
  }))),
  push: () => push(),
  newBranch: () => refsUi.createBranch(),
  stash: () => refsUi.stashPush(),
  pop: () => refsUi.stashPop(),
  terminal: () => call('openTerminal').catch(showError),
  refresh: () => refresh(),
  windowMenu: (button) => windowMenu(button),
  checkout: (name, remote) => refsUi.checkout(name, remote),
  openRepo: (path) => openRepo(path),
});

// ── 테마·배율 ─────────────────────────────────────────

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

/** 테마: dark · light · system(OS 밝기를 따르고, 바뀌면 바로 반영). */
function applyTheme(theme) {
  const resolved = theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = resolved;
  graph.redraw();
}

systemDark.addEventListener('change', () => {
  if (state.settings.theme === 'system') applyTheme('system');
});

async function setTheme(theme) {
  applyTheme(theme);
  state.settings.theme = theme;
  await call('setSettings', { theme }).catch(showError);
}

const THEMES = { dark: 'JetBrains 다크', light: 'JetBrains 라이트', system: '시스템 따르기' };
const LAYOUTS = { gitkraken: 'GitKraken', fork: 'Fork', unity: 'Unity VCS' };
const EXPLORERS = { fork: 'Fork', unity: 'Unity VCS' };

/** UI 배율: 60~200%, 10% 단위. 웹뷰 확대라 글자·그림이 함께 커진다. */
function uiScale() {
  return prefs.get('ui.scale') ?? 1;
}

function setScale(scale) {
  const next = Math.round(Math.min(2, Math.max(0.6, scale)) * 10) / 10;
  prefs.set('ui.scale', next);
  call('setZoom', { scale: next });
  renderFooter();
}

window.addEventListener('wheel', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  setScale(uiScale() + (event.deltaY < 0 ? 0.1 : -0.1));
}, { passive: false });

// ── 탭·시작 화면 ──────────────────────────────────────

function drawTabs() {
  renderTabs($('tabs'), {
    tabs: state.settings.openTabs ?? [],
    active: state.repo?.path ?? null,
    onOpen: (path) => openRepo(path),
    onClose: (path) => closeTab(path),
    onNew: () => newTab(),
  });
}

async function newTab() {
  await call('closeRepo').catch(showError);
  state.settings = await call('getSettings').catch(() => state.settings);
  showStart();
}

async function closeTab(path) {
  state.settings = await call('closeTab', { path });
  if (state.repo?.path !== path) {
    drawTabs();
    return;
  }
  const next = state.settings.openTabs[0];
  if (next) await openRepo(next.path);
  else await newTab();
}

/**
 * GitHub 가 아닌 서버가 로그인을 요구하면 로그인 창을 띄우고, 넣었으면 같은 작업을 한 번 더 한다.
 * 오류 글에 서버가 없으면(처음 접속하는 SSH 서버) 원격 주소에서 찾는다.
 */
async function withLogin(work) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!error?.login || attempt >= 2) throw error;
      let target = error.login;
      if (!target.host) {
        const fromRemote = await call('loginTarget').catch(() => null);
        target = fromRemote ? { ...fromRemote, kind: target.kind } : target;
      }
      if (!target.host) throw error;
      const reason = attempt === 0
        ? `${target.host} 서버가 로그인을 요구합니다.`
        : `${target.host} 서버가 로그인을 다시 거절했습니다. 비밀번호를 확인해 주세요.`;
      if (!(await loginDialog({ call, target, reason }))) throw error;
    }
  }
}

async function openSettings(section) {
  const before = state.settings.theme;
  const saved = await settingsDialog({ call, settings: state.settings, onTheme: applyTheme, showError, toast, section, prefs, graph, onPrefs: applyPrefs });
  if (saved) {
    state.settings = saved;
    toast('설정을 저장했습니다.', 'success');
    if (state.repo) render();
  } else {
    applyTheme(before);
  }
}

async function startClone() {
  const repo = await cloneDialog({ call, cloneDir: state.settings.cloneDir, withLogin, showError });
  if (repo) {
    toast(`${repo.name} 를 받았습니다.`, 'success');
    await enterRepo(repo);
  }
}

function showStart(notice) {
  state.repo = null;
  $('main').hidden = true;
  $('start').hidden = false;
  drawTabs();
  const box = $('start-notice');
  box.hidden = !notice;
  box.replaceChildren(...(notice ? [notice] : []));
  const list = $('recent-list');
  const recent = state.settings.recent || [];
  $('recent-empty').hidden = recent.length > 0;
  list.replaceChildren(...recent.map((r) => el('li', { class: 'recent-item', 'data-tip': r.path, onclick: () => openRepo(r.path) },
    el('div', { class: 'recent-icon', text: r.name.slice(0, 1).toUpperCase() }),
    el('div', { class: 'recent-text' }, el('div', { class: 'recent-name', text: r.name }), el('div', { class: 'recent-path muted small', text: r.path })),
    el('div', { class: 'recent-time muted small', text: relativeTime(r.openedAt) }),
    el('button', {
      class: 'recent-remove', 'data-tip': '목록에서 빼기 (폴더는 지우지 않음)',
      onclick: async (event) => {
        event.stopPropagation();
        state.settings = await call('removeRecent', { path: r.path });
        showStart();
      },
    }, icon('close', 12)))));
}

/** 고른 폴더가 저장소가 아니거나 git 을 못 찾았을 때의 안내 띠. */
function openFailure(error, path) {
  const message = error?.message ?? '';
  if (message.startsWith('Git 저장소가 아닙니다')) {
    return el('div', { class: 'notice-row' }, icon('info', 16),
      el('span', { text: `${path} 는 git 저장소가 아닙니다. 여기서 새 저장소를 만들 수 있습니다.` }),
      el('button', { class: 'btn small primary', text: 'git init…', onclick: () => initRepo(path) }));
  }
  if (message.includes('git 을 실행하지 못했습니다')) {
    return el('div', { class: 'notice-row' }, icon('warning', 16),
      el('span', { text: 'git 을 찾지 못했습니다. git 을 설치하거나 설정에서 git 실행 파일을 지정해 주세요.' }),
      el('button', { class: 'btn small primary', text: '설정 열기', onclick: () => openSettings() }));
  }
  return null;
}

async function initRepo(path) {
  const gitignore = await pickDialog({
    title: 'git init', glyph: 'folder',
    message: `${path} 를 git 저장소로 만듭니다. .gitignore 틀을 고르세요(이미 있으면 그대로 둡니다).`,
    options: [
      { value: '', label: '없음' },
      { value: 'basic', label: '기본', hint: '.DS_Store · 로그 · 편집기 설정' },
      { value: 'unity', label: 'Unity', hint: 'Library · Temp · Obj · Build …' },
      { value: 'node', label: 'Node', hint: 'node_modules · dist …' },
      { value: 'rust', label: 'Rust', hint: 'target …' },
    ],
    value: 'basic',
    ok: '저장소 만들기',
  });
  if (gitignore === null) return;
  try {
    await enterRepo(await busy('저장소를 만드는 중…', () => call('initRepo', { path, gitignore })));
    toast('새 저장소를 만들었습니다.', 'success');
  } catch (error) {
    showError(error);
  }
}

async function pickRepo() {
  const path = await call('pick', { kind: 'folder', title: 'Git 저장소 폴더 열기' }).catch(() => null);
  if (path) await openRepo(path);
}

async function openRepo(path) {
  try {
    await enterRepo(await busy('저장소를 여는 중…', () => call('openRepo', { path })));
  } catch (error) {
    const notice = openFailure(error, path);
    if (notice) {
      if (state.repo) await newTab();
      showStart(notice);
    } else showError(error);
  }
}

/** 시작 화면(툴바가 없을 때)용 작업 중 표시. */
async function busy(text, work) {
  $('busy-text').textContent = text;
  const timer = setTimeout(() => { $('busy').hidden = false; }, 150);
  try {
    return await work();
  } finally {
    clearTimeout(timer);
    $('busy').hidden = true;
  }
}

$('start-open').addEventListener('click', pickRepo);
$('start-clone').addEventListener('click', startClone);
$('start-settings').addEventListener('click', () => openSettings());

// ── 저장소 화면 ───────────────────────────────────────

async function enterRepo(repo) {
  state.repo = repo;
  // 여는 동안 설정(탭 목록)이 바뀌었다.
  state.settings = await call('getSettings').catch(() => state.settings);
  drawTabs();
  state.fingerprint = null;
  state.draft = { summary: '', description: '', amend: false };
  state.status = null;
  $('start').hidden = true;
  $('main').hidden = false;
  graph.select(null, false);
  closeDiff();
  closeMerge();
  closeDrawer();
  toolbar.setFetch({ error: null, auth: false, fetching: false });
  state.maxCount = prefs.get('graph.count') ?? 5000;
  graph.setWipSubject('');
  // 처음 읽는 동안 skeleton 을 덮는다(300ms 안에 읽히면 보이지 않는다).
  const skeleton = setTimeout(() => showSkeleton(true), 300);
  try {
    await refresh();
  } finally {
    clearTimeout(skeleton);
    showSkeleton(false);
  }
  updateFetchInfo();
  graph.select(graph.hasWip ? 'wip' : state.history?.commits[0]?.hash ?? null);
  views?.relayout();
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
  try {
    const snap = await call('snapshot', { maxCount: state.maxCount });
    const { status, history, refs } = snap;
    // 충돌을 다 풀어(또는 작업을 중단해) 그 파일이 더는 충돌이 아니면 병합 편집기를 닫는다.
    if (mergeView.isOpen && !status.unstaged.some((e) => e.path === mergeView.path && e.state === 'conflicted')) closeMerge();
    // 파일을 더 고쳐도 상태(M)는 그대로일 수 있으니, 열린 diff 는 늘 다시 읽는다(같으면 다시 그리지 않는다).
    const target = diffView.target;
    if (target && target.kind !== 'commit') {
      const list = target.kind === 'staged' ? status.staged : status.unstaged;
      if (list.some((e) => e.path === target.path)) diffView.reload();
      else closeDiff();
    }
    // 바뀐 것이 없으면 다시 그리지 않는다. 창에 포커스가 올 때도 새로고침하므로, 다시 그리면 그 클릭으로 누르던 버튼이 사라지고
    // 입력란 포커스도 잃는다.
    const fingerprint = JSON.stringify([status, refs, snap.remotes, snap.worktrees, snap.submodules, snap.undo, history.head, history.commits.length,
      history.commits.map((c) => c.hash + c.refs.map((r) => r.name).join())]);
    if (fingerprint === state.fingerprint) return;
    state.fingerprint = fingerprint;
    const operationStarted = status.operation && !state.status?.operation;
    Object.assign(state, {
      status, history, refs,
      remotes: snap.remotes, worktrees: snap.worktrees, submodules: snap.submodules,
      undo: snap.undo, template: snap.template, mergeMessage: snap.mergeMessage,
    });
    state.repo.remotes = refs.remotes;
    render();
    graph.setData(history, status);
    graphSearch.refresh();
    $('graph-empty').hidden = history.commits.length > 0;
    // 충돌로 멈춘 작업이 새로 시작되면 변경 목록(WIP)을 보인다 — 거기서 충돌을 푼다.
    if (operationStarted && graph.hasWip) graph.select('wip');
    else if (graph.selected === 'wip' || graph.selected == null) showDetail(graph.selected ?? (graph.hasWip ? 'wip' : null), false);
  } catch (error) {
    showError(error);
  }
}

function render() {
  toolbar.render(state);
  renderBanner();
  sidebar.render();
  views?.refresh();
  renderRail();
  renderFooter();
}

/** 그래프에서 그 커밋으로 가서 목록 가운데쯤에 맞춘다. 읽은 범위 밖이면 더 읽는다. */
async function revealCommit(hash) {
  if (!state.history) return;
  closeDiff();
  closeMerge();
  if (!graph.reveal(hash) && state.history.truncated) {
    state.maxCount = Math.max(state.maxCount * 4, 20000);
    await refresh();
    if (!graph.reveal(hash)) return;
  }
  graph.select(hash);
}

let loadingMore = false;

/** 그래프 끝에 닿으면 커밋을 더 읽는다(무한 스크롤). */
async function loadMore() {
  if (loadingMore || !state.history?.truncated) return;
  loadingMore = true;
  state.maxCount += 5000;
  try {
    await refresh();
  } finally {
    loadingMore = false;
  }
}

// ── 오른쪽 패널 ───────────────────────────────────────

let detailToken = 0;
async function showDetail(key, fetch = true) {
  const container = $('detail');
  const token = ++detailToken;
  // 고른 줄이 없으면(고른 줄을 다시 눌러 풀면) 오른쪽 패널을 접는다.
  const collapsed = key == null && !diffView.isOpen && !mergeView.isOpen;
  container.hidden = collapsed;
  document.querySelector('.splitter[data-split="detail"]').hidden = collapsed;
  if (collapsed) {
    graph.redraw();
    return;
  }
  if (key === 'wip' || (key == null && state.status)) {
    renderStaging(container, state.status, state.draft, actions);
    return;
  }
  if (!key || !fetch) return;
  const slow = setTimeout(() => { if (token === detailToken) renderCommitSkeleton(container); }, 200);
  try {
    const detail = await call('commitDetail', { hash: key });
    clearTimeout(slow);
    if (token === detailToken) renderCommit(container, detail, actions);
  } catch (error) {
    showError(error);
  }
}

/** 그래프에 없는 커밋(stash 등)의 정보를 오른쪽에 보인다. */
async function showCommitDetail(hash, title) {
  const container = $('detail');
  container.hidden = false;
  document.querySelector('.splitter[data-split="detail"]').hidden = false;
  try {
    const detail = await call('commitDetail', { hash });
    renderCommit(container, { ...detail, title }, actions);
  } catch (error) {
    showError(error);
  }
}

// ── 작업 ─────────────────────────────────────────────

/**
 * 작업 하나. 도구 막대 오른쪽에 진행 글자를 보이고, 끝나면 늘 다시 읽는다(터미널에서 한 일도 함께 보인다).
 * onError(error) 가 true 를 돌려주면 그 실패는 부른 쪽이 처리한다.
 */
async function act(label, work, { success, done, onError } = {}) {
  toolbar.setBusy(label);
  try {
    const result = await withLogin(work);
    if (done) done(result);
    if (success) toast(success(result), 'success');
    return result;
  } catch (error) {
    if (!onError?.(error)) showError(error);
    return undefined;
  } finally {
    toolbar.setBusy('');
    await refresh();
  }
}

async function undoRedo(which) {
  const title = state.undo?.[which];
  if (!title) return;
  await act(which === 'undo' ? `실행 취소: ${title}` : `다시 실행: ${title}`, () => call(which), { success: (t) => `${which === 'undo' ? '실행 취소' : '다시 실행'}: ${t}` });
}

// ── diff ─────────────────────────────────────────────

const diffApi = {
  prefs,
  load: (target, options) => call('diff', { target, options: { ...options, algorithm: prefs.get('diff.algorithm') || null } }),
  async applyLines(action, target, fingerprint, lines, context) {
    if (action === 'discard' && !(await confirmDialog({
      title: '고른 줄 되돌리기',
      message: `${target.path} 에서 고른 변경 ${lines.length}줄을 버립니다. 실행 취소로도 되살릴 수 없습니다.`,
      ok: '되돌리기', danger: true, glyph: 'undo',
    }))) return false;
    const label = { stage: 'Stage', unstage: 'Unstage', discard: '되돌리기' }[action];
    const ok = await act(`${label} 하는 중…`, () => call('applyLines', { action, path: target.path, untracked: !!target.untracked, fingerprint, lines, context }).then(() => true));
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
  openEditor: (target, line) => call('openInEditor', { path: target.path, line, editor: prefs.get('editor') ?? '' }).catch(showError),
  lfsPull: (target) => act('LFS 원본을 받는 중…', () => call('lfsPull', { path: target.path }), { success: () => '원본을 받았습니다.' }),
  get edit() { return tools.editFile && ((target) => tools.editFile(target.path)); },
  get blame() { return tools.blame && ((target) => tools.blame(target.path, target.kind === 'commit' ? target.hash : undefined)); },
  get history() { return tools.fileHistory && ((target) => tools.fileHistory(target.path)); },
  get imageDiff() { return tools.imageDiff; },
  setLayout: (layout) => {
    state.settings.diffLayout = layout;
    call('setSettings', { diffLayout: layout }).catch(showError);
  },
};

function openDiffView(key, target, mode, title, entryState) {
  if (toolOpen()) closeTool();
  state.diffKey = key;
  $('diff-view').hidden = false;
  const hasStaged = mode === 'unstaged' && (state.status?.staged ?? []).some((e) => e.path === target.path);
  diffView.open({ target, mode, title, entryState, hasStaged, layout: state.settings.diffLayout || 'inline', api: diffApi });
  for (const row of document.querySelectorAll('.file-row')) row.classList.remove('active');
  showDetail(graph.selected, false);
  renderRail();
}

function closeDiff() {
  if (!diffView.isOpen) return;
  diffView.close();
  state.diffKey = null;
  $('diff-view').hidden = true;
  showDetail(graph.selected, false);
  renderRail();
}

// ── 병합 충돌 ─────────────────────────────────────────

const OP_NAME = { merge: '병합', rebase: 'Rebase', cherryPick: 'Cherry-pick', revert: 'Revert' };

const mergeApi = {
  prefs,
  load: (path) => call('conflict', { path }),
  oursName: () => (state.status?.branch.detached ? 'HEAD' : state.status?.branch.name),
  theirsName: () => state.mergeMessage?.match(/Merge (?:remote-tracking )?branch '([^']+)'/)?.[1] ?? null,
  async markResolved(path) {
    await actions.markResolved([path]);
    closeMerge();
  },
  /** 이미지 충돌: 우리(:2)·들어오는(:3) 판의 그림. */
  async imageSide(path, side) {
    try {
      const data = await call('fileBytes', { revision: side === 'a' ? ':2' : ':3', path });
      const img = el('img', { src: `data:${data.mime};base64,${data.base64}`, class: 'merge-img' });
      await img.decode();
      return { img, width: img.naturalWidth, height: img.naturalHeight, size: `${data.size.toLocaleString('ko-KR')} B` };
    } catch {
      return null;
    }
  },
  async save(path, text) {
    return (await act('해결을 저장하는 중…', () => call('saveResolution', { path, text }).then(() => true), { success: () => `${path} 의 충돌을 풀었습니다.` })) === true;
  },
  async resolve(path, side) {
    const label = side === 'ours' ? 'A(지금)' : 'B(들어오는)';
    if (!(await confirmDialog({ title: '한쪽으로 풀기', message: `${path} 를 ${label} 쪽 내용으로 통째로 바꾸고 해결로 표시합니다.`, ok: '바꾸기' }))) return;
    if ((await act('충돌을 푸는 중…', () => call('resolve', { path, side }).then(() => true))) === true) closeMerge();
  },
  close: () => closeMerge(),
  error: (e) => showError(e),
};

function openMerge(path) {
  if (toolOpen()) closeTool();
  closeDiff();
  state.diffKey = diffKey('unstaged', path);
  $('merge-view').hidden = false;
  mergeView.open(path, mergeApi);
  // 넓게 보이도록 오른쪽 목록을 접는다(닫으면 돌아온다).
  $('detail').hidden = true;
  document.querySelector('.splitter[data-split="detail"]').hidden = true;
  renderRail();
}

function closeMerge() {
  if (!mergeView.isOpen) return;
  mergeView.close();
  state.diffKey = null;
  $('merge-view').hidden = true;
  showDetail(graph.selected, false);
  renderRail();
}

/** 맨 위 띠: 멈춘 병합·rebase 와 남은 충돌, 이어가기·건너뛰기·중단. */
function renderBanner() {
  const banner = $('op-banner');
  const op = state.status?.operation;
  banner.hidden = !op;
  if (!op) return;
  const conflicts = state.status.conflicted;
  banner.replaceChildren(...[
    icon('warning', 16),
    el('span', { class: 'op-text' }, el('strong', { text: `${OP_NAME[op]} 진행 중` }),
      conflicts ? ` — 충돌 파일 ${conflicts}개가 남았습니다. 오른쪽 목록에서 파일을 눌러 풀어 주세요.` : ' — 충돌을 모두 풀었습니다. 이어가면 끝납니다.'),
    el('button', { class: 'btn small primary', disabled: conflicts > 0, text: op === 'rebase' ? '이어가기' : '커밋하고 마치기', onclick: () => actions.continueOperation() }),
    op === 'rebase' ? el('button', { class: 'btn small', text: '이 커밋 건너뛰기', onclick: () => actions.skipOperation() }) : null,
    el('button', { class: 'btn small danger', text: '중단', onclick: () => actions.abortOperation() }),
  ].filter(Boolean));
}

const actions = {
  async continueOperation(message) {
    const op = state.status?.operation;
    await act(`${OP_NAME[op] ?? ''} 이어가는 중…`, () => call('continueOperation', { message }), { success: () => `${josa(OP_NAME[op] ?? '작업', '을', '를')} 이어갔습니다.` });
  },
  async skipOperation() {
    if (!(await confirmDialog({ title: '커밋 건너뛰기', message: 'Rebase 에서 지금 멈춘 커밋을 빼고 다음으로 갑니다. 그 커밋의 변경은 사라집니다.', ok: '건너뛰기', danger: true }))) return;
    await act('건너뛰는 중…', () => call('skipOperation'));
  },
  async abortOperation() {
    const op = state.status?.operation;
    if (!(await confirmDialog({ title: `${OP_NAME[op]} 중단`, message: `${josa(OP_NAME[op], '을', '를')} 취소하고 시작하기 전 상태로 되돌립니다. 지금까지 푼 충돌도 사라집니다.`, ok: '중단', danger: true }))) return;
    closeMerge();
    await act('중단하는 중…', () => call('abortOperation'), { success: () => `${josa(OP_NAME[op], '을', '를')} 중단했습니다.` });
  },
  openDiff(entry, mode) {
    if (entry.state === 'conflicted') {
      openMerge(entry.path);
      return;
    }
    const target = mode === 'staged'
      ? { kind: 'staged', path: entry.path, originalPath: entry.originalPath ?? null }
      : { kind: 'unstaged', path: entry.path, untracked: entry.state === 'untracked' };
    openDiffView(diffKey(mode, entry.path), target, mode, entry.path, entry.state);
  },
  openCommitDiff(hash, file) {
    openDiffView(diffKey(`commit-${hash}`, file.path), { kind: 'commit', hash, path: file.path, originalPath: file.originalPath ?? null }, 'commit', file.path, file.state);
  },
  activeDiffKey: () => state.diffKey,
  async discard(entry) {
    const what = entry.state === 'untracked' ? '새 파일을 지웁니다' : 'Stage 한 것을 포함해 마지막 커밋 상태로 되돌립니다';
    if (!(await confirmDialog({ title: '변경 버리기', glyph: 'undo', message: `${entry.path}\n\n이 파일의 ${what}. 실행 취소로도 되살릴 수 없습니다.`, ok: '버리기', danger: true }))) return false;
    if (state.diffKey?.endsWith(`:${entry.path}`)) closeDiff();
    return (await act('버리는 중…', () => call('discard', { paths: [entry.path] }).then(() => true))) === true;
  },
  prefs,
  /** 파일 우클릭(여럿 골랐으면 고른 것 모두에). 원본 FileActionMenu. */
  fileMenu(event, entries, mode) {
    const paths = entries.map((e) => e.path);
    const one = entries.length === 1 ? entries[0] : null;
    const many = entries.length > 1 ? ` (${entries.length}개)` : '';
    const conflicted = entries.every((e) => e.state === 'conflicted');
    const fm = state.platform === 'windows' ? '탐색기' : 'Finder';
    const items = [];
    if (conflicted && one) {
      items.push({ label: '해결됨으로 표시', action: () => actions.markResolved(paths) },
        { label: '우리 쪽(A)으로 풀기', action: () => mergeApi.resolve(one.path, 'ours') },
        { label: '상대 쪽(B)으로 풀기', action: () => mergeApi.resolve(one.path, 'theirs') }, '-');
    }
    items.push(
      mode === 'unstaged' ? { label: `Stage${many}`, action: () => actions.stage(paths) } : { label: `Unstage${many}`, action: () => actions.unstage(paths) },
      { label: `변경 버리기${many}…`, danger: true, disabled: mode !== 'unstaged', action: () => actions.discardMany(entries) },
      '-',
      { label: '무시', disabled: !one, submenu: one ? [
        { label: `이 파일 (${one.path})`, action: () => actions.ignore(one.path, 'file') },
        { label: `같은 확장자 (*${one.path.includes('.') ? one.path.slice(one.path.lastIndexOf('.')) : ''})`, disabled: !/\.[^/]+$/.test(one.path), action: () => actions.ignore(one.path, 'extension') },
        { label: '이 폴더', disabled: !one.path.includes('/'), action: () => actions.ignore(one.path.slice(0, one.path.lastIndexOf('/')), 'folder') },
      ] : [] },
      { label: 'LFS 로 추적', disabled: !one, submenu: one ? [
        { label: '이 파일', action: () => actions.lfsTrack(one.path, 'file') },
        { label: '같은 확장자', disabled: !/\.[^/]+$/.test(one.path), action: () => actions.lfsTrack(one.path, 'extension') },
      ] : [] },
      { label: `이 파일만 Stash${many}…`, disabled: mode !== 'unstaged', action: () => actions.stashPaths(paths) },
      '-',
      { label: '히스토리', disabled: !one || !tools.fileHistory, action: () => tools.fileHistory?.(one.path) },
      { label: 'Blame', disabled: !one || !tools.blame || one.state === 'untracked', action: () => tools.blame?.(one.path) },
      { label: '파일 편집', disabled: !one || one.state === 'deleted' || !tools.editFile, action: () => tools.editFile?.(one.path) },
      { label: '외부 편집기로 열기', disabled: !one || one.state === 'deleted', action: () => call('openInEditor', { path: one.path, line: 1, editor: prefs.get('editor') ?? '' }).catch(showError) },
      { label: '기본 프로그램으로 열기', disabled: !one || one.state === 'deleted', action: () => call('openDefault', { path: one.path }).catch(showError) },
      { label: `${fm} 에서 보기`, disabled: !one, action: () => call('reveal', { path: one.path }).catch(showError) },
      '-',
      { label: `패치 만들기${many}…`, action: () => actions.createPatch(paths, mode === 'staged') },
      { label: '경로 복사', action: () => navigator.clipboard?.writeText(paths.join('\n')) },
      { label: `파일 삭제${many}…`, danger: true, disabled: entries.some((e) => e.state === 'deleted'), action: () => actions.deleteFiles(paths) },
    );
    showMenu(event.clientX, event.clientY, items);
  },
  /** 폴더 우클릭(트리 보기). 원본 FileActionMenu 의 폴더 항목. */
  folderMenu(event, folder, entries, mode) {
    const paths = entries.map((e) => e.path);
    showMenu(event.clientX, event.clientY, [
      mode === 'unstaged' ? { label: `폴더 Stage (${paths.length})`, action: () => actions.stage(paths) } : { label: `폴더 Unstage (${paths.length})`, action: () => actions.unstage(paths) },
      { label: '폴더 변경 버리기…', danger: true, disabled: mode !== 'unstaged', action: () => actions.discardMany(entries) },
      { label: '폴더 무시', action: () => actions.ignore(folder.path, 'folder') },
      { label: '폴더 Stash…', disabled: mode !== 'unstaged', action: () => actions.stashPaths(paths) },
      { label: '패치 만들기…', action: () => actions.createPatch(paths, mode === 'staged') },
      '-',
      { label: '폴더 열기', action: () => call('openFolder', { path: `${state.repo.path}/${folder.path}` }).catch(showError) },
      { label: '새 파일…', disabled: !tools.newFile, action: () => tools.newFile?.(folder.path) },
    ]);
  },
  /** 커밋 상세 파일 우클릭. 원본 CommitFileMenu. */
  commitFileMenu(event, detail, files) {
    const file = files[0];
    const parent = detail.parents[0];
    const fm = state.platform === 'windows' ? '탐색기' : 'Finder';
    showMenu(event.clientX, event.clientY, [
      { label: '열기', disabled: file.state === 'deleted', action: () => call('openDefault', { path: file.path }).catch(showError) },
      { label: '외부 diff 도구로 보기', disabled: !parent, action: () => call('externalDiff', { from: parent, to: detail.hash, path: file.path, tool: prefs.get('difftool') || undefined }).catch(showError) },
      { label: `${fm} 에서 보기`, action: () => call('reveal', { path: file.path }).catch(showError) },
      '-',
      { label: '이 시점으로 되돌리기…', action: () => actions.restoreFile(detail.hash, file.path, `${detail.hash.slice(0, 7)} 시점`) },
      { label: '이 커밋 전으로 되돌리기…', disabled: !parent, action: () => actions.restoreFile(parent, file.path, `${detail.hash.slice(0, 7)} 의 부모 시점`) },
      '-',
      { label: 'Blame', disabled: !tools.blame || file.state === 'deleted', action: () => tools.blame?.(file.path, detail.hash) },
      { label: '히스토리', disabled: !tools.fileHistory, action: () => tools.fileHistory?.(file.path) },
      { label: '이 버전 저장…', disabled: file.state === 'deleted', action: () => actions.saveVersion(detail.hash, file.path) },
      { label: 'File Tree 에서 보기', disabled: !tools.showInTree, action: () => tools.showInTree?.(detail.hash, file.path) },
      { label: '경로 복사', action: () => navigator.clipboard?.writeText(files.map((f) => f.path).join('\n')) },
    ]);
  },
  async markResolved(paths) {
    const warn = await call('stageWarnings', { paths }).catch(() => ({ conflictMarkers: [] }));
    if (warn.conflictMarkers.length && !(await confirmDialog({ title: '충돌 표시가 남아 있습니다', glyph: 'warning', tone: 'warning', message: `${warn.conflictMarkers.join(', ')}\n\n<<<<<<< 같은 충돌 표시가 남은 채로 해결됨으로 표시할까요?`, ok: '그래도 표시' }))) return;
    await act('해결됨으로 표시하는 중…', () => call('stage', { paths }), { success: () => `${paths.length}개를 해결됨으로 표시했습니다.` });
  },
  async discardMany(entries) {
    if (entries.length === 1) return actions.discard(entries[0]);
    if (!(await confirmDialog({ title: `변경 버리기 (${entries.length}개)`, glyph: 'undo', danger: true, message: `${entries.map((e) => e.path).join('\n')}\n\n고른 파일을 마지막 커밋 상태로 되돌리고 새 파일은 지웁니다. 실행 취소로도 되살릴 수 없습니다.`, ok: '버리기' }))) return false;
    if (entries.some((e) => state.diffKey?.endsWith(`:${e.path}`))) closeDiff();
    return (await act('버리는 중…', () => call('discard', { paths: entries.map((e) => e.path) }).then(() => true))) === true;
  },
  async discardAll() {
    const all = [...new Map([...state.status.unstaged, ...state.status.staged].map((e) => [e.path, e])).values()];
    if (!(await confirmDialog({ title: '모든 변경 버리기', glyph: 'trash', danger: true, message: `${state.status.branch.name} 의 변경 ${all.length}개를 모두 버립니다. Stage 한 것도 마지막 커밋 상태로 되돌리고 새 파일은 지웁니다. 실행 취소로도 되살릴 수 없습니다.`, ok: '모두 버리기' }))) return;
    closeDiff();
    await act('모두 버리는 중…', () => call('discard', { paths: all.map((e) => e.path) }), { success: () => '모든 변경을 버렸습니다.' });
  },
  async ignore(path, kind) {
    await act('.gitignore 에 넣는 중…', () => call('ignore', { path, kind }), { success: (p) => `.gitignore 에 '${p}' 를 넣었습니다.` });
  },
  async lfsTrack(path, kind) {
    await act('LFS 로 추적하는 중…', () => call('lfsTrack', { path, kind }), { success: (p) => `LFS 로 '${p}' 를 추적합니다(.gitattributes).` });
  },
  async stashPaths(paths) {
    const values = await formDialog({ title: '고른 파일만 Stash', glyph: 'stash', message: `${paths.length}개 파일의 변경을 치워 둡니다.`, fields: [{ name: 'message', label: '메모 (선택)' }], ok: 'Stash' });
    if (values) await act('Stash 하는 중…', () => call('stashPaths', { paths, message: values.message }), { success: () => 'Stash 했습니다.' });
  },
  async createPatch(paths, staged) {
    const dest = await call('pick', { kind: 'save', name: paths.length === 1 ? `${paths[0].split('/').pop()}.patch` : 'changes.patch', title: '패치 저장', filters: [{ name: '패치', ext: ['patch', 'diff'] }] });
    if (dest) await act('패치를 쓰는 중…', () => call('createPatch', { paths, staged, dest }), { success: () => `패치를 저장했습니다: ${dest}` });
  },
  async deleteFiles(paths) {
    if (!(await confirmDialog({ title: '파일 삭제', danger: true, glyph: 'trash', message: `${paths.join('\n')}\n\n작업 폴더에서 지웁니다(휴지통에 가지 않습니다). 커밋한 적이 있는 파일은 변경 목록에 '삭제' 로 남습니다.`, ok: '삭제' }))) return;
    for (const path of paths) await act('지우는 중…', () => call('deletePath', { path }));
  },
  async restoreFile(revision, path, label) {
    if (!(await confirmDialog({ title: '파일 되돌리기', danger: true, glyph: 'undo', message: `${path}\n\n${label}의 내용으로 작업 폴더와 Stage 를 바꿉니다. 지금 이 파일의 변경은 사라집니다.`, ok: '되돌리기' }))) return;
    await act('되돌리는 중…', () => call('restoreFile', { revision, path }), { success: () => `${path} 를 되돌렸습니다.` });
  },
  async saveVersion(revision, path) {
    const name = path.split('/').pop();
    const dot = name.lastIndexOf('.');
    const suggested = dot > 0 ? `${name.slice(0, dot)}@${revision.slice(0, 7)}${name.slice(dot)}` : `${name}@${revision.slice(0, 7)}`;
    const dest = await call('pick', { kind: 'save', name: suggested, title: '이 버전 저장' });
    if (dest) await act('저장하는 중…', () => call('saveFileVersion', { revision, path, dest }), { success: () => `저장했습니다: ${dest}` });
  },
  /** Stage. 충돌 표시가 남은 파일·안에 git 저장소가 있는 폴더면 먼저 묻고, 누르자마자 목록을 옮겨 보인다. */
  async stage(paths) {
    const warn = await call('stageWarnings', { paths }).catch(() => ({ conflictMarkers: [], nestedRepos: [] }));
    if (warn.conflictMarkers.length && !(await confirmDialog({ title: '충돌 표시가 남아 있습니다', glyph: 'warning', tone: 'warning', message: `${warn.conflictMarkers.join(', ')}\n\n<<<<<<< 같은 충돌 표시가 남은 채로 Stage 할까요?`, ok: '그래도 Stage' }))) return;
    if (warn.nestedRepos.length && !(await confirmDialog({ title: '안에 git 저장소가 있는 폴더', glyph: 'warning', tone: 'warning', message: `${warn.nestedRepos.join(', ')}\n\n이 폴더는 다른 git 저장소라 파일 대신 커밋 하나(gitlink)로 올라갑니다. 서브모듈로 더하려면 사이드바의 서브모듈 "+" 를 쓰세요. 그래도 Stage 할까요?`, ok: '그래도 Stage' }))) return;
    optimistic(paths, 'unstaged', 'staged');
    return act('Stage 하는 중…', () => call('stage', { paths }));
  },
  unstage(paths) {
    optimistic(paths, 'staged', 'unstaged');
    return act('Unstage 하는 중…', () => call('unstage', { paths }));
  },
  stageAll: () => act('모두 Stage 하는 중…', () => call('stageAll')),
  unstageAll: () => act('모두 Unstage 하는 중…', () => call('unstageAll')),
  lastMessage: () => call('lastMessage').catch(() => ''),
  identity: () => state.repo?.identity ?? { name: '', email: '' },
  onSummary: (text) => graph.setWipSubject(text),
  avatarUrl: (email, hash) => avatars.url(email, hash),
  revealCommit: (hash) => revealCommit(hash),
  hasRemote: () => (state.refs?.remotes.length ?? 0) > 0,
  template: () => state.template,
  mergeMessage: () => state.mergeMessage,
  async commit(message, amend, pushAfter) {
    const hash = await act(amend ? 'Amend 하는 중…' : '커밋하는 중…', () => call('commit', { message, amend }), {
      // 다시 그리기 전에 입력란을 비운다.
      done: () => {
        state.draft = { summary: '', description: '', amend: false };
        graph.setWipSubject('');
      },
      success: (h) => `커밋했습니다: ${String(h).slice(0, 7)}`,
    });
    if (hash === undefined) return;
    if (pushAfter) await push();
    else showDetail(graph.hasWip ? 'wip' : null);
    if (!graph.hasWip) graph.select(state.history.commits[0]?.hash ?? null);
  },
};

/** 누르자마자 목록을 옮겨 보인다. git 이 끝나면 진짜 상태로 다시 맞춘다. */
function optimistic(paths, from, to) {
  if (!state.status || graph.selected !== 'wip') return;
  const moving = state.status[from].filter((e) => paths.includes(e.path) && e.state !== 'conflicted');
  if (!moving.length) return;
  const status = { ...state.status, [from]: state.status[from].filter((e) => !moving.includes(e)), [to]: [...state.status[to].filter((e) => !paths.includes(e.path)), ...moving] };
  renderStaging($('detail'), status, state.draft, actions);
}

// ── 커밋 검색(원본 CommitHistoryView 의 검색) ─────────────

/** 제목·작성자·SHA 앞부분·참조·가지 이름으로 찾고, Enter·[다음] 으로 다음 일치를 고른다. */
const graphSearch = (() => {
  const box = $('graph-search');
  const input = el('input', { class: 'field', placeholder: '커밋 찾기 — 제목·작성자·SHA·브랜치·태그', spellcheck: 'false' });
  const count = el('span', { class: 'muted small search-count' });
  let matches = [];
  let at = -1;
  const run = () => {
    const q = input.value.trim().toLowerCase();
    const commits = state.history?.commits ?? [];
    const nodes = state.history?.graph.nodes ?? [];
    const lanes = state.history?.graph.lanes ?? [];
    matches = [];
    if (q) {
      commits.forEach((c, i) => {
        if (c.subject.toLowerCase().includes(q) || c.authorName.toLowerCase().includes(q) || c.authorEmail.toLowerCase().includes(q)
          || c.hash.startsWith(q) || c.refs.some((r) => r.name.toLowerCase().includes(q)) || (lanes[nodes[i]?.lane]?.name ?? '').toLowerCase().includes(q)) matches.push(i);
      });
    }
    at = -1;
    count.textContent = q ? (matches.length ? `${matches.length}개` : '찾는 커밋이 없습니다') : '';
    count.classList.toggle('warning-text', !!q && !matches.length);
    graph.setSearchMatches(q && prefs.get('explorer.dim') ? new Set(matches) : null);
  };
  const next = (delta = 1) => {
    if (!matches.length) return;
    at = (at + delta + matches.length) % matches.length;
    const hash = state.history.commits[matches[at]].hash;
    graph.reveal(hash);
    graph.select(hash);
    count.textContent = `${at + 1} / ${matches.length}`;
  };
  input.addEventListener('input', run);
  input.addEventListener('keydown', (event) => {
    if (isComposing(event)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      next(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  });
  const close = () => {
    box.hidden = true;
    input.value = '';
    run();
    $('graph-scroll').focus();
  };
  box.replaceChildren(icon('search', 14), input, count,
    el('button', { class: 'icon-btn', 'data-tip': '이전 (Shift+Enter)', onclick: () => next(-1) }, icon('arrowUp', 14)),
    el('button', { class: 'icon-btn', 'data-tip': '다음 (Enter)', onclick: () => next(1) }, icon('arrowDown', 14)),
    el('button', { class: 'icon-btn', 'data-tip': '닫기 (Esc)', onclick: close }, icon('close', 12)));
  return {
    open() {
      closeDiff();
      closeMerge();
      box.hidden = false;
      input.focus();
      input.select();
    },
    refresh: () => !box.hidden && run(),
  };
})();


// ── 동기화(원본 Views/SyncFlows) ───────────────────────

const PULL_MODES = { ffOnly: '앞으로 감기만', merge: '병합', rebase: 'Rebase' };

/**
 * 푸시. 원격이 없으면 원격 추가 드로어, 원격이 여럿이고 upstream 이 없으면 고르기 카드, 거절(원격이 앞섬)이면 Pull 을 권한다.
 */
async function push() {
  const remotes = state.refs?.remotes ?? [];
  const branch = state.status.branch;
  if (!remotes.length) {
    toast('원격이 없습니다. 원격을 추가한 뒤 다시 푸시하세요.', 'warning');
    refsUi.addRemote();
    return;
  }
  let remote;
  if (!branch.upstream && remotes.length > 1) {
    remote = await pickDialog({ title: '올릴 원격', glyph: 'push', message: `'${branch.name}' 를 어느 원격에 올릴까요?`, options: remotes.map((r) => ({ value: r, label: r })), value: prefs.get('push.remote') ?? 'origin' });
    if (!remote) return;
    prefs.set('push.remote', remote);
  }
  const firstPush = !branch.upstream;
  let rejected = null;
  const result = await act('푸시하는 중…', () => call('push', { remote }), {
    success: () => (firstPush ? `'${branch.name}' 를 처음 올렸습니다.` : '푸시했습니다.'),
    onError: (error) => {
      if (error?.advice?.kind !== 'remoteAhead') return false;
      rejected = error;
      return true;
    },
  });
  if (rejected && await confirmDialog({ title: '원격에 새 커밋이 있습니다', glyph: 'pull', message: `${rejected.advice.cause}\n\n먼저 Pull 해서 합친 뒤 다시 Push 할까요?`, ok: 'Pull 하고 Push' })) {
    if (await pull()) await push();
  } else if (result !== undefined && firstPush && state.refs?.remotes && isGithub()) {
    toast(`새 브랜치를 올렸습니다. GitHub 에서 Pull Request 를 만들 수 있습니다.`, 'info');
  }
}

const isGithub = () => (state.remotes ?? []).some((r) => /github\.com/i.test(r.fetchUrl));

async function fetchNow() {
  toolbar.setFetch({ fetching: true });
  try {
    await act('페치하는 중…', () => call('fetch'), { success: () => '페치했습니다.' });
    toolbar.setFetch({ error: null, auth: false });
  } finally {
    toolbar.setFetch({ fetching: false });
    updateFetchInfo();
  }
}

/** 풀. 앞으로 감기만으로 안 되면(갈라짐) 병합·Rebase 중에서 다시 묻는다. 성공하면 true. */
async function pull(mode) {
  let diverged = false;
  const result = await act(`풀 하는 중… (${PULL_MODES[mode ?? state.settings.pullMode]})`, () => call('pull', mode ? { mode } : {}).then(() => true), {
    success: () => '풀 했습니다.',
    onError: (error) => {
      const text = error?.message ?? '';
      if (!/fast-forward|갈라져|Diverging/i.test(text)) return false;
      diverged = true;
      return true;
    },
  });
  updateFetchInfo();
  if (!diverged) return result === true;
  const choice = await choiceDialog({
    title: '로컬과 원격이 갈라졌습니다', glyph: 'pull',
    message: '앞으로 감기만으로는 받을 수 없습니다. 원격의 커밋을 어떻게 합칠까요?\n\n병합: 병합 커밋을 만듭니다.\nRebase: 내 커밋을 원격 위로 옮깁니다(이미 푸시한 커밋이 없을 때 권장).',
    ok: '병합', alt: 'Rebase',
  });
  if (!choice) return false;
  return pull(choice === 'ok' ? 'merge' : 'rebase');
}

/** 도구 막대 오른쪽의 "마지막 Fetch: 3분 전". */
async function updateFetchInfo() {
  if (!state.repo) return;
  toolbar.setLastFetch(await call('lastFetch').catch(() => null));
}

setInterval(updateFetchInfo, 30000);

on('changed', () => refresh());
on('fetching', () => toolbar.setFetch({ fetching: true }));
on('fetched', (result) => {
  const error = result.ok ? null : result.error;
  toolbar.setFetch({ fetching: false, error: error ? error.message : null, auth: !!(error && (error.auth || error.login)) });
  updateFetchInfo();
  refresh();
});

// ── 창 ⋮ 메뉴 · 하단 상태 표시줄 · 사이드바 레일 ─────────

function windowMenu(button) {
  const layout = prefs.get('layout') ?? 'gitkraken';
  const explorer = prefs.get('explorer') ?? 'fork';
  const scale = Math.round(uiScale() * 100);
  menuBelow(button, [
    { label: '배치', submenu: Object.entries(LAYOUTS).map(([key, label]) => ({ label, checked: layout === key, action: () => setLayout(key) })) },
    { label: '탐색기 모양', disabled: layout === 'gitkraken', hint: layout === 'gitkraken' ? 'GitKraken 은 가로 그래프' : '', submenu: Object.entries(EXPLORERS).map(([key, label]) => ({ label, checked: explorer === key, action: () => { prefs.set('explorer', key); views?.relayout(); } })) },
    { label: '테마', submenu: Object.entries(THEMES).map(([key, label]) => ({ label, checked: (state.settings.theme ?? 'dark') === key, action: () => setTheme(key) })) },
    {
      label: 'UI 크기',
      submenu: [
        { label: '크게', hint: '⌘ =', action: () => setScale(uiScale() + 0.1) },
        { label: '작게', hint: '⌘ -', action: () => setScale(uiScale() - 0.1) },
        { label: `원래대로 — 지금 ${scale}%`, hint: '⌘ 0', action: () => setScale(1) },
      ],
    },
    '-',
    { label: `저장소 폴더 — ${state.platform === 'windows' ? '탐색기' : 'Finder'}`, disabled: !state.repo, action: () => call('openFolder', { path: state.repo.path }).catch(showError) },
    { label: '저장소 폴더에서 터미널 열기', disabled: !state.repo, action: () => call('openTerminal').catch(showError) },
    '-',
    { label: '설정…', hint: '⌘ ,', action: () => openSettings() },
  ]);
}

function setLayout(key) {
  const changed = prefs.get('layout') !== key;
  prefs.set('layout', key);
  document.body.dataset.layout = key;
  if (changed) {
    closeDiff();
    closeMerge();
    views?.relayout();
  }
  render();
  graph.redraw();
}

function renderFooter() {
  const footer = $('footer');
  if (!state.repo) return;
  const scale = Math.round(uiScale() * 100);
  footer.replaceChildren(
    el('button', { class: 'footer-btn', 'data-tip': 'GitHub Pull Request', disabled: !isGithub() }, icon('pullRequest', 14), el('span', { text: '풀 리퀘스트 없음' })),
    el('span', { class: 'spacer' }),
    el('button', {
      class: 'footer-btn', 'data-tip': 'UI 크기 (⌘/Ctrl + 휠)',
      onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        showMenu(r.left, r.top - 4 - 30 * 9, [60, 70, 80, 90, 100, 110, 125, 150, 200].map((p) => ({ label: `${p}%`, checked: p === scale, action: () => setScale(p / 100) })));
      },
    }, el('span', { text: `${scale}%` })),
    el('span', { class: 'footer-sep' }),
    el('span', { class: 'footer-version muted', text: `v${state.version}` }));
}

/** diff·병합 편집기를 열면 사이드바가 아이콘 레일로 접힌다. 누르면 그 화면을 닫고 펼친다. */
function renderRail() {
  const folded = (diffView.isOpen && (views?.usesGraph ?? true)) || mergeView.isOpen || toolOpen();
  $('rail').hidden = !folded;
  $('sidebar').hidden = folded;
  document.querySelector('.splitter[data-split="sidebar"]').hidden = folded;
  if (!folded) return;
  const refs = state.refs ?? { local: [], remote: [], tags: [], stashes: [] };
  const expand = () => {
    closeDiff();
    closeMerge();
    closeTool();
  };
  const item = (glyph, label, count) => el('button', { class: 'rail-btn', 'data-tip': label, onclick: expand }, icon(glyph, 18),
    count ? el('span', { class: 'rail-badge', text: count > 99 ? '99+' : count }) : null);
  const changes = (state.status?.staged.length ?? 0) + (state.status?.unstaged.length ?? 0);
  $('rail').replaceChildren(
    el('button', { class: 'rail-btn expand', 'data-tip': '사이드바 펼치기', onclick: expand }, icon('chevronRight', 16)),
    item('hierarchy', '그래프 · 로컬 변경', changes),
    el('div', { class: 'rail-sep' }),
    item('laptop', '로컬', refs.local.length),
    item('cloud', '원격', state.remotes?.length ?? 0),
    item('tag', '태그', refs.tags.length),
    item('stash', 'Stash', refs.stashes.length),
    item('worktree', '워크트리', state.worktrees?.filter((w) => !w.bare).length ?? 0),
    item('submodule', '서브모듈', state.submodules?.length ?? 0));
  // 도구 화면은 레일 오른쪽 전체를 덮는다.
  $('tool-view').style.left = `${$('rail').offsetWidth}px`;
}

// ── 도구 화면(파일 히스토리·Blame·비교·편집기·이미지 diff) ──

const toolsUi = createTools({
  host: $('tool-view'),
  call,
  prefs,
  showError,
  diffApi,
  revealCommit: (hash) => revealCommit(hash),
  avatarUrl: (email, hash) => avatars.url(email, hash),
  openEditor: (path, line) => call('openInEditor', { path, line, editor: prefs.get('editor') ?? '' }).catch(showError),
  onSaved: () => refresh(),
  onOpen: () => {
    closeDiff();
    closeMerge();
    renderRail();
  },
  onClose: () => {
    renderRail();
    showDetail(graph.selected, false);
  },
});
Object.assign(tools, {
  fileHistory: (path) => toolsUi.fileHistory(path),
  blame: (path, revision) => toolsUi.blame(path, revision),
  editFile: (path) => toolsUi.editFile(path),
  newFile: (folder) => toolsUi.newFile(folder),
  imageDiff: (target, container, diffState) => toolsUi.imageDiff(target, container, diffState),
});

const toolOpen = () => toolsUi.isOpen;
function closeTool() {
  return toolsUi.close();
}

/** 처음 읽는 동안 사이드바·그래프·파일 칸을 같은 모양의 회색 막대로 덮는다. */
function showSkeleton(on) {
  const sk = $('skeleton');
  if (!on) {
    sk.hidden = true;
    sk.replaceChildren();
    return;
  }
  const bars = (n, widths) => Array.from({ length: n }, (_, i) => el('div', { class: 'sk-bar', style: { width: `${widths[i % widths.length]}%` } }));
  sk.replaceChildren(
    el('div', { class: 'sk-col sk-side' }, bars(14, [60, 80, 50, 70])),
    el('div', { class: 'sk-col sk-graph' }, Array.from({ length: 18 }, (_, i) => el('div', { class: 'sk-row' }, el('div', { class: 'sk-dot' }), el('div', { class: 'sk-bar', style: { width: `${[55, 70, 40, 65][i % 4]}%` } })))),
    el('div', { class: 'sk-col sk-detail' }, bars(12, [90, 60, 75, 50])));
  sk.hidden = false;
}

// ── 키보드 ────────────────────────────────────────────

const inField = (event) => event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target.isContentEditable;

window.addEventListener('focus', () => {
  if (prefs.get('sync.focusRefresh') !== false) refresh();
});

/** 설정 화면에서 바꾼 화면 설정을 바로 반영한다. */
function applyPrefs(values) {
  setScale(values['ui.scale'] ?? uiScale());
  document.documentElement.style.setProperty('--base-size', `${values['ui.fontSize'] ?? 13}px`);
  if (graph.avatarsOn !== (values['graph.avatars'] !== false)) graph.setAvatars(values['graph.avatars'] !== false);
  if (state.repo) call('setWatch', { on: values['sync.watch'] !== false }).catch(() => {});
  setLayout(values.layout ?? 'gitkraken');
}
window.addEventListener('keydown', (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (isComposing(event)) return;
  if (event.key === 'Escape' && (diffView.isOpen || mergeView.isOpen || toolOpen()) && !document.querySelector('.modal-backdrop, .menu, .drawer')) {
    closeDiff();
    closeMerge();
    closeTool();
    return;
  }
  if (event.key === 'F5' || (mod && event.key === 'r')) {
    event.preventDefault();
    refresh();
  } else if (mod && (event.key === '=' || event.key === '+')) {
    event.preventDefault();
    setScale(uiScale() + 0.1);
  } else if (mod && event.key === '-') {
    event.preventDefault();
    setScale(uiScale() - 0.1);
  } else if (mod && event.key === '0') {
    event.preventDefault();
    setScale(1);
  } else if (mod && event.key.toLowerCase() === 'f' && state.repo) {
    event.preventDefault();
    if ($('detail').contains(document.activeElement) && graph.selected === 'wip') openStagingFilter($('detail'));
    else graphSearch.open();
  } else if (mod && event.key === ',') {
    event.preventDefault();
    openSettings();
  } else if (mod && event.key.toLowerCase() === 'z' && !inField(event) && state.repo && !document.querySelector('.modal-backdrop')) {
    event.preventDefault();
    undoRedo(event.shiftKey ? 'redo' : 'undo');
  }
});

// ── 칸 나누기 끌기(폭 저장, 두 번 누르면 기본 폭) ───────

const SPLIT_DEFAULT = { sidebar: 240, detail: 380 };

function applySplit(name, width) {
  const target = name === 'sidebar' ? $('sidebar') : $('detail');
  target.style.width = `${width}px`;
}

for (const splitter of document.querySelectorAll('.splitter')) {
  const name = splitter.dataset.split;
  splitter.addEventListener('pointerdown', (event) => {
    const target = name === 'sidebar' ? $('sidebar') : $('detail');
    const startX = event.clientX;
    const startWidth = target.getBoundingClientRect().width;
    const sign = name === 'sidebar' ? 1 : -1;
    splitter.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-col');
    let width = startWidth;
    const move = (e) => {
      width = Math.max(180, Math.min(720, startWidth + sign * (e.clientX - startX)));
      applySplit(name, width);
      graph.redraw();
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', () => {
      splitter.removeEventListener('pointermove', move);
      document.body.classList.remove('resizing-col');
      prefs.set(`split.${name}`, Math.round(width));
    }, { once: true });
  });
  splitter.addEventListener('dblclick', () => {
    applySplit(name, SPLIT_DEFAULT[name]);
    prefs.set(`split.${name}`, null);
    graph.redraw();
  });
}

// ── 탭·배치별 화면 ─────────────────────────────────────

// 도구 화면은 탭과 상관없이 가운데(사이드바 레일 오른쪽 전체)를 덮는다.
$('workspace').append($('tool-view'));

let views = null;

function createViewsOnce() {
  views = createViews({
    call, prefs, state, act, showError, actions, diffApi, avatars, refsUi,
    revealCommit: (hash) => {
      // GitKraken 은 그래프 탭에서, 나머지 배치는 브랜치 탐색기에서 커밋을 찾는다.
      if ((prefs.get('layout') ?? 'gitkraken') === 'gitkraken') {
        views.select('main');
        revealCommit(hash);
      } else views.select('explorer');
    },
    compare: (a, b, opts) => toolsUi.compare(a, b, opts),
    fileHistory: (path) => toolsUi.fileHistory(path),
    graphPane: document.querySelector('.graph-pane'),
    detail: $('detail'),
    diffViewEl: $('diff-view'),
    mergeViewEl: $('merge-view'),
    sidebar: $('sidebar'),
    renderStagingInto: (container) => state.status && renderStaging(container, state.status, state.draft, actions),
    onChange: () => renderRail(),
  });
}

// ── 시작 ─────────────────────────────────────────────

(async () => {
  try {
    const init = await call('init');
    state.settings = init.settings;
    state.platform = init.platform;
    state.version = init.version;
    document.documentElement.dataset.platform = init.platform;
    document.body.dataset.layout = prefs.get('layout') ?? 'gitkraken';
    for (const name of ['sidebar', 'detail']) applySplit(name, prefs.get(`split.${name}`) ?? SPLIT_DEFAULT[name]);
    if (uiScale() !== 1) call('setZoom', { scale: uiScale() });
    document.documentElement.style.setProperty('--base-size', `${prefs.get('ui.fontSize') ?? 13}px`);
    applyTheme(init.settings.theme);
    createViewsOnce();
    if (init.repo) await enterRepo(init.repo);
    else showStart();
  } catch (error) {
    showError(error);
    showStart();
  }
})();
