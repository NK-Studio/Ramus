// 왼쪽 사이드바. 원본 Elements/RefSidebar.cs·RefTreeBuilder.cs 를 옮겼다.
// 맨 위 필터 칸, 구역(로컬 · 리모트(원격별) · 워크트리 · 스태시 · Pull Requests · 서브모듈 · 태그), '/' 로 묶는 폴더 트리(폴더는 눌러 접고 펼침, 원격은 늘 펼침),
// 브랜치 줄 끝 ⋮, 구역 머리 hover 의 "+",
// 키보드(↑↓ 이동, ←→ 접기·펼치기, Enter = 더블클릭 동작). 접힘 상태와 필터 값은 기억한다.

import { el, relativeTime } from './util.js';
import { icon } from './icons.js';

const DEFAULT_OPEN = new Set(['local', 'remote', 'prs']);

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

  /**
   * 걸린 잎과 그 조상만 남긴 트리를 줄로 편다. 폴더는 줄을 누르면 접고 펼친다(기본은 펼침, 접힘은 기억한다).
   * 화살표 같은 표시는 달지 않는다(화살표 자리는 남겨 들여쓰기를 맞춘다). 필터로 찾는 동안은 걸린 것이 보이게 늘 펼친다.
   */
  function emitTree(out, node, depth, keyPrefix, leafRow) {
    for (const [name, child] of [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const childRows = [];
      emitTree(childRows, child, depth + 1, `${keyPrefix}/${name}`, leafRow);
      if (!childRows.length) continue;
      const key = `${keyPrefix}/${name}/`;
      const expanded = !!filter.value.trim() || isOpen(key, true);
      out.push({ key, depth, folder: true, bare: true, label: name, glyph: 'folder', expanded, toggle: () => toggle(key, true) });
      if (expanded) out.push(...childRows);
    }
    for (const leaf of node.leaves) {
      const row = leafRow(leaf.item, leaf.label, depth);
      if (row) out.push(row);
    }
  }

  /** 원본 GitRefs.TrackBadge: "3↑ 1↓" 을 색 없이 흐린 글자 하나로(ref-tree__badge). upstream 이 지워진 것은 배지 없이 설명에만. */
  function track(branch) {
    const parts = [];
    if (branch.ahead) parts.push(`${branch.ahead}↑`);
    if (branch.behind) parts.push(`${branch.behind}↓`);
    return parts.length ? el('span', { class: 'side-track', text: parts.join(' ') }) : null;
  }

  /** 원본 RefTreeBuilder.BranchLeaf 설명: "main  →  origin/main [ahead 1, behind 2]" (지워졌으면 [gone]). */
  function branchTip(branch) {
    if (!branch.upstream) return branch.name;
    const counts = [];
    if (branch.ahead) counts.push(`ahead ${branch.ahead}`);
    if (branch.behind) counts.push(`behind ${branch.behind}`);
    const state = branch.gone ? '[gone]' : counts.length ? `[${counts.join(', ')}]` : '';
    return `${branch.name}  →  ${branch.upstream} ${state}`.trimEnd();
  }

  /** 원본 RefTreeBuilder.SubmoduleBadge: 받지 않음 −, 다른 커밋 +, 충돌 !. 맞으면 배지 대신 왼쪽 초록 체크. */
  const SUBMODULE_BADGE = { uninitialized: '−', modified: '+', conflict: '!' };

  /** 구역 순서는 원본 RefSection 과 같다: 로컬 · 리모트 · 워크트리 · 스태시 · Pull Requests · 서브모듈 · 태그. */
  function sections() {
    const state = ctx.state;
    const refs = state.refs ?? { local: [], remote: [], tags: [], stashes: [], remotes: [] };
    const remotes = state.remotes ?? refs.remotes.map((name) => ({ name, fetchUrl: '' }));
    const list = [];

    // 로컬. 줄 그림은 원본처럼 브랜치(구역 머리만 노트북).
    const localRows = [];
    const locals = refs.local.length ? refs.local : state.status?.branch.name && !state.status.branch.detached
      ? [{ name: state.status.branch.name, current: true, hash: '', ahead: 0, behind: 0 }] : [];
    emitTree(localRows, folderTree(locals.filter((b) => matches(b.name)), (b) => b.name), 1, 'local', (b, label, depth) => ({
      key: `local:${b.name}`, depth, label, glyph: 'branch', bold: b.current, check: b.current, more: true,
      tip: branchTip(b), extra: track(b),
      onClick: () => b.hash && ctx.reveal(b.hash),
      activate: () => ctx.activate({ kind: 'local', branch: b }),
      menu: (e) => ctx.menus.local(e, b),
    }));
    list.push({ id: 'local', title: '로컬', glyph: 'laptop', count: refs.local.length, rows: localRows, empty: '로컬 브랜치가 없습니다' });

    // 리모트(원격마다 묶음). 원격 줄도 폴더처럼 늘 펼쳐 둔다. 머리 개수는 원격 브랜치 수.
    const remoteRows = [];
    for (const remote of remotes) {
      const branches = refs.remote.filter((b) => b.remote === remote.name);
      const shown = branches.filter((b) => matches(b.name));
      if (filter.value.trim() && !shown.length && !matches(remote.name)) continue;
      const github = /github\.com/i.test(remote.fetchUrl ?? '');
      remoteRows.push({
        key: `remote:${remote.name}`, depth: 1, folder: true, fixed: true, label: remote.name, glyph: github ? 'github' : 'cloud',
        tip: remote.fetchUrl, more: false, menu: (e) => ctx.menus.remoteHeader(e, remote),
      });
      emitTree(remoteRows, folderTree(shown, (b) => b.name.slice(remote.name.length + 1)), 2, `remote:${remote.name}`, (b, label, depth) => ({
        key: `remote:${b.name}`, depth, label, glyph: 'branch', tip: b.name, more: true,
        onClick: () => ctx.reveal(b.hash),
        activate: () => ctx.activate({ kind: 'remote', branch: b }),
        menu: (e) => ctx.menus.remote(e, b),
      }));
    }
    list.push({ id: 'remote', title: '리모트', glyph: 'cloud', count: refs.remote.length, rows: remoteRows, empty: '원격이 없습니다', add: '원격 레포지토리 추가' });

    // 워크트리: 이름은 폴더 이름, 옆에 브랜치(분리된 HEAD 면 짧은 해시).
    const worktrees = (state.worktrees ?? []).filter((w) => !w.bare);
    const worktreeRows = worktrees.filter((w) => matches(w.path) || matches(w.branch ?? '')).map((w) => ({
      key: `worktree:${w.path}`, depth: 1, label: w.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop(), glyph: 'folder', bold: w.current, check: w.current,
      tip: `작업 폴더:  ${w.path}`, sub: w.branch ?? w.head.slice(0, 7), more: false,
      activate: () => ctx.activate({ kind: 'worktree', worktree: w }),
      menu: (e) => ctx.menus.worktree(e, w),
    }));
    list.push({ id: 'worktrees', title: '워크트리', glyph: 'worktree', count: worktrees.length, rows: worktreeRows, empty: '워크트리가 없습니다', add: '새 워크트리 만들기' });

    // 스태시
    const stashRows = refs.stashes.filter((s) => matches(s.message)).map((s) => ({
      key: `stash:${s.name}`, depth: 1, label: s.message.replace(/^(WIP on|On) [^:]+: /, ''), glyph: 'stash',
      tip: `${s.name}  ·  ${relativeTime(s.time)}\n${s.message}`, more: false,
      activate: () => ctx.activate({ kind: 'stash', stash: s }),
      menu: (e) => ctx.menus.stash(e, s),
    }));
    list.push({ id: 'stash', title: '스태시', glyph: 'stash', count: refs.stashes.length, rows: stashRows, empty: '스태시가 없습니다' });

    // Pull Requests (GitHub 원격이 있을 때만)
    if (ctx.pullRequests) {
      const pr = ctx.pullRequests({ isOpen, toggle, filter: filter.value });
      if (pr) list.push(pr);
    }

    // 서브모듈: 기록된 커밋과 맞으면 왼쪽(화살표 자리)에 초록 체크, 아니면 오른쪽에 −·+·! 배지.
    const subs = state.submodules ?? [];
    const subRows = subs.filter((s) => matches(s.path)).map((s) => ({
      key: `submodule:${s.path}`, depth: 1, label: s.path, glyph: 'submodule', synced: s.state === 'ok',
      tip: `${s.path}\n${(s.hash ?? '').slice(0, 7)}`.trim(),
      badge: SUBMODULE_BADGE[s.state] ?? null, more: false,
      activate: () => ctx.activate({ kind: 'submodule', submodule: s }),
      menu: (e) => ctx.menus.submodule(e, s),
    }));
    list.push({ id: 'submodules', title: '서브모듈', glyph: 'submodule', count: subs.length, rows: subRows, empty: '서브모듈이 없습니다', add: '서브모듈 추가' });

    // 태그
    const tagRows = [];
    emitTree(tagRows, folderTree(refs.tags.filter((t) => matches(t.name)), (t) => t.name), 1, 'tags', (t, label, depth) => ({
      key: `tag:${t.name}`, depth, label, glyph: 'tag', tip: t.subject ? `${t.name}\n${t.subject}` : t.name, more: false,
      onClick: () => ctx.reveal(t.hash),
      activate: () => ctx.activate({ kind: 'tag', tag: t }),
      menu: (e) => ctx.menus.tag(e, t),
    }));
    list.push({ id: 'tags', title: '태그', glyph: 'tag', count: refs.tags.length, rows: tagRows, empty: '태그가 없습니다' });
    return list;
  }

  // ── 그리기 ──

  function rowElement(row) {
    // 줄 대신 그대로 넣는 요소(PR 검색 칸).
    if (row.element) return row.element;
    if (row.info) {
      return el('div', {
        class: `side-info muted small${row.activate ? ' action' : ''}`, 'data-key': row.key, 'data-tip': row.tip ?? row.label ?? null, 'data-tip-side': 'below',
        style: { paddingLeft: `${8 + row.depth * 14 + 18}px` },
        ondblclick: () => row.activate?.(),
      }, el('span', { class: 'side-info-text', text: row.label }));
    }
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
        // 폴더·원격 줄(fixed)은 늘 펼쳐 두어 누를 것이 없다.
        if (row.folder && !row.fixed) row.toggle();
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
    row.folder && !row.fixed && !row.bare ? el('span', { class: `side-chev${row.expanded ? ' open' : ''}` }, icon('chevronRight', 12))
      : el('span', { class: `side-chev${row.synced ? ' synced' : ''}` }, row.synced ? icon('check', 12) : null),
    row.plain ? null : icon(row.folder && !row.glyph ? 'folder' : row.glyph, 16, 'side-icon'),
    el('span', { class: 'side-name', text: row.label }),
    row.sub ? el('span', { class: 'side-sub muted small', text: row.sub }) : null,
    row.extra ?? null,
    row.check ? el('span', { class: 'side-check' }, icon('check', 14)) : null,
    row.folder && row.count != null ? el('span', { class: 'side-count', text: row.count }) : null,
    row.badge ? el('span', { class: 'side-count side-badge', text: row.badge }) : null,
    // 줄 끝 ⋮ 는 원본처럼 브랜치·PR 줄에만(나머지는 우클릭).
    row.menu && (row.more ?? true) ? el('button', {
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
      // 빈 구역도 다른 구역처럼 접고 펼친다. 펼쳐 두면 안내 한 줄("…이 없습니다")을 보인다.
      const expanded = filtering || isOpen(key, DEFAULT_OPEN.has(section.id));
      const flip = () => toggle(key, DEFAULT_OPEN.has(section.id));
      const header = el('div', {
        class: `side-section${expanded ? ' open' : ''}${key === focused ? ' focused' : ''}`,
        'data-key': key,
        onclick: (event) => {
          if (event.target.closest('.side-add')) return;
          focused = key;
          flip();
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
        class: 'side-add', 'data-tip': section.add, 'data-tip-side': 'right',
        onclick: (event) => {
          event.stopPropagation();
          ctx.add(section.id);
        },
      }, icon('plus', 14)) : null);
      if (index > 0) children.push(el('div', { class: 'side-divider' }));
      children.push(header);
      nodes.push({ key, activate: flip, toggle: flip, expanded, section: true });
      if (!expanded) return;
      if (!section.rows.length) {
        children.push(el('div', { class: 'side-empty muted small', text: section.empty }));
        return;
      }
      for (const row of section.rows) {
        children.push(rowElement(row));
        if (!row.element && !row.info) nodes.push(row);
      }
    });
    if (filtering && !children.length) children.push(el('div', { class: 'side-empty muted small', text: '걸리는 항목이 없습니다' }));
    const scroll = tree.scrollTop;
    // 구역 안 입력 칸(PR 검색)에 쓰는 중이면 다시 그린 뒤에도 포커스·커서를 그대로 둔다.
    const active = tree.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
    const caret = active ? [active.selectionStart, active.selectionEnd] : null;
    tree.replaceChildren(...children);
    tree.scrollTop = scroll;
    if (active?.isConnected) {
      active.focus();
      active.setSelectionRange(...caret);
    }
  }

  /** 그 구역을 펼치고 머리가 보이게 스크롤한다(아래쪽 상태 줄의 풀 리퀘스트 칸). */
  function revealSection(id) {
    const key = `section:${id}`;
    if (!isOpen(key, DEFAULT_OPEN.has(id))) toggle(key, DEFAULT_OPEN.has(id));
    else render();
    tree.querySelector(`[data-key="${key}"]`)?.scrollIntoView({ block: 'start' });
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
    // 구역 안 입력 칸(PR 검색)의 글쇠는 트리 이동으로 받지 않는다.
    if (event.target instanceof HTMLInputElement) return;
    const node = nodes.find((n) => n.key === focused);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'ArrowRight' && node && ((node.folder && !node.fixed) || node.section) && !node.expanded) {
      event.preventDefault();
      node.toggle();
      markFocus();
    } else if (event.key === 'ArrowLeft' && node && ((node.folder && !node.fixed) || node.section) && node.expanded) {
      event.preventDefault();
      node.toggle();
      markFocus();
    } else if (event.key === 'Enter' && node) {
      event.preventDefault();
      if (node.folder) node.toggle?.();
      else node.activate?.();
    }
  });

  clear.hidden = !filter.value;
  return { render, revealSection, focusFilter: () => filter.focus() };
}
