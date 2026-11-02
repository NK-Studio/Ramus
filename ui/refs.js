// 브랜치·태그·stash: 왼쪽 사이드바, 커밋 우클릭 메뉴, 도구 막대의 브랜치·Stash·Pop. 작업은 모두 확인을 거쳐 Rust 에 맡긴다.

import { el, relativeTime } from './util.js';
import { confirmDialog, formDialog, showMenu } from './dialogs.js';

/**
 * ctx: { call, act(label, work, {success}), state, reveal(hash), laneColorOf(hash) }
 */
export function createRefs(ctx) {
  const { call, act } = ctx;
  const collapsed = new Set(loadCollapsed());

  function loadCollapsed() {
    try {
      return JSON.parse(localStorage.getItem('gitvcs.collapsed') || '[]');
    } catch {
      return [];
    }
  }

  function saveCollapsed() {
    try {
      localStorage.setItem('gitvcs.collapsed', JSON.stringify([...collapsed]));
    } catch {
      // 저장 못 해도 동작은 같다.
    }
  }

  const current = () => ctx.state.refs?.local.find((b) => b.current);
  const remoteOf = () => current()?.upstream?.split('/')[0] || ctx.state.refs?.remotes[0] || 'origin';
  const run = (label, cmd, args, success) => act(label, () => call(cmd, args), success ? { success: () => success } : {});

  // ── 작업 ───────────────────────────────────────────

  async function createBranch(start = 'HEAD', startLabel = '지금 커밋') {
    const values = await formDialog({
      title: '새 브랜치',
      message: `${startLabel} 에서 시작합니다.`,
      fields: [
        { name: 'name', label: '브랜치 이름', placeholder: 'feature/새-기능' },
        { name: 'checkout', type: 'checkbox', label: '만든 뒤 체크아웃', value: true },
      ],
      ok: '만들기',
      validate: (v) => (v.name.trim() ? null : '이름을 적어 주세요.'),
    });
    if (!values) return;
    await run('브랜치를 만드는 중…', 'createBranch', { name: values.name.trim(), start, checkout: values.checkout }, `브랜치 '${values.name.trim()}' 를 만들었습니다.`);
  }

  async function checkout(name, remote = false) {
    await run(`${name} 로 체크아웃하는 중…`, 'checkout', { name, remote }, `${remote ? name.replace(/^[^/]+\//, '') : name} 로 바꿨습니다.`);
  }

  async function checkoutCommit(hash) {
    if (!(await confirmDialog({
      title: '커밋 체크아웃',
      message: `${hash.slice(0, 7)} 을 브랜치 없이 봅니다(detached HEAD). 이 상태에서 만든 커밋은 브랜치를 만들지 않으면 잃기 쉽습니다.`,
      ok: '체크아웃',
    }))) return;
    await run('체크아웃하는 중…', 'checkoutDetached', { hash }, `${hash.slice(0, 7)} 을 체크아웃했습니다.`);
  }

  async function renameBranch(name) {
    const values = await formDialog({
      title: '브랜치 이름 바꾸기',
      fields: [{ name: 'name', label: '새 이름', value: name }],
      ok: '바꾸기',
      validate: (v) => (v.name.trim() ? null : '이름을 적어 주세요.'),
    });
    if (values && values.name.trim() !== name) await run('이름을 바꾸는 중…', 'renameBranch', { old: name, new: values.name.trim() });
  }

  async function deleteBranch(name) {
    const values = await formDialog({
      title: '브랜치 지우기',
      message: `로컬 브랜치 '${name}' 를 지웁니다. 원격 브랜치는 그대로입니다.`,
      fields: [{ name: 'force', type: 'checkbox', label: '병합하지 않은 커밋이 있어도 강제로 지우기' }],
      ok: '지우기',
      danger: true,
    });
    if (values) await run('브랜치를 지우는 중…', 'deleteBranch', { name, force: values.force }, `'${name}' 를 지웠습니다.`);
  }

  async function deleteRemoteBranch(branch) {
    const short = branch.name.slice(branch.remote.length + 1);
    if (!(await confirmDialog({ title: '원격 브랜치 지우기', message: `원격 '${branch.remote}' 에서 '${short}' 를 지웁니다. 다른 사람도 더는 볼 수 없습니다.`, ok: '지우기', danger: true }))) return;
    await run('원격 브랜치를 지우는 중…', 'deleteRemoteBranch', { remote: branch.remote, branch: short }, `${branch.name} 를 지웠습니다.`);
  }

  async function merge(revision, label = revision) {
    const into = current()?.name ?? 'HEAD';
    if (!(await confirmDialog({ title: '병합', message: `'${label}' 를 '${into}' 에 병합합니다.`, ok: '병합' }))) return;
    await run('병합하는 중…', 'merge', { revision }, `'${label}' 를 병합했습니다.`);
  }

  async function rebase(revision, label = revision) {
    const branch = current()?.name ?? 'HEAD';
    if (!(await confirmDialog({
      title: 'Rebase',
      message: `'${branch}' 의 커밋을 '${label}' 위로 옮깁니다. 이미 푸시한 커밋이면 다시 푸시할 때 강제 푸시가 필요합니다.`,
      ok: 'Rebase',
    }))) return;
    await run('Rebase 하는 중…', 'rebase', { revision }, 'Rebase 했습니다.');
  }

  async function createTag(hash) {
    const values = await formDialog({
      title: '태그 만들기',
      message: `${hash.slice(0, 7)} 에 태그를 붙입니다.`,
      fields: [
        { name: 'name', label: '태그 이름', placeholder: 'v1.0.0' },
        { name: 'message', type: 'textarea', label: '메시지 (적으면 주석 태그)', rows: 3 },
      ],
      ok: '만들기',
      validate: (v) => (v.name.trim() ? null : '이름을 적어 주세요.'),
    });
    if (values) await run('태그를 만드는 중…', 'createTag', { name: values.name.trim(), hash, message: values.message }, `태그 '${values.name.trim()}' 를 만들었습니다.`);
  }

  async function reset(hash) {
    const branch = current()?.name ?? 'HEAD';
    const values = await formDialog({
      title: `'${branch}' 를 여기로 reset`,
      message: `${branch} 를 ${hash.slice(0, 7)} 로 옮깁니다.`,
      fields: [{
        name: 'mode', type: 'select', label: '방식', value: 'mixed',
        options: [
          { value: 'soft', label: 'Soft — 바뀐 내용을 Stage 한 채로 남김' },
          { value: 'mixed', label: 'Mixed — 바뀐 내용을 작업 트리에 남김 (기본)' },
          { value: 'hard', label: 'Hard — 바뀐 내용을 모두 버림 (되돌릴 수 없음)' },
        ],
      }],
      ok: 'Reset',
      danger: true,
    });
    if (!values) return;
    if (values.mode === 'hard' && !(await confirmDialog({ title: 'Hard reset', message: '작업 중인 변경과 그 뒤의 커밋이 모두 사라집니다. 계속할까요?', ok: '모두 버리고 reset', danger: true }))) return;
    await run('Reset 하는 중…', 'reset', { hash, mode: values.mode }, 'Reset 했습니다.');
  }

  async function stashPush() {
    const values = await formDialog({
      title: 'Stash',
      message: '작업 중인 변경(새 파일 포함)을 잠시 치워 둡니다.',
      fields: [{ name: 'message', label: '메모 (선택)', placeholder: '무엇을 하던 중인지' }],
      ok: 'Stash',
    });
    if (values) await run('Stash 하는 중…', 'stashPush', { message: values.message }, 'Stash 했습니다.');
  }

  async function stashPop(name = 'stash@{0}') {
    await run('Stash 를 되돌리는 중…', 'stashApply', { name, pop: true }, 'Stash 를 되돌리고 지웠습니다.');
  }

  async function stashDrop(stash) {
    if (!(await confirmDialog({ title: 'Stash 지우기', message: `${stash.name}: ${stash.message}\n\n되돌릴 수 없습니다.`, ok: '지우기', danger: true }))) return;
    await run('Stash 를 지우는 중…', 'stashDrop', { name: stash.name }, 'Stash 를 지웠습니다.');
  }

  // ── 메뉴 ───────────────────────────────────────────

  function localMenu(event, branch) {
    const cur = current();
    showMenu(event.clientX, event.clientY, [
      { label: '체크아웃', disabled: branch.current, action: () => checkout(branch.name) },
      { label: `'${branch.name}' 를 '${cur?.name}' 에 병합`, disabled: branch.current || !cur, action: () => merge(branch.name) },
      { label: `'${cur?.name}' 를 '${branch.name}' 위로 Rebase`, disabled: branch.current || !cur, action: () => rebase(branch.name) },
      '-',
      { label: '여기서 새 브랜치…', action: () => createBranch(branch.name, branch.name) },
      { label: '이름 바꾸기…', action: () => renameBranch(branch.name) },
      { label: '이름 복사', action: () => navigator.clipboard?.writeText(branch.name) },
      '-',
      { label: '지우기…', danger: true, disabled: branch.current, action: () => deleteBranch(branch.name) },
    ]);
  }

  function remoteMenu(event, branch) {
    const cur = current();
    showMenu(event.clientX, event.clientY, [
      { label: '체크아웃 (로컬 브랜치로)', action: () => checkout(branch.name, true) },
      { label: `'${branch.name}' 를 '${cur?.name}' 에 병합`, disabled: !cur, action: () => merge(branch.name) },
      { label: `'${cur?.name}' 를 '${branch.name}' 위로 Rebase`, disabled: !cur, action: () => rebase(branch.name) },
      '-',
      { label: '여기서 새 브랜치…', action: () => createBranch(branch.name, branch.name) },
      { label: '이름 복사', action: () => navigator.clipboard?.writeText(branch.name) },
      '-',
      { label: '원격에서 지우기…', danger: true, action: () => deleteRemoteBranch(branch) },
    ]);
  }

  function tagMenu(event, tag) {
    showMenu(event.clientX, event.clientY, [
      { label: '이 태그 체크아웃', action: () => checkoutCommit(tag.hash) },
      { label: `원격(${remoteOf()})에 푸시`, disabled: !(ctx.state.refs?.remotes.length), action: () => run('태그를 푸시하는 중…', 'pushTag', { remote: remoteOf(), name: tag.name }, `태그 '${tag.name}' 를 푸시했습니다.`) },
      { label: '이름 복사', action: () => navigator.clipboard?.writeText(tag.name) },
      '-',
      {
        label: '지우기 (로컬)…', danger: true,
        action: async () => {
          if (await confirmDialog({ title: '태그 지우기', message: `로컬 태그 '${tag.name}' 를 지웁니다.`, ok: '지우기', danger: true })) await run('태그를 지우는 중…', 'deleteTag', { name: tag.name });
        },
      },
    ]);
  }

  function stashMenu(event, stash) {
    showMenu(event.clientX, event.clientY, [
      { label: 'Pop (되돌리고 지우기)', action: () => stashPop(stash.name) },
      { label: 'Apply (되돌리고 남겨 두기)', action: () => run('Stash 를 적용하는 중…', 'stashApply', { name: stash.name, pop: false }, 'Stash 를 적용했습니다.') },
      '-',
      { label: '지우기…', danger: true, action: () => stashDrop(stash) },
    ]);
  }

  /** 그래프의 커밋 줄 우클릭. */
  function commitMenu(event, commit) {
    const cur = current();
    const isMerge = commit.parents.length > 1;
    const branchesHere = (ctx.state.refs?.local ?? []).filter((b) => b.hash === commit.hash && !b.current);
    showMenu(event.clientX, event.clientY, [
      ...branchesHere.map((b) => ({ label: `'${b.name}' 체크아웃`, action: () => checkout(b.name) })),
      { label: '이 커밋 체크아웃 (detached)', action: () => checkoutCommit(commit.hash) },
      '-',
      { label: '여기서 새 브랜치…', action: () => createBranch(commit.hash, commit.shortHash) },
      { label: '태그 만들기…', action: () => createTag(commit.hash) },
      '-',
      { label: `Cherry-pick → '${cur?.name ?? 'HEAD'}'`, action: () => run('Cherry-pick 하는 중…', 'cherryPick', { hash: commit.hash, merge: isMerge }, 'Cherry-pick 했습니다.') },
      {
        label: 'Revert (되돌리는 커밋 만들기)',
        action: async () => {
          if (await confirmDialog({ title: 'Revert', message: `${commit.shortHash} "${commit.subject}" 를 되돌리는 새 커밋을 만듭니다.`, ok: 'Revert' })) {
            await run('Revert 하는 중…', 'revert', { hash: commit.hash, merge: isMerge }, 'Revert 했습니다.');
          }
        },
      },
      { label: `'${cur?.name ?? 'HEAD'}' 를 여기로 Reset…`, action: () => reset(commit.hash) },
      { label: `'${cur?.name ?? 'HEAD'}' 에 병합`, action: () => merge(commit.hash, commit.shortHash) },
      { label: `'${cur?.name ?? 'HEAD'}' 를 여기 위로 Rebase`, action: () => rebase(commit.hash, commit.shortHash) },
      '-',
      { label: 'SHA 복사', action: () => navigator.clipboard?.writeText(commit.hash) },
      { label: '메시지 복사', action: () => navigator.clipboard?.writeText(commit.subject) },
    ]);
  }

  // ── 사이드바 ────────────────────────────────────────

  function group(id, title, count, children, extra) {
    const isCollapsed = collapsed.has(id);
    return el('div', { class: `side-group${isCollapsed ? ' collapsed' : ''}` },
      el('div', {
        class: 'side-title',
        onclick: () => {
          if (collapsed.has(id)) collapsed.delete(id);
          else collapsed.add(id);
          saveCollapsed();
          renderSidebar(ctx.sidebar);
        },
      }, el('span', { class: 'chev', text: isCollapsed ? '▸' : '▾' }), title, el('span', { class: 'count', text: count }), extra),
      isCollapsed ? null : children);
  }

  function track(branch) {
    const parts = [];
    if (branch.ahead) parts.push(el('span', { class: 'ahead', text: `↑${branch.ahead}` }));
    if (branch.behind) parts.push(el('span', { class: 'behind', text: `↓${branch.behind}` }));
    if (branch.gone) parts.push(el('span', { class: 'gone', title: '원격 브랜치가 지워졌습니다', text: 'gone' }));
    return parts.length ? el('span', { class: 'side-track' }, parts) : null;
  }

  function item({ name, title, color, current: isCurrent, onClick, onDouble, onMenu, extra, indent = 0 }) {
    return el('div', {
      class: `side-item${isCurrent ? ' current' : ''}`,
      title: title ?? name,
      style: { paddingLeft: `${20 + indent * 12}px` },
      onclick: onClick,
      ondblclick: onDouble,
      oncontextmenu: onMenu && ((event) => { event.preventDefault(); onMenu(event); }),
    }, el('span', { class: 'side-dot', style: { background: color } }), el('span', { class: 'side-name', text: name }), extra,
    isCurrent ? el('span', { class: 'side-check', text: '✓' }) : null);
  }

  function renderSidebar(container) {
    const refs = ctx.state.refs;
    if (!refs) return;
    const color = (hash) => ctx.laneColorOf(hash);
    const local = refs.local.map((b) => item({
      name: b.name, color: color(b.hash), current: b.current,
      title: `${b.name}${b.upstream ? ` → ${b.upstream}` : ''}\n더블클릭: 체크아웃`,
      extra: track(b),
      onClick: () => ctx.reveal(b.hash),
      onDouble: () => !b.current && checkout(b.name),
      onMenu: (e) => localMenu(e, b),
    }));
    // 아직 커밋이 없는 저장소: 브랜치 이름만.
    if (!refs.local.length && ctx.state.status?.branch.name) local.push(item({ name: ctx.state.status.branch.name, color: 'var(--git-text-muted)', current: true }));

    const remoteGroups = refs.remotes.map((remote) => {
      const branches = refs.remote.filter((b) => b.remote === remote);
      return group(`remote:${remote}`, remote, branches.length, branches.map((b) => item({
        name: b.name.slice(remote.length + 1), title: `${b.name}\n더블클릭: 로컬 브랜치로 체크아웃`, color: color(b.hash), indent: 1,
        onClick: () => ctx.reveal(b.hash),
        onDouble: () => checkout(b.name, true),
        onMenu: (e) => remoteMenu(e, b),
      })));
    });

    const tags = refs.tags.map((t) => item({
      name: t.name, title: t.subject ? `${t.name}\n${t.subject}` : t.name, color: 'var(--git-graph-pill-tag)',
      onClick: () => ctx.reveal(t.hash),
      onMenu: (e) => tagMenu(e, t),
    }));

    const stashes = refs.stashes.map((s) => item({
      name: s.message.replace(/^(WIP on|On) [^:]+: /, ''), title: `${s.name} · ${relativeTime(s.time)}\n${s.message}\n더블클릭: Pop`, color: 'var(--git-text-muted)',
      onDouble: () => stashPop(s.name),
      onMenu: (e) => stashMenu(e, s),
    }));

    container.replaceChildren(
      group('local', '로컬', refs.local.length, local,
        el('button', { class: 'side-add', title: '새 브랜치', text: '+', onclick: (e) => { e.stopPropagation(); createBranch(); } })),
      group('remote', '원격', refs.remote.length, remoteGroups.length ? remoteGroups : el('div', { class: 'side-empty muted small', text: '원격이 없습니다' })),
      group('tags', '태그', refs.tags.length, tags),
      group('stash', 'Stash', refs.stashes.length, stashes));
  }

  return { renderSidebar, commitMenu, createBranch, stashPush, stashPop, checkout, current };
}
