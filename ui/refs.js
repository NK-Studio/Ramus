// 브랜치·태그·stash·원격·워크트리·서브모듈·커밋 작업과 그 메뉴, 드로어. 원본 Views/BranchMenu·BranchActions·CommitMenu·CommitActions·RefActions,
// Elements/AddRemoteDrawer·AddWorktreeDrawer·AddSubmoduleDrawer·EditSubmoduleDrawer 를 옮겼다. 작업은 모두 확인을 거쳐 Rust 에 맡긴다.

import { el } from './util.js';
import { icon } from './icons.js';
import { confirmDialog, formDialog, showMenu, openDrawer, searchSelect, pickDialog } from './dialogs.js';
import { branchNameProblem } from './graph.js';

const copy = (text) => navigator.clipboard?.writeText(text);

/**
 * ctx: { call, act(label, work, {success}), state, prefs, graph, reveal(hash), showCommit(hash), openRepo(path), notify(text),
 *        inlineBranches(), beforeInlineBranch(), sidebarElement(), compare(a, b, options), fileManager }
 */
export function createRefs(ctx) {
  const { call, act } = ctx;

  const current = () => ctx.state.refs?.local.find((b) => b.current);
  const remotes = () => ctx.state.refs?.remotes ?? [];
  const busyOp = () => !!ctx.state.status?.operation;
  const remoteOf = () => current()?.upstream?.split('/')[0] || remotes()[0] || 'origin';
  const run = (label, cmd, args, success) => act(label, () => call(cmd, args), success ? { success: () => success } : {});
  const localNames = () => (ctx.state.refs?.local ?? []).map((b) => b.name);
  const fileManager = () => (ctx.state.platform === 'windows' ? '탐색기' : 'Finder');

  // ── 브랜치 ───────────────────────────────────────────

  /** 시작점(이름·HEAD·해시)이 가리키는 커밋 해시. 그래프에 없으면 null. */
  function resolve(start) {
    const history = ctx.state.history;
    if (!history) return null;
    if (start === 'HEAD') return history.head;
    const branch = [...(ctx.state.refs?.local ?? []), ...(ctx.state.refs?.remote ?? [])].find((b) => b.name === start);
    const hash = branch?.hash ?? start;
    return history.commits.some((c) => c.hash === hash) ? hash : null;
  }

  /**
   * 새 브랜치. GitKraken 배치면 그 커밋 줄의 브랜치/태그 칸에 입력란을 띄우고(쓰는 동안 검사, Enter 면 만들고 바로 전환),
   * 그래프에 없는 커밋이거나 다른 배치면 브랜치 만들기 카드로 묻는다.
   */
  async function createBranch(start = 'HEAD', startLabel = '지금 커밋 (HEAD)', { inline = true } = {}) {
    const hash = inline && ctx.inlineBranches?.() ? resolve(start) : null;
    if (hash) {
      ctx.beforeInlineBranch?.();
      const existing = localNames();
      const started = ctx.graph.beginBranchInput(hash, {
        validate: (name) => branchNameProblem(name, existing),
        submit: (name) => run('브랜치를 만드는 중…', 'createBranch', { name, start, checkout: true }, `브랜치 '${name}' 를 만들고 바꿨습니다.`),
      });
      if (started) return;
    }
    const values = await formDialog({
      title: '새 브랜치',
      glyph: 'branch',
      className: 'branch-card',
      message: `시작점: ${startLabel}`,
      fields: [
        { name: 'name', placeholder: 'feature/새-기능', icon: 'branch', hint: "'/' 로 폴더를 나눌 수 있습니다 (feature/login)" },
        { name: 'checkout', type: 'checkbox', label: '만든 뒤 바로 전환', value: true },
      ],
      ok: '만들기',
      validate: (v) => branchNameProblem(v.name, localNames()),
    });
    if (!values) return;
    await run('브랜치를 만드는 중…', 'createBranch', { name: values.name.trim(), start, checkout: values.checkout }, `브랜치 '${values.name.trim()}' 를 만들었습니다.`);
  }

  async function checkout(name, remote = false) {
    await run(`${name} 로 전환하는 중…`, 'checkout', { name, remote }, `${remote ? name.replace(/^[^/]+\//, '') : name} 로 바꿨습니다.`);
  }

  async function checkoutCommit(hash, label) {
    if (!(await confirmDialog({
      title: '커밋으로 전환',
      glyph: 'info',
      message: `${label ?? hash.slice(0, 7)} 을 브랜치 없이 봅니다(detached HEAD). 이 상태에서 만든 커밋은 브랜치를 만들지 않으면 잃기 쉽습니다.`,
      ok: '전환',
    }))) return;
    await run('전환하는 중…', 'checkoutDetached', { hash }, `${label ?? hash.slice(0, 7)} 로 전환했습니다.`);
  }

  async function renameBranch(name) {
    const values = await formDialog({
      title: '브랜치 이름 바꾸기', glyph: 'pencil',
      fields: [{ name: 'name', label: '새 이름', value: name, icon: 'branch' }],
      ok: '바꾸기',
      validate: (v) => (v.name.trim() === name ? '지금 이름과 같습니다.' : branchNameProblem(v.name, localNames())),
    });
    if (values) await run('이름을 바꾸는 중…', 'renameBranch', { old: name, new: values.name.trim() });
  }

  async function deleteBranch(branch) {
    const unmerged = branch.ahead > 0 || !branch.upstream;
    const values = await formDialog({
      title: '브랜치 지우기',
      danger: true,
      message: `로컬 브랜치 '${branch.name}' 를 지웁니다. 원격 브랜치는 그대로입니다. 실행 취소로 되살릴 수 있습니다.`,
      fields: [{ name: 'force', type: 'checkbox', label: '병합하지 않은 커밋이 있어도 강제로 지우기', value: false, hint: unmerged ? '(올리지 않은 커밋이 있을 수 있습니다)' : '' }],
      ok: '지우기',
    });
    if (values) await run('브랜치를 지우는 중…', 'deleteBranch', { name: branch.name, force: values.force }, `'${branch.name}' 를 지웠습니다.`);
  }

  async function deleteRemoteBranch(branch) {
    const short = branch.name.slice(branch.remote.length + 1);
    if (!(await confirmDialog({ title: '원격 브랜치 지우기', message: `원격 '${branch.remote}' 에서 '${short}' 를 지웁니다. 다른 사람도 더는 볼 수 없고 실행 취소로 되살릴 수 없습니다.`, ok: '지우기', danger: true }))) return;
    await run('원격 브랜치를 지우는 중…', 'deleteRemoteBranch', { remote: branch.remote, branch: short }, `${branch.name} 를 지웠습니다.`);
  }

  const MERGE_LABEL = { default: '병합', noFf: '병합 (No-FF)', squash: '병합 (Squash)', ffOnly: '앞으로 감기만' };

  async function merge(revision, label = revision, mode = 'default') {
    const into = current()?.name ?? 'HEAD';
    const note = { noFf: ' 앞으로 감을 수 있어도 병합 커밋을 만듭니다.', squash: ' 변경을 하나로 모아 Stage 하고, 커밋은 직접 합니다.', ffOnly: ' 갈라졌으면 하지 않습니다.' }[mode] ?? '';
    if (!(await confirmDialog({ title: MERGE_LABEL[mode], glyph: 'merge', message: `'${label}' 를 '${into}' 에 합칩니다.${note}`, ok: '병합' }))) return;
    await run('병합하는 중…', 'merge', { revision, mode }, mode === 'squash' ? `'${label}' 의 변경을 Stage 했습니다. 커밋해 마무리하세요.` : `'${label}' 를 병합했습니다.`);
  }

  async function rebase(revision, label = revision) {
    const branch = current()?.name ?? 'HEAD';
    if (!(await confirmDialog({
      title: 'Rebase', glyph: 'branch',
      message: `'${branch}' 의 커밋을 '${label}' 위로 옮깁니다. 이미 푸시한 커밋이면 다시 푸시할 때 강제 푸시가 필요합니다.`,
      ok: 'Rebase',
    }))) return;
    await run('Rebase 하는 중…', 'rebase', { revision, stopOnConflict: ctx.prefs.get('rebase.stop') !== false }, 'Rebase 했습니다.');
  }

  async function pushBranch(branch) {
    const list = remotes();
    if (!list.length) return ctx.addRemote?.();
    let remote = branch.upstream?.split('/')[0];
    if (!remote) {
      remote = list.length > 1 ? await pickDialog({ title: '올릴 원격', glyph: 'push', options: list.map((r) => ({ value: r, label: r })), value: ctx.prefs.get('push.remote') ?? 'origin' }) : list[0];
      if (!remote) return;
      ctx.prefs.set('push.remote', remote);
    }
    await run(`${branch.name} 를 푸시하는 중…`, 'pushBranch', { branch: branch.name, remote, setUpstream: !branch.upstream }, `${branch.name} 를 ${remote} 에 올렸습니다.`);
  }

  async function setUpstream(branch) {
    const options = (ctx.state.refs?.remote ?? []).map((b) => ({ value: b.name, label: b.name }));
    if (!options.length) return ctx.notify('원격 브랜치가 없습니다. 먼저 푸시하거나 원격을 추가하세요.');
    const picked = await pickDialog({ title: `'${branch.name}' 의 upstream`, glyph: 'cloud', options: [{ value: '', label: '(없음 — 추적 끊기)' }, ...options], value: branch.upstream ?? '' });
    if (picked === null) return;
    await run('upstream 을 바꾸는 중…', 'setUpstream', picked ? { branch: branch.name, upstream: picked } : { branch: branch.name }, picked ? `${branch.name} → ${picked}` : '추적을 끊었습니다.');
  }

  async function createTag(hash, label) {
    const values = await formDialog({
      title: '새 태그', glyph: 'tag',
      message: `${label ?? hash.slice(0, 7)} 에 태그를 붙입니다.`,
      fields: [
        { name: 'name', placeholder: 'v1.0.0', icon: 'tag' },
        { name: 'message', type: 'textarea', label: '메시지 (적으면 주석 태그)', rows: 3 },
      ],
      ok: '만들기',
      validate: (v) => (!v.name.trim() ? '이름을 적어 주세요.' : (ctx.state.refs?.tags ?? []).some((t) => t.name === v.name.trim()) ? '같은 이름의 태그가 있습니다.' : /[\s~^:?*[\\]/.test(v.name) ? '공백과 ~ ^ : ? * [ \\ 는 쓸 수 없습니다.' : null),
    });
    if (values) await run('태그를 만드는 중…', 'createTag', { name: values.name.trim(), hash, message: values.message }, `태그 '${values.name.trim()}' 를 만들었습니다.`);
  }

  const RESET_TEXT = {
    soft: '바뀐 내용을 Stage 한 채로 남깁니다.',
    mixed: '바뀐 내용을 작업 트리에 남깁니다.',
    hard: '작업 중인 변경과 그 뒤의 커밋을 모두 버립니다. 커밋은 실행 취소로 되돌릴 수 있지만, 커밋하지 않은 변경은 되살릴 수 없습니다.',
  };

  async function reset(hash, mode) {
    const branch = current()?.name ?? 'HEAD';
    if (!(await confirmDialog({ title: `Reset (${mode[0].toUpperCase()}${mode.slice(1)})`, message: `'${branch}' 를 ${hash.slice(0, 7)} 로 옮깁니다. ${RESET_TEXT[mode]}`, ok: 'Reset', danger: mode === 'hard', glyph: 'warning', tone: 'warning' }))) return;
    await run('Reset 하는 중…', 'reset', { hash, mode }, 'Reset 했습니다.');
  }

  // ── stash ──

  async function stashPush() {
    const values = await formDialog({
      title: '스태시', glyph: 'stash',
      message: '작업 중인 변경(새 파일 포함)을 잠시 치워 둡니다.',
      fields: [{ name: 'message', label: '메모 (선택)', placeholder: '무엇을 하던 중인지' }],
      ok: '스태시',
    });
    if (values) await run('Stash 하는 중…', 'stashPush', { message: values.message }, 'Stash 했습니다.');
  }

  async function stashPop(name = 'stash@{0}') {
    let overlap = null;
    await act('Stash 를 되돌리는 중…', () => call('stashApply', { name, pop: true }), {
      success: () => 'Stash 를 되돌리고 지웠습니다.',
      onError: (error) => {
        if (error?.advice?.kind !== 'localChanges') return false;
        overlap = error;
        return true;
      },
    });
    if (!overlap) return;
    // Pop 이 로컬 변경과 겹치면: 그 변경을 버리고 다시 Pop 할지 묻는다.
    const files = overlap.advice.files;
    if (await confirmDialog({ title: 'Pop 하려니 로컬 변경이 겹칩니다', danger: true, message: `${files.join(', ')}\n\n이 파일들의 로컬 변경을 버리고 다시 Pop 할까요? 버린 변경은 되살릴 수 없습니다.`, ok: '버리고 Pop' })) {
      await act('버리는 중…', () => call('discard', { paths: files }));
      await run('Stash 를 되돌리는 중…', 'stashApply', { name, pop: true }, 'Stash 를 되돌리고 지웠습니다.');
    }
  }

  async function stashDrop(stash) {
    if (!(await confirmDialog({ title: 'Stash 지우기', message: `${stash.name}: ${stash.message}\n\n실행 취소로도 되살릴 수 없습니다.`, ok: '지우기', danger: true }))) return;
    await run('Stash 를 지우는 중…', 'stashDrop', { name: stash.name }, 'Stash 를 지웠습니다.');
  }

  async function stashBranch(stash) {
    const values = await formDialog({
      title: 'Stash 에서 브랜치 만들기', glyph: 'branch',
      message: `${stash.name} 을 만든 커밋에서 새 브랜치를 만들고 그 변경을 되돌립니다.`,
      fields: [{ name: 'name', icon: 'branch', placeholder: 'feature/이어서' }],
      ok: '만들기',
      validate: (v) => branchNameProblem(v.name, localNames()),
    });
    if (values) await run('브랜치를 만드는 중…', 'stashBranch', { name: stash.name, branch: values.name.trim() }, `브랜치 '${values.name.trim()}' 로 바꿨습니다.`);
  }

  /**
   * 이름표·사이드바 줄을 두 번 눌렀을 때: 로컬은 전환, 원격은 같은 이름 로컬로(없으면 추적 브랜치 만들기), 태그는 그 커밋으로(detached),
   * stash 는 변경 보기, 워크트리는 열기, 서브모듈은 편집 드로어. 이미 지금 브랜치거나 진행 중인 작업이 있으면 전환하지 않는다.
   */
  function activate(target) {
    const switching = ['local', 'remote', 'tag', 'current'].includes(target.kind);
    if (switching && busyOp()) {
      ctx.notify('진행 중인 작업을 먼저 끝내세요.');
      return;
    }
    switch (target.kind) {
      case 'local':
        if (!target.branch.current) checkout(target.branch.name);
        break;
      case 'remote': {
        const local = target.branch.name.slice((target.branch.remote ?? '').length + 1);
        if (current()?.name !== local) checkout(target.branch.name, true);
        break;
      }
      case 'tag':
        checkoutCommit(target.tag.hash, `태그 '${target.tag.name}'`);
        break;
      case 'stash':
        ctx.showCommit(target.stash.hash, `${target.stash.name}: ${target.stash.message}`);
        break;
      case 'worktree':
        if (!target.worktree.current) ctx.openRepo(target.worktree.path);
        break;
      case 'submodule':
        editSubmodule(target.submodule);
        break;
      default:
    }
  }

  /** 그래프 이름표를 두 번 눌렀을 때. */
  function activateRef(ref, commit) {
    if (ref.kind === 'current') return;
    if (ref.kind === 'local') activate({ kind: 'local', branch: ctx.state.refs?.local.find((b) => b.name === ref.name) ?? { name: ref.name } });
    else if (ref.kind === 'remote') activate({ kind: 'remote', branch: ctx.state.refs?.remote.find((b) => b.name === ref.name) ?? { name: ref.name, remote: ref.name.split('/')[0] } });
    else if (ref.kind === 'tag') activate({ kind: 'tag', tag: { name: ref.name, hash: commit.hash } });
  }

  // ── 원격 ──

  async function renameRemote(remote) {
    const values = await formDialog({ title: '원격 이름 바꾸기', glyph: 'cloud', fields: [{ name: 'name', label: '새 이름', value: remote.name }], ok: '바꾸기',
      validate: (v) => (!v.name.trim() ? '이름을 적어 주세요.' : /\s/.test(v.name) ? '공백은 쓸 수 없습니다.' : remotes().includes(v.name.trim()) && v.name.trim() !== remote.name ? '같은 이름의 원격이 있습니다.' : null) });
    if (values && values.name.trim() !== remote.name) await run('이름을 바꾸는 중…', 'renameRemote', { old: remote.name, new: values.name.trim() });
  }

  async function editRemoteUrl(remote) {
    const values = await formDialog({
      title: `원격 '${remote.name}' 주소`, glyph: 'cloud',
      fields: [{ name: 'url', label: 'Pull 주소', value: remote.fetchUrl }, { name: 'pushUrl', label: 'Push 주소 (비우면 같음)', value: remote.pushUrl === remote.fetchUrl ? '' : remote.pushUrl }],
      ok: '저장',
      validate: (v) => (v.url.trim() ? null : '주소를 적어 주세요.'),
    });
    if (values) await run('주소를 바꾸는 중…', 'setRemoteUrl', { name: remote.name, url: values.url, pushUrl: values.pushUrl }, '주소를 바꿨습니다.');
  }

  async function removeRemote(remote) {
    if (!(await confirmDialog({ title: '원격 지우기', danger: true, message: `원격 '${remote.name}' 와 그 원격 브랜치 표시를 지웁니다. 서버의 저장소는 그대로입니다.`, ok: '지우기' }))) return;
    await run('원격을 지우는 중…', 'removeRemote', { name: remote.name }, `원격 '${remote.name}' 를 지웠습니다.`);
  }

  /** 원격 추가 드로어: [URL] 이름·Pull 주소·Push 주소 / [GitHub] 기존 저장소·새로 만들기. 더한 뒤 그 원격만 Fetch. */
  function addRemote() {
    openDrawer({
      glyph: 'cloud', title: '원격 추가', anchor: ctx.sidebarElement(),
      build(body, close) {
        let tab = ctx.prefs.get('addRemote.tab') ?? 'url';
        const tabs = el('div', { class: 'seg drawer-tabs' });
        const content = el('div', { class: 'drawer-content' });
        const draw = () => {
          tabs.replaceChildren(
            el('button', { class: tab === 'url' ? 'on' : '', onclick: () => { tab = 'url'; ctx.prefs.set('addRemote.tab', tab); draw(); } }, icon('globe', 14), ' URL'),
            el('button', { class: tab === 'github' ? 'on' : '', onclick: () => { tab = 'github'; ctx.prefs.set('addRemote.tab', tab); draw(); } }, icon('github', 14), ' GitHub'));
          content.replaceChildren(tab === 'url' ? urlForm() : (ctx.githubRemoteForm?.(close) ?? el('div', { class: 'muted small', text: 'GitHub 에 로그인하면 저장소를 고르거나 새로 만들 수 있습니다.' })));
          content.querySelector('input')?.focus();
        };
        const urlForm = () => {
          const name = el('input', { class: 'field', placeholder: 'origin', spellcheck: 'false' });
          name.value = remotes().includes('origin') ? '' : 'origin';
          const url = el('input', { class: 'field', placeholder: 'https://… 또는 git@…', spellcheck: 'false' });
          const pushUrl = el('input', { class: 'field', placeholder: '비우면 Pull 주소와 같음', spellcheck: 'false' });
          const problem = el('div', { class: 'modal-error' }, ' ');
          const ok = el('button', { class: 'btn primary', text: '추가' });
          const check = () => {
            const p = !name.value.trim() ? '이름을 적어 주세요.' : /\s/.test(name.value) ? '이름에 공백은 쓸 수 없습니다.'
              : remotes().includes(name.value.trim()) ? '같은 이름의 원격이 있습니다.' : !url.value.trim() ? '주소를 적어 주세요.' : null;
            problem.textContent = p ?? ' ';
            ok.disabled = !!p;
            return p;
          };
          [name, url, pushUrl].forEach((i) => i.addEventListener('input', check));
          const submit = async () => {
            if (check()) return;
            const remoteName = name.value.trim();
            const added = await act('원격을 추가하는 중…', () => call('addRemote', { name: remoteName, url: url.value, pushUrl: pushUrl.value }).then(() => true));
            if (added !== true) return;
            close();
            await act(`${remoteName} 을 페치하는 중…`, () => call('fetchRemote', { name: remoteName }), { success: () => `원격 '${remoteName}' 를 추가했습니다.` });
          };
          ok.addEventListener('click', submit);
          for (const i of [name, url, pushUrl]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) submit(); });
          check();
          return el('div', { class: 'drawer-form' },
            el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: '이름' }), name),
            el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: 'Pull 주소' }), url),
            el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: 'Push 주소' }), pushUrl),
            problem,
            el('div', { class: 'modal-actions' }, el('button', { class: 'btn', text: '취소', onclick: () => close() }), ok));
        };
        body.append(tabs, content);
        draw();
      },
    });
  }

  // ── 워크트리·서브모듈 ──

  function addWorktree(reference) {
    openDrawer({
      glyph: 'worktree', title: '워크트리 추가', anchor: ctx.sidebarElement(),
      build(body, close) {
        const refs = ctx.state.refs ?? { local: [], remote: [], tags: [] };
        const items = [
          ...refs.local.map((b) => ({ value: b.name, label: b.name, icon: 'laptop' })),
          ...refs.remote.map((b) => ({ value: b.name, label: b.name, icon: 'cloud' })),
          ...refs.tags.map((t) => ({ value: t.name, label: t.name, icon: 'tag' })),
        ];
        const repoPath = ctx.state.repo.path;
        const sep = repoPath.includes('\\') ? '\\' : '/';
        const parent = repoPath.slice(0, repoPath.lastIndexOf(sep));
        const base = repoPath.slice(repoPath.lastIndexOf(sep) + 1);
        let folderTouched = false;
        const folder = el('input', { class: 'field', spellcheck: 'false' });
        const newBranch = el('input', { type: 'checkbox' });
        const branchName = el('input', { class: 'field', placeholder: '새 브랜치 이름', spellcheck: 'false', disabled: true });
        const select = searchSelect({ items, value: reference ?? current()?.name, placeholder: '브랜치·태그', onChange: () => auto() });
        const auto = () => {
          if (folderTouched) return;
          const name = (newBranch.checked && branchName.value.trim() ? branchName.value.trim() : select.value ?? 'worktree').replace(/^[^/]+\//, (m) => (refs.remote.some((b) => b.name === select.value) ? '' : m)).replace(/[\\/]/g, '-');
          folder.value = `${parent}${sep}${base}-${name}`;
          check();
        };
        folder.addEventListener('input', () => { folderTouched = true; check(); });
        newBranch.addEventListener('change', () => { branchName.disabled = !newBranch.checked; if (newBranch.checked) branchName.focus(); auto(); });
        branchName.addEventListener('input', auto);
        const problem = el('div', { class: 'modal-error' }, ' ');
        const ok = el('button', { class: 'btn primary', text: '추가' });
        function check() {
          const p = !select.value ? '참조를 고르세요.' : newBranch.checked ? branchNameProblem(branchName.value, localNames()) : !folder.value.trim() ? '폴더를 적어 주세요.' : null;
          problem.textContent = p ?? ' ';
          ok.disabled = !!p;
          return p;
        }
        ok.addEventListener('click', async () => {
          if (check()) return;
          const done = await act('워크트리를 만드는 중…', () => call('addWorktree', { path: folder.value.trim(), reference: select.value, newBranch: newBranch.checked ? branchName.value.trim() : undefined }).then(() => true), { success: () => '워크트리를 만들었습니다.' });
          if (done === true) close();
        });
        const browse = el('button', { class: 'btn', text: '찾아보기…', onclick: async () => {
          const picked = await call('pick', { kind: 'folder', start: parent, title: '워크트리를 둘 폴더' });
          if (picked) { folder.value = `${picked}${sep}${base}-${(select.value ?? '').replace(/[\\/]/g, '-')}`; folderTouched = true; check(); }
        } });
        auto();
        body.append(el('div', { class: 'drawer-form' },
          el('div', { class: 'modal-field' }, el('span', { class: 'modal-label', text: '참조' }), select.element),
          el('label', { class: 'check' }, newBranch, '새 브랜치 만들기'),
          branchName,
          el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: '폴더' }), el('div', { class: 'row' }, folder, browse)),
          problem,
          el('div', { class: 'modal-actions' }, el('button', { class: 'btn', text: '취소', onclick: () => close() }), ok)));
        check();
      },
    });
  }

  async function removeWorktree(w) {
    const values = await formDialog({ title: '워크트리 지우기', danger: true, message: `${w.path}\n\n이 폴더를 지웁니다. 브랜치는 남습니다.`, fields: [{ name: 'force', type: 'checkbox', label: '커밋하지 않은 변경이 있어도 지우기' }], ok: '지우기' });
    if (values) await run('워크트리를 지우는 중…', 'removeWorktree', { path: w.path, force: values.force }, '워크트리를 지웠습니다.');
  }

  function submoduleDrawer(existing) {
    openDrawer({
      glyph: 'submodule', title: existing ? `서브모듈 편집: ${existing.path}` : '서브모듈 추가', anchor: ctx.sidebarElement(),
      build(body, close) {
        const url = el('input', { class: 'field', placeholder: 'https://… 또는 git@…', spellcheck: 'false' });
        const path = el('input', { class: 'field', placeholder: 'Packages/라이브러리', spellcheck: 'false', disabled: !!existing });
        const branch = el('input', { class: 'field', placeholder: '비우면 기본 브랜치', spellcheck: 'false' });
        url.value = existing?.url ?? '';
        path.value = existing?.path ?? '';
        branch.value = existing?.branch ?? '';
        let pathTouched = !!existing;
        path.addEventListener('input', () => { pathTouched = true; check(); });
        url.addEventListener('input', async () => {
          if (!pathTouched) path.value = url.value.trim() ? await call('cloneName', { url: url.value }).catch(() => '') : '';
          check();
        });
        const problem = el('div', { class: 'modal-error' }, ' ');
        const ok = el('button', { class: 'btn primary', text: existing ? '저장' : '추가' });
        function check() {
          const p = !url.value.trim() ? '주소를 적어 주세요.' : !path.value.trim() ? '경로를 적어 주세요.'
            : !existing && (ctx.state.submodules ?? []).some((s) => s.path === path.value.trim()) ? '같은 경로의 서브모듈이 있습니다.' : null;
          problem.textContent = p ?? ' ';
          ok.disabled = !!p;
          return p;
        }
        ok.addEventListener('click', async () => {
          if (check()) return;
          const done = existing
            ? await act('서브모듈을 고치는 중…', () => call('editSubmodule', { path: existing.path, url: url.value, branch: branch.value || undefined }).then(() => true), { success: () => '서브모듈을 고쳤습니다.' })
            : await act('서브모듈을 받는 중…', () => call('addSubmodule', { url: url.value, path: path.value, branch: branch.value || undefined }).then(() => true), { success: () => '서브모듈을 추가했습니다.' });
          if (done === true) close();
        });
        body.append(el('div', { class: 'drawer-form' },
          el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: '주소' }), url),
          el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: '경로' }), path),
          el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: '브랜치' }), branch),
          problem,
          el('div', { class: 'modal-actions' },
            existing ? el('button', { class: 'btn', text: '열기', onclick: () => { close(); ctx.openRepo(`${ctx.state.repo.path}/${existing.path}`); } }) : null,
            el('span', { class: 'spacer' }),
            el('button', { class: 'btn', text: '취소', onclick: () => close() }), ok)));
        check();
      },
    });
  }

  const addSubmodule = () => submoduleDrawer(null);
  const editSubmodule = (s) => submoduleDrawer(s);

  // ── 메뉴 ───────────────────────────────────────────

  const compareItems = (revision, label) => ({
    label: '비교',
    submenu: [
      { label: `'${current()?.name ?? 'HEAD'}' 와 갈라진 뒤`, disabled: !ctx.compare, action: () => ctx.compare?.('HEAD', revision, { range: true, title: `${label} (갈라진 뒤)` }) },
      { label: '다른 브랜치와…', disabled: !ctx.compare, action: () => compareWithOther(revision, label) },
      { label: '작업 폴더와', disabled: !ctx.compare, action: () => ctx.compare?.(revision, null, { title: `${label} ↔ 작업 사본` }) },
    ],
  });

  async function compareWithOther(revision, label) {
    const options = [...(ctx.state.refs?.local ?? []), ...(ctx.state.refs?.remote ?? [])].filter((b) => b.name !== revision).map((b) => ({ value: b.name, label: b.name }));
    const other = await pickDialog({ title: `'${label}' 와 비교할 브랜치`, glyph: 'branch', options, value: current()?.name });
    if (other) ctx.compare?.(other, revision, { title: `${other} ↔ ${label}` });
  }

  /** 브랜치 메뉴 항목(로컬). 커밋 메뉴의 하위 메뉴에도 쓴다. */
  function localItems(branch) {
    const cur = current();
    const writable = !busyOp();
    const isCurrent = branch.current;
    return [
      { label: '전환', disabled: isCurrent || !writable, action: () => checkout(branch.name) },
      { label: 'Pull (앞으로 감기)', disabled: !branch.upstream || !writable, action: () => (isCurrent ? ctx.pull?.() : run('앞으로 감는 중…', 'fastForward', { branch: branch.name, current: false }, `${branch.name} 를 앞으로 감았습니다.`)) },
      { label: 'Push', disabled: !writable, action: () => pushBranch(branch) },
      { label: 'upstream 설정…', action: () => setUpstream(branch) },
      { label: `'${branch.upstream ?? 'upstream'}' 로 앞으로 감기`, disabled: !branch.upstream || !branch.behind || !writable, action: () => run('앞으로 감는 중…', 'fastForward', { branch: branch.name, current: isCurrent }, `${branch.name} 를 앞으로 감았습니다.`) },
      '-',
      {
        label: `'${cur?.name ?? 'HEAD'}' 에 병합`, disabled: isCurrent || !writable,
        submenu: ['default', 'noFf', 'squash', 'ffOnly'].map((mode) => ({ label: MERGE_LABEL[mode], action: () => merge(branch.name, branch.name, mode) })),
      },
      { label: `'${cur?.name ?? 'HEAD'}' 를 여기 위로 Rebase`, disabled: isCurrent || !writable, action: () => rebase(branch.name) },
      '-',
      { label: '여기서 새 브랜치…', action: () => createBranch(branch.name, branch.name) },
      { label: '새 태그…', action: () => createTag(branch.hash, branch.name) },
      { label: '이름 바꾸기…', action: () => renameBranch(branch.name) },
      { label: '지우기…', danger: true, disabled: isCurrent, action: () => deleteBranch(branch) },
      { label: '원격 브랜치 지우기…', danger: true, disabled: !branch.upstream, action: () => deleteRemoteBranch(ctx.state.refs.remote.find((r) => r.name === branch.upstream) ?? { name: branch.upstream, remote: branch.upstream.split('/')[0] }) },
      '-',
      compareItems(branch.name, branch.name),
      { label: '그래프에서 보기', action: () => ctx.reveal(branch.hash) },
      { label: 'Pull Request 만들기…', disabled: !ctx.createPullRequest, action: () => ctx.createPullRequest?.(branch.name) },
      { label: '이름 복사', action: () => copy(branch.name) },
    ];
  }

  function remoteItems(branch) {
    const cur = current();
    const writable = !busyOp();
    return [
      { label: '로컬 브랜치로 전환', disabled: !writable, action: () => activate({ kind: 'remote', branch }) },
      '-',
      { label: `'${cur?.name ?? 'HEAD'}' 에 병합`, disabled: !writable, submenu: ['default', 'noFf', 'squash', 'ffOnly'].map((mode) => ({ label: MERGE_LABEL[mode], action: () => merge(branch.name, branch.name, mode) })) },
      { label: `'${cur?.name ?? 'HEAD'}' 를 여기 위로 Rebase`, disabled: !writable, action: () => rebase(branch.name) },
      '-',
      { label: '여기서 새 브랜치…', action: () => createBranch(branch.name, branch.name) },
      { label: '새 태그…', action: () => createTag(branch.hash, branch.name) },
      compareItems(branch.name, branch.name),
      { label: '그래프에서 보기', action: () => ctx.reveal(branch.hash) },
      { label: '이름 복사', action: () => copy(branch.name) },
      '-',
      { label: '원격에서 지우기…', danger: true, action: () => deleteRemoteBranch(branch) },
    ];
  }

  const menuAt = (event, items) => showMenu(event.clientX, event.clientY, items);

  const menus = {
    local: (event, branch) => menuAt(event, localItems(branch)),
    remote: (event, branch) => menuAt(event, remoteItems(branch)),
    remoteHeader: (event, remote) => menuAt(event, [
      { label: '이 원격만 Fetch', action: () => run(`${remote.name} 을 페치하는 중…`, 'fetchRemote', { name: remote.name }, `${remote.name} 을 페치했습니다.`) },
      { label: 'Prune (지워진 원격 브랜치 정리)', action: () => run('정리하는 중…', 'pruneRemote', { name: remote.name }, '정리했습니다.') },
      '-',
      { label: '이름 바꾸기…', action: () => renameRemote(remote) },
      { label: '주소 고치기…', action: () => editRemoteUrl(remote) },
      { label: '주소 복사', action: () => copy(remote.fetchUrl) },
      '-',
      { label: '지우기…', danger: true, action: () => removeRemote(remote) },
    ]),
    tag: (event, tag) => menuAt(event, [
      { label: '이 태그로 전환', disabled: busyOp(), action: () => activate({ kind: 'tag', tag }) },
      { label: `'${current()?.name ?? 'HEAD'}' 에 병합`, disabled: busyOp(), action: () => merge(tag.name, `태그 ${tag.name}`) },
      '-',
      { label: 'Push', disabled: !remotes().length, submenu: remotes().map((r) => ({ label: r, action: () => run('태그를 푸시하는 중…', 'pushTag', { remote: r, name: tag.name }, `태그 '${tag.name}' 를 ${r} 에 올렸습니다.`) })) },
      {
        label: '원격 태그 지우기', disabled: !remotes().length,
        submenu: remotes().map((r) => ({
          label: r, danger: true,
          action: async () => {
            if (await confirmDialog({ title: '원격 태그 지우기', danger: true, message: `원격 '${r}' 에서 태그 '${tag.name}' 를 지웁니다.`, ok: '지우기' })) await run('원격 태그를 지우는 중…', 'deleteRemoteTag', { remote: r, name: tag.name }, '원격 태그를 지웠습니다.');
          },
        })),
      },
      '-',
      { label: '그래프에서 보기', action: () => ctx.reveal(tag.hash) },
      { label: '이름 복사', action: () => copy(tag.name) },
      { label: 'SHA 복사', action: () => copy(tag.hash) },
      '-',
      {
        label: '지우기…', danger: true,
        action: async () => {
          if (await confirmDialog({ title: '태그 지우기', message: `로컬 태그 '${tag.name}' 를 지웁니다.`, ok: '지우기', danger: true })) await run('태그를 지우는 중…', 'deleteTag', { name: tag.name });
        },
      },
    ]),
    stash: (event, stash) => menuAt(event, [
      { label: '변경 보기', action: () => activate({ kind: 'stash', stash }) },
      { label: 'Pop (되돌리고 지우기)', disabled: busyOp(), action: () => stashPop(stash.name) },
      { label: 'Apply (되돌리고 남겨 두기)', disabled: busyOp(), action: () => run('Stash 를 적용하는 중…', 'stashApply', { name: stash.name, pop: false }, 'Stash 를 적용했습니다.') },
      { label: '여기서 브랜치 만들기…', disabled: busyOp(), action: () => stashBranch(stash) },
      { label: '메시지 복사', action: () => copy(stash.message) },
      '-',
      { label: '지우기…', danger: true, action: () => stashDrop(stash) },
    ]),
    worktree: (event, w) => menuAt(event, [
      { label: '열기', disabled: w.current, action: () => ctx.openRepo(w.path) },
      { label: `${fileManager()} 에서 열기`, action: () => call('openFolder', { path: w.path }).catch(ctx.showError) },
      { label: '터미널', action: () => call('openTerminal', { path: w.path }).catch(ctx.showError) },
      { label: '경로 복사', action: () => copy(w.path) },
      '-',
      { label: '지우기…', danger: true, disabled: w.current, action: () => removeWorktree(w) },
    ]),
    submodule: (event, s) => {
      const full = `${ctx.state.repo.path}/${s.path}`;
      menuAt(event, [
        { label: '편집…', action: () => editSubmodule(s) },
        { label: '열기', disabled: s.state === 'uninitialized', action: () => ctx.openRepo(full) },
        { label: s.state === 'uninitialized' ? '받기 (update)' : 'Update (기록된 커밋으로)', action: () => run('서브모듈을 받는 중…', 'updateSubmodules', { path: s.path }, '서브모듈을 받았습니다.') },
        { label: `${fileManager()} 에서 열기`, disabled: s.state === 'uninitialized', action: () => call('openFolder', { path: full }).catch(ctx.showError) },
        { label: '터미널', disabled: s.state === 'uninitialized', action: () => call('openTerminal', { path: full }).catch(ctx.showError) },
        { label: '경로 복사', action: () => copy(s.path) },
      ]);
    },
    section: (id, event) => {
      const items = {
        local: [{ label: '새 브랜치…', action: () => createBranch('HEAD', '지금 커밋 (HEAD)', { inline: false }) }],
        remote: [{ label: '원격 추가…', action: addRemote }, { label: '모두 Fetch', disabled: !remotes().length, action: () => ctx.fetch?.() }],
        tags: [{ label: 'HEAD 에 새 태그…', disabled: !ctx.state.history?.head, action: () => createTag(ctx.state.history.head, 'HEAD') }],
        stash: [{ label: '지금 스태시…', disabled: !(ctx.state.status?.staged.length + ctx.state.status?.unstaged.length), action: stashPush }],
        worktrees: [{ label: '워크트리 추가…', action: () => addWorktree() }],
        submodules: [{ label: '서브모듈 추가…', action: addSubmodule }, { label: '모두 받기 (update)', disabled: !(ctx.state.submodules ?? []).length, action: () => run('서브모듈을 받는 중…', 'updateSubmodules', {}, '서브모듈을 받았습니다.') }],
      }[id] ?? ctx.sectionMenu?.(id) ?? [];
      if (items.length) menuAt(event, items);
    },
  };

  /** 구역 머리의 "+". */
  function add(sectionId) {
    if (sectionId === 'remote') addRemote();
    else if (sectionId === 'worktrees') addWorktree();
    else if (sectionId === 'submodules') addSubmodule();
    else ctx.sectionAdd?.(sectionId);
  }

  /** 그래프 이름표 우클릭: 그 참조의 메뉴. */
  function refMenu(event, ref, commit) {
    const refs = ctx.state.refs;
    if (ref.kind === 'local' || ref.kind === 'current') {
      const branch = refs?.local.find((b) => b.name === ref.name);
      if (branch) return menus.local(event, branch);
    } else if (ref.kind === 'remote') {
      const branch = refs?.remote.find((b) => b.name === ref.name);
      if (branch) return menus.remote(event, branch);
    } else if (ref.kind === 'tag') {
      const tag = refs?.tags.find((t) => t.name === ref.name);
      if (tag) return menus.tag(event, tag);
    }
    return commitMenu(event, commit);
  }

  // ── 커밋 메뉴(원본 CommitMenu, Fork 모양) ──

  let compareBase = null;

  async function rewrite(commit, kind) {
    const labels = { reword: 'Reword', squash: 'Squash (부모와 합치기)', fixup: 'Fixup (부모와 합치고 메시지 버리기)', drop: 'Drop (커밋 빼기)' };
    let message;
    if (kind === 'reword' || kind === 'squash') {
      const full = await call('commitDetail', { hash: kind === 'squash' ? commit.parents[0] : commit.hash }).then((d) => d.message).catch(() => commit.subject);
      const own = kind === 'squash' ? await call('commitDetail', { hash: commit.hash }).then((d) => d.message).catch(() => commit.subject) : '';
      const values = await formDialog({
        title: labels[kind], glyph: 'pencil',
        message: kind === 'squash' ? `${commit.shortHash} 를 부모 커밋과 합칩니다. 합친 메시지:` : `${commit.shortHash} 의 메시지를 고칩니다. 작업 트리는 그대로입니다.`,
        fields: [{ name: 'message', type: 'textarea', rows: 6, value: kind === 'squash' ? `${full.trim()}\n\n${own.trim()}` : full }],
        ok: kind === 'squash' ? '합치기' : '고치기',
        validate: (v) => (v.message.trim() ? null : '메시지를 적어 주세요.'),
      });
      if (!values) return;
      message = values.message;
    } else if (!(await confirmDialog({
      title: labels[kind], danger: kind === 'drop',
      message: kind === 'drop' ? `${commit.shortHash} "${commit.subject}" 를 히스토리에서 뺍니다. 그 뒤 커밋들은 다시 만들어집니다. 실행 취소로 되돌릴 수 있습니다.` : `${commit.shortHash} 를 부모 커밋과 합치고 이 커밋의 메시지는 버립니다.`,
      ok: kind === 'drop' ? '빼기' : '합치기',
    }))) return;
    await run(`${labels[kind]} 하는 중…`, 'rewrite', { kind, hash: commit.hash, message }, '히스토리를 고쳤습니다. 이미 푸시했다면 강제 푸시가 필요합니다.');
  }

  async function savePatch(commit) {
    const path = await call('pick', { kind: 'save', name: `${commit.shortHash}.patch`, title: '패치 저장', filters: [{ name: '패치', ext: ['patch', 'diff'] }] });
    if (path) await run('패치를 쓰는 중…', 'savePatch', { hash: commit.hash, path }, `패치를 저장했습니다: ${path}`);
  }

  async function copyInfo(commit) {
    const detail = await call('commitDetail', { hash: commit.hash }).catch(() => null);
    const date = new Date(commit.time * 1000).toLocaleString('ko-KR');
    copy(`commit ${commit.hash}\nAuthor: ${commit.authorName} <${commit.authorEmail}>\nDate:   ${date}\n\n${(detail?.message ?? commit.subject).replace(/^/gm, '    ')}\n`);
    ctx.notify('커밋 정보를 복사했습니다.');
  }

  function commitMenu(event, commit) {
    const cur = current();
    const curName = cur?.name ?? 'HEAD';
    const isMerge = commit.parents.length > 1;
    const isHead = commit.hash === ctx.state.history?.head;
    const writable = !busyOp();
    const refs = ctx.state.refs ?? { local: [], remote: [] };
    const here = [...refs.local, ...refs.remote].filter((b) => b.hash === commit.hash)
      .sort((a, b) => (b.current - a.current) || (!!a.remote - !!b.remote) || a.name.localeCompare(b.name));
    const rewriteOff = (kind) => !writable || (kind !== 'reword' && (commit.parents.length !== 1));
    const items = [];
    if (here.length) {
      for (const b of here) {
        const hasLocal = b.remote && refs.local.some((l) => l.name === b.name.slice(b.remote.length + 1));
        if (!b.current && !hasLocal) items.push({ label: `'${b.name}' 로 전환`, disabled: !writable, action: () => activate({ kind: b.remote ? 'remote' : 'local', branch: b }) });
      }
      for (const b of here) items.push({ label: `브랜치 '${b.name}'`, submenu: b.remote ? remoteItems(b) : localItems(b) });
      items.push('-');
    }
    items.push(
      { label: '여기서 새 브랜치…', disabled: !writable, action: () => createBranch(commit.hash, commit.shortHash) },
      { label: '여기에 새 태그…', action: () => createTag(commit.hash, commit.shortHash) },
      {
        label: 'Interactive Rebase',
        submenu: [
          { label: 'Reword (메시지 고치기)…', disabled: rewriteOff('reword'), action: () => rewrite(commit, 'reword') },
          { label: 'Squash (부모와 합치기)…', disabled: rewriteOff('squash'), action: () => rewrite(commit, 'squash') },
          { label: 'Fixup (합치고 메시지 버리기)…', disabled: rewriteOff('fixup'), action: () => rewrite(commit, 'fixup') },
          { label: 'Drop (빼기)…', danger: true, disabled: rewriteOff('drop'), action: () => rewrite(commit, 'drop') },
        ],
      },
      {
        label: `'${curName}' 를 여기로 Reset`, disabled: isHead || !writable,
        submenu: [
          { label: 'Soft — 바뀐 내용을 Stage 한 채로', action: () => reset(commit.hash, 'soft') },
          { label: 'Mixed — 바뀐 내용을 작업 트리에', action: () => reset(commit.hash, 'mixed') },
          { label: 'Hard — 모두 버리기', danger: true, action: () => reset(commit.hash, 'hard') },
        ],
      },
      '-',
      { label: '이 커밋으로 전환 (detached)', disabled: isHead || !writable, action: () => checkoutCommit(commit.hash) },
      {
        label: `'${curName}' 에 병합`, disabled: isHead || !writable,
        submenu: ['default', 'noFf', 'squash'].map((mode) => ({ label: MERGE_LABEL[mode], action: () => merge(commit.hash, commit.shortHash, mode) })),
      },
      { label: `Cherry-pick → '${curName}'`, disabled: isHead || !writable, action: () => run('Cherry-pick 하는 중…', 'cherryPick', { hash: commit.hash, merge: isMerge }, 'Cherry-pick 했습니다.') },
      {
        label: 'Revert (되돌리는 커밋 만들기)…', disabled: !writable,
        action: async () => {
          if (await confirmDialog({ title: 'Revert', glyph: 'undo', message: `${commit.shortHash} "${commit.subject}" 를 되돌리는 새 커밋을 만듭니다.`, ok: 'Revert' })) {
            await run('Revert 하는 중…', 'revert', { hash: commit.hash, merge: isMerge }, 'Revert 했습니다.');
          }
        },
      },
      { label: '패치로 저장…', action: () => savePatch(commit) },
      '-',
      { label: '작업 폴더와 비교', disabled: !ctx.compare, action: () => ctx.compare?.(commit.hash, null, { title: `${commit.shortHash} ↔ 작업 사본` }) },
      { label: '부모와 비교', disabled: !ctx.compare || !commit.parents.length, action: () => ctx.compare?.(`${commit.hash}^`, commit.hash, { title: `${commit.shortHash} 의 부모 ↔ ${commit.shortHash}` }) },
      {
        label: '비교',
        submenu: [
          { label: '다른 리비전과…', disabled: !ctx.compare, action: () => compareWithRevision(commit) },
          { label: compareBase && compareBase.hash !== commit.hash ? `표시한 ${compareBase.shortHash} 와 비교` : '표시한 커밋과 비교 (먼저 표시하세요)', disabled: !ctx.compare || !compareBase || compareBase.hash === commit.hash, action: () => ctx.compare?.(compareBase.hash, commit.hash, { title: `${compareBase.shortHash} ↔ ${commit.shortHash}` }) },
          { label: '비교 기준으로 표시', checked: compareBase?.hash === commit.hash, action: () => { compareBase = commit; } },
        ],
      },
      { label: '부모로 이동', disabled: !commit.parents.length, action: () => ctx.reveal(commit.parents[0]) },
      '-',
      { label: 'SHA 복사', action: () => copy(commit.hash) },
      { label: '정보 복사', action: () => copyInfo(commit) },
      { label: '메시지 복사', action: () => copy(commit.subject) },
    );
    showMenu(event.clientX, event.clientY, items);
  }

  async function compareWithRevision(commit) {
    const values = await formDialog({ title: `${commit.shortHash} 와 비교할 리비전`, glyph: 'search', fields: [{ name: 'rev', placeholder: 'main, v1.0, abc1234, HEAD~3' }], ok: '비교', validate: (v) => (v.rev.trim() ? null : '리비전을 적어 주세요.') });
    if (values) ctx.compare?.(values.rev.trim(), commit.hash, { title: `${values.rev.trim()} ↔ ${commit.shortHash}` });
  }

  return {
    commitMenu, refMenu, activateRef, activate, menus, add, createBranch, stashPush, stashPop, checkout, current, addRemote, addWorktree, addSubmodule, merge, rewrite,
  };
}
