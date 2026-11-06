// 앱 전체의 흐름: 시작 화면 ↔ 레포지토리 화면, 새로고침, 작업 뒤 다시 읽기, 도구 막대·사이드바·그래프·오른쪽 패널을 잇는다.

import { call, on, onMenu } from './bridge.js';
import { el, relativeTime, josa, isComposing } from './util.js';
import { icon } from './icons.js';
import { createGraph, createAvatars, laneColor, stashLabel } from './graph.js';
import { renderStaging, renderCommit, renderCommitSkeleton, diffKey, openStagingFilter } from './changes.js';
import { createDiffView } from './diff.js';
import { confirmDialog, overwriteDialog, choiceDialog, pickDialog, formDialog, errorDialog, showMenu, menuBelow, closeDrawer } from './dialogs.js';
import { createRefs } from './refs.js';
import { createSidebar } from './sidebar.js';
import { createToolbar } from './toolbar.js';
import { createMergeView } from './merge.js';
import { cloneDialog, loginDialog, settingsDialog, renderTabs, bindTitlebar } from './screens.js';
import { startOpCard } from './opcard.js';
import { installTooltips } from './tooltip.js';
import { createTools } from './tools.js';
import { createViews } from './views.js';
import { createGitHub } from './github.js';
import { newRepoDialog } from './newrepo.js';

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
/** 알림: 창 아래 가운데에서 위로 올라오고, 시간이 지나거나 닫으면 아래로 가라앉으며 사라진다. 여럿이면 새 것이 아래에 쌓인다. */
function toast(message, kind = 'info') {
  let leaving = false;
  const leave = () => {
    if (leaving) return;
    leaving = true;
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 220);
  };
  const node = el('div', { class: `toast ${kind}` },
    el('div', { class: 'toast-text', text: message }),
    el('button', { class: 'toast-close', 'data-tip': '닫기', onclick: leave }, icon('close', 12)));
  $('toasts').append(node);
  setTimeout(leave, kind === 'warning' ? 7000 : 4000);
}

/** git 실패를 오류 대화상자로 보인다(설명 / git 원문, 원인·해결, SSL 이면 설정, 충돌이면 충돌 보기). */
function showError(error, title) {
  return errorDialog(error, {
    title,
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
  onSelect: (key) => {
    // 고른 줄을 다시 눌러 선택을 풀면 오른쪽 패널을 접는다.
    if (key == null) wipShown = false;
    showDetail(key);
  },
  // 줄·이름표 어디를 우클릭하든 커밋 메뉴(브랜치 작업은 그 안의 "브랜치 'x'" 하위 메뉴, 원본 CommitGraphList). stash 줄은 stash 메뉴.
  onContextMenu: (key, event, commit) => {
    const stash = commit?.stash ? state.refs?.stashes.find((s) => s.hash === commit.hash) : null;
    if (stash) refsUi.menus.stash(event, stash);
    else if (commit) refsUi.commitMenu(event, commit);
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
  // stash 변경 보기: 그래프에 그 stash 가 있으면 그 줄로 가서 고르고, 없으면(다른 배치) 오른쪽에 변경만.
  stashApplied: (stash) => showAppliedStash(stash),
  showCommit: (hash, title) => {
    if (layoutName() === 'gitkraken' && state.history?.commits.some((c) => c.hash === hash)) revealCommit(hash);
    else showCommitDetail(hash, title);
  },
  openRepo: (path) => openRepo(path),
  notify: (text) => toast(text, 'info'),
  showError,
  // 그래프 안 입력란은 GitKraken 그래프 탭이 있을 때만 쓴다(그 탭으로 옮긴 뒤 띄운다). 다른 배치는 브랜치 만들기 카드.
  inlineBranches: () => layoutName() === 'gitkraken',
  beforeInlineBranch: () => {
    views?.select('main');
    closeDiff();
    closeMerge();
    closeTool();
  },
  addRemote: () => refsUi.addRemote(),
  showInExplorer: (hash) => showInExplorer(hash),
  sidebarElement: () => $('sidebar'),
  pull: () => pull(),
  fetch: () => fetchNow(),
  compare: (from, to, options) => toolsUi.compare(from, to, options),
  githubRemoteForm: (close) => github.remoteForm(close),
  createPullRequest: (branch) => github.createPull(branch),
  sectionMenu: (id) => (id === 'prs' ? github.sectionMenu() : null),
  sectionAdd: (id) => id === 'prs' && github.createPull(),
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
  pullRequests: (tree) => github.section(tree),
});

const toolbar = createToolbar($('toolbar'), {
  undo: () => undoRedo('undo'),
  redo: () => undoRedo('redo'),
  fetch: () => fetchNow(),
  // 자동 페치가 계정 문제로 실패했다: 이 레포지토리의 계정을 고르게 하고, 고르면 다시 받는다.
  fetchProblem: async () => {
    if (await github.chooseAccount(lastFetchError ?? '')) fetchNow();
  },
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

// ── GitHub(로그인·계정·Pull Request) ─────────────────────

const github = createGitHub({
  call,
  act: (...a) => act(...a),
  prefs,
  state,
  showError,
  toast,
  sidebarElement: () => $('sidebar'),
  onChanged: () => {
    sidebar.render();
    renderFooter();
    syncMenu();
  },
  onSignedIn: () => {
    github.reset();
    if (state.repo) github.load(true);
    renderFooter();
    syncMenu();
  },
  revealCommit: (hash) => revealCommit(hash),
  refsUi,
  compare: (from, to, options) => toolsUi.compare(from, to, options),
  fetch: () => fetchNow(),
  connect: () => showConnect(),
});

/** 이번 실행에서 "이번에는 연결하지 않고 계속" 을 눌렀는지. 앱을 다시 켜면 다시 묻는다(원본 SessionState). */
let connectSkipped = false;

/**
 * GitHub 에 로그인하지 않았으면 본체 대신 연결 화면을 띄운다. 마치면(로그인 또는 건너뛰기) after 를 부르거나, 없으면 보던 화면으로 돌아간다.
 * 본체는 조금 아래에서 올라오며 나타난다(원본 EnterShell).
 */
function showConnect(after) {
  const shown = { main: !$('main').hidden, start: !$('start').hidden };
  for (const id of ['main', 'start', 'tabs']) $(id).hidden = true;
  closeDrawer();
  github.connectScreen($('connect'), async (signedIn) => {
    if (!signedIn) connectSkipped = true;
    $('tabs').hidden = false;
    document.body.classList.add('shell-enter');
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('shell-enter')));
    if (after) await after();
    else {
      $('main').hidden = !shown.main;
      $('start').hidden = !shown.start;
      graph.redraw();
    }
  });
}

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
  const changed = next !== uiScale();
  prefs.set('ui.scale', next);
  call('setZoom', { scale: next });
  renderFooter();
  if (changed) showScaleIndicator(next);
}

let scaleIndicatorTimer = 0;
/** 배율을 바꾸면 오른쪽 아래에 "120%" 를 잠깐 띄운다(원본 UiScaleController 900ms). */
function showScaleIndicator(scale) {
  let box = $('scale-indicator');
  if (!box) {
    box = el('div', { id: 'scale-indicator', class: 'scale-indicator' });
    document.body.append(box);
  }
  box.textContent = `${Math.round(scale * 100)}%`;
  box.hidden = false;
  clearTimeout(scaleIndicatorTimer);
  scaleIndicatorTimer = setTimeout(() => { box.hidden = true; }, 900);
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
    onBrowse: () => pickRepo(),
  });
  syncMenu();
}

/** 이번 실행에서 닫은 탭(최근 것이 끝). 메뉴 "닫은 탭 다시 열기" 가 끝에서부터 다시 연다. */
const closedTabs = [];

async function newTab() {
  await call('closeRepo').catch(showError);
  state.settings = await call('getSettings').catch(() => state.settings);
  showStart();
}

/** 가장 최근에 닫은 탭을 다시 연다. 그새 다시 열어 둔 탭은 건너뛴다. */
async function reopenTab() {
  const open = new Set((state.settings.openTabs ?? []).map((t) => t.path));
  while (closedTabs.length) {
    const path = closedTabs.pop();
    if (open.has(path)) continue;
    await openRepo(path);
    break;
  }
  syncMenu();
}

async function closeTab(path) {
  state.settings = await call('closeTab', { path });
  closedTabs.splice(0, closedTabs.length, ...closedTabs.filter((p) => p !== path), path);
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
      // 계정이 틀렸거나 로그인이 없어 원격이 거부했다(GitHub 등): 어느 계정이 거부됐는지 알리고 계정을 고르게 한다. 고르면 한 번 더.
      if (error?.auth && !error.login && attempt < 2) {
        if (await github.chooseAccount(error.message ?? '')) continue;
        throw { cancelled: true };
      }
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
  // 설정의 로그인 칸에서 로그아웃했을 수 있다.
  github.refreshSignedIn().then(() => syncMenu());
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

/** 고른 폴더가 레포지토리가 아니거나 git 을 못 찾았을 때의 안내 띠. */
function openFailure(error, path) {
  const message = error?.message ?? '';
  if (message.startsWith('Git 레포지토리가 아닙니다')) {
    return el('div', { class: 'notice-row' }, icon('info', 16),
      el('span', { text: `${path} 는 git 레포지토리가 아닙니다. 여기서 새 레포지토리를 만들 수 있습니다.` }),
      el('button', { class: 'btn small primary', text: 'git init…', onclick: () => initRepo(path) }));
  }
  if (message.includes('git 을 실행하지 못했습니다')) {
    return el('div', { class: 'notice-row' }, icon('warning', 16),
      el('span', { text: 'git 을 찾지 못했습니다. git 을 설치하거나 설정에서 git 실행 파일을 지정해 주세요.' }),
      el('button', { class: 'btn small primary', text: '설정 열기', onclick: () => openSettings() }));
  }
  return null;
}

/** 시작 화면의 "git init…": 레포지토리 만들기 창의 로컬 탭을 그 폴더로 채워 연다(이미 있는 폴더라도 .git 만 없으면 만든다). */
async function initRepo(path) {
  await createRepo({ path });
}

/** 메뉴·명령 팔레트·시작 화면의 "레포지토리 만들기": 로컬만 / GitHub.com 창(원본에 없음 · 확장). 만들면 새 탭으로 연다. */
async function createRepo(preset) {
  const repo = await newRepoDialog({ call, state, prefs, login: github.login, showError, toast }, preset);
  if (repo) await enterRepo(repo);
}

async function pickRepo() {
  const path = await call('pick', { kind: 'folder', title: 'Git 레포지토리 폴더 열기' }).catch(() => null);
  if (path) await openRepo(path);
}

async function openRepo(path) {
  try {
    await enterRepo(await busy('레포지토리를 여는 중…', () => call('openRepo', { path })));
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
$('start-create').addEventListener('click', () => createRepo());
$('start-settings').addEventListener('click', () => openSettings());

// ── 레포지토리 화면 ───────────────────────────────────────

async function enterRepo(repo) {
  // 다른 레포지토리로 가기 전에 도구 화면을 닫는다(편집 중이면 저장할지 묻고, 취소하면 머문다).
  if (toolOpen() && state.repo && state.repo.path !== repo.path && (await closeTool()) === false) return;
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
  lastFetchError = null;
  github.reset();
  state.maxCount = prefs.get('graph.count') ?? 5000;
  graph.setWipSubject('');
  // 처음 읽는 동안 skeleton 을 덮는다(300ms 안에 읽히면 보이지 않는다).
  graph.setLoading?.();
  const skeleton = setTimeout(() => showSkeleton(true), 250);
  try {
    await refresh();
  } finally {
    clearTimeout(skeleton);
    showSkeleton(false);
  }
  updateFetchInfo();
  // 원본처럼 고른 줄 없이 오른쪽에 작업 패널을 보인다.
  wipShown = true;
  graph.select(null, false);
  showDetail(null, false);
  views?.relayout();
  github.load();
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
      undo: snap.undo, template: snap.template, mergeMessage: snap.mergeMessage, mergeConflicts: snap.mergeConflicts ?? [],
    });
    state.repo.remotes = refs.remotes;
    render();
    graph.setData(history, status);
    graphSearch.refresh();
    $('graph-empty').hidden = history.commits.length > 0;
    // 충돌로 멈춘 작업이 새로 시작되면 변경 목록(WIP)을 보인다 — 거기서 충돌을 푼다.
    if (operationStarted && graph.hasWip) graph.select('wip');
    else if (graph.selected === 'wip' || graph.selected == null) showDetail(graph.selected, false);
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
  syncMenu();
}

/** 그래프에서 그 커밋으로 가서 목록 가운데쯤에 맞춘다. 읽은 범위 밖이면 더 읽는다. */
async function revealCommit(hash) {
  if (!state.history) return;
  // 그래프는 GitKraken 배치의 그래프 탭에만 있다. 다른 배치는 브랜치 탐색기에서 고른다.
  if (layoutName() !== 'gitkraken') {
    showInExplorer(hash);
    return;
  }
  views?.select('main');
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
  graph.setLoading?.();
  state.maxCount += 5000;
  try {
    await refresh();
  } finally {
    loadingMore = false;
  }
}

// ── 오른쪽 패널 ───────────────────────────────────────

let detailToken = 0;
/** 고른 줄이 없을 때 오른쪽에 작업 패널을 보이는지. 레포지토리를 열면 보이고, 고른 줄을 다시 눌러 풀면 접는다. */
let wipShown = true;
async function showDetail(key, fetch = true) {
  const container = $('detail');
  const token = ++detailToken;
  const collapsed = key == null && !wipShown && !diffView.isOpen && !mergeView.isOpen;
  container.hidden = collapsed;
  document.querySelector('.splitter[data-split="detail"]').hidden = collapsed;
  if (collapsed) {
    graph.redraw();
    return;
  }
  if (key === 'wip' || (key == null && state.status)) {
    if (key === 'wip') wipShown = true;
    renderStaging(container, state.status, state.draft, actions);
    return;
  }
  if (!key || !fetch) return;
  // 해시·제목·작성자는 그래프의 요약으로 바로 보이고, 파일 칸만 읽는 동안 회색 막대(원본 GraphCommitDetail.Show).
  const commit = state.history?.commits.find((c) => c.hash === key);
  renderCommitSkeleton(container, commit);
  try {
    const detail = await call('commitDetail', { hash: key });
    // stash 줄은 사이드바에서 열 때처럼 이름·메시지를 머리에.
    if (token === detailToken) renderCommit(container, commit?.stash ? { ...detail, title: `${commit.stash}: ${commit.subject}` } : detail, actions);
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
  setRunning(1);
  // 오래 걸리면(0.9초 넘게) 오른쪽 아래에 진행 카드가 뜬다 — 단계·진행률·지난 시간.
  const finishCard = startOpCard($('toasts'), label);
  try {
    const result = await withStash(label, () => withLogin(work));
    const message = success ? success(result) : null;
    // 진행 카드가 떠 있었으면 완료도 카드가 알린다(같은 알림을 두 번 띄우지 않는다).
    const carded = finishCard(true, message);
    if (done) done(result);
    if (message && !carded) toast(message, 'success');
    return result;
  } catch (error) {
    finishCard(false);
    // 계정 고르기를 닫았으면 같은 실패를 오류로 또 알리지 않는다.
    if (!error?.cancelled && !onError?.(error)) showError(error, failedTitle(label));
    return undefined;
  } finally {
    finishCard(false);
    toolbar.setBusy('');
    setRunning(-1);
    await refresh();
  }
}

/** "푸시하는 중…" → "푸시 실패", "브랜치를 만드는 중…" → "브랜치를 만드는 중 실패"(원본 runner.failed "{작업} 실패"). */
/** "풀 하는 중… (앞으로 감기만)" → "풀 (앞으로 감기만) 실패". 진행 글의 "하는 중…" 을 빼고 뒤에 붙은 설명은 남긴다. */
function failedTitle(label) {
  const text = String(label ?? '').trim();
  if (!text) return undefined;
  const m = /^(.+?)\s*(?:하는\s*)?중…?\s*(.*)$/.exec(text);
  const head = (m ? `${m[1].trim()} ${m[2].trim()}` : text.replace(/…$/, '')).trim();
  return `${head} 실패`;
}

let running = 0;

/**
 * 작업이 도는 동안(state.busy) 도구 막대·사이드바 메뉴의 쓰기 동작을 끈다(원본 GitToolbar idle·Runner.IsBusy).
 * 변경 목록은 다시 그리지 않고(누르자마자 옮겨 보인 목록을 지우지 않게) body 의 git-busy 로 버튼을 끈다.
 */
function setRunning(delta) {
  running = Math.max(0, running + delta);
  const busy = running > 0;
  if (busy === !!state.busy) return;
  state.busy = busy;
  document.body.classList.toggle('git-busy', busy);
  if (state.repo) {
    toolbar.render(state);
    sidebar.render();
  }
  syncMenu();
}

/**
 * 로컬 변경 때문에 전환·Pull·병합이 실패하면 오류와 함께 "Stash 하고 다시 {작업}" 을 권한다. 고르면 stash 한 뒤 한 번 더(원본 OfferStashAndRetryAsync).
 */
async function withStash(label, work) {
  try {
    return await work();
  } catch (error) {
    const kind = error?.advice?.kind;
    if (kind !== 'localChanges' && kind !== 'untrackedFiles') throw error;
    const op = String(label ?? '').replace(/(하는)? 중…$/, '').trim() || '작업';
    if (!(await overwriteDialog({ title: failedTitle(label) ?? '작업 실패', op, files: error.advice.files ?? [], untracked: kind === 'untrackedFiles' }))) throw { cancelled: true };
    try {
      await call('stashPush', { message: '', includeUntracked: false });
    } catch (stashError) {
      showError(stashError, 'Stash 실패');
      throw { cancelled: true };
    }
    return work();
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
    if (state.busy) return false;
    // 원본 GitDiffPanel.DiscardLinesAsync: 되돌릴 수 없어 한 번 묻는다. Stage 는 충돌 표시가 남았으면 묻는다(목록의 Stage 와 같은 규칙).
    if (action === 'discard' && !(await confirmDialog({
      title: '변경된 묶음 버리기',
      message: `${target.path} 의 이 변경된 묶음을 작업 사본에서 되돌립니다.\n툴바의 Undo 로도 되살릴 수 없습니다.`,
      ok: '버리기', danger: true, glyph: 'undo',
    }))) return false;
    if (action === 'stage') {
      const warn = await call('stageWarnings', { paths: [target.path] }).catch(() => ({ conflictMarkers: [] }));
      if (warn.conflictMarkers?.length && !(await confirmDialog({ title: '충돌 표시가 남아 있습니다', glyph: 'branch', danger: true, message: `아래 파일에 충돌 표시(<<<<<<< ======= >>>>>>>)가 남아 있습니다.\n올리면 git 은 충돌이 해결된 것으로 봅니다.\n\n${target.path}`, ok: '그대로 Stage' }))) return false;
    }
    if (state.busy) return false;
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
  /** LFS 원본 받기. 실패하면 그 글을 돌려준다(diff 가 안내 아래에 덧붙이고, 계정 문제면 [계정 고르기] 를 보인다). */
  async lfsPull(target) {
    let failure = null;
    await act('LFS 원본을 받는 중…', () => call('lfsPull', { path: target.path }), {
      onError: (error) => {
        failure = error?.message ?? String(error);
        return true;
      },
    });
    return failure;
  },
  /** LFS 원본 받기가 계정 문제로 실패했을 때의 [계정 고르기]. 고르면 다시 받는다. */
  chooseAccount: async (target) => {
    if (await github.chooseAccount('') && target) diffApi.lfsPull(target);
  },
  // 보던 변경 줄로 편집기를 연다(원본 LineToOpen).
  get edit() { return tools.editFile && ((target, line) => tools.editFile(target.path, line)); },
  get blame() { return tools.blame && ((target) => tools.blame(target.path, target.kind === 'commit' ? target.hash : undefined)); },
  get history() { return tools.fileHistory && ((target) => tools.fileHistory(target.path)); },
  get imageDiff() { return tools.imageDiff; },
  setLayout: (layout) => {
    state.settings.diffLayout = layout;
    call('setSettings', { diffLayout: layout }).catch(showError);
  },
};

async function openDiffView(key, target, mode, title, entryState) {
  // 도구 화면(편집기)을 닫을 때 저장할지 묻고, 취소하면 diff 를 열지 않는다.
  if (toolOpen() && (await closeTool()) === false) return;
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
  /** 멈춘 작업 종류(merge·rebase·cherryPick·revert). A·B 이름이 이걸 따른다. */
  operation: () => state.status?.operation ?? null,
  oursName: () => (state.status?.branch.detached ? 'HEAD' : state.status?.branch.name),
  theirsName: () => state.mergeMessage?.match(/Merge (?:remote-tracking )?branch '([^']+)'/)?.[1] ?? null,
  async markResolved(path) {
    await actions.markResolved([path]);
    closeMerge();
  },
  /** 이미지 충돌: 우리(:2)·들어오는(:3) 판의 그림. 읽을 수 없으면(LFS 주소 파일 등) null. */
  async imageSide(path, side) {
    try {
      const data = await call('fileBytes', { revision: side === 'a' ? ':2' : ':3', path });
      const src = `data:${data.mime};base64,${data.base64}`;
      const img = new Image();
      img.src = src;
      await img.decode();
      return { src, width: img.naturalWidth, height: img.naturalHeight, bytes: data.size };
    } catch {
      return null;
    }
  },
  /** force 면 충돌 표시가 남아도 쓴다(직접 고치기에서 한 번 더 확인한 뒤). */
  async save(path, text, force = false) {
    return (await act('해결을 저장하는 중…', () => call('saveResolution', { path, text, force }).then(() => true), { success: () => `${path} 의 충돌을 풀었습니다.` })) === true;
  },
  /** 한쪽으로 해결. ask 면 먼저 묻는다(파일 메뉴). 병합 편집기의 버튼은 원본처럼 바로 한다. */
  async resolve(path, side, ask = true) {
    const names = { merge: ['현재 브랜치', '병합해 오는'], cherryPick: ['현재 브랜치', '가져오는 커밋'], revert: ['현재 브랜치', '되돌리는 변경'], rebase: ['바탕 브랜치', '다시 쌓는 내 커밋'] }[state.status?.operation] ?? ['현재', '상대'];
    const label = side === 'ours' ? `A(${names[0]})` : `B(${names[1]})`;
    if (ask && !(await confirmDialog({ title: '한쪽으로 풀기', message: `${path} 를 ${label} 쪽 내용으로 통째로 바꾸고 해결로 표시합니다.`, ok: '바꾸기' }))) return;
    if ((await act('충돌을 푸는 중…', () => call('resolve', { path, side }).then(() => true))) === true) closeMerge();
  },
  close: () => closeMerge(),
  error: (e) => showError(e),
};

async function openMerge(path) {
  // 저장 안 한 편집이 있으면 먼저 묻는다. 취소하면 열지 않는다.
  if (toolOpen() && (await closeTool()) === false) return;
  closeDiff();
  state.diffKey = diffKey('unstaged', path);
  $('merge-view').hidden = false;
  mergeView.open(path, mergeApi);
  // 넓게 보이도록 오른쪽 목록을 접는다(닫으면 돌아온다). Fork·Unity VCS 배치는 목록·커밋 칸·세부사항을 접는다.
  $('detail').hidden = true;
  document.querySelector('.splitter[data-split="detail"]').hidden = true;
  views?.setMergeFullScreen?.(true);
  renderRail();
}

function closeMerge() {
  if (!mergeView.isOpen) return;
  mergeView.close();
  state.diffKey = null;
  $('merge-view').hidden = true;
  views?.setMergeFullScreen?.(false);
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
  /** git 작업이 도는 중인지(원본 Runner.IsBusy). 목록 버튼·메뉴가 끈다. */
  isBusy: () => !!state.busy,
  /** 파일 하나 버리기. side 는 discardMany 와 같다. */
  discard: (entry, side = 'unstaged') => actions.discardMany([entry], side),
  prefs,
  /**
   * 파일 우클릭(여럿 골랐으면 고른 것 모두에). 원본 StagingLists.Populate*Menu + FileActionMenu 순서:
   * [Stage · 변경 버리기] [충돌: 해결됨으로 표시 · 한쪽으로 해결] [무시 › · LFS › · 파일 Stash] [히스토리 · Blame] [외부 편집기 · 기본 프로그램 · Finder] [경로 복사 · 패치] [파일 편집 · 파일 삭제].
   * mode: 'unstaged' | 'staged' | 'conflict'(충돌 중 "충돌 파일" 목록 — 맨 위 묶음 없이 작업·공통 묶음만). clicked: 우클릭한 줄(공통 묶음의 대상).
   */
  fileMenu(event, entries, mode, clicked) {
    const busy = !!state.busy;
    const entry = clicked ?? entries[0];
    const many = entries.length > 1;
    const items = [];
    if (mode === 'unstaged') {
      if (many) {
        // 여럿: 고른 것 전부를 옮기거나 버린다. 버리기는 새 파일을 뺀다(하나일 때와 같다).
        items.push({ label: `파일 ${entries.length}개 Stage`, disabled: busy, action: () => actions.stage(entries.map((e) => e.path)) });
        const discardable = entries.filter((e) => e.state !== 'untracked');
        if (discardable.length) items.push({ label: `파일 ${discardable.length}개 변경 버리기`, disabled: busy, action: () => actions.discardMany(discardable, 'unstaged') });
        items.push('-', ...actions.commonFileItems(entry, false));
        showMenu(event.clientX, event.clientY, items);
        return;
      }
      items.push({ label: 'Stage', disabled: busy, action: () => actions.stage([entry.path]) });
      if (entry.state !== 'untracked') items.push({ label: '변경 버리기', disabled: busy, action: () => actions.discardMany([entry], 'unstaged') });
    } else if (mode === 'staged') {
      items.push({ label: many ? `파일 ${entries.length}개 Unstage` : 'Unstage', disabled: busy, action: () => actions.unstage(entries.map((e) => e.path)) }, '-');
    }
    if (mode !== 'staged') items.push(...actions.workingFileItems(entry));
    items.push(...actions.commonFileItems(entry, mode === 'staged'));
    showMenu(event.clientX, event.clientY, items);
  },
  /** 무시·LFS·Stash 묶음(충돌 파일이면 그 앞에 해결 항목). Staged 목록에는 넣지 않는다. 원본 FileActionMenu.AppendWorkingItems. */
  workingFileItems(entry) {
    const busy = !!state.busy;
    const items = [];
    if (entry.state === 'conflicted') {
      // 쪽 이름은 작업마다 다르다 — rebase 에서는 ours 가 바탕 브랜치, theirs 가 다시 쌓는 내 커밋이다(git 과 같다).
      const SIDES = { merge: ['현재 브랜치', '병합해 오는'], cherryPick: ['현재 브랜치', '가져오는 커밋'], revert: ['현재 브랜치', '되돌리는 변경'], rebase: ['바탕 브랜치', '다시 쌓는 내 커밋'] };
      const [ours, theirs] = SIDES[state.status?.operation] ?? ['현재', '상대'];
      items.push(
        { label: '충돌 해결됨으로 표시', disabled: busy, action: () => actions.markResolved([entry.path]) },
        { label: `${ours} 쪽으로 해결 (ours)`, disabled: busy, action: () => mergeApi.resolve(entry.path, 'ours') },
        { label: `${theirs} 쪽으로 해결 (theirs)`, disabled: busy, action: () => mergeApi.resolve(entry.path, 'theirs') }, '-');
    }
    const name = entry.path.split('/').pop();
    const ext = /\.([^./]+)$/.exec(name)?.[1];
    const folder = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
    items.push(
      { label: '무시', submenu: [
        { label: `'${name}' 무시`, disabled: busy, action: () => actions.ignore(entry.path, 'file') },
        ext ? { label: `모든 '*.${ext}' 파일 무시`, disabled: busy, action: () => actions.ignore(entry.path, 'extension') } : null,
        folder ? { label: `'${folder}/' 안의 모든 파일 무시`, disabled: busy, action: () => actions.ignore(folder, 'folder') } : null,
      ].filter(Boolean) },
      { label: 'LFS', submenu: [
        { label: `'${name}' 를 LFS 로 추적`, disabled: busy, action: () => actions.lfsTrack(entry.path, 'file') },
        ext ? { label: `모든 '*.${ext}' 를 LFS 로 추적`, disabled: busy, action: () => actions.lfsTrack(entry.path, 'extension') } : null,
      ].filter(Boolean) },
      { label: '파일 Stash', disabled: busy, action: () => actions.stashPaths([entry.path]) },
      '-');
    return items;
  },
  /** 히스토리·외부 프로그램·패치·편집·삭제 묶음. 지운 파일은 여는 항목을, 새 파일(untracked·added)은 히스토리·Blame 을 끈다. 원본 FileActionMenu.AppendCommonItems. */
  commonFileItems(entry, staged) {
    const exists = entry.state !== 'deleted';
    const hasHistory = entry.state !== 'untracked' && entry.state !== 'added';
    const fm = state.platform === 'windows' ? '파일 탐색기' : state.platform === 'linux' ? '파일 관리자' : 'Finder';
    return [
      { label: '파일 히스토리', disabled: !hasHistory || !tools.fileHistory, action: () => tools.fileHistory?.(entry.path) },
      { label: '파일 Blame', disabled: !hasHistory || !exists || !tools.blame, action: () => tools.blame?.(entry.path) },
      '-',
      { label: '외부 편집기로 열기', disabled: !exists, action: () => call('openInEditor', { path: entry.path, line: 1, editor: prefs.get('editor') ?? '' }).catch(showError) },
      { label: '기본 프로그램으로 열기', disabled: !exists, action: () => call('openDefault', { path: entry.path }).catch(showError) },
      { label: `${fm} 에서 보기`, disabled: !exists, action: () => call('reveal', { path: entry.path }).catch(showError) },
      '-',
      { label: '파일 경로 복사', action: () => navigator.clipboard?.writeText(entry.path) },
      { label: '파일 변경으로 패치 만들기', action: () => actions.createPatch([entry.path], staged) },
      '-',
      { label: '파일 편집', disabled: !exists || !tools.editFile, action: () => tools.editFile?.(entry.path) },
      { label: '파일 삭제', disabled: !exists || !!state.busy, action: () => actions.deleteFiles([entry.path]) },
    ];
  },
  /**
   * 폴더 우클릭(트리 보기). 원본 StagingLists.Populate*FolderMenu + FileActionMenu.AppendFolderItems + FileTree.PopulateFolderMenu:
   * git 동작이 맨 위, 보기 동작(모두 펼치기·접기·경로 복사)이 아래. view: {expandAll, collapseAll}.
   */
  folderMenu(event, folder, entries, mode, view = {}) {
    const busy = !!state.busy;
    const paths = entries.map((e) => e.path);
    const name = `${folder.path.replace(/\/$/, '')}/`;
    const fm = state.platform === 'windows' ? '파일 탐색기' : state.platform === 'linux' ? '파일 관리자' : 'Finder';
    const staged = mode === 'staged';
    showMenu(event.clientX, event.clientY, [
      staged ? { label: '폴더 Unstage', disabled: busy, action: () => actions.unstage(paths) } : { label: '폴더 Stage', disabled: busy, action: () => actions.stage(paths) },
      staged ? null : { label: '폴더의 모든 변경 버리기', disabled: busy, action: () => actions.discardMany(entries, 'unstaged') },
      staged ? null : { label: `'${name}' 안의 모든 파일 무시`, disabled: busy, action: () => actions.ignore(folder.path, 'folder') },
      staged ? null : { label: '폴더 Stash', disabled: busy, action: () => actions.stashPaths([folder.path]) },
      { label: '폴더 변경으로 패치 만들기', action: () => actions.createPatch(paths, staged) },
      '-',
      { label: `${fm} 에서 열기`, action: () => call('openFolder', { path: `${state.repo.path}/${folder.path}` }).catch(showError) },
      { label: '이 폴더에 파일 만들기', disabled: !tools.newFile, action: () => tools.newFile?.(folder.path) },
      '-',
      { label: '모두 펼치기', action: () => view.expandAll?.() },
      { label: '모두 접기', action: () => view.collapseAll?.() },
      { label: '경로 복사', action: () => navigator.clipboard?.writeText(folder.path) },
    ].filter(Boolean));
  },
  /** 커밋 상세 파일 우클릭. 원본 CommitFileMenu. extra.showInTree(path): 그 화면의 File Tree 로 가는 함수(Fork 탐색기). */
  commitFileMenu(event, detail, files, extra = null) {
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
      extra?.showInTree
        ? { label: 'File Tree 에서 보기', disabled: file.state === 'deleted', action: () => extra.showInTree(file.path) }
        : { label: 'File Tree 에서 보기', disabled: !tools.showInTree, action: () => tools.showInTree?.(detail.hash, file.path) },
      { label: '경로 복사', action: () => navigator.clipboard?.writeText(files.map((f) => f.path).join('\n')) },
    ]);
  },
  async markResolved(paths) {
    if (state.busy || !paths.length) return;
    const warn = await call('stageWarnings', { paths }).catch(() => ({ conflictMarkers: [] }));
    if (warn.conflictMarkers.length && !(await confirmDialog({ title: '모두 해결됨으로 표시', glyph: 'warning', danger: true, message: `다음 파일에는 아직 충돌 표시(<<<<<<< … >>>>>>>)가 남아 있습니다. 그대로 해결됨으로 표시할까요?\n\n${warn.conflictMarkers.join('\n')}`, ok: '모두 해결됨으로 표시' }))) return;
    await act('충돌 해결됨으로 표시하는 중…', () => call('stage', { paths }), { success: () => `${paths.length}개를 해결됨으로 표시했습니다.` });
  },
  /**
   * 변경 버리기. 되돌릴 수 없어 한 번 더 묻는다(원본 StagingLists.Discard).
   * side 'unstaged': 작업 트리 쪽만(Stage 한 내용은 남는다) · 'staged': Stage 한 것까지 마지막 커밋 상태로 · 'all': 둘 다(Unity VCS "변경 되돌리기").
   * 새 파일은 지운다. Fork 배치는 파일 목록 없이 짧게 묻는 경고창.
   */
  async discardMany(entries, side = 'all') {
    if (state.busy || !entries.length) return false;
    const list = entries.slice(0, 10).map((e) => e.path).join('\n') + (entries.length > 10 ? `\n… 외 ${entries.length - 10}개` : '');
    const fork = document.body.dataset.layout === 'fork';
    const dialog = fork
      ? { title: '선택한 파일의 변경을 모두 버릴까요?', message: side === 'unstaged' ? '커밋하지 않은 변경이 모두 사라집니다. 툴바의 Undo 로도 되살릴 수 없습니다.' : 'Stage 한 것을 포함해 커밋하지 않은 변경이 모두 사라집니다.', ok: '버리기' }
      : {
        title: entries.length > 1 ? `파일 ${entries.length}개 변경 버리기` : '변경 버리기',
        message: side === 'unstaged' ? `Stage 하지 않은 변경을 버립니다. 새 파일은 지웁니다.\n툴바의 Undo 로도 되살릴 수 없습니다.\n\n${list}` : `Stage 한 변경까지 마지막 커밋 상태로 되돌립니다(되돌릴 수 없음). 새 파일은 지웁니다.\n\n${list}`,
        ok: '되돌리기',
      };
    if (!(await confirmDialog({ ...dialog, glyph: 'undo', danger: true, alert: fork })) || state.busy) return false;
    if (entries.some((e) => state.diffKey?.endsWith(`:${e.path}`))) closeDiff();
    return (await act('되돌리는 중…', () => call('discard', { paths: entries.map((e) => e.path), worktreeOnly: side === 'unstaged' }).then(() => true))) === true;
  },
  async discardAll() {
    if (state.busy) return;
    const all =[...new Map([...state.status.unstaged, ...state.status.staged].map((e) => [e.path, e])).values()];
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
  /** Stage 전 확인: 충돌 표시가 남은 파일·안에 git 레포지토리가 있는 폴더(원본 StagingLists.Stage). 올려도 되면 true. */
  async confirmStage(paths) {
    const warn = await call('stageWarnings', { paths }).catch(() => ({ conflictMarkers: [], nestedRepos: [] }));
    const list = (xs) => xs.slice(0, 10).join('\n');
    if (warn.nestedRepos?.length && !(await confirmDialog({ title: '별도 git 레포지토리가 있는 폴더', glyph: 'warning', tone: 'warning', message: `다음 폴더는 안에 별도 git 레포지토리가 있습니다. 그대로 Stage 하면 파일이 아니라 그 레포지토리의 커밋을 가리키는 링크(gitlink)만 올라갑니다.\n\n${list(warn.nestedRepos)}`, ok: 'gitlink 로 같이 Stage' }))) return false;
    if (warn.conflictMarkers?.length && !(await confirmDialog({ title: '충돌 표시가 남아 있습니다', glyph: 'warning', danger: true, message: `아래 파일에 충돌 표시(<<<<<<< ======= >>>>>>>)가 남아 있습니다.\n올리면 git 은 충돌이 해결된 것으로 봅니다.\n\n${list(warn.conflictMarkers)}`, ok: '그대로 Stage' }))) return false;
    return !state.busy;
  },
  /** Stage. 바쁜 동안 누른 파일 하나는 무시한다 — 목록이 밀려 커서 밑에 온 다른 파일을 두 번째 클릭으로 올리지 않게. */
  async stage(paths) {
    if (state.busy || !paths.length) return;
    if (!(await actions.confirmStage(paths))) return;
    optimistic(paths, 'unstaged', 'staged');
    return act('Stage 하는 중…', () => call('stage', { paths }));
  },
  unstage(paths) {
    if (state.busy || !paths.length) return undefined;
    optimistic(paths, 'staged', 'unstaged');
    return act('Unstage 하는 중…', () => call('unstage', { paths }));
  },
  /** 모두 Stage: 전부를 같은 확인을 거쳐 올리고, 누르자마자 목록을 옮겨 보인다. */
  async stageAll() {
    if (state.busy) return;
    const paths = (state.status?.unstaged ?? []).map((e) => e.path);
    if (paths.length && !(await actions.confirmStage(paths))) return;
    optimistic(null, 'unstaged', 'staged');
    return act('모두 Stage 하는 중…', () => call('stageAll'));
  },
  unstageAll() {
    if (state.busy) return undefined;
    optimistic(null, 'staged', 'unstaged');
    return act('모두 Unstage 하는 중…', () => call('unstageAll'));
  },
  lastMessage: () => call('lastMessage').catch(() => ''),
  identity: () => state.repo?.identity ?? { name: '', email: '' },
  onSummary: (text) => graph.setWipSubject(text),
  avatarUrl: (email, hash) => avatars.url(email, hash),
  revealCommit: (hash) => revealCommit(hash),
  hasRemote: () => (state.refs?.remotes.length ?? 0) > 0,
  template: () => state.template,
  mergeMessage: () => state.mergeMessage,
  /** MERGE_MSG 의 "# Conflicts:" 경로(앱을 다시 열어도 "해결한 파일"·"변경 없음" 을 남긴다). */
  mergeConflicts: () => state.mergeConflicts ?? [],
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
  if (!state.status) return;
  // paths 가 null 이면 전부(모두 Stage·Unstage). 충돌 파일은 옮기지 않는다(원본 GitStaging.PredictStage).
  const moving = state.status[from].filter((e) => (!paths || paths.includes(e.path)) && e.state !== 'conflicted');
  if (!moving.length) return;
  const movedPaths = new Set(moving.map((e) => e.path));
  // 새 파일은 Stage 하면 "추가", 추가한 파일을 Unstage 하면 다시 "새 파일".
  const moved = moving.map((e) => (to === 'staged' && e.state === 'untracked' ? { ...e, state: 'added' } : to === 'unstaged' && e.state === 'added' ? { ...e, state: 'untracked' } : e));
  const status = { ...state.status, [from]: state.status[from].filter((e) => !movedPaths.has(e.path)), [to]: [...state.status[to].filter((e) => !movedPaths.has(e.path)), ...moved] };
  // 보이는 변경 목록(GitKraken 오른쪽 칸·Fork 왼쪽 목록)만 다시 그린다. Fork 는 커밋 상자를 오른쪽 아래 칸으로 다시 옮긴다.
  if (graph.selected === 'wip' && !$('detail').hidden) renderStaging($('detail'), status, state.draft, actions);
  for (const lists of document.querySelectorAll('.view-host:not([hidden]) .fork-lists')) {
    renderStaging(lists, status, state.draft, actions);
    const box = lists.querySelector('.commit-box');
    const host = lists.closest('.fork-layout')?.querySelector('.fork-commit');
    if (box && host) host.replaceChildren(box);
  }
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

/** 마지막 자동 페치의 실패 글(계정 문제면 도구 막대 Fetch 의 "!" 를 누를 때 계정 고르기에 보인다). */
let lastFetchError = null;

async function fetchNow() {
  toolbar.setFetch({ fetching: true });
  try {
    const ok = await act('페치하는 중…', () => call('fetch').then(() => true), { success: () => '페치했습니다.' });
    if (ok) {
      toolbar.setFetch({ error: null, auth: false });
      lastFetchError = null;
      github.load(true);
    }
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
// macOS 전체 화면에서는 신호등 버튼이 사라지므로 탭 막대 왼쪽 여백을 거둔다.
on('window', (data) => document.body.classList.toggle('fullscreen', !!data?.fullscreen));
on('fetching', () => toolbar.setFetch({ fetching: true }));
on('fetched', (result) => {
  const error = result.ok ? null : result.error;
  lastFetchError = error?.message ?? null;
  toolbar.setFetch({ fetching: false, error: error ? error.message : null, auth: !!(error && (error.auth || error.login)) });
  if (result.ok) github.load(true);
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
    { label: 'UI 크기', submenu: scaleItems(scale) },
    '-',
    { label: `레포지토리 폴더 — ${state.platform === 'windows' ? '탐색기' : 'Finder'}`, disabled: !state.repo, action: () => call('openFolder', { path: state.repo.path }).catch(showError) },
    { label: '레포지토리 폴더에서 터미널 열기', disabled: !state.repo, action: () => call('openTerminal').catch(showError) },
    '-',
    // 로그인하지 않고 쓰는 중이면 연결 화면으로 돌아가 로그인할 수 있게.
    github.signedIn === false ? { label: 'GitHub 로그인…', action: () => showConnect() } : null,
    state.repo ? { label: '이 레포지토리의 GitHub 계정…', action: () => github.chooseAccount() } : null,
    { label: '설정…', hint: '⌘ ,', action: () => openSettings() },
  ].filter(Boolean));
}

const layoutName = () => prefs.get('layout') ?? 'gitkraken';

/** 브랜치 탐색기 탭으로 옮겨 그 커밋을 고른다. */
function showInExplorer(hash) {
  closeDiff();
  closeMerge();
  views?.select('explorer');
  views?.reveal?.(hash);
}

function setLayout(key) {
  const changed = prefs.get('layout') !== key;
  prefs.set('layout', key);
  if (!changed) {
    document.body.dataset.layout = key;
    render();
    graph.redraw();
    return;
  }
  // 먼저 "다시 그리는 중" 을 덮어 보이고 다음 틀에 바꾼다(원본 GitWindow.Rebuild).
  const cover = el('div', { class: 'rebuilding', text: '다시 그리는 중…' });
  document.body.append(cover);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.body.dataset.layout = key;
    closeDiff();
    closeMerge();
    views?.relayout();
    render();
    graph.redraw();
    cover.remove();
  }));
}

/** UI 배율 메뉴(창 ⋮ 메뉴와 아래쪽 상태 줄이 같이 쓴다). */
function scaleItems(scale) {
  return [
    { label: '크게', hint: '⌘ =', action: () => setScale(uiScale() + 0.1) },
    { label: '작게', hint: '⌘ -', action: () => setScale(uiScale() - 0.1) },
    { label: `원래대로 — 지금 ${scale}%`, hint: '⌘ 0', action: () => setScale(1) },
  ];
}

/** 창 아래쪽 상태 줄: 왼쪽 풀 리퀘스트 수 | 오른쪽 UI 배율 · GitHub 계정 · 버전(원본 GitFooter). */
function renderFooter() {
  const footer = $('footer');
  if (!state.repo) return;
  const scale = Math.round(uiScale() * 100);
  const pulls = github.footer();
  footer.replaceChildren(
    el('button', {
      class: 'footer-btn', 'data-tip': pulls.tip,
      onclick: () => {
        // 접힌 사이드바를 펼치고 풀 리퀘스트 구역을 보인다.
        closeDiff();
        closeMerge();
        closeTool();
        sidebar.revealSection('prs');
      },
    }, icon('pullRequest', 14, 'footer-icon'), el('span', { class: 'footer-text', text: pulls.text })),
    el('span', { class: 'spacer' }),
    el('button', {
      class: 'footer-btn', 'data-tip': 'UI 크기',
      onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        showMenu(r.left, r.top - 4 - 30 * 3, scaleItems(scale));
      },
    }, icon('zoomIn', 14, 'footer-icon'), el('span', { class: 'footer-text', text: `${scale}%` })),
    el('button', { class: 'footer-btn', 'data-tip': '이 레포지토리의 GitHub 계정…', onclick: () => github.chooseAccount() },
      icon('github', 14, 'footer-icon'), el('span', { class: 'footer-text', text: github.account ?? 'GitHub' })),
    el('span', { class: 'footer-version', 'data-tip': 'GitVcs', text: state.version }));
}

/** 원본 RefTreeBuilder.Sections 순서. 레일 아이콘도 이 순서다. */
const RAIL_SECTIONS = [
  ['local', 'laptop', '로컬'], ['remote', 'cloud', '리모트'], ['worktrees', 'worktree', '워크트리'], ['stash', 'stash', '스태시'],
  ['prs', 'pullRequest', '풀 리퀘스트'], ['submodules', 'submodule', '서브모듈'], ['tags', 'tag', '태그'],
];
const MAIN_TAB = { gitkraken: ['hierarchy', '그래프'], fork: ['pencil', '로컬 변경'], unity: ['pencil', '대기 중인 변경사항'] };

/**
 * diff·병합 편집기·도구 화면을 열면 사이드바가 아이콘 레일로 접힌다(원본 SidebarRail):
 * [펼치기] · 보기 탭 4개(고른 탭 강조, 변경 수) · 구역 아이콘과 개수. 탭을 누르면 펼치고 그 탭으로, 구역을 누르면 펼치고 그 구역으로.
 */
function renderRail() {
  const folded = (diffView.isOpen && (views?.usesGraph ?? true)) || mergeView.isOpen || toolOpen();
  $('rail').hidden = !folded;
  $('sidebar').hidden = folded;
  document.querySelector('.splitter[data-split="sidebar"]').hidden = folded;
  if (!folded) return;
  const refs = state.refs ?? { local: [], remote: [], tags: [], stashes: [] };
  const restore = async () => {
    if (toolOpen() && (await closeTool()) === false) return false;
    closeDiff();
    closeMerge();
    return true;
  };
  const item = (glyph, label, badge, onclick, selected = false) => el('button', { class: `rail-item${selected ? ' selected' : ''}`, 'data-tip': label, onclick },
    icon(glyph, 18, 'rail-icon'), badge ? el('span', { class: 'rail-badge', text: badge > 99 ? '99+' : String(badge) }) : null);
  const changes = new Set([...(state.status?.staged ?? []), ...(state.status?.unstaged ?? [])].map((e) => e.path)).size;
  const [mainGlyph, mainLabel] = MAIN_TAB[layoutName()] ?? MAIN_TAB.gitkraken;
  const tabs = [['main', mainGlyph, mainLabel, changes], ['explorer', 'branch', '브랜치 탐색기', 0], ['workspace', 'folder', '워크스페이스', 0], ['changesets', 'history', '체인지 세트', 0]];
  const counts = {
    local: refs.local.length, remote: refs.remote.length, worktrees: state.worktrees?.filter((w) => !w.bare).length ?? 0, stash: refs.stashes.length,
    prs: github.count, submodules: state.submodules?.length ?? 0, tags: refs.tags.length,
  };
  const hasGithub = (state.remotes ?? []).some((r) => /github\.com/i.test(r.fetchUrl ?? ''));
  $('rail').replaceChildren(
    item('expand', '왼쪽 패널 펼치기', 0, restore),
    el('div', { class: 'rail-group' }, tabs.map(([key, glyph, label, badge]) => item(glyph, label, badge, async () => { if (await restore()) views?.select(key); }, (views?.tab ?? 'main') === key))),
    el('div', { class: 'rail-group' }, RAIL_SECTIONS.filter(([id]) => id !== 'prs' || hasGithub).map(([id, glyph, label]) => item(glyph, label, counts[id], async () => {
      if (await restore()) sidebar.revealSection(id);
    }))));
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

/**
 * 처음 읽는 동안 사이드바·그래프·파일 칸을 같은 모양의 회색 막대로 덮는다(원본 GitSkeleton). 칸의 지금 위치·폭(저장한 폭·배치)을 따라
 * 덮고, 밝은 띠가 위에서 아래로 지나간다. 한 번 보이면 깜빡이지 않게 60ms 는 남긴다.
 */
let skeletonShownAt = 0;
function showSkeleton(on) {
  const sk = $('skeleton');
  if (!on) {
    const left = Math.max(0, 60 - (performance.now() - skeletonShownAt));
    setTimeout(() => {
      sk.hidden = true;
      sk.replaceChildren();
    }, sk.hidden ? 0 : left);
    return;
  }
  const base = $('workspace').getBoundingClientRect();
  const bar = (width, cls = '') => el('div', { class: `sk-bar${cls}`, style: { width: typeof width === 'number' ? `${width}px` : width } });
  const cover = (node, kind) => {
    const r = node?.getBoundingClientRect();
    if (!r || !r.width || !r.height || node.hidden || node.classList.contains('view-hidden')) return null;
    const rows = Math.ceil(r.height / (kind === 'commits' ? 34 : 24));
    return el('div', { class: `sk-cover sk-${kind}`, style: { left: `${r.left - base.left}px`, top: `${r.top - base.top}px`, width: `${r.width}px`, height: `${r.height}px` } },
      Array.from({ length: rows }, (_, i) => (kind === 'commits'
        ? el('div', { class: 'sk-row' }, el('div', { class: 'sk-dot' }), bar(`${[46, 62, 38, 55, 70][i % 5]}%`))
        : el('div', { class: 'sk-row' }, bar(14, ' sk-lead'), bar(`${[58, 74, 46, 66][i % 4]}%`), bar(28, ' sk-meta')))));
  };
  sk.replaceChildren(...[cover($('sidebar'), 'files'), cover(document.querySelector('.graph-pane:not([hidden])') ?? document.querySelector('.view-host:not([hidden])'), 'commits'), cover($('detail'), 'files')].filter(Boolean));
  skeletonShownAt = performance.now();
  sk.hidden = false;
}

// ── 키보드 ────────────────────────────────────────────

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

// ── 메뉴 막대(운영체제 메뉴)·단축키 ─────────────────────
//
// 메뉴 항목 id 하나에 명령 하나. 메뉴 막대를 누르면 Rust 가 window.__gitvcs.menu(id) 로 부르고(bridge.onMenu),
// 키는 macOS 면 메뉴 막대가 받아 같은 길로 오고, Windows·리눅스는 아래 keydown 이 같은 id 로 부른다 — 한 키에 한 길.
// keys: KeyboardEvent.code 기준('mod' = macOS ⌘ / 그 밖 Ctrl). macKeys 는 macOS 에서 보이는 키가 다를 때(전체 화면).
// repo: 레포지토리가 열려 있고 작업 중이 아닐 때만. on(): 그 밖의 켜짐 조건. always: 카드(모달)가 떠 있어도 받는다.

const isMac = () => state.platform === 'macos';
const modalOpen = () => !!document.querySelector('.modal-backdrop');
/** 글을 쓰는 칸에 포커스가 있는가(체크박스·버튼은 아니다). */
function textFocused() {
  const node = document.activeElement;
  if (node instanceof HTMLTextAreaElement || node?.isContentEditable) return true;
  return node instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(node.type);
}
const repoReady = () => !!state.repo && !state.busy && !$('main').hidden;
/** 도구 막대 버튼이 켜져 있는가 — 메뉴도 도구 막대와 같은 때에만 동작한다(원격 없음·진행 중인 병합 등). */
const toolbarOn = (id) => { const button = $(id); return !!button && !button.disabled; };
const clickToolbar = (id) => () => $(id)?.click();

const MENU = {
  settings: { label: '설정', keys: 'mod+Comma', run: () => openSettings() },
  newTab: { label: '새 탭', keys: 'mod+KeyT', on: () => !!state.repo, run: () => newTab() },
  closeTab: { label: '탭 닫기', keys: 'mod+KeyW', on: () => !!state.repo, run: () => closeTab(state.repo.path) },
  reopenTab: { label: '닫은 탭 다시 열기', keys: 'mod+shift+KeyT', on: () => closedTabs.length > 0, run: () => reopenTab() },
  clone: { label: '레포지토리 복제', keys: 'mod+KeyN', run: () => startClone() },
  initRepo: { label: '레포지토리 만들기', keys: 'mod+KeyI', run: () => createRepo() },
  openRepo: { label: '레포지토리 열기', keys: 'mod+KeyO', run: () => pickRepo() },
  terminal: { label: '터미널에서 열기', keys: 'alt+KeyT', on: () => !!state.repo, run: () => call('openTerminal').catch(showError) },
  reveal: { label: () => (state.platform === 'windows' ? '탐색기에서 보기' : 'Finder 에서 보기'), keys: 'alt+KeyO', on: () => !!state.repo, run: () => call('openFolder', { path: state.repo.path }).catch(showError) },
  githubLogout: { label: 'GitHub 로그아웃', on: () => github.signedIn === true, run: () => githubLogout() },
  undo: { label: '실행 취소 (글 칸 밖에서는 git 작업)', keys: 'mod+KeyZ', always: true, run: () => editOrGit('undo') },
  redo: { label: '다시 실행', keys: 'mod+shift+KeyZ', always: true, run: () => editOrGit('redo') },
  find: { label: '찾기', keys: 'mod+KeyF', on: () => !!state.repo, run: () => find() },
  zoomIn: { label: '확대', keys: ['mod+Equal', 'mod+shift+Equal', 'mod+NumpadAdd'], always: true, run: () => setScale(uiScale() + 0.1) },
  zoomOut: { label: '축소', keys: ['mod+Minus', 'mod+NumpadSubtract'], always: true, run: () => setScale(uiScale() - 0.1) },
  zoomReset: { label: '실제 크기', keys: ['mod+Digit0', 'mod+Numpad0'], always: true, run: () => setScale(1) },
  refresh: { label: '새로 고침', keys: 'mod+KeyR', on: () => !!state.repo, run: () => refresh() },
  // macOS 는 운영체제 기본 항목(⌃⌘F)이 처리하고, Windows 메뉴 항목은 Rust 가 바로 처리한다. 여기는 Windows·리눅스의 F11 키.
  fullscreen: { label: '전체 화면', keys: 'F11', macKeys: 'ctrl+mod+KeyF', always: true, run: () => call('toggleFullscreen').catch(() => {}) },
  commit: { label: '커밋 (커밋 칸으로, 칸에 있으면 커밋)', keys: 'mod+shift+KeyC', repo: true, run: () => commitFromMenu() },
  fetch: { label: 'Fetch', keys: 'mod+shift+KeyF', repo: true, on: () => toolbarOn('act-fetch'), run: clickToolbar('act-fetch') },
  pull: { label: 'Pull', keys: 'mod+shift+KeyL', repo: true, on: () => toolbarOn('act-pull'), run: clickToolbar('act-pull') },
  push: { label: 'Push', keys: 'mod+shift+KeyP', repo: true, on: () => toolbarOn('act-push'), run: clickToolbar('act-push') },
  stash: { label: 'Stash 저장', keys: 'mod+shift+KeyH', repo: true, on: () => toolbarOn('act-stash'), run: clickToolbar('act-stash') },
  pop: { label: 'Stash 꺼내기 (Pop)', repo: true, on: () => toolbarOn('act-pop'), run: clickToolbar('act-pop') },
  switchBranch: { label: '브랜치 전환', keys: 'mod+KeyB', repo: true, on: () => !!state.status, run: () => toolbar.openBranchPicker() },
  newBranch: { label: '새 브랜치', keys: 'mod+shift+KeyB', repo: true, on: () => toolbarOn('act-branch'), run: clickToolbar('act-branch') },
  newTag: { label: '새 태그', keys: 'mod+shift+KeyG', repo: true, on: () => !!state.history?.head, run: () => refsUi.createTag(state.history.head, 'HEAD') },
  newWorktree: { label: '새 워크트리', repo: true, run: () => refsUi.addWorktree() },
  shortcuts: { label: '키보드 단축키 보기', run: () => showShortcuts() },
};

/** 메뉴 항목 하나를 실행한다. 카드가 떠 있거나 연결 화면이면 크기·편집 말고는 무시한다(카드 뒤 화면을 바꾸지 않게). */
function runMenu(id) {
  const cmd = MENU[id];
  if (!cmd) return;
  if (!cmd.always && (modalOpen() || !$('connect').hidden)) return;
  if (cmd.repo && !repoReady()) return;
  if (cmd.on && !cmd.on()) return;
  cmd.run();
}
onMenu(runMenu);

let menuSent = '';
/** 메뉴 막대 항목의 켜짐을 Rust 에 알린다(바뀌었을 때만). */
function syncMenu() {
  const items = {};
  for (const [id, cmd] of Object.entries(MENU)) {
    if (cmd.repo || cmd.on) items[id] = (!cmd.repo || repoReady()) && (!cmd.on || !!cmd.on());
  }
  const text = JSON.stringify(items);
  if (text === menuSent) return;
  menuSent = text;
  call('menuState', { items }).catch(() => {});
}

/** 실행 취소·다시 실행: 글 칸이면 그 칸의 글 편집을, 아니면 git 작업(도구 막대 Undo·Redo)을 되돌린다. */
function editOrGit(which) {
  if (textFocused()) {
    document.execCommand(which);
    return;
  }
  if (!modalOpen() && repoReady()) undoRedo(which);
}

/**
 * 찾기: 목록 안의 찾기 칸(Fork 변경 목록·탐색기 목록 — 그 칸들은 ⌘/Ctrl+F keydown 을 받는다)이 먼저 받게 포커스 자리에 키를 한 번 보내고,
 * 아무도 받지 않으면 Fork 변경 목록 찾기 또는 커밋 찾기.
 */
function find() {
  const focused = document.activeElement;
  if (focused && focused !== document.body) {
    const probe = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', metaKey: isMac(), ctrlKey: !isMac(), bubbles: true, cancelable: true });
    if (!focused.dispatchEvent(probe)) return;
  }
  // 변경 목록 찾기는 Fork 배치에만 있다(원본 StagingLists). 그 밖에는 커밋 찾기.
  const forkLists = layoutName() === 'fork' && (views?.tab ?? 'main') === 'main' ? document.querySelector('.view-host:not([hidden]) .fork-lists') : null;
  if (!openStagingFilter(forkLists)) graphSearch.open();
}

/**
 * stash 를 Apply·Pop 하면 그 변경이 Unstaged 로 돌아온다. 어느 배치든(브랜치 탐색기에 있었어도) 작업 변경 화면으로 옮기고,
 * 커밋 제목이 비어 있으면(또는 앞서 stash 로 채운 그대로면) 그 stash 메시지("WIP on x: " 를 뗀 것)를 적는다 — 쓰던 제목은 덮지 않는다.
 */
async function showAppliedStash(stash) {
  const subject = stashLabel(stash.message ?? '').trim();
  const draft = state.draft;
  if (subject && !draft.amend && (!draft.summary.trim() || draft.summary === draft.stashSubject)) {
    draft.summary = subject;
    draft.stashSubject = subject;
    // GitKraken 배치는 그래프 맨 위 작업 중 줄의 제목 칸도 같은 글이다.
    graph.setWipSubject(subject);
  }
  if (toolOpen() && (await closeTool()) === false) return;
  closeDiff();
  closeMerge();
  views?.select('main');
  if (layoutName() === 'gitkraken') {
    wipShown = true;
    if (graph.hasWip) graph.select('wip');
    else {
      graph.select(null, false);
      showDetail(null, false);
    }
  }
  render();
}

/** 커밋: 커밋 칸에 있으면 커밋한다(⌘/Ctrl+Enter 와 같다). 아니면 변경 목록을 보이고 커밋 제목 칸으로 간다. */
async function commitFromMenu() {
  const shown = (node) => !!node && node.offsetParent !== null;
  const active = document.activeElement;
  if (shown(active) && (active.id === 'commit-summary' || active.id === 'commit-description')) {
    const button = active.closest('.commit-box')?.querySelector('#commit-button');
    if (button && !button.disabled) button.click();
    return;
  }
  if (toolOpen() && (await closeTool()) === false) return;
  closeDiff();
  closeMerge();
  views?.select('main');
  if (layoutName() === 'gitkraken') {
    wipShown = true;
    if (graph.hasWip) graph.select('wip');
    else {
      graph.select(null, false);
      showDetail(null, false);
    }
  }
  requestAnimationFrame(() => {
    const field = [...document.querySelectorAll('#commit-summary')].find(shown);
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  });
}

async function githubLogout() {
  const ok = await confirmDialog({
    title: 'GitHub 로그아웃', glyph: 'github',
    message: '이 앱에 로그인한 GitHub 계정에서 로그아웃합니다. 저장해 둔 토큰을 지웁니다.\n다른 곳(gh·자격 증명 저장소)에 있는 계정은 그대로 둡니다.',
    ok: '로그아웃',
  });
  if (!ok) return;
  try {
    await call('githubLogout');
  } catch (error) {
    showError(error);
    return;
  }
  await github.refreshSignedIn();
  github.reset();
  if (state.repo) github.load(true);
  renderFooter();
  syncMenu();
  toast('GitHub 에서 로그아웃했습니다.', 'success');
}

// ── 단축키 ──

/** 'mod+shift+KeyT' → {code, mod, shift, alt, ctrl}. */
function parseKey(spec) {
  const parts = spec.split('+');
  return { code: parts.pop(), mod: parts.includes('mod'), shift: parts.includes('shift'), alt: parts.includes('alt'), ctrl: parts.includes('ctrl') };
}

const keySpecs = (cmd) => [cmd.keys ?? []].flat();

/** 이 keydown 이 어느 메뉴 항목의 키인가. */
function menuKeyOf(event) {
  const mod = event.metaKey || event.ctrlKey;
  for (const [id, cmd] of Object.entries(MENU)) {
    for (const spec of keySpecs(cmd)) {
      const k = parseKey(spec);
      if (k.code === event.code && k.mod === mod && k.shift === event.shiftKey && k.alt === event.altKey) return id;
    }
  }
  return null;
}

const KEY_TEXT = { Comma: ',', Equal: '=', Minus: '-', Slash: '/', Enter: 'Enter', Escape: 'Esc' };
/** 단축키를 그 운영체제 모양으로: macOS ⌃⌥⇧⌘T, 그 밖 Ctrl+Shift+Alt+T. */
function keyText(spec) {
  const k = parseKey(spec);
  const key = KEY_TEXT[k.code] ?? k.code.replace(/^Key|^Digit/, '');
  if (isMac()) return `${k.ctrl ? '⌃' : ''}${k.alt ? '⌥' : ''}${k.shift ? '⇧' : ''}${k.mod ? '⌘' : ''}${key}`;
  return [k.mod || k.ctrl ? 'Ctrl' : '', k.shift ? 'Shift' : '', k.alt ? 'Alt' : '', key].filter(Boolean).join('+');
}

const SHORTCUT_GROUPS = [
  ['파일', ['newTab', 'closeTab', 'reopenTab', 'clone', 'initRepo', 'openRepo', 'terminal', 'reveal', 'settings']],
  ['편집', ['undo', 'redo', 'find']],
  ['보기', ['zoomIn', 'zoomOut', 'zoomReset', 'refresh', 'fullscreen']],
  ['레포지토리', ['commit', 'fetch', 'pull', 'push', 'stash', 'switchBranch', 'newBranch', 'newTag']],
];

/** 도움말 > 키보드 단축키: 메뉴 단축키와 화면 안의 키를 한 카드에. */
function showShortcuts() {
  const row = (label, keys) => el('div', { class: 'shortcut-row' }, el('span', { class: 'shortcut-label', text: label }), el('kbd', { class: 'shortcut-key', text: keys }));
  const groups = SHORTCUT_GROUPS.map(([title, ids]) => el('div', { class: 'shortcut-group' },
    el('div', { class: 'shortcut-title', text: title }),
    ids.map((id) => {
      const cmd = MENU[id];
      const spec = (isMac() && cmd.macKeys) || keySpecs(cmd)[0];
      return row(typeof cmd.label === 'function' ? cmd.label() : cmd.label, keyText(spec));
    })));
  const mod = isMac() ? '⌘' : 'Ctrl+';
  groups.push(el('div', { class: 'shortcut-group' },
    el('div', { class: 'shortcut-title', text: '화면 안' }),
    row('새로 고침', 'F5'),
    row('커밋 (커밋 칸에서)', `${mod}Enter`),
    row('diff·병합·도구 화면 닫기', 'Esc'),
    row('UI 크기', `${mod}휠`),
    isMac() ? row('최소화', '⌘M') : null));
  formDialog({ title: '키보드 단축키', glyph: 'info', fields: [], ok: '닫기', cancel: null, className: 'shortcuts-card', extra: el('div', { class: 'shortcut-list' }, groups) });
}

window.addEventListener('keydown', (event) => {
  // 찾기가 보낸 시험 키(isTrusted=false)는 목록 칸만 받는다.
  if (!event.isTrusted || isComposing(event)) return;
  if (event.key === 'Escape' && (diffView.isOpen || mergeView.isOpen || toolOpen()) && !document.querySelector('.modal-backdrop, .menu, .drawer')) {
    // 도구 화면은 닫기 전에 편집 중이면 저장할지 묻는다(취소하면 남는다).
    if (toolOpen()) {
      closeTool();
      return;
    }
    closeDiff();
    closeMerge();
    return;
  }
  if (event.key === 'F5') {
    event.preventDefault();
    refresh();
    return;
  }
  const id = menuKeyOf(event);
  if (!id) return;
  // macOS 는 메뉴 막대가 이 키를 받아 같은 명령을 부른다. 여기서도 부르면 두 번 된다(막지도 않는다 — 막으면 메뉴로 안 간다).
  if (isMac()) return;
  // 글 칸의 실행 취소·다시 실행은 웹뷰 기본 동작에 맡긴다.
  if ((id === 'undo' || id === 'redo') && textFocused()) return;
  event.preventDefault();
  runMenu(id);
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
    notify: (text) => toast(text, 'info'),
    revealCommit: (hash) => revealCommit(hash),
    compare: (a, b, opts) => toolsUi.compare(a, b, opts),
    fileHistory: (path) => toolsUi.fileHistory(path),
    blame: (path, revision) => toolsUi.blame(path, revision),
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
    const [init, account] = await Promise.all([call('init'), github.refreshSignedIn()]);
    state.settings = init.settings;
    state.platform = init.platform;
    state.version = init.version;
    document.documentElement.dataset.platform = init.platform;
    if (init.platform === 'macos') bindTitlebar($('tabs'), call);
    document.body.dataset.layout = prefs.get('layout') ?? 'gitkraken';
    for (const name of ['sidebar', 'detail']) applySplit(name, prefs.get(`split.${name}`) ?? SPLIT_DEFAULT[name]);
    if (uiScale() !== 1) call('setZoom', { scale: uiScale() });
    document.documentElement.style.setProperty('--base-size', `${prefs.get('ui.fontSize') ?? 13}px`);
    applyTheme(init.settings.theme);
    createViewsOnce();
    const proceed = async () => {
      if (init.repo) await enterRepo(init.repo);
      else showStart();
    };
    // GitHub 에 로그인하지 않았으면 본체 대신 연결 화면부터(원본 GitWindow.NeedsGitHubConnect).
    if (account && !account.signedIn && !connectSkipped) showConnect(proceed);
    else await proceed();
  } catch (error) {
    showError(error);
    showStart();
  } finally {
    // 첫 화면을 다 그렸다 — 켜는 동안의 스켈레톤(boot.js)을 걷어 낸다.
    window.__bootDone?.();
  }
})();
