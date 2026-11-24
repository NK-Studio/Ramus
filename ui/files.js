// 파일 목록 부품: 스테이징 목록·커밋 상세·비교 창이 함께 쓴다. 원본 Elements/FileBrowser·FileList·FileTree·FileTreeBuilder·FileRowBinder·StateBadge 를 옮겼다.
// 줄(원본 FileRow.uxml, 20px): [상태 그림][파일 아이콘 16px][경로(트리는 이름)][← 원래 경로][메모][hover 버튼].
// [경로 | 트리] 보기, 여러 선택(Shift=범위, ⌘/Ctrl=하나씩), 폴더 트리(폴더 먼저·이름순, 한 단계에 한 줄, 폴더 굵게, 접힌 폴더는 상태별 수 ✏ 1 + 1 − 1, 접힘 기억,
// 폴더 줄도 고를 수 있다 — 고르면 그 아래 파일 전부가 대상), 키보드(↑↓·Enter·Delete, Space 는 막음).

import { el, splitPath } from './util.js';
import { icon } from './icons.js';
import { scoped, isEn } from './i18n.js';

/** 이 모듈의 글(locales/en/files.js 를 먼저 본다). */
const t = scoped('files');

// 상태 이름. '수정'·'추가'·'삭제' 같은 한 낱말 원문은 다른 화면의 버튼(Add·Delete 등)과 겹쳐 영어 표 하나로는 형용사 꼴을 고를 수 없다 — 여기서 따로 둔다.
export const STATE_LABEL = isEn
  ? { modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', untracked: 'New file', conflicted: 'Conflicted' }
  : { modified: '수정', added: '추가', deleted: '삭제', renamed: '이름 바뀜', untracked: '새 파일', conflicted: '충돌' }; // i18n-ignore
export const CHANGE_STATE = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'renamed', T: 'modified' };

/**
 * 상태 그림(원본 StateBadge). 수정=연필(그림 자체 색) · 추가·새 파일=+ · 삭제=− 는 12px 그림을 상태 색으로 물들이고,
 * 이름 변경·충돌은 원본이 쓰는 UVCS 오버레이 그림(16px, 테마마다 따로).
 */
export function stateIcon(state) {
  // 툴팁은 띄우지 않는다(목록을 훑을 때 줄마다 떠서 거슬린다) — 화면 읽기용 이름만 둔다.
  return el('span', { class: `state-icon st-${state}`, role: 'img', 'aria-label': STATE_LABEL[state] ?? state });
}

const KINDS = [
  [/\.(png|jpe?g|gif|bmp|tga|psd|psb|tiff?|webp|svg|ico|exr|hdr)$/i, 'image'],
  [/\.(cs|js|mjs|ts|tsx|jsx|rs|c|cc|cpp|h|hpp|m|mm|swift|kt|java|go|py|rb|php|lua|shader|hlsl|cginc|compute|glsl)$/i, 'code'],
  [/\.(json|ya?ml|xml|toml|ini|cfg|asmdef|asmref|uxml|uss|css|html?)$/i, 'data'],
  [/\.(md|txt|rtf|csv|log)$/i, 'text'],
  [/\.(unity|prefab|asset|mat|anim|controller|meta|scene)$/i, 'asset'],
  [/\.(wav|mp3|ogg|aif+|flac|mp4|mov|avi|webm)$/i, 'media'],
  [/\.(zip|7z|rar|gz|tgz|unitypackage|dll|so|dylib|exe|bin)$/i, 'binary'],
];

/** 파일 종류 아이콘 16px(확장자로 색을 고른다). */
export function fileIcon(path) {
  const kind = KINDS.find(([re]) => re.test(path))?.[1] ?? 'other';
  return el('span', { class: `file-kind fk-${kind}` }, icon('file', 16));
}

/** 경로/트리 두 칸 묶음(원본 FileViewModeSwitch). large 는 스테이징 맨 위 줄의 큰 전환(.view-mode-switch--large). */
export function viewSwitch(view, onChange, large = false) {
  return el('div', { class: `view-switch${large ? ' large' : ''}` },
    el('button', { class: view === 'path' ? 'on' : '', 'data-tip': t('전체 경로를 한 줄씩 봅니다.'), onclick: () => onChange('path') }, icon('pathList', 13), el('span', { class: 'seg-text', text: t('경로') })),
    el('button', { class: view === 'tree' ? 'on' : '', 'data-tip': t('폴더 구조로 봅니다.'), onclick: () => onChange('tree') }, icon('fileTree', 13), el('span', { class: 'seg-text', text: t('트리') })));
}

/** 파일들을 폴더 트리로: 폴더 먼저·이름순. 하위 폴더 하나뿐인 폴더도 합치지 않고 단계마다 한 줄이다(원본 1.2.0, GitKraken 과 같다). */
export function buildTree(entries) {
  const root = { name: '', path: '', folders: new Map(), files: [] };
  for (const entry of entries) {
    const parts = entry.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      if (!node.folders.has(name)) node.folders.set(name, { name, path: parts.slice(0, i + 1).join('/'), folders: new Map(), files: [] });
      node = node.folders.get(name);
    }
    node.files.push(entry);
  }
  return root;
}

/** 상태별 수의 차례(원본 FileTreeBuilder.SummaryOrder): 수정·추가·삭제·이름 변경·충돌. */
const SUMMARY_ORDER = ['modified', 'added', 'deleted', 'renamed', 'conflicted'];

/**
 * 접힌 폴더 옆에 보일 상태별 파일 수(GitKraken 처럼 ✏ 1 + 1 − 1, 원본 StateSummary). 0 인 상태는 빼고,
 * 새 파일(untracked)은 추가와 같은 + 로 보이므로 추가에 더한다.
 */
export function stateSummary(files) {
  const counts = new Map();
  for (const file of files) {
    const state = file.state === 'untracked' ? 'added' : file.state;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return SUMMARY_ORDER.filter((state) => counts.get(state)).map((state) => [state, counts.get(state)]);
}
export const folderFiles = (node) => [...node.files, ...[...node.folders.values()].flatMap(folderFiles)];
const allFolders = (node) => [...node.folders.values()].flatMap((f) => [f.path, ...allFolders(f)]);

/** 경로가 고른 폴더(Set) 중 하나의 아래에 있는가. 경로 앞부분만 훑으므로 폴더 수와 상관없이 빠르다. */
function inFolder(path, folders) {
  for (let i = path.indexOf('/'); i > 0; i = path.indexOf('/', i + 1)) if (folders.has(path.slice(0, i))) return true;
  return false;
}
const folderSet = (st) => (st.folders instanceof Set ? st.folders : new Set(st.folders ?? []));

/** 고른 파일 전부(목록 순서). 고른 폴더는 그 아래 파일 전부로 센다(원본 FileTree.SelectedFiles). */
export function selectedEntries(st, entries) {
  const folders = folderSet(st);
  if (!folders.size) return st.selected.size ? entries.filter((e) => st.selected.has(e.path)) : [];
  return entries.filter((e) => st.selected.has(e.path) || inFolder(e.path, folders));
}

/** 고른 줄의 경로(폴더는 폴더 경로 그대로). 고른 폴더 아래의 폴더·파일은 그 폴더에 들어 있으니 뺀다 — 숨기기처럼 폴더째 다루는 동작이 쓴다. */
export function selectionPaths(st) {
  const folders = folderSet(st);
  return [...[...folders].filter((f) => !inFolder(f, folders)), ...[...st.selected].filter((p) => !inFolder(p, folders))];
}

// ── 보이는 줄만 그리기 ──
// 바뀐 파일이 수만 개여도(예: 반쯤 끝난 체크아웃) 줄을 전부 DOM 으로 만들면 그릴 때마다 1초가 넘게 걸린다.
// 목록은 전체 높이만 자리를 잡아 두고, 화면에 보이는 줄과 위아래 몇 줄만 그린다(GitKraken·Fork 와 같다).

/** 트리 정렬. localeCompare 와 같은 순서지만 파일이 수만 개면 훨씬 빠르다. */
const byName = new Intl.Collator().compare;

/** 줄 높이(px). CSS 의 .file-row height 와 같다 — 처음 그린 줄에서 재어 맞춘다. */
let rowHeight = 20;
/** 보이는 칸 위아래로 더 그려 둘 줄 수. 빨리 굴려도 빈 칸이 덜 보이고, 이만큼 굴리기 전에는 다시 그리지 않는다. */
const OVERSCAN = 24;
/** 화면에 붙기 전(크기를 모를 때) 먼저 그려 둘 줄 수. */
const FIRST_ROWS = 80;

/** 화면에 붙은 목록들. 바깥 칸이 굴러가거나 창 크기가 바뀌면 보이는 줄을 다시 고른다. */
const liveLists = new Set();
const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver((records) => { for (const r of records) r.target.paintRows?.(); }) : null;
function pruneLists() {
  for (const list of liveLists) {
    if (list.isConnected) continue;
    liveLists.delete(list);
    resizeObserver?.unobserve(list);
  }
}
if (globalThis.window) {
  // 목록 밖의 칸(바깥 스크롤)이 굴러갈 때. 목록 자신의 스크롤은 목록이 직접 받는다.
  window.addEventListener('scroll', (event) => {
    const target = event.target;
    if (target?.nodeType !== Node.ELEMENT_NODE && target !== document) return;
    for (const list of liveLists) if (target !== list && (target === document || target.contains(list))) list.paintRows();
  }, { capture: true, passive: true });
  window.addEventListener('resize', () => {
    pruneLists();
    for (const list of liveLists) list.paintRows();
  });
}

/**
 * 파일 목록. opts:
 *  entries: [{path, originalPath, state, note}], view: 'path'|'tree',
 *  state: {selected: Set<path>, folders: Set<folderPath>, anchor, cursor} (그리기 사이에 남는 선택. anchor·cursor 는 줄 키 'f:경로'|'d:폴더'),
 *  activeKey (값, 또는 지금 값을 돌려주는 함수 — 나중에 굴러 들어와 그려지는 줄도 맞게), keyOf(entry), collapsed: Set<folderPath>, onToggleFolder(path), onSetCollapsed(paths[]),
 *  onSelect(entries), onOpen(entry, { toggle }?), onActivate(entries), onMenu(event, entries, clicked), onFolderMenu(event, folder, entries, {expandAll, collapseAll}),
 *  onDelete(entries), rowAction: {label, kind, run(entry), labelOf(entry)} | null, expandToggle: 트리 위 [모두 펼치기/접기], empty: '…',
 *  eye: {isHidden(path), toggle(paths[], {solo})} | null — 줄 맨 왼쪽의 눈 버튼(마우스를 올린 줄에만 보인다). 누르면 그 줄을 숨기고,
 *       Alt(Option) 로 누르면 그 줄만 남긴다. 숨긴 줄(isHidden)은 흐리게 그리고 꺼진 눈을 늘 보인다. H 키는 고른 줄 전부에.
 *  decorateRow(row, item): 줄을 그릴 때마다 덧붙일 것(체크 상자 등). item 은 {entry} 또는 {folder}.
 * 보이는 줄만 그린다. 돌려주는 .file-list 요소의 revealPath(path, block) 는 그 파일 줄로 굴리고, folderPaths() 는 트리의 폴더 전부.
 */
export function fileList(opts) {
  const { entries, view = 'path', eye = null } = opts;
  // 눈 버튼이 있으면 들여쓰기 앞에 그 자리(16px)를 비워 둔다.
  const pad = (depth) => `${(eye ? 20 : 4) + depth * 14}px`;
  const eyeButton = (path, hidden) => (eye ? el('button', {
    class: 'row-eye',
    // 툴팁은 띄우지 않는다(줄마다 나타나 거슬린다) — 화면 읽기용 이름만 둔다.
    'aria-label': hidden ? t('다시 보이기') : t('숨기기'),
    onclick: (event) => eye.toggle([path], { solo: event.altKey && !hidden }),
  }, icon(hidden ? 'eyeOff' : 'eye', 14)) : null);
  const activeKey = () => (typeof opts.activeKey === 'function' ? opts.activeKey() : opts.activeKey);
  const st = opts.state ?? { selected: new Set(), anchor: null };
  st.folders ??= new Set();
  const selected = st.selected;
  // 목록에서 사라진 파일·폴더는 선택에서 뺀다.
  if (selected.size) {
    const present = new Set(entries.map((e) => e.path));
    for (const path of [...selected]) if (!present.has(path)) selected.delete(path);
  }
  if (st.folders.size) {
    if (view !== 'tree') st.folders.clear();
    else {
      const dirs = new Set();
      for (const e of entries) for (let i = e.path.indexOf('/'); i > 0; i = e.path.indexOf('/', i + 1)) dirs.add(e.path.slice(0, i));
      for (const folder of [...st.folders]) if (!dirs.has(folder)) st.folders.delete(folder);
    }
  }

  // 보이는 줄 순서(폴더 줄 포함). Shift 범위·화살표 이동이 이 순서를 따른다(원본 TreeView SelectionType.Multiple).
  // 줄: {key, entry, depth, showDir} 또는 {key, folder, depth, collapsed}. anchor 는 Shift 범위의 시작, cursor 는 마지막으로 누른(옮겨 간) 줄.
  const order = [];
  const fileKey = (path) => `f:${path}`;
  const folderKey = (path) => `d:${path}`;
  let tree = null;
  if (view === 'tree' && entries.length) {
    tree = buildTree(entries);
    const emit = (node, depth) => {
      for (const folder of [...node.folders.values()].sort((a, b) => byName(a.name, b.name))) {
        const isCollapsed = !!opts.collapsed?.has(folder.path);
        order.push({ key: folderKey(folder.path), folder, depth, collapsed: isCollapsed });
        if (!isCollapsed) emit(folder, depth + 1);
      }
      for (const entry of [...node.files].sort((a, b) => byName(a.path, b.path))) order.push({ key: fileKey(entry.path), entry, depth: depth + 1, showDir: false });
    };
    emit(tree, 0);
  } else {
    for (const entry of entries) order.push({ key: fileKey(entry.path), entry, depth: 0, showDir: true });
  }
  const indexOf = new Map(order.map((item, i) => [item.key, i]));
  const itemOf = (key) => order[indexOf.get(key)];
  const isOn = (item) => (item.entry ? selected.has(item.entry.path) : st.folders.has(item.folder.path));
  const setOn = (item, on) => {
    const set = item.entry ? selected : st.folders;
    const key = item.entry ? item.entry.path : item.folder.path;
    if (on) set.add(key);
    else set.delete(key);
  };
  const clearAll = () => {
    selected.clear();
    st.folders.clear();
  };
  const list = el('div', { class: 'file-list', tabindex: '0', role: 'listbox' });
  // 전체 높이만 잡는 칸과, 그 안에서 보이는 줄들만 담아 제자리로 내려 두는 칸.
  const space = el('div', { class: 'file-list-space' });
  const rows = el('div', { class: 'file-list-rows' });
  space.append(rows);

  const paintSelection = () => {
    for (const row of rows.children) {
      row.classList.toggle('selected', row.dataset.folder != null ? st.folders.has(row.dataset.folder) : selected.has(row.dataset.path));
      row.classList.toggle('cursor', row.dataset.key === st.cursor);
    }
  };
  const notify = () => opts.onSelect?.(selectedEntries(st, entries));

  /**
   * 줄 고르기. Shift: anchor 부터 이 줄까지(폴더 줄도 함께 — 폴더는 그 아래 파일 전부로 센다). Cmd/Ctrl: 이 줄만 켜고 끈다.
   * Cmd/Ctrl+Shift: 지금 선택에 범위를 더한다. 그냥: 이 줄 하나.
   */
  const pick = (item, event) => {
    const shift = !!event?.shiftKey;
    const toggle = !!(event?.metaKey || event?.ctrlKey);
    const anchor = shift ? itemOf(st.anchor) : null;
    if (anchor) {
      const a = indexOf.get(anchor.key);
      const b = indexOf.get(item.key);
      if (!toggle) clearAll();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) setOn(order[i], true);
    } else if (toggle) {
      setOn(item, !isOn(item));
      st.anchor = item.key;
    } else {
      clearAll();
      setOn(item, true);
      st.anchor = item.key;
    }
    st.cursor = item.key;
    // Shift 누름은 mousedown 에서 막아 포커스가 안 오므로 여기서 목록에 준다(이어서 화살표로 범위를 늘릴 수 있게).
    if (event instanceof MouseEvent) list.focus({ preventScroll: true });
    paintSelection();
    notify();
  };
  const select = (entry, event) => pick(itemOf(fileKey(entry.path)), event);
  const selectFolder = (folder, event) => pick(itemOf(folderKey(folder.path)), event);

  // 우클릭·Enter·Delete 의 대상: 고른 것 중 하나면 고른 것 전부, 아니면 그 파일 하나.
  const picked = (entry) => {
    const all = selectedEntries(st, entries);
    return all.length > 1 && all.includes(entry) ? all : [entry];
  };

  const fileRow = ({ entry, depth, showDir }) => {
    const key = opts.keyOf?.(entry);
    const action = opts.rowAction?.labelOf ? opts.rowAction.labelOf(entry) : opts.rowAction;
    const hidden = !!eye?.isHidden(entry.path);
    return el('div', {
      class: `file-row${selected.has(entry.path) ? ' selected' : ''}${key && key === activeKey() ? ' active' : ''}${st.cursor === fileKey(entry.path) ? ' cursor' : ''}${hidden ? ' is-hidden' : ''}`,
      'data-path': entry.path,
      'data-key': fileKey(entry.path),
      'data-diff-key': key ?? null,
      style: depth || eye ? { paddingLeft: pad(depth) } : null,
      onmousedown: (event) => {
        // Shift 로 누를 때 글자가 끌려 선택되지 않게.
        if (event.shiftKey) event.preventDefault();
      },
      // 마우스를 올리면(누르기 전에) 알린다 — 커밋 파일은 diff 를 미리 읽어 두어 누를 때 바로 보이게.
      onpointerenter: opts.onHover && ((event) => { if (event.pointerType !== 'touch') opts.onHover(entry); }),
      onclick: (event) => {
        if (event.target.closest('button')) return;
        select(entry, event);
        // 마우스 클릭은 { toggle: true } 를 넘긴다 — 이미 열린 파일을 다시 누르면 diff 를 닫는다(키보드 이동은 닫지 않는다).
        if (!event.shiftKey && !(event.metaKey || event.ctrlKey)) opts.onOpen?.(entry, { toggle: true });
      },
      ondblclick: (event) => {
        if (!event.target.closest('button')) opts.onActivate?.([entry]);
      },
      oncontextmenu: opts.onMenu && ((event) => {
        event.preventDefault();
        if (!selected.has(entry.path) && !selectedEntries(st, entries).includes(entry)) select(entry);
        opts.onMenu(event, picked(entry), entry);
      }),
    },
    eyeButton(entry.path, hidden),
    // 툴팁은 상태 그림·아이콘에만 단다(원본과 같다 — 줄 전체에 달면 아래 줄을 덮는다).
    el('span', { class: 'file-badges' }, stateIcon(entry.state), fileIcon(entry.path)),
    el('span', { class: 'file-name', text: showDir ? entry.path : splitPath(entry.path).name }),
    entry.originalPath ? el('span', { class: 'file-orig', text: `← ${entry.originalPath}` }) : null,
    entry.note ? el('span', { class: 'file-note', text: entry.note }) : null,
    action ? el('button', { class: `row-action ${action.kind}`, text: action.label, onclick: () => (action.run ?? opts.rowAction.run)(entry) }) : null);
  };

  const folderRow = ({ folder, depth, collapsed: isCollapsed }) => {
    const hidden = !!eye?.isHidden(folder.path);
    return el('div', {
      class: `file-row folder${st.folders.has(folder.path) ? ' selected' : ''}${st.cursor === folderKey(folder.path) ? ' cursor' : ''}${hidden ? ' is-hidden' : ''}`,
      style: { paddingLeft: pad(depth) }, 'data-folder': folder.path, 'data-key': folderKey(folder.path),
      onmousedown: (event) => {
        if (event.shiftKey) event.preventDefault();
      },
      onclick: (event) => {
        // 눈 버튼은 제 일만 한다. 화살표는 펼치고 접고, 줄은 고른다(원본 TreeView).
        if (event.target.closest('button')) return;
        if (event.target.closest('.side-chev')) opts.onToggleFolder?.(folder.path);
        else selectFolder(folder, event);
      },
      ondblclick: (event) => {
        if (!event.target.closest('.side-chev, button')) opts.onToggleFolder?.(folder.path);
      },
      oncontextmenu: opts.onFolderMenu && ((event) => {
        event.preventDefault();
        if (!st.folders.has(folder.path)) selectFolder(folder);
        // 이 폴더 말고도 고른 것이 있으면 고른 것 전부에 대한 파일 메뉴(여럿)를 띄운다.
        const all = selectedEntries(st, entries);
        const mine = folderFiles(folder);
        if (opts.onMenu && (st.folders.size > 1 || all.length > mine.length)) opts.onMenu(event, all, mine[0]);
        else opts.onFolderMenu(event, folder, mine, { expandAll: () => opts.onSetCollapsed?.([]), collapseAll: () => opts.onSetCollapsed?.(allFolders(tree)) });
      }),
    }, eyeButton(folder.path, hidden), el('span', { class: `side-chev${isCollapsed ? '' : ' open'}` }, icon('chevronRight', 12)), icon('folder', 16, 'folder-icon'),
    // 폴더는 파일 수를 보이지 않는다. 접힌 폴더만 아래 파일의 상태별 수를 보인다(펼치면 아래 파일이 다 보인다).
    el('span', { class: 'file-name', text: folder.name }),
    isCollapsed ? el('span', { class: 'file-summary' }, stateSummary(folderFiles(folder)).flatMap(([state, n]) => [stateIcon(state), el('span', { class: 'file-summary-count', text: n })])) : null);
  };

  const drawRow = (item) => {
    const node = item.entry ? fileRow(item) : folderRow(item);
    opts.decorateRow?.(node, item);
    return node;
  };

  // 그려 둔 줄의 범위 [first, last).
  let first = 0;
  let last = 0;
  const drawRange = (from, to) => {
    first = from;
    last = to;
    rows.style.transform = from ? `translateY(${from * rowHeight}px)` : '';
    rows.replaceChildren(...order.slice(from, to).map(drawRow));
  };
  /** 화면에 보이는 줄을 고른다. 이미 그려 둔 범위 안이면 그대로 둔다(force 면 다시 그린다). */
  const paintRows = (force = false) => {
    if (!order.length) return;
    if (!list.isConnected) {
      if (force || last === 0) drawRange(0, Math.min(order.length, FIRST_ROWS));
      return;
    }
    const box = list.getBoundingClientRect();
    // 숨겨진 칸(display: none)이면 크기가 없다 — 다시 보일 때 크기 감시가 다시 부른다.
    if (!box.width && !box.height) return;
    const origin = space.getBoundingClientRect().top;
    const top = Math.max(box.top, 0) - origin;
    const bottom = Math.min(box.bottom, window.innerHeight) - origin;
    const from = Math.max(0, Math.min(order.length - 1, Math.floor(top / rowHeight)));
    const to = Math.min(order.length, Math.max(from + 1, Math.ceil(bottom / rowHeight)));
    if (!force && from >= first && to <= last) return;
    drawRange(Math.max(0, from - OVERSCAN), Math.min(order.length, to + OVERSCAN));
    // 줄 높이가 CSS 와 다르면(글자 크기 설정 등) 잰 값으로 다시 맞춘다.
    const measured = rows.firstElementChild?.getBoundingClientRect().height;
    if (measured && Math.abs(measured - rowHeight) > 0.5) {
      rowHeight = measured;
      space.style.height = `${order.length * rowHeight}px`;
      paintRows(true);
    }
  };
  list.paintRows = () => paintRows();
  list.addEventListener('scroll', () => paintRows(), { passive: true });

  /** 그 줄로 굴린다. 아직 그리지 않은 줄이면 먼저 그 둘레를 그린다. */
  const reveal = (item, block = 'nearest') => {
    const index = indexOf.get(item?.key);
    if (index == null) return;
    if (index < first || index >= last) drawRange(Math.max(0, index - OVERSCAN), Math.min(order.length, index + OVERSCAN + 1));
    rows.children[index - first]?.scrollIntoView({ block });
    paintRows();
  };
  list.revealPath = (path, block) => reveal(itemOf(fileKey(path)), block);
  list.folderPaths = () => (tree ? allFolders(tree) : []);

  if (!entries.length) {
    list.append(el('div', { class: 'empty muted small', text: opts.empty ?? t('파일이 없습니다.') }));
  } else {
    space.style.height = `${order.length * rowHeight}px`;
    list.append(space);
    paintRows();
    // 화면에 붙으면 크기를 재어 보이는 줄을 맞추고, 그 뒤로는 크기가 바뀔 때(칸 경계 끌기 등)마다 다시 고른다.
    let tries = 0;
    const attach = () => {
      if (!list.isConnected) {
        if (++tries < 30) requestAnimationFrame(attach);
        return;
      }
      pruneLists();
      liveLists.add(list);
      resizeObserver?.observe(list);
      paintRows(true);
    };
    if (list.isConnected) attach();
    else requestAnimationFrame(attach);
  }

  list.addEventListener('keydown', (event) => {
    if (event.target !== list) return;
    const current = indexOf.get(st.cursor) ?? -1;
    const cursorItem = order[current];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = order[current < 0 ? 0 : Math.max(0, Math.min(order.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (!next) return;
      // Shift+화살표: anchor 는 두고 범위를 늘리고 줄인다.
      pick(next, event.shiftKey ? { shiftKey: true } : null);
      if (next.entry && !event.shiftKey) opts.onOpen?.(next.entry);
      reveal(next);
    } else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && cursorItem?.folder) {
      // 폴더에서 → 는 펼치고 ← 는 접는다.
      event.preventDefault();
      const open = event.key === 'ArrowRight';
      if (cursorItem.collapsed === open) opts.onToggleFolder?.(cursorItem.folder.path);
    } else if (event.key === 'ArrowLeft' && cursorItem?.entry && view === 'tree') {
      // 파일에서 ← 는 그 파일이 든 폴더 줄로 간다.
      event.preventDefault();
      const dir = cursorItem.entry.path.split('/').slice(0, -1).join('/');
      const parent = dir && itemOf(folderKey(dir));
      if (parent) {
        pick(parent, null);
        reveal(parent);
      }
    } else if (event.key.toLowerCase() === 'a' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
      // Cmd/Ctrl+A: 보이는 줄 전부.
      event.preventDefault();
      clearAll();
      for (const item of order) setOn(item, true);
      paintSelection();
      notify();
    } else if (event.key === 'Enter' && cursorItem) {
      event.preventDefault();
      const targets = selectedEntries(st, entries);
      opts.onActivate?.(cursorItem.entry ? picked(cursorItem.entry) : targets);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && opts.onDelete) {
      // 고른 파일들의 변경을 버릴지 묻는다(원본 StagingLists.OnDeleteKey). 폴더를 골랐으면 그 아래 전부.
      const targets = selectedEntries(st, entries);
      if (!targets.length) return;
      event.preventDefault();
      opts.onDelete(targets);
    } else if (eye && event.code === 'KeyH' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      // H: 고른 줄을 숨긴다(이미 숨긴 줄이면 다시 보인다). 한글 자판에서도 되게 글쇠 자리(code)로 본다.
      const paths = selectionPaths(st);
      if (!paths.length) return;
      event.preventDefault();
      eye.toggle(paths, {});
    } else if (event.key === ' ') {
      // Space 는 아무것도 하지 않는다(원본 IgnoreSpace).
      event.preventDefault();
    }
  });

  // 트리 위 [모두 펼치기 / 모두 접기](원본 FileTree 의 GitKraken 식 글자 버튼). 다 펼쳐져 있으면 접기, 아니면 펼치기.
  if (tree && opts.expandToggle) {
    const folders = allFolders(tree);
    if (folders.length) {
      const allOpen = folders.every((f) => !opts.collapsed?.has(f));
      const toolbar = el('div', { class: 'file-tree-toolbar' },
        el('button', { class: 'expand-toggle', text: allOpen ? t('모두 접기') : t('모두 펼치기'), onclick: () => opts.onSetCollapsed?.(allOpen ? folders : []) }));
      return el('div', { class: 'file-browser' }, toolbar, list);
    }
  }
  return list;
}

/** 그 안의 파일 목록에서 그 파일 줄로 굴린다(보이는 줄만 그리므로 아직 없는 줄도 그려서). */
export function revealFile(container, path, block = 'nearest') {
  const list = container?.querySelector('.file-list');
  list?.revealPath?.(path, block);
}
