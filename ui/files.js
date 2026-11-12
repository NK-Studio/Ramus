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

/** 고른 파일 전부(목록 순서). 고른 폴더는 그 아래 파일 전부로 센다(원본 FileTree.SelectedFiles). */
export function selectedEntries(st, entries) {
  const folders = [...(st.folders ?? [])];
  return entries.filter((e) => st.selected.has(e.path) || folders.some((f) => e.path.startsWith(`${f}/`)));
}

/** 고른 줄의 경로(폴더는 폴더 경로 그대로). 고른 폴더 아래의 폴더·파일은 그 폴더에 들어 있으니 뺀다 — 숨기기처럼 폴더째 다루는 동작이 쓴다. */
export function selectionPaths(st) {
  const folders = [...(st.folders ?? [])];
  const inside = (path) => folders.some((f) => path.startsWith(`${f}/`));
  return [...folders.filter((f) => !inside(f)), ...[...st.selected].filter((p) => !inside(p))];
}

/**
 * 파일 목록. opts:
 *  entries: [{path, originalPath, state, note}], view: 'path'|'tree',
 *  state: {selected: Set<path>, folders: Set<folderPath>, anchor, cursor} (그리기 사이에 남는 선택. anchor·cursor 는 줄 키 'f:경로'|'d:폴더'),
 *  activeKey, keyOf(entry), collapsed: Set<folderPath>, onToggleFolder(path), onSetCollapsed(paths[]),
 *  onSelect(entries), onOpen(entry, { toggle }?), onActivate(entries), onMenu(event, entries, clicked), onFolderMenu(event, folder, entries, {expandAll, collapseAll}),
 *  onDelete(entries), rowAction: {label, kind, run(entry), labelOf(entry)} | null, expandToggle: 트리 위 [모두 펼치기/접기], empty: '…',
 *  eye: {isHidden(path), toggle(paths[], {solo})} | null — 줄 맨 왼쪽의 눈 버튼(마우스를 올린 줄에만 보인다). 누르면 그 줄을 숨기고,
 *       Alt(Option) 로 누르면 그 줄만 남긴다. 숨긴 줄(isHidden)은 흐리게 그리고 꺼진 눈을 늘 보인다. H 키는 고른 줄 전부에.
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
  const st = opts.state ?? { selected: new Set(), anchor: null };
  st.folders ??= new Set();
  const selected = st.selected;
  // 목록에서 사라진 파일은 선택에서 뺀다.
  for (const path of [...selected]) if (!entries.some((e) => e.path === path)) selected.delete(path);
  for (const folder of [...st.folders]) if (view !== 'tree' || !entries.some((e) => e.path.startsWith(`${folder}/`))) st.folders.delete(folder);
  // 보이는 줄 순서(폴더 줄 포함). Shift 범위·화살표 이동이 이 순서를 따른다(원본 TreeView SelectionType.Multiple).
  // 줄: {key, entry} 또는 {key, folder}. anchor 는 Shift 범위의 시작, cursor 는 마지막으로 누른(옮겨 간) 줄.
  const order = [];
  const fileKey = (path) => `f:${path}`;
  const folderKey = (path) => `d:${path}`;
  const itemOf = (key) => order.find((item) => item.key === key);
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

  const paintSelection = () => {
    for (const row of list.querySelectorAll('.file-row')) {
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
      const a = order.indexOf(anchor);
      const b = order.indexOf(item);
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

  const row = (entry, depth, showDir) => {
    const key = opts.keyOf?.(entry);
    const action = opts.rowAction?.labelOf ? opts.rowAction.labelOf(entry) : opts.rowAction;
    const hidden = !!eye?.isHidden(entry.path);
    order.push({ key: fileKey(entry.path), entry });
    return el('div', {
      class: `file-row${selected.has(entry.path) ? ' selected' : ''}${key && key === opts.activeKey ? ' active' : ''}${st.cursor === fileKey(entry.path) ? ' cursor' : ''}${hidden ? ' is-hidden' : ''}`,
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

  const children = [];
  let tree = null;
  if (!entries.length) {
    children.push(el('div', { class: 'empty muted small', text: opts.empty ?? t('파일이 없습니다.') }));
  } else if (view === 'tree') {
    tree = buildTree(entries);
    const emit = (node, depth) => {
      for (const folder of [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const isCollapsed = opts.collapsed?.has(folder.path);
        const hidden = !!eye?.isHidden(folder.path);
        order.push({ key: folderKey(folder.path), folder, collapsed: isCollapsed });
        children.push(el('div', {
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
        isCollapsed ? el('span', { class: 'file-summary' }, stateSummary(folderFiles(folder)).flatMap(([state, n]) => [stateIcon(state), el('span', { class: 'file-summary-count', text: n })])) : null));
        if (!isCollapsed) emit(folder, depth + 1);
      }
      for (const entry of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) children.push(row(entry, depth + 1, false));
    };
    emit(tree, 0);
  } else {
    for (const entry of entries) children.push(row(entry, 0, true));
  }
  list.replaceChildren(...children);

  const reveal = (item) => list.querySelector(`.file-row[data-key="${CSS.escape(item.key)}"]`)?.scrollIntoView({ block: 'nearest' });

  list.addEventListener('keydown', (event) => {
    if (event.target !== list) return;
    const current = order.findIndex((item) => item.key === st.cursor);
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
