// 왼쪽 사이드바. 원본 Elements/RefSidebar.cs·RefTreeBuilder.cs 를 옮겼다.
// 맨 위 필터 칸, 구역(로컬 · 원격(원격별) · 태그 · Stash · 워크트리 · 서브모듈), '/' 로 묶는 폴더 트리, 줄 끝 ⋮, 구역 머리 hover 의 "+",
// 키보드(↑↓ 이동, ←→ 접기·펼치기, Enter = 더블클릭 동작). 접힘 상태와 필터 값은 기억한다.

import { el, relativeTime } from './util.js';
import { icon } from './icons.js';

const DEFAULT_OPEN = new Set(['local', 'remote']);

/**
 * ctx: { state, prefs, menus: {local, remote, remoteHeader, tag, stash, worktree, submodule, section(id, event)},
 *        activate(node), add(sectionId), reveal(hash), laneColorOf(hash) }
 */
export function createSidebar(container, ctx) {
  const filter = el('input', { class: 'side-filter-input', placeholder: '필터', spellcheck: 'false', autocomplete: 'off' });
  filter.value = ctx.prefs.get('sidebar.filter') ?? '';
  const clear = el('button', { class: 'side-filter-clear', 'data-tip': '지우기', onclick: () => { filter.value = ''; onFilter(); filter.focus(); } }, icon('close', 12));
  const tree = el('div', { class: 'side-tree', tabindex: '0', role: 'tree' });
  container.append(el('div', { class: 'side-filter' }, icon('search', 14), filter, clear), tree);

  const open = new Set(ctx.prefs.get('sidebar.open') ?? [...DEFAULT_OPEN]);
  const closed = new Set(ctx.prefs.get('sidebar.closed') ?? []);
  let focused = null; // node key
  let nodes = []; // 보이는 줄 차례(키보드용)

  const isOpen = (key, defaultOpen) => (open.has(key) ? true : closed.has(key) ? false : defaultOpen);
  function toggle(key, defaultOpen) {
    if (isOpen(key, defaultOpen)) {
      open.delete(key);
      closed.add(key);
    } else {
      closed.delete(key);
      open.add(key);
    }
    ctx.prefs.set('sidebar.open', [...open]);
    ctx.prefs.set('sidebar.closed', [...closed]);
    render();
  }

  let filterTimer = 0;
  function onFilter() {
    clear.hidden = !filter.value;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => ctx.prefs.set('sidebar.filter', filter.value), 400);
    render();
  }
  filter.addEventListener('input', onFilter);
  filter.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      filter.value = '';
      onFilter();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      tree.focus();
      move(1);
    }
  });

  // ── 트리 만들기 ──

  /** 이름을 '/' 로 나눠 폴더 트리로. items: [{name, …}] → [{folder, name, children} | {leaf}] */
  function folderTree(items, nameOf) {
    const root = { children: new Map(), leaves: [] };
    for (const item of items) {
      const parts = nameOf(item).split('/');
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!node.children.has(part)) node.children.set(part, { children: new Map(), leaves: [] });
        node = node.children.get(part);
      }
      node.leaves.push({ item, label: parts[parts.length - 1] });
    }
    return root;
  }

  function matches(text) {
    const q = filter.value.trim().toLowerCase();
    return !q || text.toLowerCase().includes(q);
  }

  /** 걸린 잎과 그 조상만 남긴 트리를 줄로 편다. */
  function emitTree(out, node, depth, keyPrefix, leafRow) {
    const filtering = !!filter.value.trim();
    for (const [name, child] of [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const childRows = [];
      emitTree(childRows, child, depth + 1, `${keyPrefix}/${name}`, leafRow);
      if (!childRows.length) continue;
      const key = `${keyPrefix}/${name}/`;
      const expanded = filtering || isOpen(key, true);
      out.push({ key, depth, folder: true, label: name, expanded, toggle: () => toggle(key, true), count: childRows.filter((r) => !r.folder).length });
      if (expanded) out.push(...childRows);
    }
    for (const leaf of node.leaves) {
      const row = leafRow(leaf.item, leaf.label, depth);
      if (row) out.push(row);
    }
  }

  function track(branch) {
    const parts = [];
    if (branch.ahead) parts.push(el('span', { class: 'ahead', text: `↑${branch.ahead}` }));
    if (branch.behind) parts.push(el('span', { class: 'behind', text: `↓${branch.behind}` }));
    if (branch.gone) parts.push(el('span', { class: 'gone', 'data-tip': '원격 브랜치가 지워졌습니다', text: 'gone' }));
    return parts.length ? el('span', { class: 'side-track' }, parts) : null;
  }

  function sections() {
    const state = ctx.state;
    const refs = state.refs ?? { local: [], remote: [], tags: [], stashes: [], remotes: [] };
    const remotes = state.remotes ?? refs.remotes.map((name) => ({ name, fetchUrl: '' }));
    const list = [];

    // 로컬
    const localRows = [];
    const locals = refs.local.length ? refs.local : state.status?.branch.name && !state.status.branch.detached
      ? [{ name: state.status.branch.name, current: true, hash: '', ahead: 0, behind: 0 }] : [];
    emitTree(localRows, folderTree(locals.filter((b) => matches(b.name)), (b) => b.name), 1, 'local', (b, label, depth) => ({
      key: `local:${b.name}`, depth, label, glyph: 'laptop', bold: b.current, check: b.current,
      tip: `${b.name}${b.upstream ? ` → ${b.upstream}` : ''}`, extra: track(b),
      onClick: () => b.hash && ctx.reveal(b.hash),
      activate: () => ctx.activate({ kind: 'local', branch: b }),
      menu: (e) => ctx.menus.local(e, b),
    }));
    list.push({ id: 'local', title: '로컬', glyph: 'laptop', count: refs.local.length, rows: localRows, empty: '로컬 브랜치가 없습니다' });

    // 원격(원격마다 하위 구역)
    const remoteRows = [];
    for (const remote of remotes) {
      const branches = refs.remote.filter((b) => b.remote === remote.name);
      const shown = branches.filter((b) => matches(b.name));
      const key = `remote:${remote.name}`;
      if (filter.value.trim() && !shown.length && !matches(remote.name)) continue;
      const github = /github\.com/i.test(remote.fetchUrl ?? '');
      const expanded = filter.value.trim() ? true : isOpen(key, true);
      remoteRows.push({
        key, depth: 1, folder: true, label: remote.name, glyph: github ? 'github' : 'cloud', expanded, toggle: () => toggle(key, true), count: branches.length,
        tip: remote.fetchUrl, menu: (e) => ctx.menus.remoteHeader(e, remote), activate: () => toggle(key, true),
      });
      if (!expanded) continue;
      emitTree(remoteRows, folderTree(shown, (b) => b.name.slice(remote.name.length + 1)), 2, key, (b, label, depth) => ({
        key: `remote:${b.name}`, depth, label, glyph: github ? 'github' : 'cloud', tip: b.name,
        onClick: () => ctx.reveal(b.hash),
        activate: () => ctx.activate({ kind: 'remote', branch: b }),
        menu: (e) => ctx.menus.remote(e, b),
      }));
    }
    list.push({ id: 'remote', title: '원격', glyph: 'cloud', count: remotes.length, rows: remoteRows, empty: '원격이 없습니다', add: '원격 추가' });

    // 태그
    const tagRows = [];
    emitTree(tagRows, folderTree(refs.tags.filter((t) => matches(t.name)), (t) => t.name), 1, 'tags', (t, label, depth) => ({
      key: `tag:${t.name}`, depth, label, glyph: 'tag', tip: t.subject ? `${t.name}\n${t.subject}` : t.name,
      onClick: () => ctx.reveal(t.hash),
      activate: () => ctx.activate({ kind: 'tag', tag: t }),
      menu: (e) => ctx.menus.tag(e, t),
    }));
    list.push({ id: 'tags', title: '태그', glyph: 'tag', count: refs.tags.length, rows: tagRows, empty: '태그가 없습니다' });

    // Stash
    const stashRows = refs.stashes.filter((s) => matches(s.message)).map((s) => ({
      key: `stash:${s.name}`, depth: 1, label: s.message.replace(/^(WIP on|On) [^:]+: /, ''), glyph: 'stash',
      tip: `${s.name} · ${relativeTime(s.time)}\n${s.message}`,
      activate: () => ctx.activate({ kind: 'stash', stash: s }),
      menu: (e) => ctx.menus.stash(e, s),
    }));
    list.push({ id: 'stash', title: 'Stash', glyph: 'stash', count: refs.stashes.length, rows: stashRows, empty: '스태시가 없습니다' });

    // 워크트리
    const worktrees = (state.worktrees ?? []).filter((w) => !w.bare);
    const worktreeRows = worktrees.filter((w) => matches(w.path) || matches(w.branch ?? '')).map((w) => ({
      key: `worktree:${w.path}`, depth: 1, label: w.branch ?? `(분리됨) ${w.head.slice(0, 7)}`, glyph: 'worktree', bold: w.current, check: w.current,
      tip: w.path, sub: w.path.split(/[\\/]/).pop(),
      activate: () => ctx.activate({ kind: 'worktree', worktree: w }),
      menu: (e) => ctx.menus.worktree(e, w),
    }));
    list.push({ id: 'worktrees', title: '워크트리', glyph: 'worktree', count: worktrees.length, rows: worktreeRows, empty: '워크트리가 없습니다', add: '워크트리 추가' });

    // 서브모듈
    const subs = state.submodules ?? [];
    const subRows = subs.filter((s) => matches(s.path)).map((s) => ({
      key: `submodule:${s.path}`, depth: 1, label: s.path, glyph: 'submodule',
      tip: `${s.url}\n${{ ok: '기록된 커밋과 같습니다', modified: '기록된 커밋과 다른 커밋입니다', uninitialized: '아직 받지 않았습니다', conflict: '충돌' }[s.state]}`,
      extra: s.state === 'ok' ? el('span', { class: 'side-ok' }, icon('check', 14))
        : el('span', { class: `side-sub-state ${s.state}`, text: { modified: '바뀜', uninitialized: '받지 않음', conflict: '충돌' }[s.state] }),
      activate: () => ctx.activate({ kind: 'submodule', submodule: s }),
      menu: (e) => ctx.menus.submodule(e, s),
    }));
    list.push({ id: 'submodules', title: '서브모듈', glyph: 'submodule', count: subs.length, rows: subRows, empty: '서브모듈이 없습니다', add: '서브모듈 추가' });

    // Pull Requests (GitHub 원격이 있을 때만)
    if (ctx.pullRequests) {
      const pr = ctx.pullRequests();
      if (pr) list.push(pr);
    }
    return list;
  }

  // ── 그리기 ──

  function rowElement(row) {
    const element = el('div', {
      class: `side-item${row.bold ? ' current' : ''}${row.folder ? ' folder' : ''}${row.key === focused ? ' focused' : ''}`,
      'data-key': row.key,
      'data-tip': row.tip ?? null,
      'data-tip-side': 'below',
      role: 'treeitem',
      style: { paddingLeft: `${8 + row.depth * 14}px` },
      onclick: (event) => {
        focused = row.key;
        markFocus();
        if (event.target.closest('.side-more')) return;
        if (row.folder && !event.target.closest('.side-more')) row.toggle();
        else row.onClick?.();
      },
      ondblclick: (event) => {
        if (!row.folder && !event.target.closest('.side-more')) row.activate?.();
      },
      oncontextmenu: row.menu && ((event) => {
        event.preventDefault();
        focused = row.key;
        markFocus();
        row.menu(event);
      }),
    },
    row.folder ? el('span', { class: `side-chev${row.expanded ? ' open' : ''}` }, icon('chevronRight', 12)) : el('span', { class: 'side-chev' }),
    icon(row.folder && !row.glyph ? 'folder' : row.glyph, 16, 'side-icon'),
    el('span', { class: 'side-name', text: row.label }),
    row.sub ? el('span', { class: 'side-sub muted small', text: row.sub }) : null,
    row.extra ?? null,
    row.check ? el('span', { class: 'side-check' }, icon('check', 14)) : null,
    row.folder && row.count != null ? el('span', { class: 'side-count', text: row.count }) : null,
    row.menu ? el('button', {
      class: 'side-more', 'data-tip': '메뉴',
      onclick: (event) => {
        event.stopPropagation();
        const r = event.currentTarget.getBoundingClientRect();
        row.menu({ clientX: r.left, clientY: r.bottom + 2, preventDefault() {} });
      },
    }, icon('moreVert', 14)) : null);
    return element;
  }

  function render() {
    const list = sections();
    const filtering = !!filter.value.trim();
    nodes = [];
    const children = [];
    list.forEach((section, index) => {
      if (filtering && !section.rows.length) return;
      const key = `section:${section.id}`;
      const expanded = filtering || isOpen(key, DEFAULT_OPEN.has(section.id));
      const header = el('div', {
        class: `side-section${expanded ? ' open' : ''}${key === focused ? ' focused' : ''}`,
        'data-key': key,
        onclick: (event) => {
          if (event.target.closest('.side-add')) return;
          focused = key;
          toggle(key, DEFAULT_OPEN.has(section.id));
        },
        oncontextmenu: (event) => {
          event.preventDefault();
          ctx.menus.section(section.id, event);
        },
      },
      el('span', { class: `side-chev${expanded ? ' open' : ''}` }, icon('chevronRight', 12)),
      icon(section.glyph, 15, 'side-section-icon'),
      el('span', { class: 'side-section-title', text: section.title }),
      el('span', { class: 'side-section-count', text: section.count }),
      section.add ? el('button', {
        class: 'side-add', 'data-tip': section.add,
        onclick: (event) => {
          event.stopPropagation();
          ctx.add(section.id);
        },
      }, icon('plus', 14)) : null);
      if (index > 0) children.push(el('div', { class: 'side-divider' }));
      children.push(header);
      nodes.push({ key, activate: () => toggle(key, DEFAULT_OPEN.has(section.id)), toggle: () => toggle(key, DEFAULT_OPEN.has(section.id)), expanded, section: true });
      if (!expanded) return;
      if (!section.rows.length) {
        children.push(el('div', { class: 'side-empty muted small', text: section.empty }));
        return;
      }
      for (const row of section.rows) {
        children.push(rowElement(row));
        nodes.push(row);
      }
    });
    if (filtering && !children.length) children.push(el('div', { class: 'side-empty muted small', text: '걸리는 항목이 없습니다' }));
    const scroll = tree.scrollTop;
    tree.replaceChildren(...children);
    tree.scrollTop = scroll;
  }

  // ── 키보드 ──

  function markFocus() {
    for (const node of tree.querySelectorAll('[data-key]')) node.classList.toggle('focused', node.dataset.key === focused);
    tree.querySelector('.focused')?.scrollIntoView({ block: 'nearest' });
  }

  function move(delta) {
    let index = nodes.findIndex((n) => n.key === focused);
    index = Math.max(0, Math.min(nodes.length - 1, index + delta));
    focused = nodes[index]?.key ?? null;
    markFocus();
    const node = nodes[index];
    if (node?.onClick) node.onClick();
  }

  tree.addEventListener('keydown', (event) => {
    const node = nodes.find((n) => n.key === focused);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'ArrowRight' && node && (node.folder || node.section) && !node.expanded) {
      event.preventDefault();
      node.toggle();
      markFocus();
    } else if (event.key === 'ArrowLeft' && node && (node.folder || node.section) && node.expanded) {
      event.preventDefault();
      node.toggle();
      markFocus();
    } else if (event.key === 'Enter' && node) {
      event.preventDefault();
      if (node.folder) node.toggle();
      else node.activate?.();
    }
  });

  clear.hidden = !filter.value;
  return { render, focusFilter: () => filter.focus() };
}
