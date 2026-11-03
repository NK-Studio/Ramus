// 파일 목록 부품: 스테이징 목록·커밋 상세·비교 창이 함께 쓴다. 원본 Elements/FileBrowser·FileTree·FileTreeBuilder·FileRowBinder·StateBadge 를 옮겼다.
// [경로 | 트리] 보기, 여러 선택(Shift=범위, ⌘/Ctrl=하나씩), 상태 그림(수정=연필 · 추가=+ · 삭제=−, 이름 변경·충돌 표시), 파일 종류 아이콘,
// 폴더 트리(폴더 먼저·이름순, 하위 하나뿐인 폴더는 한 줄로, 폴더 굵게+파일 수, 접힘 기억), 키보드(↑↓·Enter·Delete).

import { el, splitPath } from './util.js';
import { icon } from './icons.js';

export const STATE_LABEL = { modified: '수정', added: '추가', deleted: '삭제', renamed: '이름 바뀜', untracked: '새 파일', conflicted: '충돌' };
export const CHANGE_STATE = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'renamed', T: 'modified' };

/** 상태 그림 12px. 수정=연필(원래 색) · 추가=+ · 삭제=− 는 상태 색, 이름 변경·충돌은 따로 그린다. */
export function stateIcon(state) {
  const box = el('span', { class: `state-icon st-${state}`, 'data-tip': STATE_LABEL[state] });
  if (state === 'renamed') box.append(icon('chevronRight', 12));
  else if (state === 'conflicted') box.append(icon('warning', 12));
  return box;
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

/** 경로/트리 두 칸 묶음. */
export function viewSwitch(view, onChange) {
  return el('div', { class: 'seg view-switch' },
    el('button', { class: view === 'path' ? 'on' : '', 'data-tip': '경로로 보기', onclick: () => onChange('path') }, icon('pathList', 14), el('span', { class: 'seg-text', text: '경로' })),
    el('button', { class: view === 'tree' ? 'on' : '', 'data-tip': '폴더 트리로 보기', onclick: () => onChange('tree') }, icon('fileTree', 14), el('span', { class: 'seg-text', text: '트리' })));
}

/** 파일들을 폴더 트리로: 폴더 먼저·이름순, 자식이 폴더 하나뿐이면 한 줄로 합친다. */
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
  const compact = (node) => {
    for (const child of node.folders.values()) compact(child);
    // 파일 없이 폴더 하나만 든 폴더는 이름을 이어 붙인다(a/b/c).
    for (const [key, child] of [...node.folders.entries()]) {
      let c = child;
      while (c.files.length === 0 && c.folders.size === 1) {
        const only = [...c.folders.values()][0];
        c = { ...only, name: `${c.name}/${only.name}` };
      }
      if (c !== child) node.folders.set(key, c);
    }
  };
  compact(root);
  return root;
}

const countFiles = (node) => node.files.length + [...node.folders.values()].reduce((n, f) => n + countFiles(f), 0);
export const folderFiles = (node) => [...node.files, ...[...node.folders.values()].flatMap(folderFiles)];

/**
 * 파일 목록. opts:
 *  entries: [{path, originalPath, state, note}], view: 'path'|'tree', state: {selected: Set<path>, anchor: path} (그리기 사이에 남는 선택), activeKey, keyOf(entry),
 *  collapsed: Set<folderPath>, onToggleFolder(path), onSelect(selectedSet, entry), onOpen(entry), onActivate(entries),
 *  onMenu(event, entries), onFolderMenu(event, folder, entries), onDelete(entries), rowAction: {label, kind, run(entry), labelOf(entry)} | null,
 *  empty: '…'
 */
export function fileList(opts) {
  const { entries, view = 'path' } = opts;
  const st = opts.state ?? { selected: new Set(), anchor: null };
  const selected = st.selected;
  // 목록에서 사라진 파일은 선택에서 뺀다.
  for (const path of [...selected]) if (!entries.some((e) => e.path === path)) selected.delete(path);
  const order = [];
  const anchorEntry = () => order.find((e) => e.path === st.anchor);
  const list = el('div', { class: 'file-list', tabindex: '0', role: 'listbox' });

  const select = (entry, event) => {
    if (event?.shiftKey && anchorEntry()) {
      const a = order.indexOf(anchorEntry());
      const b = order.indexOf(entry);
      if (!(event.metaKey || event.ctrlKey)) selected.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(order[i].path);
    } else if (event?.metaKey || event?.ctrlKey) {
      if (selected.has(entry.path)) selected.delete(entry.path);
      else selected.add(entry.path);
      st.anchor = entry.path;
    } else {
      selected.clear();
      selected.add(entry.path);
      st.anchor = entry.path;
    }
    for (const row of list.querySelectorAll('.file-row')) row.classList.toggle('selected', selected.has(row.dataset.path));
    opts.onSelect?.(selected, entry, event);
  };

  const picked = (entry) => (selected.has(entry.path) && selected.size > 1 ? entries.filter((e) => selected.has(e.path)) : [entry]);

  const row = (entry, depth, showDir) => {
    const { dir, name } = splitPath(entry.path);
    const key = opts.keyOf?.(entry);
    const action = opts.rowAction?.labelOf ? opts.rowAction.labelOf(entry) : opts.rowAction;
    order.push(entry);
    return el('div', {
      class: `file-row${selected.has(entry.path) ? ' selected' : ''}${key && key === opts.activeKey ? ' active' : ''}`,
      'data-path': entry.path,
      'data-tip': entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path,
      'data-tip-side': 'below',
      style: depth ? { paddingLeft: `${10 + depth * 14}px` } : null,
      onclick: (event) => {
        if (event.target.closest('button')) return;
        select(entry, event);
        if (!event.shiftKey && !(event.metaKey || event.ctrlKey)) opts.onOpen?.(entry);
      },
      ondblclick: (event) => {
        if (!event.target.closest('button')) opts.onActivate?.([entry]);
      },
      oncontextmenu: opts.onMenu && ((event) => {
        event.preventDefault();
        if (!selected.has(entry.path)) select(entry);
        opts.onMenu(event, picked(entry));
      }),
    },
    stateIcon(entry.state),
    fileIcon(entry.path),
    el('span', { class: 'file-name', text: name }),
    showDir && dir ? el('span', { class: 'file-dir', text: dir.replace(/\/$/, '') }) : null,
    entry.originalPath ? el('span', { class: 'file-orig', text: `← ${entry.originalPath}` }) : null,
    entry.note ? el('span', { class: 'file-note', text: entry.note }) : null,
    action ? el('button', { class: `row-action ${action.kind}`, text: action.label, onclick: () => (action.run ?? opts.rowAction.run)(entry) }) : null);
  };

  const children = [];
  if (!entries.length) {
    children.push(el('div', { class: 'empty muted small', text: opts.empty ?? '파일이 없습니다.' }));
  } else if (view === 'tree') {
    const emit = (node, depth) => {
      for (const folder of [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const isCollapsed = opts.collapsed?.has(folder.path);
        children.push(el('div', {
          class: 'file-row folder', style: { paddingLeft: `${10 + depth * 14}px` }, 'data-folder': folder.path,
          onclick: () => opts.onToggleFolder?.(folder.path),
          oncontextmenu: opts.onFolderMenu && ((event) => {
            event.preventDefault();
            opts.onFolderMenu(event, folder, folderFiles(folder));
          }),
        }, el('span', { class: `side-chev${isCollapsed ? '' : ' open'}` }, icon('chevronRight', 12)), icon('folder', 16, 'folder-icon'),
        el('span', { class: 'file-name', text: folder.name }), el('span', { class: 'file-count', text: countFiles(folder) })));
        if (!isCollapsed) emit(folder, depth + 1);
      }
      for (const entry of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) children.push(row(entry, depth + (depth ? 1 : 0.6), false));
    };
    emit(buildTree(entries), 0);
  } else {
    for (const entry of entries) children.push(row(entry, 0, true));
  }
  list.replaceChildren(...children);

  list.addEventListener('keydown', (event) => {
    if (event.target !== list) return;
    const current = order.findIndex((e) => e.path === st.anchor);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = order[Math.max(0, Math.min(order.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (!next) return;
      select(next, event.shiftKey ? event : null);
      opts.onOpen?.(next);
      list.querySelector(`.file-row[data-path="${CSS.escape(next.path)}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && anchorEntry()) {
      event.preventDefault();
      opts.onActivate?.(picked(anchorEntry()));
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && anchorEntry() && opts.onDelete) {
      event.preventDefault();
      opts.onDelete(picked(anchorEntry()));
    } else if (event.key === ' ') {
      event.preventDefault();
    }
  });
  return list;
}
