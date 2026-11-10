// 오른쪽 패널. WIP 를 고르면 스테이징(Unstaged·Staged 목록)과 커밋 상자, 커밋을 고르면 그 커밋의 정보와 바뀐 파일.
// 원본 Elements/StagingLists·CommitBox·OperationActions·GraphCommitDetail 과 Views/GraphWorkspaceView 의 작업 패널 머리 줄을 옮겼다.

import { el, formatDate, initials, isComposing, autoHorizontalScroll } from './util.js';
import { icon } from './icons.js';
import { fileList, viewSwitch, selectedEntries, selectionPaths, stateIcon, CHANGE_STATE } from './files.js';
import { hiddenKey, isHidden, isAllHidden, hidePaths, showPath, soloRules } from './hidden.js';
import { authorRgb } from './graph.js';

/** diff 를 연 파일을 알아보는 키. */
export const diffKey = (mode, path) => `${mode}:${path}`;

// 그리기 사이에 남는 것: 고른 파일·폴더, 찾기 글, 숨긴 줄을 흐리게 보이는 중인지, 이번 충돌에서 충돌로 보인 경로, 바쁜 동안 누른 "모두 Stage/Unstage".
const ui = {
  unstaged: { selected: new Set(), folders: new Set(), anchor: null },
  staged: { selected: new Set(), folders: new Set(), anchor: null },
  commit: { selected: new Set(), folders: new Set(), anchor: null },
  filter: '',
  filterOpen: false,
  filterOpening: false,
  showHidden: false,
  conflictSeen: new Set(),
  queued: null,
};

const rgb = (c) => `rgb(${c.map(Math.round).join(',')})`;
const isBusy = () => document.body.classList.contains('git-busy');

/** '#' 으로 시작하는 줄(템플릿 안내)을 뺀다. 템플릿이 있을 때만 쓴다(원본 CommitBox — git 의 -F 는 '#' 줄을 남긴다). */
export function stripComments(text) {
  return text.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
}

/** 제목(첫 줄)과 설명(빈 줄 뒤)으로 나눈다. 예: "Fix: a\n\nbody" → ["Fix: a", "body"](원본 CommitBox.SplitMessage). */
function splitMessage(message) {
  const text = (message ?? '').replace(/\r\n/g, '\n').trim();
  const newline = text.indexOf('\n');
  return newline < 0 ? [text, ''] : [text.slice(0, newline).trim(), text.slice(newline + 1).trim()];
}

/** 제목과 설명을 git 커밋 메시지 형식(제목, 빈 줄, 본문)으로 합친다. */
const joinMessage = (subject, description) => {
  const head = subject.trim();
  const body = description.trim();
  return body ? `${head}\n\n${body}` : head;
};

// Shift 를 누르는 동안 Fork 배치 머리 버튼이 "… All" 이 된다. 키는 창 어디에 포커스가 있든, 다른 창에서 손을 뗀 경우는 마우스가 움직일 때 맞춘다.
const setShift = (held) => document.body.classList.toggle('shift-held', held);
for (const type of ['keydown', 'keyup']) window.addEventListener(type, (event) => setShift(event.shiftKey));
window.addEventListener('pointermove', (event) => setShift(event.shiftKey));
window.addEventListener('blur', () => setShift(false));

// 바쁜 동안 누른 "모두 Stage/Unstage" 는 앞 작업이 끝나면(body 의 git-busy 가 빠지면) 이어서 한다(원본 StagingLists.RunQueuedBulk).
new MutationObserver(() => {
  if (!ui.queued || isBusy()) return;
  const queued = ui.queued;
  ui.queued = null;
  queued();
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

/** 패키지 목록 충돌은 먼저 풀어야 해서 맨 위로(원본 GitConflictSafety.ManifestFirst). */
const manifestFirst = (entries) => [...entries].sort((a, b) => Number(b.path.endsWith('Packages/manifest.json')) - Number(a.path.endsWith('Packages/manifest.json')));

/**
 * 패널을 다시 그려도 파일 목록의 스크롤·포커스가 그대로 남게 한다. 파일을 눌러 diff 를 열거나 감시가 새로 읽을 때
 * 패널을 통째로 다시 그리는데, 그대로 두면 목록이 맨 위로 돌아가고 화살표 키도 먹지 않는다.
 */
function keepListState(container, redraw) {
  const lists = [...container.querySelectorAll('.file-list')];
  const tops = lists.map((n) => n.scrollTop);
  const focused = lists.indexOf(document.activeElement);
  redraw();
  const next = [...container.querySelectorAll('.file-list')];
  next.forEach((n, i) => {
    if (tops[i]) n.scrollTop = tops[i];
  });
  if (focused >= 0) next[focused]?.focus({ preventScroll: true });
}

/** Fork·GitKraken 의 머리 줄 버튼. */
function headerButton(kind, { fork, picked, total, onAll, onSome }) {
  const verb = kind === 'stage' ? 'Stage' : 'Unstage';
  const cls = `staging-btn ${kind}`;
  if (fork) {
    // Fork 배치: 무채색 "Stage"/"Unstage" 는 고른 것만(고른 게 없으면 꺼짐), Shift 를 누르는 동안 "… All" 로 전부.
    return el('button', {
      class: `${cls} fork-head${picked ? '' : ' no-pick'}${total ? '' : ' empty'}`,
      onclick: (event) => (event.shiftKey ? onAll() : picked ? onSome() : null),
    }, el('span', { class: 'lbl-normal', text: verb }), el('span', { class: 'lbl-shift', text: `${verb} All` }));
  }
  // GitKraken 배치: 고른 게 없으면 "모두 …", 하나면 "…", 여럿이면 "파일 n개 …".
  const label = picked === 0 ? `모두 ${verb}` : picked === 1 ? verb : `파일 ${picked}개 ${verb}`;
  return el('button', { class: cls, disabled: total === 0, text: label, onclick: () => (picked ? onSome() : onAll()) });
}

/** 칸 사이 경계를 끌어 Staged 칸 높이를 바꾼다(원본 TwoPaneSplitView, Staged 첫 높이 200px). */
function splitter(host, api) {
  const bar = el('div', { class: 'stage-split' });
  bar.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    bar.setPointerCapture(event.pointerId);
    const staged = host.querySelector('.stage-section.staged');
    const move = (e) => {
      const rect = host.getBoundingClientRect();
      const height = Math.max(60, Math.min(rect.height - 60, rect.bottom - e.clientY));
      staged.style.height = `${height}px`;
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      api.prefs.set('staging.stagedHeight', Math.round(staged.getBoundingClientRect().height));
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  });
  bar.addEventListener('dblclick', () => {
    host.querySelector('.stage-section.staged').style.height = '200px';
    api.prefs.set('staging.stagedHeight', 200);
  });
  return bar;
}

/**
 * 스테이징 화면. `api` 는 app.js 가 주는 작업 함수들.
 * GitKraken 배치(#detail): 머리 줄(휴지통 · 가운데 "{브랜치} 의 변경 n개", 병합 중이면 "병합 충돌" + "[들어오는] → [지금] 병합 중") → 경로/트리 줄 → 목록 → 커밋 상자.
 * Fork 배치(.fork-lists): 경로/트리 줄(왼쪽 돋보기 = 파일 찾기) → 목록. 커밋 상자는 Fork 화면이 오른쪽 아래로 옮긴다.
 */
export function renderStaging(container, status, draft, api) {
  const forkLists = container.classList.contains('fork-lists');
  const fork = forkLists || document.body.dataset.layout === 'fork';
  const view = api.prefs.get('staging.view') ?? 'path';
  const collapsed = new Set(api.prefs.get('staging.collapsed') ?? []);
  const rerender = () => renderStaging(container, status, draft, api);
  container.stagingRerender = rerender;
  const setCollapsed = (paths) => {
    api.prefs.set('staging.collapsed', [...paths]);
    rerender();
  };
  const toggleFolder = (path) => {
    if (collapsed.has(path)) collapsed.delete(path);
    else collapsed.add(path);
    setCollapsed(collapsed);
  };
  // 파일 찾기는 Fork 배치에만 있다(원본 StagingLists.ShiftForAll).
  if (!fork) {
    ui.filterOpen = false;
    ui.filter = '';
  }
  const q = ui.filter.trim().toLowerCase();
  const filtering = q.length > 0;
  const matches = (e) => !q || e.path.toLowerCase().includes(q);
  const operation = status.operation;

  // ── 충돌 구역(원본 StagingLists.ShowConflicts): 충돌이 남았거나, 충돌로 멈춘 작업이 끝나지 않았으면 Unstaged 자리가 "충돌 파일", Staged 자리가 "해결한 파일".
  const conflicts = manifestFirst(status.unstaged.filter((e) => e.state === 'conflicted'));
  if (!conflicts.length && !operation) ui.conflictSeen.clear();
  else if (!ui.conflictSeen.size) for (const path of api.mergeConflicts?.() ?? []) ui.conflictSeen.add(path);
  for (const e of conflicts) ui.conflictSeen.add(e.path);
  const conflictMode = conflicts.length > 0 || (!!operation && ui.conflictSeen.size > 0);
  const unstagedAll = status.unstaged.filter((e) => e.state !== 'conflicted');

  // ── 숨기기: Unstaged 목록에서 보기에서만 감춘다(git 은 그대로). 규칙은 레포지토리(워크트리)마다 설정에 남는다.
  // Staged 는 커밋될 내용이라 늘 다 보이고, 충돌 중에는 숨기지 않는다. "모두 Stage"·"모든 변경 버리기" 는 숨긴 파일을 건드리지 않는다.
  const hiddenPref = hiddenKey(api.repoPath?.() ?? '');
  const rules = conflictMode ? [] : api.prefs.get(hiddenPref) ?? [];
  const ruleSet = new Set(rules);
  const hiddenAll = ruleSet.size ? unstagedAll.filter((e) => isHidden(e.path, ruleSet)) : [];
  const visibleAll = hiddenAll.length ? unstagedAll.filter((e) => !isHidden(e.path, ruleSet)) : unstagedAll;
  if (!hiddenAll.length) ui.showHidden = false;
  const setRules = (next) => {
    api.prefs.set(hiddenPref, next.length ? next : null);
    rerender();
  };
  const rowHidden = (path) => isAllHidden(path, ruleSet, unstagedAll);
  /** 숨기거나 다시 보인다(모두 숨긴 것이면 다시 보이기). solo: 이것만 남기고 나머지를 숨긴다. */
  const toggleHidden = (paths, { solo = false } = {}) => {
    if (!paths.length) return;
    if (solo) setRules(soloRules(rules, unstagedAll, paths));
    else if (paths.every(rowHidden)) setRules(paths.reduce((acc, path) => showPath(acc, path, unstagedAll), rules));
    else setRules(hidePaths(rules, paths));
  };
  // 숨긴 줄은 "숨김 n" 을 눌러 흐리게 보이는 동안에만 목록에 있다.
  const eye = conflictMode ? null : { isHidden: ui.showHidden ? rowHidden : () => false, toggle: toggleHidden };
  /** 우클릭 메뉴가 쓸 숨기기 동작: 고른 줄 전부에(없으면 누른 줄). */
  const eyeOps = (fallback) => {
    if (!eye) return null;
    const picked = selectionPaths(ui.unstaged);
    const paths = picked.length ? picked : fallback;
    return { hidden: paths.every(rowHidden), toggle: () => toggleHidden(paths), solo: () => toggleHidden(paths, { solo: true }) };
  };
  // 머리 버튼("모두 Stage")이 옮길 것: 숨기지 않았고 찾기에 걸린 파일.
  const stageable = visibleAll.filter(matches);
  const unstaged = conflictMode ? [...conflicts, ...unstagedAll.filter(matches)] : ui.showHidden ? unstagedAll.filter(matches) : stageable;
  // 이번에 풀었지만 바뀐 것이 없는 파일은 "해결한 파일" 에 "변경 없음" 으로 남긴다(푼 파일이 사라진 것처럼 보이지 않게).
  const known = new Set([...status.unstaged, ...status.staged].map((e) => e.path));
  const unchanged = conflictMode ? [...ui.conflictSeen].filter((p) => !known.has(p)).sort().map((path) => ({ path, state: 'modified', note: '변경 없음', unchanged: true })) : [];
  const staged = [...status.staged, ...unchanged].filter(matches);

  const common = (mode, st) => ({
    view, state: st, collapsed, onToggleFolder: toggleFolder, onSetCollapsed: setCollapsed,
    keyOf: (e) => diffKey(mode, e.path),
    activeKey: api.activeDiffKey(),
    onOpen: (e, how) => api.openDiff(e, mode, how),
    expandToggle: !fork && !conflictMode,
  });

  // 한쪽 목록에서 고르면 다른 쪽 선택은 푼다(원본 StagingLists.OnSelected).
  const clearOther = (other, host) => {
    if (!other.selected.size && !other.folders.size) return;
    other.selected.clear();
    other.folders.clear();
    for (const row of host.querySelectorAll('.file-row.selected')) row.classList.remove('selected');
  };
  const unstagedHost = el('div', { class: 'list-host' });
  const stagedHost = el('div', { class: 'list-host' });

  const stageEntries = (entries) => api.stage(entries.filter((e) => e.state !== 'conflicted').map((e) => e.path));
  const unstagedList = fileList({
    ...common('unstaged', ui.unstaged),
    entries: unstaged,
    empty: filtering ? '찾는 파일이 없습니다.' : conflictMode ? '남은 충돌이 없습니다.' : hiddenAll.length ? '보이는 파일이 없습니다. 위의 "숨김" 을 누르면 숨긴 파일이 보입니다.' : '바뀐 파일이 없습니다.',
    // GitKraken 배치만: 줄에 마우스를 올리면 그 파일 하나만 옮기는 버튼. 충돌 파일은 "해결됨으로 표시".
    rowAction: fork ? null : {
      labelOf: (e) => (e.state === 'conflicted'
        ? { label: '해결됨으로 표시', kind: 'resolve', run: (x) => api.markResolved([x.path]) }
        : { label: '파일 Stage', kind: 'stage', run: (x) => api.stage([x.path]) }),
    },
    // 더블클릭·Enter = Stage. 충돌 파일은 병합 편집기에서 푼다.
    onActivate: (entries) => stageEntries(entries),
    eye,
    onMenu: (event, entries, clicked) => api.fileMenu(event, entries, conflictMode ? 'conflict' : 'unstaged', clicked, eyeOps([clicked.path])),
    onFolderMenu: (event, folder, entries, viewOps) => api.folderMenu(event, folder, entries, 'unstaged', { ...viewOps, eye: eyeOps([folder.path]) }),
    onDelete: conflictMode ? null : (entries) => api.discardMany(entries, 'unstaged'),
    onSelect: () => {
      clearOther(ui.staged, stagedHost);
      updateButtons();
    },
  });
  const realStaged = (entries) => entries.filter((e) => !e.unchanged);
  const stagedList = fileList({
    ...common('staged', ui.staged),
    entries: staged,
    empty: filtering ? '찾는 파일이 없습니다.' : conflictMode ? '아직 푼 파일이 없습니다.' : 'Stage 한 파일이 없습니다.',
    rowAction: fork ? null : { labelOf: (e) => (e.unchanged ? null : { label: '파일 Unstage', kind: 'unstage', run: (x) => api.unstage([x.path]) }) },
    onActivate: (entries) => api.unstage(realStaged(entries).map((e) => e.path)),
    onMenu: (event, entries, clicked) => api.fileMenu(event, entries, 'staged', clicked),
    onFolderMenu: (event, folder, entries, viewOps) => api.folderMenu(event, folder, entries, 'staged', viewOps),
    onDelete: (entries) => realStaged(entries).length && api.discardMany(realStaged(entries), 'staged'),
    onSelect: () => {
      clearOther(ui.unstaged, unstagedHost);
      updateButtons();
    },
  });
  unstagedHost.append(unstagedList);
  stagedHost.append(stagedList);

  // 머리 줄 버튼이 옮길 파일: 고른 것, 없거나 Shift(Fork)면 전부. 찾는 중이거나 숨긴 파일이 있으면 "… All" 은 보이는 것만(원본 ButtonTargets).
  // 바쁜 동안 누른 "모두 …" 는 앞 작업이 끝나면 이어서 한다.
  const bulk = (run) => () => {
    if (isBusy()) ui.queued = run;
    else run();
  };
  const stageAll = bulk(() => (filtering || hiddenAll.length ? api.stage(stageable.map((e) => e.path)) : api.stageAll()));
  const unstageAll = bulk(() => (filtering ? api.unstage(status.staged.filter(matches).map((e) => e.path)) : api.unstageAll()));
  const unstagedButton = el('span', { class: 'header-btn-host' });
  const stagedButton = el('span', { class: 'header-btn-host' });
  function updateButtons() {
    const pickU = selectedEntries(ui.unstaged, unstaged).filter((e) => e.state !== 'conflicted');
    const pickS = realStaged(selectedEntries(ui.staged, staged));
    unstagedButton.replaceChildren(conflictMode
      ? el('button', { class: 'staging-btn resolve', disabled: !conflicts.length, 'data-tip': '충돌 파일을 모두 지금 내용 그대로 해결됨으로 표시합니다(git add).', text: '모두 해결됨으로 표시', onclick: () => api.markResolved(conflicts.map((e) => e.path)) })
      : headerButton('stage', { fork, picked: pickU.length, total: stageable.length, onAll: stageAll, onSome: () => api.stage(pickU.map((e) => e.path)) }));
    stagedButton.replaceChildren(headerButton('unstage', { fork, picked: pickS.length, total: realStaged(staged).length, onAll: unstageAll, onSome: () => api.unstage(pickS.map((e) => e.path)) }));
  }
  updateButtons();

  const section = (cls, title, host, button, extra = null) => el('div', { class: `stage-section ${cls}` },
    el('div', { class: 'stage-header' }, el('span', { class: 'stage-title', text: title }), extra, button),
    host);
  const unstagedTitle = conflictMode ? `충돌 파일 (${unstaged.length})` : `Unstaged (${visibleAll.length})`;
  // 숨긴 파일이 있으면 머리 줄에 "숨김 n". 누르면 숨긴 줄을 제자리에 흐리게 보이고(다시 누르면 감춘다), 그 줄의 눈을 눌러 되살린다.
  const toggleShowHidden = () => {
    ui.showHidden = !ui.showHidden;
    rerender();
  };
  const hiddenChip = hiddenAll.length ? el('button', {
    class: `hidden-chip${ui.showHidden ? ' on' : ''}`,
    'data-tip': ui.showHidden ? '숨긴 파일을 다시 감춥니다.' : '숨긴 파일을 흐리게 보입니다. 숨긴 파일은 "모두 Stage"·"모든 변경 버리기" 에서 빠집니다.',
    onclick: toggleShowHidden,
  }, icon('eyeOff', 13), el('span', { text: `숨김 ${hiddenAll.length}` })) : null;
  if (ui.showHidden) {
    unstagedHost.prepend(el('div', { class: 'hidden-banner' },
      el('span', { class: 'hidden-banner-text', text: `숨긴 파일 ${hiddenAll.length}개를 흐리게 보이는 중` }),
      el('button', { class: 'expand-toggle', 'data-tip': '이 레포지토리에서 숨긴 것을 모두 다시 보입니다.', text: '모두 보이기', onclick: () => setRules([]) })));
  }
  const stagedTitle = conflictMode ? `해결한 파일 (${status.staged.length + unchanged.length})` : `Staged (${status.staged.length})`;
  const stagedSection = section('staged', stagedTitle, stagedHost, stagedButton);
  stagedSection.style.height = `${api.prefs.get('staging.stagedHeight') ?? 200}px`;
  const lists = el('div', { class: 'staging-lists' });
  lists.append(section('unstaged', unstagedTitle, unstagedHost, unstagedButton, hiddenChip), splitter(lists, api), stagedSection);

  // ── 경로/트리 줄(+ Fork 배치는 왼쪽 돋보기) ──
  const toggleFilter = () => {
    if (ui.filterOpen) {
      ui.filterOpen = false;
      ui.filter = '';
      rerender();
    } else openFilter();
  };
  const openFilter = () => {
    ui.filterOpen = true;
    ui.filterOpening = true;
    rerender();
    const input = container.querySelector('.filter-input');
    input?.focus();
    input?.select();
  };
  const toolbar = el('div', { class: 'staging-toolbar' },
    fork ? el('button', { class: `staging-filter-btn${ui.filterOpen ? ' on' : ''}`, 'data-tip': '파일 찾기 (Ctrl+F). Unstaged·Staged 를 경로로 거릅니다. Esc 로 지우고 닫습니다.', onclick: toggleFilter }, icon('search', 16)) : null,
    viewSwitch(view, (v) => { api.prefs.set('staging.view', v); rerender(); }, true));
  container.stagingOpenFilter = fork ? openFilter : null;

  let filterRow = null;
  if (fork && ui.filterOpen) {
    const input = el('input', { class: 'filter-input', placeholder: '필터', spellcheck: 'false' });
    input.value = ui.filter;
    const apply = () => {
      ui.filter = input.value;
      const caret = input.selectionStart;
      rerender();
      const again = container.querySelector('.filter-input');
      again?.focus();
      again?.setSelectionRange(caret, caret);
    };
    // 한글을 조합하는 동안 다시 그리면 입력란이 새로 만들어져 조합이 끊긴다 — 조합이 끝난 뒤에 거른다.
    input.addEventListener('input', (event) => {
      if (event.isComposing) ui.filter = input.value;
      else apply();
    });
    input.addEventListener('compositionend', apply);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !isComposing(event)) {
        event.stopPropagation();
        ui.filter = '';
        ui.filterOpen = false;
        rerender();
      }
    });
    filterRow = el('div', { class: `staging-filter-row${ui.filterOpening ? ' opening' : ''}` }, el('div', { class: 'staging-filter' }, icon('search', 14), input));
    ui.filterOpening = false;
  }

  // ── GitKraken 작업 패널 머리 줄(원본 GraphWorkspaceView.UpdatePanelTitle) ──
  let head = null;
  if (!forkLists) {
    const total = new Set([...status.unstaged, ...status.staged].map((e) => e.path)).size;
    // 숨긴 파일은 버리지 않는다(Staged 에도 있어 보이는 파일은 버린다).
    const stagedPaths = new Set(status.staged.map((e) => e.path));
    const keep = hiddenAll.map((e) => e.path).filter((path) => !stagedPaths.has(path));
    const branch = status.branch?.name || '-';
    const merging = operation === 'merge';
    const incoming = merging ? (api.mergeMessage?.() ?? '').match(/Merge (?:remote-tracking )?branch '([^']+)'/)?.[1] ?? 'MERGE_HEAD' : null;
    head = [
      el('div', { class: `wip-header${merging ? ' merging' : ''}` },
        el('button', { class: 'wip-discard', 'data-tip': keep.length ? `모든 변경 버리기 (숨긴 파일 ${keep.length}개는 그대로 둡니다)` : '모든 변경 버리기', disabled: total <= keep.length, onclick: () => api.discardAll(keep) }, icon('trash', 16)),
        merging ? el('span', { class: 'wip-warning' }, icon('warning', 15)) : null,
        el('span', { class: 'wip-title', text: merging ? '병합 충돌' : `${branch} 의 변경 ${total}개` })),
      merging ? el('div', { class: 'wip-merge-info' },
        el('span', { class: 'merge-ref incoming', text: incoming }), el('span', { class: 'merge-text', text: '→' }),
        el('span', { class: 'merge-ref target', text: branch }), el('span', { class: 'merge-text', text: '병합 중' })) : null,
    ];
  }

  keepListState(container, () => container.replaceChildren(...[
    ...(head ?? []),
    toolbar,
    filterRow,
    lists,
    commitBox(status, draft, api),
  ].filter(Boolean)));

  // Fork 배치: ⌘/Ctrl+F 는 목록 안 어디서든 찾기 칸을 연다(원본 StagingLists 의 Root 키 처리).
  if (!container.stagingKeys) {
    container.stagingKeys = true;
    container.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && container.stagingOpenFilter) {
        event.preventDefault();
        event.stopPropagation();
        container.stagingOpenFilter();
      }
    });
  }
}

/** 찾기 칸을 연다(⌘/Ctrl+F). Fork 배치에만 있다 — 열었으면 true. */
export function openStagingFilter(container) {
  if (!container?.stagingOpenFilter) return false;
  container.stagingOpenFilter();
  return true;
}

// ── 커밋 상자(원본 CommitBox·OperationActions) ───────────

const OP_NAME = { merge: '병합', rebase: 'rebase', cherryPick: '체리픽', revert: 'revert' };
/** 병합·cherry-pick·revert 는 커밋 하나로 끝난다(입력란 메시지로 커밋). rebase 는 git 이 준비한 메시지로 이어간다. */
const requiresFullCommit = (op) => op === 'merge' || op === 'cherryPick' || op === 'revert';

/** 멈춘 작업을 마칠 수 없는 까닭(원본 GitInProgress.ContinueBlocker·OperationActions.MergeCommitBlocker). 막을 것이 없으면 null. */
function continueBlocker(status) {
  const op = status.operation;
  const conflicts = status.unstaged.filter((e) => e.state === 'conflicted').length;
  if (conflicts) return `충돌 파일 ${conflicts}개를 먼저 해결해 Stage 하세요.`;
  if (op === 'rebase' && status.unstaged.some((e) => e.state !== 'untracked')) return 'Stage 하지 않은 변경이 있으면 rebase 를 이어갈 수 없습니다. Stage 하거나 되돌리세요.';
  if (op === 'merge') {
    if (status.unstaged.length) return `Stage 하지 않은 변경 ${status.unstaged.length}개가 있습니다. 모두 Stage 하거나 버려야 병합을 마칠 수 있습니다.`;
    if (!status.staged.length) return 'Stage 한 변경이 없습니다. 해결한 파일을 Stage 하세요.';
  }
  return null;
}

/**
 * 제목 → 설명 → 작성자 경고 → 아래 한 줄 [Amend][중단][건너뛰기] … [커밋 후 푸시][커밋 (n)].
 * 진행 중인 병합·cherry-pick·revert 면 버튼이 [커밋하고 병합]/[{작업} 마치기], rebase 면 [rebase 이어가기]. 빈 입력란에 MERGE_MSG.
 * 템플릿(commit.template)이 있으면 빈 입력란에 채우고, 칸을 다 지우고 나가면 다시 채우며, 커밋할 때 '#' 줄을 뺀다.
 */
function commitBox(status, draft, api) {
  const op = status.operation;
  const template = api.template();
  const [tplSubject, tplDescription] = template ? splitMessage(template) : ['', ''];
  const untouched = () => (!draft.summary.trim() && !draft.description.trim()) || (template && draft.summary === tplSubject && draft.description === tplDescription);
  const fill = (subject, description) => {
    draft.summary = subject;
    draft.description = description;
  };
  // 작업이 시작·끝날 때(원본 FillPreparedMessage): 끝나면 손대지 않은 MERGE_MSG 를 거두고, 커밋으로 끝나는 작업이 보이기 시작하면 빈 입력란에 채운다.
  if ((draft.seenOperation ?? null) !== (op ?? null)) {
    draft.seenOperation = op ?? null;
    if (draft.prepared != null && joinMessage(draft.summary, draft.description) === draft.prepared) fill(tplSubject, tplDescription);
    draft.prepared = null;
    const prepared = requiresFullCommit(op) && !draft.amend && untouched() ? api.mergeMessage() : null;
    if (prepared) {
      fill(...splitMessage(prepared));
      draft.prepared = joinMessage(draft.summary, draft.description);
    }
  }
  if (!op && template && !draft.summary && !draft.description && !draft.amend) fill(tplSubject, tplDescription);

  const summary = el('input', { class: 'field', id: 'commit-summary', placeholder: '커밋 제목', maxlength: 200 });
  summary.value = draft.summary;
  const description = el('textarea', { class: 'field', id: 'commit-description', placeholder: '설명', rows: 3 });
  autoHorizontalScroll(description);
  description.value = draft.description;
  const amend = el('input', { type: 'checkbox', id: 'commit-amend' });
  amend.checked = !!draft.amend && !op;
  const commitButton = el('button', { class: 'commit-btn', id: 'commit-button' });
  const pushButton = el('button', { class: 'commit-push', id: 'commit-push', text: '커밋 후 푸시' });
  const identity = api.identity();
  const hasAuthor = !!(identity.name && identity.email);

  // 실제로 커밋될 제목이 있는가. 템플릿을 쓰면 '#' 안내 줄은 빠지므로 안내 그대로인 제목은 없는 것으로 본다.
  const hasSubject = () => (template ? stripComments(summary.value).length > 0 : summary.value.trim().length > 0);
  const message = () => {
    const text = joinMessage(summary.value, description.value);
    return template ? stripComments(text) : text;
  };
  const update = () => {
    draft.summary = summary.value;
    draft.description = description.value;
    draft.amend = amend.checked;
    if (op) {
      const blocker = continueBlocker(status);
      commitButton.textContent = op === 'merge' ? (status.staged.length ? '커밋하고 병합' : '병합할 변경 없음') : requiresFullCommit(op) ? `${OP_NAME[op]} 마치기` : `${OP_NAME[op]} 이어가기`;
      commitButton.disabled = !hasAuthor || !!blocker || (requiresFullCommit(op) && !hasSubject());
      commitButton.dataset.tip = blocker ?? (requiresFullCommit(op) ? `적은 메시지로 커밋해 ${OP_NAME[op]}을(를) 마칩니다.` : `해결한 결과로 ${OP_NAME[op]}을(를) 이어갑니다(git ${op} --continue). 커밋 메시지는 git 이 준비한 것을 씁니다.`);
      return;
    }
    // 고쳐 쓰기는 Stage 한 것이 없어도(메시지만 고칠 때) 할 수 있다. 새 커밋은 제목과 Stage 한 파일이 있어야 한다.
    const can = hasAuthor && (amend.checked || (status.staged.length > 0 && hasSubject()));
    commitButton.disabled = !can;
    commitButton.textContent = amend.checked ? '고쳐 쓰기' : `커밋 (${status.staged.length})`;
    delete commitButton.dataset.tip;
    // 원격이 없으면 커밋만 되고 푸시는 실패한다 — 누르기 전에 막고 까닭을 보인다.
    const hasRemote = api.hasRemote();
    pushButton.disabled = !can || !!status.branch?.detached || !hasRemote;
    if (hasRemote) delete pushButton.dataset.tip;
    else pushButton.dataset.tip = '등록된 원격이 없어 푸시할 수 없습니다. 사이드바 REMOTE 의 + 로 원격을 추가하거나 새 GitHub 레포지토리를 만드세요.';
  };
  summary.addEventListener('input', () => {
    update();
    api.onSummary?.(summary.value);
  });
  description.addEventListener('input', update);
  // 칸을 다 지우고 다른 곳을 누르면 그 칸에 템플릿을 다시 채운다(Fork 와 같다).
  summary.addEventListener('blur', () => {
    if (template && !summary.value.trim()) {
      summary.value = tplSubject;
      update();
      api.onSummary?.(summary.value);
    }
  });
  description.addEventListener('blur', () => {
    if (template && !description.value.trim()) {
      description.value = tplDescription;
      update();
    }
  });
  // Amend 를 켜면 비어 있는(또는 템플릿 그대로인) 입력란에 마지막 커밋 메시지를 채운다. 끌 때는 쓴 글을 지우지 않는다.
  amend.addEventListener('change', async () => {
    update();
    if (!amend.checked || !untouched()) return;
    const [first, rest] = splitMessage(await api.lastMessage());
    summary.value = first;
    description.value = rest;
    update();
    api.onSummary?.(summary.value);
  });
  const submit = (pushAfter) => {
    if (commitButton.disabled || isBusy()) return;
    if (op) {
      api.continueOperation(requiresFullCommit(op) ? message() : undefined);
      return;
    }
    const text = message();
    fill(tplSubject, tplDescription);
    draft.amend = false;
    api.commit(text, amend.checked, pushAfter);
  };
  commitButton.addEventListener('click', () => submit(false));
  pushButton.addEventListener('click', () => submit(true));
  for (const field of [summary, description]) {
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isComposing(event)) submit(false);
    });
  }
  update();

  const abortLabel = op ? `${OP_NAME[op]} 중단` : '';
  return el('div', { class: 'commit-box' },
    summary,
    description,
    hasAuthor ? null : el('div', { class: 'author-notice' }, el('span', { text: 'user.name / user.email 이 설정되지 않아 커밋할 수 없습니다.' })),
    el('div', { class: 'commit-footer' },
      op ? null : el('label', { class: 'commit-amend', 'data-tip': '마지막 커밋을 고쳐 씁니다. 켜면 비어 있는 입력란에 마지막 메시지를 채웁니다.' }, amend, el('span', { text: '마지막 커밋 고치기 (Amend)' })),
      op ? el('button', { class: 'commit-link danger', text: abortLabel, 'data-tip': `${OP_NAME[op]}을(를) 중단하고 시작 전 상태로 돌립니다(git ${op === 'cherryPick' ? 'cherry-pick' : op} --abort).`, onclick: () => api.abortOperation() }) : null,
      op === 'rebase' ? el('button', { class: 'commit-link', text: '건너뛰기', 'data-tip': '지금 멈춘 커밋을 빼고 다음 커밋으로 넘어갑니다(git rebase --skip).', onclick: () => api.skipOperation() }) : null,
      el('span', { class: 'spacer' }),
      op ? null : pushButton,
      commitButton));
}

// ── 커밋 상세(원본 GraphCommitDetail) ───────────────────

const COAUTHOR = /^co-authored-by:\s*(.+?)\s*<([^>]+)>\s*$/gim;

/** 아바타: 그림이 있으면 그림, 없으면 작성자 색 바탕에 머리글자. hash 는 작성자 사진을 찾을 때만 — 공동 작성자에게 넘기면 작성자 얼굴이 들어간다. */
function avatar(api, name, email, hash, cls) {
  // 그래프가 이미 읽어 디코딩한 사진은 캔버스에 바로 옮겨 그린다. 커밋을 고를 때마다 새 <img> 를 만들면 캐시에 있어도
  // 디코딩하는 동안 빈 칸(또는 머리글자)이 한 프레임 보였다가 사진이 나와 깜박인다.
  const image = api.avatarImage?.(email);
  if (image) return el('span', { class: cls, style: { background: 'none' } }, avatarCanvas(image));
  const node = el('span', { class: cls, style: { background: rgb(authorRgb(name)) } }, el('span', { class: 'avatar-initials', text: initials(name) }));
  const show = (url) => {
    if (!url) return;
    // 디코딩까지 끝난 뒤에 바꾼다 — 그동안은 머리글자를 둔다(빈 그림이 잠깐 보이지 않게).
    const img = el('img', { src: url, alt: '' });
    const swap = () => {
      if (!img.naturalWidth) return;
      node.style.background = 'none';
      node.replaceChildren(img);
    };
    img.decode().then(swap, swap);
  };
  const known = api.avatarPeek?.(email);
  if (known !== undefined) show(known); // null 은 사진이 없는 작성자 — 다시 묻지 않는다.
  else api.avatarUrl?.(email, hash ?? null).then(show);
  return node;
}

/** 다 읽은 그림을 같은 크기의 캔버스로(그리는 즉시 보인다). */
function avatarCanvas(image) {
  const canvas = el('canvas', { width: image.naturalWidth, height: image.naturalHeight });
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas;
}

/** AI 공동 작성자는 모델·버전 없이 이름만("Claude Opus 5.5" → "Claude"). 사람 이름은 그대로. */
const AI_NAMES = [[/^claude\b/i, 'Claude'], [/^gemini\b/i, 'Gemini'], [/^chatgpt\b/i, 'ChatGPT'], [/^codex\b/i, 'Codex'], [/^(github )?copilot\b/i, 'Copilot'], [/^cursor\b/i, 'Cursor']];
function coauthorName(name, email) {
  if (/@anthropic\.com$/i.test(email)) return 'Claude';
  return AI_NAMES.find(([re]) => re.test(name))?.[1] ?? name;
}

/**
 * "✎ 2 수정  + 1 추가  − 1 삭제  → 1 이름 변경  • 1 기타" — 그림은 파일 줄과 같은 상태 그림(연필·초록 +·빨간 −),
 * 글자는 흰색(원본 GraphCommitDetail.BindSummary).
 */
function fileSummary(files) {
  const states = files.map((f) => CHANGE_STATE[f.status] ?? 'modified');
  const count = (s) => states.filter((x) => x === s).length;
  const other = states.filter((x) => !['modified', 'added', 'deleted', 'renamed'].includes(x)).length;
  const parts = [
    ['modified', '✎', count('modified'), '수정'],
    ['added', '+', count('added'), '추가'],
    ['deleted', '−', count('deleted'), '삭제'],
    ['renamed', '→', count('renamed'), '이름 변경'],
    ['other', '•', other, '기타'],
  ].filter((p) => p[2]);
  return el('div', { class: 'cd-summary' }, parts.map(([kind, sign, n, label]) => el('span', { class: `cd-count cd-count-${kind}` },
    kind === 'other' ? el('span', { class: 'cd-count-sign', text: sign }) : stateIcon(kind),
    el('span', { text: `${n} ${label}` }))));
}

/** "commit: 해시" 머리 줄. 해시를 누르면 전체 해시를 복사한다. */
function commitHeader(hash) {
  const button = el('button', {
    class: 'cd-hash', 'data-tip': '누르면 전체 해시를 복사합니다.', text: hash.slice(0, 7),
    onclick: () => {
      navigator.clipboard?.writeText(hash);
      button.dataset.tip = '복사했습니다';
    },
  });
  return el('div', { class: 'cd-header' }, el('span', { class: 'cd-label', text: 'commit:' }), button);
}

/** 메시지 카드·작성자 줄. 파일 목록 위의 고정 부분이다(파일 목록만 스크롤한다). */
/** 메시지 칸 아래 손잡이: 위아래로 끌어 칸 높이를 바꾸고(패널의 60% 까지), 두 번 누르면 기본 높이. */
function messageGrip(card, api) {
  const set = (h, save) => {
    const body = card.parentElement;
    const max = Math.max(MESSAGE_HEIGHT.min, (body?.clientHeight ?? 600) * 0.6);
    messageHeight = Math.round(Math.min(max, Math.max(MESSAGE_HEIGHT.min, h)));
    card.style.height = `${messageHeight}px`;
    if (save) api.prefs?.set?.(MESSAGE_HEIGHT.key, messageHeight);
  };
  return el('div', {
    class: 'cd-grip', role: 'separator', 'aria-orientation': 'horizontal', 'data-tip': '끌어서 높이 바꾸기 · 두 번 누르면 기본 높이',
    ondblclick: () => set(MESSAGE_HEIGHT.initial, true),
    onpointerdown: (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const grip = event.currentTarget;
      const startY = event.clientY;
      const startH = card.offsetHeight;
      grip.setPointerCapture(event.pointerId);
      grip.classList.add('dragging');
      const move = (e) => set(startH + e.clientY - startY, false);
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        grip.classList.remove('dragging');
        set(card.offsetHeight, true);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    },
  });
}

/** 메시지 칸의 높이(px). 글 길이와 상관없이 늘 이 높이고, 길면 칸 안에서 스크롤한다. 손잡이로 바꾸면 기억한다. */
const MESSAGE_HEIGHT = { initial: 120, min: 56, key: 'commit.messageHeight' };
let messageHeight = null; // 마지막으로 읽은·바꾼 높이(읽는 중 화면도 같은 높이로)

function commitTop(commit, api, message) {
  const [subject, body] = (() => {
    const text = (message ?? '').replace(/\r\n/g, '\n').trim();
    const newline = text.indexOf('\n');
    return newline < 0 ? [text, ''] : [text.slice(0, newline).trim(), text.slice(newline + 1).replace(/^\n+|\n+$/g, '')];
  })();
  const parents = commit.parents ?? [];
  messageHeight = api.prefs?.get?.(MESSAGE_HEIGHT.key) ?? messageHeight ?? MESSAGE_HEIGHT.initial;
  const card = el('div', { class: 'cd-card', style: { height: `${messageHeight}px` } },
    el('div', { class: 'cd-subject', text: subject }), body ? el('div', { class: 'cd-message', text: body }) : null);
  return [
    card,
    messageGrip(card, api),
    el('div', { class: 'cd-meta' },
      avatar(api, commit.authorName, commit.authorEmail, commit.hash, 'cd-avatar'),
      el('div', { class: 'cd-author-block' },
        el('div', { class: 'cd-author', text: commit.authorName, 'data-tip': commit.authorEmail }),
        el('div', { class: 'cd-authored', text: commit.time ? `${formatDate(commit.time, true)} 작성` : '' })),
      parents.length ? el('div', { class: 'cd-parents' }, el('span', { class: 'cd-parent-label', text: '부모:' }),
        parents.map((p) => el('button', { class: 'cd-parent', 'data-tip': '그래프에서 이 커밋 보기', text: p.slice(0, 7), onclick: () => api.revealCommit?.(p) }))) : null),
  ];
}

/** 커밋 하나의 정보. detail.title 이 있으면(stash 등) 머리에 보인다. */
export function renderCommit(container, detail, api) {
  const coauthors = [];
  const seen = new Set();
  for (const m of detail.message.matchAll(COAUTHOR)) {
    if (seen.has(m[2].trim().toLowerCase())) continue;
    seen.add(m[2].trim().toLowerCase());
    coauthors.push({ name: coauthorName(m[1].trim(), m[2].trim()), email: m[2].trim() });
  }
  const view = api.prefs.get('commit.view') ?? 'path';
  const collapsed = new Set(api.prefs.get('commit.collapsed') ?? []);
  const entries = detail.files.map((f) => ({ ...f, state: CHANGE_STATE[f.status] || 'modified' }));
  const rerender = () => renderCommit(container, detail, api);
  const setCollapsed = (paths) => {
    api.prefs.set('commit.collapsed', [...paths]);
    rerender();
  };
  const list = fileList({
    view, collapsed, state: ui.commit, entries,
    onToggleFolder: (path) => {
      if (collapsed.has(path)) collapsed.delete(path);
      else collapsed.add(path);
      setCollapsed(collapsed);
    },
    onSetCollapsed: setCollapsed,
    expandToggle: true,
    keyOf: (e) => diffKey(`commit-${detail.hash}`, e.path),
    activeKey: api.activeDiffKey(),
    onOpen: (f, how) => api.openCommitDiff(detail.hash, f, how),
    onHover: api.prefetchCommitDiff && ((f) => api.prefetchCommitDiff(detail.hash, f)),
    onMenu: (event, files) => api.commitFileMenu(event, detail, files),
    empty: '바뀐 파일이 없습니다.',
  });
  // 같은 커밋을 다시 그릴 때만 목록 스크롤을 남긴다(다른 커밋은 맨 위부터).
  const sameCommit = container.commitHash === detail.hash;
  container.commitHash = detail.hash;
  const draw = () => container.replaceChildren(
    el('div', { class: 'commit-detail' },
      commitHeader(detail.hash),
      el('div', { class: 'cd-body' },
        detail.title ? el('div', { class: 'cd-title muted small', text: detail.title }) : null,
        // Co-Authored-By 줄은 아래 "공동 작성자" 에 따로 보이므로 본문에서는 뺀다(모델·버전 같은 꼬리표가 본문에 남지 않게).
        ...commitTop(detail, api, detail.message.replace(COAUTHOR, '').replace(/\n{3,}/g, '\n\n')),
        coauthors.length ? el('div', { class: 'cd-coauthors' }, el('span', { class: 'cd-coauthors-label', text: '공동 작성자:' }),
          coauthors.map((c) => el('span', { class: 'cd-coauthor', 'data-tip': `${c.name} <${c.email}>` }, avatar(api, c.name, c.email, null, 'cd-coauthor-avatar'), el('span', { class: 'cd-coauthor-name', text: c.name })))) : null,
        // 파일 칸 머리는 늘 두 줄: [바뀜 요약] / [보기 전환]. 요약이 길어도 전환이 밑으로 밀리거나 칸 높이가 바뀌지 않는다.
        el('div', { class: 'cd-files-head' },
          fileSummary(detail.files),
          el('div', { class: 'cd-files-tools' }, viewSwitch(view, (v) => { api.prefs.set('commit.view', v); rerender(); }))),
        el('div', { class: 'cd-files' }, list))));
  if (sameCommit) keepListState(container, draw);
  else draw();
}

/**
 * 커밋 정보를 읽는 동안. commit(그래프의 커밋 요약)을 주면 해시·제목·작성자는 바로 보이고 파일 칸은 비어 있다.
 */
export function renderCommitSkeleton(container, commit, api = {}) {
  // 읽는 동안 파일 칸은 비워 둔다(회색 막대 없이) — 다 읽으면 목록이 그대로 나타난다.
  const files = el('div', { class: 'cd-files' });
  if (!commit) {
    container.replaceChildren(el('div', { class: 'commit-detail' }, el('div', { class: 'cd-header' }), el('div', { class: 'cd-body' }, files)));
    return;
  }
  container.replaceChildren(el('div', { class: 'commit-detail' },
    commitHeader(commit.hash),
    el('div', { class: 'cd-body' },
      // 사진은 이미 받은 것만 쓴다(읽는 동안 새로 묻지 않는다) — 머리글자로 그렸다가 다 읽은 뒤 사진으로 바뀌면 깜박인다.
      ...commitTop(commit, { avatarImage: api.avatarImage, avatarPeek: api.avatarPeek, avatarUrl: () => Promise.resolve(null) }, commit.subject),
      // 읽는 동안에도 같은 두 줄 자리를 둔다 — 다 읽은 뒤 파일 칸이 밀려 내려가지 않게.
      el('div', { class: 'cd-files-head' }, el('div', { class: 'cd-summary' }), el('div', { class: 'cd-files-tools' })),
      files)));
}
