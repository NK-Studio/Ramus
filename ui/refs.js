// 브랜치·태그·stash·원격·워크트리·서브모듈·커밋 작업과 그 메뉴, 드로어. 원본 Views/BranchMenu·BranchActions·CommitMenu·CommitActions·RefActions,
// Elements/AddRemoteDrawer·AddWorktreeDrawer·AddSubmoduleDrawer·EditSubmoduleDrawer 를 옮겼다. 작업은 모두 확인을 거쳐 Rust 에 맡긴다.

import { el } from './util.js';
import { scoped, locale } from './i18n.js';
import { icon } from './icons.js';
import { confirmDialog, formDialog, showMenu, openDrawer, searchSelect, pickDialog, drawerPrimary, drawerProblem, drawerField } from './dialogs.js';
import { branchNameProblem, stashLabel } from './graph.js';

/** 이 모듈의 글(locales/en/refs.js 를 먼저 본다). */
const t = scoped('refs');

const copy = (text) => navigator.clipboard?.writeText(text);

/**
 * ctx: { call, act(label, work, {success}), state, prefs, graph, reveal(hash), showCommit(hash), openRepo(path), notify(text),
 *        inlineBranches(), beforeInlineBranch(), sidebarElement(), compare(a, b, options), fileManager, showInExplorer(hash) }
 * state.busy 면(다른 작업이 도는 중) 원본처럼 쓰는 메뉴 항목을 끄고 더블클릭을 무시한다.
 */
export function createRefs(ctx) {
  const { call, act } = ctx;

  const current = () => ctx.state.refs?.local.find((b) => b.current);
  const remotes = () => ctx.state.refs?.remotes ?? [];
  const busy = () => !!ctx.state.busy;
  /** 병합·rebase 가 멈춰 있거나 다른 작업이 도는 중(그동안은 레포지토리를 바꾸는 항목을 끈다). */
  const busyOp = () => !!ctx.state.status?.operation || busy();
  const remoteOf = () => current()?.upstream?.split('/')[0] || remotes()[0] || 'origin';
  const run = (label, cmd, args, success) => act(label, () => call(cmd, args), success ? { success: () => success } : {});
  const localNames = () => (ctx.state.refs?.local ?? []).map((b) => b.name);
  const fileManager = () => (ctx.state.platform === 'windows' ? t('탐색기') : 'Finder');

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
  async function createBranch(start = 'HEAD', startLabel = (start === 'HEAD' && current()?.name) || start, { inline = true } = {}) {
    const hash = inline && ctx.inlineBranches?.() ? resolve(start) : null;
    if (hash) {
      ctx.beforeInlineBranch?.();
      const existing = localNames();
      const started = ctx.graph.beginBranchInput(hash, {
        validate: (name) => branchNameProblem(name, existing),
        submit: (name) => run(t('브랜치를 만드는 중…'), 'createBranch', { name, start, checkout: true }, t("브랜치 '{name}' 를 만들고 바꿨습니다.", { name })),
      });
      if (started) return;
    }
    // 원본 GitBranchDialog: 브랜치 원 배지 · "'/' 로 나누면…" 안내 · 만들 위치 줄 · 아이콘 든 이름 칸 · "만든 뒤 체크아웃"(고른 값을 기억).
    const values = await formDialog({
      title: t('브랜치 만들기'),
      glyph: 'branch',
      className: 'branch-card',
      message: t("'/' 로 나누면 폴더처럼 묶입니다"),
      fields: [
        { type: 'static', label: t('만들 위치:'), icon: 'branch', text: startLabel },
        { name: 'name', label: t('브랜치 이름:'), placeholder: t('브랜치 이름 입력'), icon: 'branch' },
        { name: 'checkout', type: 'checkbox', label: t('만든 뒤 체크아웃'), value: ctx.prefs.get('branch.checkout') ?? true },
      ],
      ok: t('만들기'),
      validate: (v) => branchNameProblem(v.name, localNames()),
    });
    if (!values) return;
    ctx.prefs.set('branch.checkout', values.checkout);
    await run(t('브랜치를 만드는 중…'), 'createBranch', { name: values.name.trim(), start, checkout: values.checkout }, t("브랜치 '{name}' 를 만들었습니다.", { name: values.name.trim() }));
  }

  async function checkout(name, remote = false) {
    // 전환은 LFS 파일을 서버에서 받느라 오래 걸릴 수 있어 작업 목록에 보인다(remote: 'checkout').
    const done = t('{name} 로 바꿨습니다.', { name: remote ? name.replace(/^[^/]+\//, '') : name });
    await act(t('{name} 로 전환하는 중…', { name }), (job) => call('checkout', { name, remote, job }), { success: () => done, remote: 'checkout' });
  }

  async function checkoutCommit(hash, label) {
    if (!(await confirmDialog({
      title: t('커밋으로 전환'),
      glyph: 'info',
      message: t('{name} 을 브랜치 없이 봅니다(detached HEAD). 이 상태에서 만든 커밋은 브랜치를 만들지 않으면 잃기 쉽습니다.', { name: label ?? hash.slice(0, 7) }),
      ok: t('전환'),
    }))) return;
    const done = t('{name} 로 전환했습니다.', { name: label ?? hash.slice(0, 7) });
    await act(t('{name} 로 전환하는 중…', { name: label ?? hash.slice(0, 7) }), (job) => call('checkoutDetached', { hash, job }), { success: () => done, remote: 'checkout' });
  }

  async function renameBranch(name) {
    const values = await formDialog({
      title: t('브랜치 이름 바꾸기'), glyph: 'pencil',
      fields: [{ name: 'name', label: t('새 이름'), value: name, icon: 'branch' }],
      ok: t('바꾸기'),
      validate: (v) => (v.name.trim() === name ? t('지금 이름과 같습니다.') : branchNameProblem(v.name, localNames())),
    });
    if (values) await run(t('이름을 바꾸는 중…'), 'renameBranch', { old: name, new: values.name.trim() });
  }

  /**
   * 원본 BranchActions.DeleteAsync: 확인 → `branch -d`. 병합되지 않은 커밋이 있어 거부되면 강제 삭제를 한 번 더 묻고,
   * 지운 뒤에는 추적하던 원격 브랜치도 지울지 묻는다.
   */
  async function deleteBranch(branch) {
    if (!(await confirmDialog({
      title: t('브랜치 삭제'), glyph: 'branch', danger: true, ok: t('삭제'),
      message: t("로컬 브랜치 '{name}'을(를) 삭제합니다. 원격 브랜치는 그대로 둡니다.", { name: branch.name }),
    }))) return;
    const upstream = branch.upstream;
    let notMerged = false;
    const deleted = await act(t("'{name}' 삭제하는 중…", { name: branch.name }), () => call('deleteBranch', { name: branch.name, force: false }).then(() => true), {
      success: () => t("'{name}' 를 지웠습니다.", { name: branch.name }),
      onError: (error) => {
        // Rust 가 "not fully merged" 를 우리말로 바꿔 돌려준다(refs.rs delete_branch).
        if (!/not fully merged|병합하지 않은 커밋|unmerged|not (?:yet )?merged/i.test(error?.message ?? '')) return false;
        notMerged = true;
        return true;
      },
    });
    if (notMerged) {
      if (!(await confirmDialog({
        title: t('브랜치 삭제'), glyph: 'branch', danger: true, ok: t('강제 삭제'),
        message: t("'{name}' 에는 병합되지 않은 커밋이 있습니다. 강제로 삭제하면 그 커밋에 다시 가기 어렵습니다.\n\n강제로 삭제할까요?", { name: branch.name }),
      }))) return;
      const forced = await act(t("'{name}' 강제 삭제하는 중…", { name: branch.name }), () => call('deleteBranch', { name: branch.name, force: true }).then(() => true),
        { success: () => t("'{name}' 를 지웠습니다.", { name: branch.name }) });
      if (forced !== true) return;
    } else if (deleted !== true) return;
    await offerDeleteUpstream(upstream);
  }

  /** 지운 로컬 브랜치가 추적하던 원격 브랜치가 아직 있으면 그것도 지울지 묻는다(원본 OfferDeleteUpstreamAsync). */
  async function offerDeleteUpstream(upstream) {
    if (!upstream || !(ctx.state.refs?.remote ?? []).some((b) => b.name === upstream)) return;
    if (!(await confirmDialog({
      title: t('원격 브랜치 삭제'), glyph: 'cloud', danger: true, ok: t('삭제'), cancel: t('원격은 남기기'),
      message: t("로컬 브랜치를 지웠습니다.\n추적하던 원격 브랜치 '{name}' 도 지울까요? 다른 사람에게도 사라집니다.", { name: upstream }),
    }))) return;
    const remote = remotes().find((r) => upstream.startsWith(`${r}/`)) ?? upstream.split('/')[0];
    await run(t("'{name}' 삭제하는 중…", { name: upstream }), 'deleteRemoteBranch', { remote, branch: upstream.slice(remote.length + 1) }, t('{name} 를 지웠습니다.', { name: upstream }));
  }

  async function deleteRemoteBranch(branch) {
    const short = branch.name.slice(branch.remote.length + 1);
    if (!(await confirmDialog({ title: t('원격 브랜치 삭제'), glyph: 'cloud', message: t("'{remote}' 에서 '{branch}' 를 삭제할까요? 다른 사람에게도 사라지고 실행 취소로 되살릴 수 없습니다.", { remote: branch.remote, branch: short }), ok: t('삭제'), danger: true }))) return;
    await run(t('원격 브랜치를 지우는 중…'), 'deleteRemoteBranch', { remote: branch.remote, branch: short }, t('{name} 를 지웠습니다.', { name: branch.name }));
  }

  const MERGE_LABEL = { default: t('병합'), noFf: t('병합 (No-FF)'), squash: t('병합 (Squash)'), ffOnly: t('앞으로 감기만') };

  async function merge(revision, label = revision, mode = 'default') {
    const into = current()?.name ?? 'HEAD';
    const note = { noFf: t(' 앞으로 감을 수 있어도 병합 커밋을 만듭니다.'), squash: t(' 변경을 하나로 모아 Stage 하고, 커밋은 직접 합니다.'), ffOnly: t(' 갈라졌으면 하지 않습니다.') }[mode] ?? '';
    if (!(await confirmDialog({ title: MERGE_LABEL[mode], glyph: 'merge', message: t("'{label}' 를 '{into}' 에 합칩니다.{note}", { label, into, note }), ok: t('병합') }))) return;
    await run(t('병합하는 중…'), 'merge', { revision, mode }, mode === 'squash' ? t("'{label}' 의 변경을 Stage 했습니다. 커밋해 마무리하세요.", { label }) : t("'{label}' 를 병합했습니다.", { label }));
  }

  async function rebase(revision, label = revision) {
    const branch = current()?.name ?? 'HEAD';
    if (!(await confirmDialog({
      title: 'Rebase', glyph: 'branch',
      message: t("'{branch}' 의 커밋을 '{label}' 위로 옮깁니다. 이미 푸시한 커밋이면 다시 푸시할 때 강제 푸시가 필요합니다.", { branch, label }),
      ok: 'Rebase',
    }))) return;
    await run(t('Rebase 하는 중…'), 'rebase', { revision, stopOnConflict: ctx.prefs.get('rebase.stop') !== false }, t('Rebase 했습니다.'));
  }

  /** 원격이 없으면 원격 추가 드로어를 권한다(원본 SyncFlows.OfferAddRemoteAsync). */
  async function offerAddRemote(title) {
    if (await confirmDialog({ title, glyph: 'cloud', ok: t('원격 추가…'), message: t('등록된 원격이 없어 올릴 곳이 없습니다.\n원격을 추가하거나 GitHub 에 새 레포지토리를 만드세요.') })) addRemote();
  }

  async function pushBranch(branch) {
    const list = remotes();
    if (!list.length) return offerAddRemote(t('브랜치 푸시'));
    let remote = branch.upstream?.split('/')[0];
    if (!remote) {
      remote = list.length > 1 ? await pickDialog({ title: t('브랜치 푸시'), message: t('어느 원격에 올릴까요?'), glyph: 'cloud', options: list.map((r) => ({ value: r, label: r })), value: ctx.prefs.get('push.remote') ?? 'origin' }) : list[0];
      if (!remote) return;
      ctx.prefs.set('push.remote', remote);
    }
    await run(t('{name} 를 푸시하는 중…', { name: branch.name }), 'pushBranch', { branch: branch.name, remote, setUpstream: !branch.upstream }, t('{name} 를 {remote} 에 올렸습니다.', { name: branch.name, remote }));
  }

  async function setUpstream(branch) {
    const options = (ctx.state.refs?.remote ?? []).map((b) => ({ value: b.name, label: b.name }));
    if (!options.length) return ctx.notify(t('원격 브랜치가 없습니다. 먼저 푸시하거나 원격을 추가하세요.'));
    const picked = await pickDialog({ title: t("'{name}' 의 upstream", { name: branch.name }), glyph: 'cloud', options: [{ value: '', label: t('(없음 — 추적 끊기)') }, ...options], value: branch.upstream ?? '' });
    if (picked === null) return;
    await run(t('upstream 을 바꾸는 중…'), 'setUpstream', picked ? { branch: branch.name, upstream: picked } : { branch: branch.name }, picked ? `${branch.name} → ${picked}` : t('추적을 끊었습니다.'));
  }

  async function createTag(hash, label) {
    const values = await formDialog({
      title: t('새 태그'), glyph: 'tag',
      message: t('{name} 에 태그를 붙입니다.', { name: label ?? hash.slice(0, 7) }),
      fields: [
        { name: 'name', placeholder: 'v1.0.0', icon: 'tag' },
        { name: 'message', type: 'textarea', label: t('메시지 (적으면 주석 태그)'), rows: 3 },
      ],
      ok: t('만들기'),
      validate: (v) => (!v.name.trim() ? t('이름을 적어 주세요.') : (ctx.state.refs?.tags ?? []).some((tag) => tag.name === v.name.trim()) ? t('같은 이름의 태그가 있습니다.') : /[\s~^:?*[\\]/.test(v.name) ? t('공백과 ~ ^ : ? * [ \\ 는 쓸 수 없습니다.') : null),
    });
    if (values) await run(t('태그를 만드는 중…'), 'createTag', { name: values.name.trim(), hash, message: values.message }, t("태그 '{name}' 를 만들었습니다.", { name: values.name.trim() }));
  }

  const RESET_TEXT = {
    soft: t('바뀐 내용을 Stage 한 채로 남깁니다.'),
    mixed: t('바뀐 내용을 작업 트리에 남깁니다.'),
    hard: t('작업 중인 변경과 그 뒤의 커밋을 모두 버립니다. 커밋은 실행 취소로 되돌릴 수 있지만, 커밋하지 않은 변경은 되살릴 수 없습니다.'),
  };

  async function reset(hash, mode) {
    const branch = current()?.name ?? 'HEAD';
    if (!(await confirmDialog({ title: `Reset (${mode[0].toUpperCase()}${mode.slice(1)})`, message: t("'{branch}' 를 {hash} 로 옮깁니다. {detail}", { branch, hash: hash.slice(0, 7), detail: RESET_TEXT[mode] }), ok: 'Reset', danger: mode === 'hard', glyph: 'warning', tone: 'warning' }))) return;
    await run(t('Reset 하는 중…'), 'reset', { hash, mode }, t('Reset 했습니다.'));
  }

  // ── stash ──

  /** 작업 중인 변경(새 파일 포함)을 바로 stash 한다 — 원본 도구 막대·구역 메뉴처럼 메모를 묻지 않는다. */
  async function stashPush() {
    if (busy()) return;
    await run(t('Stash 하는 중…'), 'stashPush', { message: '' }, t('Stash 했습니다.'));
  }

  /** Apply·Pop 이 끝나면 변경이 작업 트리로 돌아온다 — 작업 변경 화면으로 옮기고 커밋 제목에 그 stash 메시지를 적는다(app.js). */
  const applied = (stash, result) => {
    if (result !== undefined && stash) ctx.stashApplied?.(stash);
  };

  async function stashApply(stash) {
    applied(stash, await run(t('{name} Apply 하는 중…', { name: stash.name }), 'stashApply', { name: stash.name, pop: false }, t('Stash 를 적용했습니다.')));
  }

  async function stashPop(name = 'stash@{0}') {
    // Pop 하면 목록에서 빠지므로 메시지를 먼저 잡아 둔다.
    const stash = ctx.state.refs?.stashes.find((s) => s.name === name);
    let overlap = null;
    const result = await act(t('Stash 를 되돌리는 중…'), () => call('stashApply', { name, pop: true }), {
      success: () => t('Stash 를 되돌리고 지웠습니다.'),
      onError: (error) => {
        if (error?.advice?.kind !== 'localChanges') return false;
        overlap = error;
        return true;
      },
    });
    if (!overlap) {
      applied(stash, result);
      return;
    }
    // Pop 이 로컬 변경과 겹치면: 그 변경을 버리고 다시 Pop 할지 묻는다.
    const files = overlap.advice.files;
    if (await confirmDialog({ title: t('Pop 하려니 로컬 변경이 겹칩니다'), danger: true, message: t('{files}\n\n이 파일들의 로컬 변경을 버리고 다시 Pop 할까요? 버린 변경은 되살릴 수 없습니다.', { files: files.join(', ') }), ok: t('버리고 Pop') })) {
      await act(t('버리는 중…'), () => call('discard', { paths: files }));
      applied(stash, await run(t('Stash 를 되돌리는 중…'), 'stashApply', { name, pop: true }, t('Stash 를 되돌리고 지웠습니다.')));
    }
  }

  async function stashDrop(stash) {
    if (!(await confirmDialog({ title: t('Stash 삭제'), glyph: 'stash', message: t('되돌릴 수 없는 작업입니다.\n\nstash "{label}" 를 정말 삭제할까요?', { label: stashLabel(stash.message) }), ok: t('삭제'), danger: true }))) return;
    await run(t('Stash 를 삭제하는 중…'), 'stashDrop', { name: stash.name }, t('Stash 를 삭제했습니다.'));
  }

  async function stashBranch(stash) {
    const values = await formDialog({
      title: t('Stash 에서 브랜치 만들기'), glyph: 'branch',
      message: t('{name} 을 만든 커밋에서 새 브랜치를 만들고 그 변경을 되돌립니다.', { name: stash.name }),
      fields: [{ name: 'name', icon: 'branch', placeholder: t('feature/이어서') }],
      ok: t('만들기'),
      validate: (v) => branchNameProblem(v.name, localNames()),
    });
    if (values) await run(t('브랜치를 만드는 중…'), 'stashBranch', { name: stash.name, branch: values.name.trim() }, t("브랜치 '{name}' 로 바꿨습니다.", { name: values.name.trim() }));
  }

  /**
   * 이름표·사이드바 줄을 두 번 눌렀을 때: 로컬은 전환, 원격은 같은 이름 로컬로(없으면 추적 브랜치 만들기), 태그는 그 커밋으로(detached),
   * stash 는 변경 보기, 워크트리는 탭으로 열기, 서브모듈은 편집 드로어. 이미 지금 브랜치거나 진행 중인 작업이 있으면 전환하지 않는다.
   */
  function activate(target) {
    // 다른 작업이 도는 중이면 아무것도 하지 않는다(원본 RunDefault).
    if (busy()) return;
    const switching = ['local', 'remote', 'tag', 'current'].includes(target.kind);
    if (switching && busyOp()) {
      ctx.notify(t('진행 중인 작업을 먼저 끝내세요.'));
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
        checkoutCommit(target.tag.hash, t("태그 '{name}'", { name: target.tag.name }));
        break;
      case 'stash':
        ctx.showCommit(target.stash.hash, `${target.stash.name}: ${target.stash.message}`);
        break;
      case 'worktree':
        openWorktree(target.worktree);
        break;
      case 'submodule':
        editSubmodule(target.submodule);
        break;
      default:
    }
  }

  /**
   * 워크트리를 탭으로 연다(원본은 Finder·탐색기로 폴더를 열었다 — 그것은 메뉴의 "폴더 열기" 에 남겼다).
   * 보던 탭 바로 오른쪽에 새 탭이 생기고 그 작업 폴더 기준으로 다시 읽는다. 이미 열어 둔 워크트리면 그 탭으로 간다.
   */
  function openWorktree(w) {
    if (w.current) return;
    if (w.prunable) {
      ctx.notify(t('워크트리 폴더를 찾을 수 없습니다: {path}', { path: w.path }));
      return;
    }
    ctx.openRepo(w.path, { beside: true });
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
    const values = await formDialog({ title: t('원격 이름 바꾸기'), glyph: 'cloud', fields: [{ name: 'name', label: t('새 이름'), value: remote.name }], ok: t('바꾸기'),
      validate: (v) => (!v.name.trim() ? t('이름을 적어 주세요.') : /\s/.test(v.name) ? t('공백은 쓸 수 없습니다.') : remotes().includes(v.name.trim()) && v.name.trim() !== remote.name ? t('같은 이름의 원격이 있습니다.') : null) });
    if (values && values.name.trim() !== remote.name) await run(t('이름을 바꾸는 중…'), 'renameRemote', { old: remote.name, new: values.name.trim() });
  }

  async function editRemoteUrl(remote) {
    const values = await formDialog({
      title: t("원격 '{name}' 주소", { name: remote.name }), glyph: 'cloud',
      fields: [{ name: 'url', label: t('Pull 주소'), value: remote.fetchUrl }, { name: 'pushUrl', label: t('Push 주소 (비우면 같음)'), value: remote.pushUrl === remote.fetchUrl ? '' : remote.pushUrl }],
      ok: t('저장'),
      validate: (v) => (v.url.trim() ? null : t('주소를 적어 주세요.')),
    });
    if (values) await run(t('주소를 바꾸는 중…'), 'setRemoteUrl', { name: remote.name, url: values.url, pushUrl: values.pushUrl }, t('주소를 바꿨습니다.'));
  }

  async function removeRemote(remote) {
    if (!(await confirmDialog({ title: t('원격 삭제'), glyph: 'cloud', danger: true, message: t("'{name}' 원격과 그 원격 브랜치 추적 참조를 지울까요?\n원격 레포지토리 자체는 지워지지 않습니다.", { name: remote.name }), ok: t('삭제') }))) return;
    await run(t('원격을 지우는 중…'), 'removeRemote', { name: remote.name }, t("원격 '{name}' 를 지웠습니다.", { name: remote.name }));
  }

  /** 원격 주소처럼 보이는지(원본 GitRemoteForm.IsPlausibleUrl): https·ssh·git·file 주소, user@host:경로, 또는 폴더 경로. */
  const plausibleUrl = (value) => {
    const v = value.trim();
    return /^(https?|ssh|git|file):\/\/\S+$/i.test(v) || /^[\w.-]+@[\w.-]+:\S+$/.test(v) || /^(\/|~\/|\.{1,2}\/|[a-zA-Z]:[\\/])/.test(v);
  };
  const BAD_URL = t('원격 주소가 아닙니다. https://…, git@host:owner/repo.git, 또는 있는 폴더 경로를 넣으세요.');

  /**
   * 원격 추가 드로어(원본 AddRemoteDrawer): 위 탭 [주소 | GitHub]. 주소 탭은 이름·가져올 주소·올릴 주소와 폭을 다 쓰는 초록 [원격 추가].
   * 더한 뒤 그 원격만 Fetch.
   */
  function addRemote() {
    openDrawer({
      glyph: 'cloud', title: t('원격 추가'), anchor: ctx.sidebarElement(),
      build(body, close) {
        let tab = ctx.prefs.get('addRemote.tab') ?? 'url';
        const tabs = el('div', { class: 'drawer-tabs' });
        const content = el('div', { class: 'drawer-content' });
        const tabButton = (key, glyph, label, tip) => el('button', {
          class: `drawer-tab${tab === key ? ' on' : ''}`, 'data-tip': tip,
          onclick: () => { tab = key; ctx.prefs.set('addRemote.tab', tab); draw(); },
        }, icon(glyph, 24), el('span', { text: label }));
        const draw = () => {
          tabs.replaceChildren(
            tabButton('url', 'globe', t('주소'), t('원격 레포지토리 주소(URL)를 직접 넣습니다.')),
            tabButton('github', 'github', 'GitHub', t('GitHub 의 레포지토리를 고르거나 새로 만듭니다.')));
          content.replaceChildren(tab === 'url' ? urlForm() : (ctx.githubRemoteForm?.(close) ?? el('div', { class: 'muted small', text: t('GitHub 에 로그인하면 레포지토리를 고르거나 새로 만들 수 있습니다.') })));
          content.querySelector('input')?.focus();
        };
        const urlForm = () => {
          const name = el('input', { class: 'field', spellcheck: 'false' });
          name.value = remotes().includes('origin') ? '' : 'origin';
          const url = el('input', { class: 'field', spellcheck: 'false' });
          const pushUrl = el('input', { class: 'field', placeholder: t('비우면 Pull URL 을 씁니다'), spellcheck: 'false' });
          const problem = drawerProblem();
          const ok = drawerPrimary(t('원격 추가'));
          // 비어 있는 칸은 알리지 않고 버튼만 끈다(원본 Validate).
          const check = () => {
            const n = name.value.trim();
            const nameProblem = !n ? null : remotes().includes(n) ? t('같은 이름의 원격이 이미 있습니다.') : n.includes('/') ? t('원격 이름에 / 는 쓸 수 없습니다.') : branchNameProblem(n, []);
            const badUrl = [url, pushUrl].some((i) => i.value.trim() && !plausibleUrl(i.value));
            problem.set(nameProblem ?? (badUrl ? BAD_URL : null));
            ok.disabled = busy() || !n || !!nameProblem || !url.value.trim() || badUrl;
            return ok.disabled;
          };
          [name, url, pushUrl].forEach((i) => i.addEventListener('input', check));
          const submit = async () => {
            if (check()) return;
            const remoteName = name.value.trim();
            const added = await act(t('원격을 추가하는 중…'), () => call('addRemote', { name: remoteName, url: url.value.trim(), pushUrl: pushUrl.value.trim() }).then(() => true));
            if (added !== true) return;
            close();
            await act(t("'{name}' 에서 Fetch 하는 중…", { name: remoteName }), () => call('fetchRemote', { name: remoteName }), { success: () => t("원격 '{name}' 를 추가했습니다.", { name: remoteName }) });
          };
          ok.addEventListener('click', submit);
          for (const i of [name, url, pushUrl]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) submit(); });
          check();
          return el('div', { class: 'drawer-form' },
            drawerField(t('이름'), name), drawerField(t('가져올 주소 (Pull URL)'), url), drawerField(t('올릴 주소 (Push URL)'), pushUrl),
            problem, ok);
        };
        body.append(tabs, content);
        draw();
      },
    });
  }

  // ── 워크트리·서브모듈 ──

  /** 레포지토리 폴더 옆 "<레포지토리>-<브랜치>" (원본 GitWorktreeForm.SuggestPath). 경로 구분자·공백 등은 '-' 로. */
  function suggestWorktreePath(name) {
    if (!name?.trim()) return '';
    const root = ctx.state.repo.path.replace(/\\/g, '/').replace(/\/+$/, '');
    const slash = root.lastIndexOf('/');
    const suffix = name.trim().replace(/[\\/\s<>:"|?*]/g, '-');
    return `${slash < 0 ? '' : `${root.slice(0, slash)}/`}${root.slice(slash + 1)}-${suffix}`;
  }

  /** 폴더 상태(있는지·폴더인지·비었는지). 경로가 상대면 레포지토리 기준. */
  const pathInfo = (path) => call('pathInfo', { path }).catch(() => ({ exists: false, dir: false, empty: true }));

  /**
   * 워크트리 만들기 드로어(원본 AddWorktreeDrawer): 체크아웃할 참조(로컬·원격·태그) · 새로 만들 브랜치(원격을 고르면 이름을 넣어 준다) ·
   * 작업 폴더(자동 "<레포지토리>-<브랜치>", [찾아보기]). 이미 다른 워크트리에서 쓰는 브랜치·비어 있지 않은 폴더는 막는다.
   */
  function addWorktree(reference) {
    openDrawer({
      glyph: 'worktree', title: t('워크트리 만들기'), anchor: ctx.sidebarElement(),
      build(body, close) {
        const refs = ctx.state.refs ?? { local: [], remote: [], tags: [] };
        const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        const choices = [
          ...[...refs.local].sort(byName).map((b) => ({ value: b.name, label: b.name, hint: t('로컬'), kind: 'local', icon: 'branch' })),
          ...refs.remote.filter((b) => !b.name.endsWith('/HEAD')).sort(byName).map((b) => ({ value: b.name, label: b.name, hint: t('원격'), kind: 'remote', icon: 'cloud' })),
          ...refs.tags.map((tag) => ({ value: tag.name, label: tag.name, hint: t('태그'), kind: 'tag', icon: 'tag' })),
        ];
        let branchEdited = false;
        let pathEdited = false;
        let folderState = { exists: false, dir: false, empty: true };
        let token = 0;
        const branch = el('input', { class: 'field', placeholder: t('비우면 고른 참조를 그대로 체크아웃합니다'), spellcheck: 'false' });
        const folder = el('input', { class: 'field', spellcheck: 'false' });
        const select = searchSelect({ items: choices, value: null, placeholder: t('선택…'), onChange: () => onChosen() });
        const chosen = () => choices.find((c) => c.value === select.value) ?? null;
        const problem = drawerProblem();
        const ok = drawerPrimary(t('워크트리 만들기'));
        async function readFolder() {
          const mine = ++token;
          const path = folder.value.trim();
          const info = path ? await pathInfo(path) : { exists: false, dir: false, empty: true };
          if (mine !== token) return;
          folderState = info;
          check();
        }
        const suggestPath = () => {
          if (pathEdited) return;
          folder.value = suggestWorktreePath(branch.value.trim() || chosen()?.value);
          readFolder();
        };
        // 원격을 고르면 같은 이름의 로컬 브랜치가 없을 때 그 이름을 새 브랜치로 넣어 둔다(원본 SuggestBranch).
        function onChosen() {
          const c = chosen();
          if (!branchEdited) {
            const local = c?.kind === 'remote' ? c.value.slice(c.value.indexOf('/') + 1) : null;
            branch.value = local && !localNames().some((n) => n.toLowerCase() === local.toLowerCase()) ? local : '';
          }
          suggestPath();
          check();
        }
        function check() {
          const c = chosen();
          const name = branch.value.trim();
          const path = folder.value.trim();
          let p = name ? branchNameProblem(name, localNames()) : null;
          const usedBy = c?.kind === 'local' && !name ? (ctx.state.worktrees ?? []).find((w) => w.branch === c.value)?.path : null;
          if (!p && usedBy) p = t("'{name}' 는 이미 {path} 에서 체크아웃되어 있습니다. 새 브랜치 이름을 적으세요.", { name: c.value, path: usedBy });
          if (!p && path && folderState.exists && (!folderState.dir || !folderState.empty)) p = t('이 폴더는 비어 있지 않습니다.');
          problem.set(p);
          ok.disabled = busy() || !c || !path || !!p;
          return ok.disabled;
        }
        branch.addEventListener('input', () => { branchEdited = true; suggestPath(); check(); });
        folder.addEventListener('input', () => { pathEdited = true; readFolder(); check(); });
        ok.addEventListener('click', async () => {
          if (check()) return;
          const name = branch.value.trim();
          const done = await act(t("워크트리 '{name}' 만드는 중…", { name: name || select.value }), () => call('addWorktree', { path: folder.value.trim(), reference: select.value, newBranch: name || undefined }).then(() => true), { success: () => t('워크트리를 만들었습니다.') });
          if (done === true) close();
          else check();
        });
        const browse = el('button', { class: 'btn drawer-secondary', text: t('찾아보기'), onclick: async () => {
          const start = folder.value.trim() || ctx.state.repo.path.replace(/[\\/][^\\/]+[\\/]?$/, '');
          const picked = await call('pick', { kind: 'folder', start, title: t('작업 폴더') });
          if (picked) { folder.value = picked.replace(/\\/g, '/'); pathEdited = true; readFolder(); check(); }
        } });
        body.append(el('div', { class: 'drawer-form' },
          drawerField(t('체크아웃할 참조'), select.element),
          drawerField(t('새로 만들 브랜치'), branch),
          drawerField(t('작업 폴더'), el('div', { class: 'row' }, folder, browse)),
          problem, ok));
        // PR 메뉴의 "워크트리 만들기" 처럼 참조를 정해 열었으면 그것을 골라 둔다.
        if (reference && choices.some((c) => c.value === reference)) {
          select.set(reference);
          onChosen();
        }
        check();
      },
    });
  }

  async function removeWorktree(w) {
    if (!(await confirmDialog({
      title: t('워크트리 제거'), glyph: 'worktree', danger: true, ok: t('삭제'),
      message: t('워크트리 {path} 를 제거할까요?\n\n그 폴더가 지워집니다. 커밋하지 않은 변경이 있으면 git 이 거부합니다. 브랜치는 그대로 남습니다.', { path: w.path }),
    }))) return;
    await run(t('워크트리를 제거하는 중…'), 'removeWorktree', { path: w.path, force: false }, t('워크트리를 제거했습니다.'));
  }

  /** 주소에서 서브모듈 경로를 짐작한다(원본 GitSubmoduleForm.PathFromUrl): 마지막 / \ : 뒤, ".git" 은 뗀다. */
  function pathFromUrl(url) {
    const trimmed = url.trim().replace(/[\\/]+$/, '');
    const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'), trimmed.lastIndexOf(':'));
    const name = cut < 0 ? trimmed : trimmed.slice(cut + 1);
    return name.toLowerCase().endsWith('.git') ? name.slice(0, -4) : name;
  }

  /** 서브모듈 추가 드로어(원본 AddSubmoduleDrawer): 원격 URL · 이름/경로(주소에서 자동). 경로는 레포지토리 안 상대 경로, 빈 곳이어야 한다. */
  function addSubmodule() {
    openDrawer({
      glyph: 'submodule', title: t('서브모듈 추가'), anchor: ctx.sidebarElement(),
      build(body, close) {
        const url = el('input', { class: 'field', spellcheck: 'false' });
        const path = el('input', { class: 'field', placeholder: t('Packages/라이브러리'), spellcheck: 'false' });
        const problem = drawerProblem();
        const ok = drawerPrimary(t('서브모듈 추가'));
        let pathEdited = false;
        let taken = false;
        let token = 0;
        function check() {
          const value = path.value.trim().replace(/\\/g, '/');
          const p = !value ? null
            : value.startsWith('/') || /^[a-zA-Z]:/.test(value) ? t('레포지토리 루트 기준의 상대 경로를 적으세요.')
              : value.split('/').includes('..') ? t("'..' 로 레포지토리 밖을 가리킬 수 없습니다.")
                : taken ? t('그 경로에 이미 파일이나 폴더가 있습니다.') : null;
          problem.set(p);
          ok.disabled = busy() || !url.value.trim() || !value || !!p;
          return ok.disabled;
        }
        async function readPath() {
          const mine = ++token;
          const value = path.value.trim();
          const info = value ? await pathInfo(value) : { exists: false };
          if (mine !== token) return;
          taken = !!info.exists && (!info.dir || !info.empty);
          check();
        }
        url.addEventListener('input', () => {
          if (!pathEdited) path.value = pathFromUrl(url.value);
          readPath();
          check();
        });
        path.addEventListener('input', () => { pathEdited = true; readPath(); check(); });
        ok.addEventListener('click', async () => {
          if (check()) return;
          const value = path.value.trim().replace(/\\/g, '/');
          const done = await act(t("서브모듈 '{path}' 추가하는 중…", { path: value }), () => call('addSubmodule', { url: url.value.trim(), path: value }).then(() => true), { success: () => t('서브모듈을 추가했습니다.') });
          if (done === true) close();
        });
        body.append(el('div', { class: 'drawer-form' }, drawerField(t('원격 URL'), url), drawerField(t('이름/경로'), path), problem, ok));
        check();
      },
    });
  }

  const SUBMODULE_STATE = {
    ok: (repo) => t('이 서브모듈은 레포지토리({repo})에 기록된 커밋과 맞습니다.', { repo }),
    modified: (repo) => t('이 서브모듈은 레포지토리({repo})에 기록된 것과 다른 커밋에 있습니다. 커밋하면 레포지토리 기록이 지금 커밋으로 바뀝니다.', { repo }),
    uninitialized: () => t('아직 받지 않은 서브모듈입니다. 사이드바 메뉴의 Update 로 받으세요.'),
    conflict: () => t('이 서브모듈은 병합 충돌 중입니다.'),
  };

  /**
   * 서브모듈 편집 드로어(원본 EditSubmoduleDrawer): 원격 URL(바꾸면 [이 서브모듈 고치기]) · 이름/경로(읽기만) · 기록된 커밋과 맞는지 ·
   * 현재 리비전(커밋·메시지) · [이 서브모듈 열기] [이 서브모듈 지우기].
   */
  function editSubmodule(s) {
    openDrawer({
      glyph: 'submodule', title: t('서브모듈 편집'), anchor: ctx.sidebarElement(),
      build(body, close) {
        const url = el('input', { class: 'field', spellcheck: 'false' });
        url.value = s.url ?? '';
        const path = el('input', { class: 'field', spellcheck: 'false', readonly: true });
        path.value = s.path;
        const problem = drawerProblem();
        const apply = el('button', { class: 'btn drawer-secondary', text: t('이 서브모듈 고치기') });
        let savedUrl = s.url ?? '';
        const check = () => {
          const value = url.value.trim();
          const bad = !!value && !plausibleUrl(value);
          problem.set(bad ? BAD_URL : null);
          apply.disabled = busy() || !value || value === savedUrl || bad;
        };
        url.addEventListener('input', check);
        apply.addEventListener('click', async () => {
          const value = url.value.trim();
          // 기록된 브랜치는 그대로 둔다(비워 넘기면 기본 브랜치로 바뀐다).
          const done = await act(t("'{path}' 주소 바꾸는 중…", { path: s.path }), () => call('editSubmodule', { path: s.path, url: value, branch: s.branch || undefined }).then(() => true), { success: () => t('서브모듈 주소를 바꿨습니다.') });
          if (done === true) savedUrl = value;
          check();
        });
        const sync = el('div', { class: `submodule-sync ${s.state}`, text: (SUBMODULE_STATE[s.state] ?? SUBMODULE_STATE.ok)(ctx.state.repo?.name ?? '') });
        const revisionCaption = el('span', { class: 'drawer-caption', text: t('현재 리비전') });
        const commit = el('div', { class: 'fact-value mono', text: s.hash ?? '' });
        const message = el('div', { class: 'fact-value', text: '…' });
        const unknown = () => {
          message.textContent = t('(받지 않아 알 수 없음)');
          message.classList.add('empty');
        };
        call('submoduleInfo', { path: s.path }).then((info) => {
          if (info?.date) revisionCaption.textContent = t('현재 리비전 ({date})', { date: new Date(info.date * 1000).toLocaleString('sv-SE').slice(0, 16) });
          if (info?.message) message.textContent = info.message;
          else unknown();
        }).catch(unknown);
        const open = el('button', {
          class: 'btn drawer-secondary icon-text', disabled: s.state === 'uninitialized',
          onclick: () => { close(); ctx.openRepo(`${ctx.state.repo.path}/${s.path}`); },
        }, icon('folder', 15), el('span', { text: t('이 서브모듈 열기') }));
        const remove = el('button', {
          class: 'btn drawer-secondary icon-text danger-text', disabled: busy(),
          onclick: async () => {
            if (!(await confirmDialog({
              title: t('서브모듈 지우기'), glyph: 'submodule', danger: true, ok: t('삭제'),
              message: t("'{path}' 서브모듈을 레포지토리에서 빼고 폴더를 지웁니다. 커밋해야 레포지토리 기록에 반영됩니다.\n\n서브모듈 안에서 커밋하지 않은 변경은 사라집니다.", { path: s.path }),
            }))) return;
            const done = await act(t("서브모듈 '{path}' 지우는 중…", { path: s.path }), () => call('removeSubmodule', { path: s.path }).then(() => true), { success: () => t('서브모듈을 지웠습니다. 커밋해 마무리하세요.') });
            if (done === true) close();
          },
        }, icon('trash', 15), el('span', { text: t('이 서브모듈 지우기') }));
        body.append(el('div', { class: 'drawer-form' },
          drawerField(t('원격 URL'), url), drawerField(t('이름/경로'), path), problem, el('div', {}, apply),
          sync,
          el('div', { class: 'drawer-field' }, revisionCaption,
            el('div', { class: 'fact' }, el('span', { class: 'fact-name', text: t('커밋') }), commit),
            el('div', { class: 'fact' }, el('span', { class: 'fact-name', text: t('커밋 메시지') }), message)),
          el('div', { class: 'drawer-actions' }, open, remove)));
        check();
      },
    });
  }

  // ── 메뉴 ───────────────────────────────────────────

  const compareItems = (revision, label) => ({
    label: t('비교'),
    submenu: [
      { label: t("'{name}' 와 갈라진 뒤", { name: current()?.name ?? 'HEAD' }), disabled: !ctx.compare, action: () => ctx.compare?.('HEAD', revision, { range: true, title: t('{label} (갈라진 뒤)', { label }) }) },
      { label: t('다른 브랜치와…'), disabled: !ctx.compare, action: () => compareWithOther(revision, label) },
      { label: t('작업 폴더와'), disabled: !ctx.compare, action: () => ctx.compare?.(revision, null, { title: t('{label} ↔ 작업 사본', { label }) }) },
    ],
  });

  async function compareWithOther(revision, label) {
    const options = [...(ctx.state.refs?.local ?? []), ...(ctx.state.refs?.remote ?? [])].filter((b) => b.name !== revision).map((b) => ({ value: b.name, label: b.name }));
    const other = await pickDialog({ title: t("'{label}' 와 비교할 브랜치", { label }), glyph: 'branch', options, value: current()?.name });
    if (other) ctx.compare?.(other, revision, { title: `${other} ↔ ${label}` });
  }

  /** 브랜치 메뉴 항목(로컬). 커밋 메뉴의 하위 메뉴에도 쓴다. */
  function localItems(branch) {
    const cur = current();
    const writable = !busyOp();
    const isCurrent = branch.current;
    return [
      { label: t('전환'), disabled: isCurrent || !writable, action: () => checkout(branch.name) },
      { label: t('Pull (앞으로 감기)'), disabled: !branch.upstream || !writable, action: () => (isCurrent ? ctx.pull?.() : run(t('앞으로 감는 중…'), 'fastForward', { branch: branch.name, current: false }, t('{name} 를 앞으로 감았습니다.', { name: branch.name }))) },
      { label: 'Push', disabled: !writable, action: () => pushBranch(branch) },
      { label: t('upstream 설정…'), action: () => setUpstream(branch) },
      { label: t("'{name}' 로 앞으로 감기", { name: branch.upstream ?? 'upstream' }), disabled: !branch.upstream || !branch.behind || !writable, action: () => run(t('앞으로 감는 중…'), 'fastForward', { branch: branch.name, current: isCurrent }, t('{name} 를 앞으로 감았습니다.', { name: branch.name })) },
      '-',
      {
        label: t("'{name}' 에 병합", { name: cur?.name ?? 'HEAD' }), disabled: isCurrent || !writable,
        submenu: ['default', 'noFf', 'squash', 'ffOnly'].map((mode) => ({ label: MERGE_LABEL[mode], action: () => merge(branch.name, branch.name, mode) })),
      },
      { label: t("'{name}' 를 여기 위로 Rebase", { name: cur?.name ?? 'HEAD' }), disabled: isCurrent || !writable, action: () => rebase(branch.name) },
      '-',
      { label: t('여기서 새 브랜치…'), action: () => createBranch(branch.name, branch.name) },
      { label: t('새 태그…'), action: () => createTag(branch.hash, branch.name) },
      { label: t('이름 바꾸기…'), action: () => renameBranch(branch.name) },
      { label: t('지우기…'), danger: true, disabled: isCurrent, action: () => deleteBranch(branch) },
      { label: t('원격 브랜치 지우기…'), danger: true, disabled: !branch.upstream, action: () => deleteRemoteBranch(ctx.state.refs.remote.find((r) => r.name === branch.upstream) ?? { name: branch.upstream, remote: branch.upstream.split('/')[0] }) },
      '-',
      compareItems(branch.name, branch.name),
      { label: t('그래프에서 보기'), action: () => ctx.reveal(branch.hash) },
      { label: t('Pull Request 만들기…'), disabled: !ctx.createPullRequest, action: () => ctx.createPullRequest?.(branch.name) },
      { label: t('이름 복사'), action: () => copy(branch.name) },
    ];
  }

  function remoteItems(branch) {
    const cur = current();
    const writable = !busyOp();
    return [
      { label: t('로컬 브랜치로 전환'), disabled: !writable, action: () => activate({ kind: 'remote', branch }) },
      '-',
      { label: t("'{name}' 에 병합", { name: cur?.name ?? 'HEAD' }), disabled: !writable, submenu: ['default', 'noFf', 'squash', 'ffOnly'].map((mode) => ({ label: MERGE_LABEL[mode], action: () => merge(branch.name, branch.name, mode) })) },
      { label: t("'{name}' 를 여기 위로 Rebase", { name: cur?.name ?? 'HEAD' }), disabled: !writable, action: () => rebase(branch.name) },
      '-',
      { label: t('여기서 새 브랜치…'), action: () => createBranch(branch.name, branch.name) },
      { label: t('새 태그…'), action: () => createTag(branch.hash, branch.name) },
      compareItems(branch.name, branch.name),
      { label: t('그래프에서 보기'), action: () => ctx.reveal(branch.hash) },
      { label: t('이름 복사'), action: () => copy(branch.name) },
      '-',
      { label: t('원격에서 지우기…'), danger: true, action: () => deleteRemoteBranch(branch) },
    ];
  }

  const menuAt = (event, items) => showMenu(event.clientX, event.clientY, items);

  const menus = {
    local: (event, branch) => menuAt(event, localItems(branch)),
    remote: (event, branch) => menuAt(event, remoteItems(branch)),
    // 원본 RefSidebar.PopulateMenu 의 원격 메뉴. 다른 작업이 도는 중이면 쓰는 항목을 끈다.
    remoteHeader: (event, remote) => menuAt(event, [
      { label: t("'{name}' 에서 Fetch", { name: remote.name }), disabled: busy(), action: () => run(t("'{name}' 에서 Fetch 하는 중…", { name: remote.name }), 'fetchRemote', { name: remote.name }, t("'{name}' 에서 받았습니다.", { name: remote.name })) },
      { label: t('지워진 원격 브랜치 정리 (Prune)'), disabled: busy(), action: () => run(t("'{name}' 정리하는 중…", { name: remote.name }), 'pruneRemote', { name: remote.name }, t('정리했습니다.')) },
      '-',
      { label: t('원격 이름 바꾸기…'), disabled: busy(), action: () => renameRemote(remote) },
      { label: t('주소 바꾸기…'), disabled: busy(), action: () => editRemoteUrl(remote) },
      { label: t('주소 복사'), disabled: !remote.fetchUrl, action: () => copy(remote.fetchUrl) },
      '-',
      { label: t("'{name}' 원격 삭제…", { name: remote.name }), danger: true, disabled: busy(), action: () => removeRemote(remote) },
    ]),
    // 원본 PopulateTagMenu: 원격이 여럿이면 원격마다 Push·삭제 항목을 둔다(하나로 정해 올리지 않는다).
    tag: (event, tag) => {
      const cur = current()?.name ?? 'HEAD';
      const list = [...remotes()].sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : a.localeCompare(b)));
      menuAt(event, [
        { label: t("'{tag}' 체크아웃 (분리된 HEAD)…", { tag: tag.name }), disabled: busyOp(), action: () => activate({ kind: 'tag', tag }) },
        { label: t("'{tag}' 를 '{into}' 에 Merge…", { tag: tag.name, into: cur }), disabled: busyOp(), action: () => merge(tag.name, tag.name) },
        '-',
        ...list.map((r) => ({
          label: t("'{tag}' 를 {remote} 에 Push…", { tag: tag.name, remote: r }), disabled: busy(),
          action: async () => {
            if (await confirmDialog({ title: t('태그 Push'), glyph: 'tag', ok: 'Push', message: t("태그 '{tag}' 를 {remote} 에 올릴까요?", { tag: tag.name, remote: r }) })) {
              await run(t("태그 '{tag}' 올리는 중…", { tag: tag.name }), 'pushTag', { remote: r, name: tag.name }, t("태그 '{tag}' 를 {remote} 에 올렸습니다.", { tag: tag.name, remote: r }));
            }
          },
        })),
        {
          label: t("'{tag}' 삭제…", { tag: tag.name }), danger: true, disabled: busy(),
          action: async () => {
            if (await confirmDialog({ title: t('태그 삭제'), glyph: 'tag', danger: true, ok: t('삭제'), message: t("로컬 태그 '{tag}' 를 삭제할까요? 원격의 태그는 그대로 둡니다.", { tag: tag.name }) })) {
              await run(t("태그 '{tag}' 지우는 중…", { tag: tag.name }), 'deleteTag', { name: tag.name });
            }
          },
        },
        ...list.map((r) => ({
          label: t("{remote} 에서 '{tag}' 삭제…", { remote: r, tag: tag.name }), danger: true, disabled: busy(),
          action: async () => {
            if (await confirmDialog({ title: t('태그 삭제'), glyph: 'tag', danger: true, ok: t('삭제'), message: t("{remote} 에서 태그 '{tag}' 를 삭제할까요?\n\n다른 사람에게도 바로 사라집니다. 로컬 태그는 그대로 남습니다.", { remote: r, tag: tag.name }) })) {
              await run(t("원격 태그 '{tag}' 지우는 중…", { tag: tag.name }), 'deleteRemoteTag', { remote: r, name: tag.name }, t('원격 태그를 지웠습니다.'));
            }
          },
        })),
        '-',
        { label: t('이름 복사'), action: () => copy(tag.name) },
        { label: t('커밋 SHA 복사'), action: () => copy(tag.hash) },
      ]);
    },
    // 원본 PopulateStashMenu.
    stash: (event, stash) => menuAt(event, [
      { label: 'Apply Stash', disabled: busyOp(), action: () => stashApply(stash) },
      { label: 'Pop Stash', disabled: busyOp(), action: () => stashPop(stash.name) },
      { label: 'Delete Stash…', danger: true, disabled: busy(), action: () => stashDrop(stash) },
      '-',
      { label: t('변경 보기'), action: () => ctx.showCommit(stash.hash, `${stash.name}: ${stash.message}`) },
      { label: t('여기서 브랜치 만들기…'), disabled: busyOp(), action: () => stashBranch(stash) },
      '-',
      { label: t('메시지 복사'), action: () => copy(stash.message) },
    ]),
    // 원본 PopulateWorktreeMenu: 지금 쓰고 있는 워크트리와 원본(bare) 레포지토리는 지울 수 없다.
    worktree: (event, w) => menuAt(event, [
      { label: t('탭으로 열기'), disabled: w.current || w.prunable, action: () => openWorktree(w) },
      '-',
      { label: t('폴더 열기'), action: () => call('openFolder', { path: w.path }).catch(ctx.showError) },
      { label: t('터미널 열기'), action: () => call('openTerminal', { path: w.path }).catch(ctx.showError) },
      { label: t('경로 복사'), action: () => copy(w.path) },
      '-',
      { label: t('워크트리 제거…'), danger: true, disabled: w.current || w.bare || busy(), action: () => removeWorktree(w) },
    ]),
    submodule: (event, s) => {
      const full = `${ctx.state.repo.path}/${s.path}`;
      menuAt(event, [
        { label: t('편집…'), action: () => editSubmodule(s) },
        { label: t('열기'), disabled: s.state === 'uninitialized', action: () => ctx.openRepo(full) },
        '-',
        { label: t('Update (받기·체크아웃)'), disabled: busy(), action: () => run(t("서브모듈 '{path}' Update 하는 중…", { path: s.path }), 'updateSubmodules', { path: s.path }, t('서브모듈을 받았습니다.')) },
        '-',
        { label: t('폴더 열기'), action: () => call('openFolder', { path: full }).catch(ctx.showError) },
        { label: t('터미널 열기'), action: () => call('openTerminal', { path: full }).catch(ctx.showError) },
        { label: t('경로 복사'), action: () => copy(s.path) },
      ]);
    },
    // 원본 PopulateSectionMenu: 구역 머리 우클릭.
    section: (id, event) => {
      const head = ctx.state.history?.head;
      const items = {
        local: [{ label: t('HEAD 에서 새 브랜치…'), disabled: !head || busy(), action: () => createBranch('HEAD', undefined, { inline: false }) }],
        remote: [{ label: t('원격 추가…'), disabled: busy(), action: addRemote }, { label: 'Fetch', disabled: busy() || !remotes().length, action: () => ctx.fetch?.() }],
        tags: [{ label: t('HEAD 에 새 태그…'), disabled: !head || busy(), action: () => createTag(head, 'HEAD') }],
        stash: [{ label: t('지금 변경을 Stash'), disabled: busy() || !(ctx.state.status?.staged.length + ctx.state.status?.unstaged.length), action: stashPush }],
        worktrees: [
          { label: t('워크트리 만들기…'), disabled: busy(), action: () => addWorktree() },
          { label: t('폴더 열기'), action: () => call('openFolder', { path: ctx.state.repo.path }).catch(ctx.showError) },
        ],
        submodules: [
          { label: t('서브모듈 추가…'), disabled: busy(), action: addSubmodule },
          { label: t('모든 서브모듈 Update'), disabled: busy() || !(ctx.state.submodules ?? []).length, action: () => run(t('모든 서브모듈 Update 하는 중…'), 'updateSubmodules', {}, t('서브모듈을 받았습니다.')) },
        ],
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
      const tag = refs?.tags.find((x) => x.name === ref.name);
      if (tag) return menus.tag(event, tag);
    }
    return commitMenu(event, commit);
  }

  // ── 커밋 메뉴(원본 CommitMenu, Fork 모양) ──

  let compareBase = null;

  async function rewrite(commit, kind) {
    const labels = { reword: 'Reword', squash: t('Squash (부모와 합치기)'), fixup: t('Fixup (부모와 합치고 메시지 버리기)'), drop: t('Drop (커밋 빼기)') };
    let message;
    if (kind === 'reword' || kind === 'squash') {
      const full = await call('commitDetail', { hash: kind === 'squash' ? commit.parents[0] : commit.hash }).then((d) => d.message).catch(() => commit.subject);
      const own = kind === 'squash' ? await call('commitDetail', { hash: commit.hash }).then((d) => d.message).catch(() => commit.subject) : '';
      const values = await formDialog({
        title: labels[kind], glyph: 'pencil',
        message: kind === 'squash' ? t('{hash} 를 부모 커밋과 합칩니다. 합친 메시지:', { hash: commit.shortHash }) : t('{hash} 의 메시지를 고칩니다. 작업 트리는 그대로입니다.', { hash: commit.shortHash }),
        fields: [{ name: 'message', type: 'textarea', rows: 6, value: kind === 'squash' ? `${full.trim()}\n\n${own.trim()}` : full }],
        ok: kind === 'squash' ? t('합치기') : t('고치기'),
        validate: (v) => (v.message.trim() ? null : t('메시지를 적어 주세요.')),
      });
      if (!values) return;
      message = values.message;
    } else if (!(await confirmDialog({
      title: labels[kind], danger: kind === 'drop',
      message: kind === 'drop' ? t('{hash} "{subject}" 를 히스토리에서 뺍니다. 그 뒤 커밋들은 다시 만들어집니다. 실행 취소로 되돌릴 수 있습니다.', { hash: commit.shortHash, subject: commit.subject }) : t('{hash} 를 부모 커밋과 합치고 이 커밋의 메시지는 버립니다.', { hash: commit.shortHash }),
      ok: kind === 'drop' ? t('빼기') : t('합치기'),
    }))) return;
    await run(t('{label} 하는 중…', { label: labels[kind] }), 'rewrite', { kind, hash: commit.hash, message }, t('히스토리를 고쳤습니다. 이미 푸시했다면 강제 푸시가 필요합니다.'));
  }

  async function savePatch(commit) {
    const path = await call('pick', { kind: 'save', name: `${commit.shortHash}.patch`, title: t('패치 저장'), filters: [{ name: t('패치'), ext: ['patch', 'diff'] }] });
    if (path) await run(t('패치를 쓰는 중…'), 'savePatch', { hash: commit.hash, path }, t('패치를 저장했습니다: {path}', { path }));
  }

  async function copyInfo(commit) {
    const detail = await call('commitDetail', { hash: commit.hash }).catch(() => null);
    const date = new Date(commit.time * 1000).toLocaleString(locale);
    copy(`commit ${commit.hash}\nAuthor: ${commit.authorName} <${commit.authorEmail}>\nDate:   ${date}\n\n${(detail?.message ?? commit.subject).replace(/^/gm, '    ')}\n`);
    ctx.notify(t('커밋 정보를 복사했습니다.'));
  }

  /**
   * hooks(원본 CommitMenu.Hooks): 화면마다 바꾸는 항목. goToParent 를 넘기면 "부모로 이동" 이 그 화면 안에서 움직이고(null 이면 흐리게),
   * 그때는 "브랜치 탐색기에서 보기" 를 넣지 않는다(브랜치 탐색기 자신의 메뉴).
   */
  function commitMenu(event, commit, hooks = null) {
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
        if (!b.current && !hasLocal) items.push({ label: t("'{name}' 로 전환", { name: b.name }), disabled: !writable, action: () => activate({ kind: b.remote ? 'remote' : 'local', branch: b }) });
      }
      for (const b of here) items.push({ label: t("브랜치 '{name}'", { name: b.name }), submenu: b.remote ? remoteItems(b) : localItems(b) });
      items.push('-');
    }
    items.push(
      { label: t('여기서 새 브랜치…'), disabled: !writable, action: () => createBranch(commit.hash, commit.shortHash) },
      { label: t('여기에 새 태그…'), action: () => createTag(commit.hash, commit.shortHash) },
      {
        label: 'Interactive Rebase',
        submenu: [
          { label: t('Reword (메시지 고치기)…'), disabled: rewriteOff('reword'), action: () => rewrite(commit, 'reword') },
          { label: t('Squash (부모와 합치기)…'), disabled: rewriteOff('squash'), action: () => rewrite(commit, 'squash') },
          { label: t('Fixup (합치고 메시지 버리기)…'), disabled: rewriteOff('fixup'), action: () => rewrite(commit, 'fixup') },
          { label: t('Drop (빼기)…'), danger: true, disabled: rewriteOff('drop'), action: () => rewrite(commit, 'drop') },
        ],
      },
      {
        label: t("'{name}' 를 여기로 Reset", { name: curName }), disabled: isHead || !writable,
        submenu: [
          { label: t('Soft — 바뀐 내용을 Stage 한 채로'), action: () => reset(commit.hash, 'soft') },
          { label: t('Mixed — 바뀐 내용을 작업 트리에'), action: () => reset(commit.hash, 'mixed') },
          { label: t('Hard — 모두 버리기'), danger: true, action: () => reset(commit.hash, 'hard') },
        ],
      },
      '-',
      { label: t('이 커밋으로 전환 (detached)'), disabled: isHead || !writable, action: () => checkoutCommit(commit.hash) },
      {
        label: t("'{name}' 에 병합", { name: curName }), disabled: isHead || !writable,
        submenu: ['default', 'noFf', 'squash'].map((mode) => ({ label: MERGE_LABEL[mode], action: () => merge(commit.hash, commit.shortHash, mode) })),
      },
      { label: `Cherry-pick → '${curName}'`, disabled: isHead || !writable, action: () => run(t('Cherry-pick 하는 중…'), 'cherryPick', { hash: commit.hash, merge: isMerge }, t('Cherry-pick 했습니다.')) },
      {
        label: t('Revert (되돌리는 커밋 만들기)…'), disabled: !writable,
        action: async () => {
          if (await confirmDialog({ title: 'Revert', glyph: 'undo', message: t('{hash} "{subject}" 를 되돌리는 새 커밋을 만듭니다.', { hash: commit.shortHash, subject: commit.subject }), ok: 'Revert' })) {
            await run(t('Revert 하는 중…'), 'revert', { hash: commit.hash, merge: isMerge }, t('Revert 했습니다.'));
          }
        },
      },
      { label: t('패치로 저장…'), action: () => savePatch(commit) },
      '-',
      { label: t('작업 폴더와 비교'), disabled: !ctx.compare, action: () => ctx.compare?.(commit.hash, null, { title: t('{label} ↔ 작업 사본', { label: commit.shortHash }) }) },
      { label: t('부모와 비교'), disabled: !ctx.compare || !commit.parents.length, action: () => ctx.compare?.(`${commit.hash}^`, commit.hash, { title: t('{hash} 의 부모 ↔ {hash}', { hash: commit.shortHash }) }) },
      {
        label: t('비교'),
        submenu: [
          { label: t('다른 리비전과…'), disabled: !ctx.compare, action: () => compareWithRevision(commit) },
          { label: compareBase && compareBase.hash !== commit.hash ? t('표시한 {hash} 와 비교', { hash: compareBase.shortHash }) : t('표시한 커밋과 비교 (먼저 표시하세요)'), disabled: !ctx.compare || !compareBase || compareBase.hash === commit.hash, action: () => ctx.compare?.(compareBase.hash, commit.hash, { title: `${compareBase.shortHash} ↔ ${commit.shortHash}` }) },
          { label: t('비교 기준으로 표시'), checked: compareBase?.hash === commit.hash, action: () => { compareBase = commit; } },
        ],
      },
      hooks
        ? { label: t('부모로 이동'), disabled: !hooks.goToParent, action: () => hooks.goToParent?.() }
        : { label: t('부모로 이동'), disabled: !commit.parents.length, action: () => ctx.reveal(commit.parents[0]) },
      // 원본 GraphWorkspaceView 의 커밋 메뉴: 브랜치 탐색기 탭으로 가서 그 커밋을 보인다.
      hooks ? null : { label: t('브랜치 탐색기에서 보기'), disabled: !ctx.showInExplorer, action: () => ctx.showInExplorer?.(commit.hash) },
      '-',
      { label: t('SHA 복사'), action: () => copy(commit.hash) },
      { label: t('정보 복사'), action: () => copyInfo(commit) },
      { label: t('메시지 복사'), action: () => copy(commit.subject) },
    );
    showMenu(event.clientX, event.clientY, items.filter(Boolean));
  }

  async function compareWithRevision(commit) {
    const values = await formDialog({ title: t('{hash} 와 비교할 리비전', { hash: commit.shortHash }), glyph: 'search', fields: [{ name: 'rev', placeholder: 'main, v1.0, abc1234, HEAD~3' }], ok: t('비교'), validate: (v) => (v.rev.trim() ? null : t('리비전을 적어 주세요.')) });
    if (values) ctx.compare?.(values.rev.trim(), commit.hash, { title: `${values.rev.trim()} ↔ ${commit.shortHash}` });
  }

  return {
    commitMenu, refMenu, activateRef, activate, menus, add, createBranch, stashPush, stashPop, checkout, current, addRemote, addWorktree, addSubmodule, merge, rewrite,
  };
}
