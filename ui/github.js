// GitHub: 로그인(Device Flow), 계정 고르기, Pull Request(사이드바 구역·상세·만들기·필터), 원격 추가의 GitHub 탭(기존 저장소·새로 만들기).
// 원본 Elements/GitHubConnectPanel·Window/GitAccountDialog·Elements/PullRequest*Drawer·AddRemoteDrawer(GitHub 탭) 를 옮겼다.
// 토큰은 Rust 가 들고 있다 — 여기서는 경로만 넘겨 부른다.

import { el, relativeTime, formatDate, isComposing } from './util.js';
import { icon } from './icons.js';
import { openDrawer, showMenu, confirmDialog, formDialog, searchSelect } from './dialogs.js';

const STATE = { open: '열림', draft: '초안', merged: '병합됨', closed: '닫힘' };

/**
 * ctx: { call, act, prefs, state, showError, toast, sidebarElement(), refresh(), renderSidebar(), revealCommit(hash), refsUi }
 */
export function createGitHub(ctx) {
  let info = null; // {owner, repo, me, signedIn}
  let pulls = [];
  let custom = new Map(); // filter name → [pull]
  let loading = false;
  let loadedFor = null;

  const api = (path, { method = 'GET', body } = {}) => ctx.call('githubApi', { method, path, body });
  const repoPath = () => `/repos/${info.owner}/${info.repo}`;
  const filters = () => ctx.prefs.get('github.filters') ?? [];

  // ── 로그인(GH-01) ──

  function connect() {
    return new Promise((resolve) => {
      const backdrop = el('div', { class: 'modal-backdrop' });
      const card = el('div', { class: 'modal card connect-card' });
      backdrop.append(card);
      document.body.append(backdrop);
      let cancelled = false;
      const close = (value) => {
        cancelled = true;
        backdrop.remove();
        resolve(value);
      };
      const status = el('div', { class: 'muted small connect-status', text: 'GitHub 에 코드를 받는 중…' });
      const cells = el('div', { class: 'code-cells' });
      const openButton = el('button', { class: 'btn primary', text: 'GitHub 페이지 열기', disabled: true });
      const copyButton = el('button', { class: 'btn', disabled: true }, icon('copy', 14), ' 코드 복사');
      card.append(el('div', { class: 'card-head' }, el('span', { class: 'card-badge tone-accent' }, icon('github', 18)), el('div', { class: 'modal-title', text: 'GitHub 로그인' }),
        el('button', { class: 'card-close', onclick: () => close(false) }, icon('close', 14))),
      el('div', { class: 'modal-message', text: '브라우저에서 아래 코드를 넣고 GitHub 에서 승인하면 끝납니다. 토큰은 이 PC 의 키체인·자격 증명 관리자에만 둡니다.' }),
      cells, el('div', { class: 'row connect-actions' }, copyButton, openButton), status,
      el('div', { class: 'modal-actions' }, el('button', { class: 'link', text: '로그인 없이 계속', onclick: () => close(false) })));
      (async () => {
        try {
          const code = await ctx.call('githubDeviceStart');
          if (cancelled) return;
          // 코드를 글자 칸으로 보이고, 차례로 반짝인다.
          cells.replaceChildren(...[...code.user_code].map((ch, i) => el('span', { class: `code-cell${ch === '-' ? ' dash' : ''}`, style: { animationDelay: `${i * 70}ms` }, text: ch })));
          const copy = () => {
            navigator.clipboard?.writeText(code.user_code);
            cells.querySelectorAll('.code-cell').forEach((c) => { c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); });
          };
          copyButton.disabled = false;
          openButton.disabled = false;
          copyButton.onclick = copy;
          openButton.onclick = () => {
            copy();
            ctx.call('openUrl', { url: code.verification_uri });
          };
          status.textContent = 'GitHub 에서 승인하기를 기다리는 중…';
          let interval = (code.interval ?? 5) * 1000;
          const deadline = Date.now() + (code.expires_in ?? 900) * 1000;
          while (!cancelled && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, interval));
            if (cancelled) return;
            try {
              const r = await ctx.call('githubDevicePoll', { deviceCode: code.device_code });
              if (r.status === 'slowDown') interval += 5000;
              if (r.status === 'done') {
                ctx.toast(`GitHub 에 ${r.login} 으로 로그인했습니다.`, 'success');
                close(true);
                info = null;
                ctx.refresh();
                return;
              }
            } catch (error) {
              status.textContent = error?.message ?? String(error);
              status.classList.add('error-text');
              return;
            }
          }
          if (!cancelled) status.textContent = '코드의 기한이 지났습니다. 다시 시작해 주세요.';
        } catch (error) {
          status.textContent = error?.message ?? String(error);
          status.classList.add('error-text');
        }
      })();
    });
  }

  // ── 계정 고르기(GH-02) ──

  async function chooseAccount(reason) {
    const accounts = await ctx.call('githubAccounts').catch((e) => { ctx.showError(e); return null; });
    if (!accounts) return false;
    const SOURCE = { app: '앱 로그인', gh: 'GitHub CLI', credential: '자격 증명 관리자' };
    return new Promise((resolve) => {
      const backdrop = el('div', { class: 'modal-backdrop' });
      const card = el('div', { class: 'modal card' });
      const close = (v) => { backdrop.remove(); resolve(v); };
      const list = el('div', { class: 'pick-list' }, accounts.length ? accounts.map((a) => el('div', {
        class: `pick-item${a.current ? ' on' : ''}`,
        onclick: async () => {
          try {
            await ctx.call('githubChoose', { source: a.source, login: a.login });
            ctx.toast(`이 저장소는 ${a.login} (${SOURCE[a.source]}) 로 GitHub 에 접속합니다.`, 'success');
            info = null;
            close(true);
          } catch (e) {
            ctx.showError(e);
          }
        },
      }, el('span', { class: 'pick-radio' }), icon(a.source === 'gh' ? 'terminal' : a.source === 'app' ? 'github' : 'lock', 16),
      el('div', {}, el('div', { text: a.login }), el('div', { class: 'muted small', text: SOURCE[a.source] })), el('span', { class: 'spacer' }),
      a.canAccess == null ? el('span', { class: 'muted small', text: '확인 못 함' }) : el('span', { class: `access ${a.canAccess ? 'ok' : 'no'}`, text: a.canAccess ? '읽을 수 있음' : '접근 불가' })))
        : [el('div', { class: 'muted small', text: '찾은 GitHub 계정이 없습니다. 로그인해 주세요.' })]);
      card.append(el('div', { class: 'card-head' }, el('span', { class: 'card-badge tone-accent' }, icon('user', 18)), el('div', { class: 'modal-title', text: '이 저장소의 GitHub 계정' }),
        el('button', { class: 'card-close', onclick: () => close(false) }, icon('close', 14))),
      reason ? el('div', { class: 'modal-message', text: reason }) : null, list,
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', text: 'GitHub 로그인…', onclick: async () => { close(false); if (await connect()) resolve(true); } }), el('span', { class: 'spacer' }), el('button', { class: 'btn', text: '닫기', onclick: () => close(false) })));
      backdrop.append(card);
      document.body.append(backdrop);
    });
  }

  // ── Pull Request 읽기 ──

  async function load(force = false) {
    if (loading) return;
    const key = ctx.state.repo?.path;
    if (!force && loadedFor === key) return;
    loading = true;
    try {
      info = await ctx.call('githubRepo');
      loadedFor = key;
      if (!info.owner) {
        pulls = [];
        return;
      }
      pulls = await api(`${repoPath()}/pulls?state=open&per_page=100`);
      custom = new Map();
      for (const f of filters()) {
        const q = encodeURIComponent(`repo:${info.owner}/${info.repo} is:pr ${f.query}`);
        const found = await api(`/search/issues?q=${q}&per_page=50`).catch(() => ({ items: [] }));
        custom.set(f.name, found.items ?? []);
      }
    } catch (error) {
      pulls = [];
      info = info ?? {};
      info.error = error?.message ?? String(error);
    } finally {
      loading = false;
      ctx.renderSidebar();
      ctx.onCount?.(pulls.length);
    }
  }

  const has = (p, who) => !!who && (p.user?.login === who || p.assignees?.some((a) => a.login === who) || p.requested_reviewers?.some((r) => r.login === who));

  /** 사이드바 구역(GH-03). GitHub 원격이 없으면 null. */
  function section() {
    if (!ctx.state.remotes?.some((r) => /github\.com/i.test(r.fetchUrl))) return null;
    if (loadedFor !== ctx.state.repo?.path) load();
    const me = info?.me;
    const groups = [
      ['mine', '내 PR', pulls.filter((p) => p.user?.login === me)],
      ['assigned', '배정됨', pulls.filter((p) => p.assignees?.some((a) => a.login === me))],
      ['review', '리뷰 대기', pulls.filter((p) => p.requested_reviewers?.some((r) => r.login === me))],
      ['all', '전체', pulls],
      ...filters().map((f) => [`filter:${f.name}`, f.name, custom.get(f.name) ?? [], f]),
    ];
    const q = (ctx.filterText?.() ?? '').toLowerCase();
    const rows = [];
    for (const [id, title, list, filter] of groups) {
      const shown = list.filter((p) => !q || p.title.toLowerCase().includes(q) || String(p.number).includes(q));
      const key = `pr:${id}`;
      rows.push({
        key, depth: 1, folder: true, label: title, glyph: filter ? 'filterAdd' : 'folder', count: shown.length,
        expanded: ctx.isOpen(key, id !== 'all'), toggle: () => ctx.toggle(key, id !== 'all'),
        menu: filter ? (e) => filterMenu(e, filter) : null,
      });
      if (!ctx.isOpen(key, id !== 'all')) continue;
      for (const p of shown) {
        rows.push({
          key: `pr:${id}:${p.number}`, depth: 2, label: `#${p.number} ${p.title}`, glyph: 'pullRequest',
          tip: `#${p.number} ${p.title}\n${p.user?.login} · ${p.head?.ref ?? ''} → ${p.base?.ref ?? ''}${p.draft ? ' · 초안' : ''}`,
          extra: p.draft ? el('span', { class: 'side-sub-state', text: '초안' }) : null,
          onClick: () => detail(p.number),
          activate: () => ctx.call('openUrl', { url: p.html_url }),
          menu: (e) => pullMenu(e, p),
        });
      }
    }
    return {
      id: 'prs', title: 'Pull Requests', glyph: 'pullRequest', count: pulls.length, rows,
      empty: info?.error ? `PR 을 읽지 못했습니다: ${info.error}` : loading ? '불러오는 중…' : '열린 Pull Request 가 없습니다', add: 'Pull Request 만들기',
    };
  }

  function pullMenu(event, p) {
    showMenu(event.clientX, event.clientY, [
      { label: 'GitHub 에서 보기', action: () => ctx.call('openUrl', { url: p.html_url }) },
      { label: '링크 복사', action: () => navigator.clipboard?.writeText(p.html_url) },
      { label: '바뀐 것 보기', action: () => detail(p.number, 'files') },
      { label: '그래프에서 보기', disabled: !p.head?.sha, action: () => ctx.revealCommit(p.head.sha) },
      '-',
      { label: '체크아웃', action: () => checkoutPull(p) },
      { label: '워크트리 만들기', action: () => ctx.act(`#${p.number} 를 받는 중…`, () => fetchPull(p)).then(() => ctx.refsUi.addWorktree(`pr-${p.number}`)) },
    ]);
  }

  function filterMenu(event, filter) {
    const list = filters();
    const index = list.findIndex((f) => f.name === filter.name);
    const save = (next) => { ctx.prefs.set('github.filters', next); load(true); };
    showMenu(event.clientX, event.clientY, [
      { label: '고치기…', action: () => filterDrawer(filter) },
      { label: '지우기', danger: true, action: () => save(list.filter((_, i) => i !== index)) },
      '-',
      { label: '위로', disabled: index <= 0, action: () => { const n = [...list]; [n[index - 1], n[index]] = [n[index], n[index - 1]]; save(n); } },
      { label: '아래로', disabled: index >= list.length - 1, action: () => { const n = [...list]; [n[index + 1], n[index]] = [n[index], n[index + 1]]; save(n); } },
    ]);
  }

  async function fetchPull(p) {
    const remote = ctx.state.remotes.find((r) => /github\.com/i.test(r.fetchUrl))?.name ?? 'origin';
    await ctx.call('fetchRefspec', { remote, refspec: `+refs/pull/${p.number}/head:refs/heads/pr-${p.number}` });
  }

  async function checkoutPull(p) {
    await ctx.act(`#${p.number} 를 받는 중…`, async () => {
      await fetchPull(p);
      await ctx.call('checkout', { name: `pr-${p.number}`, remote: false });
    }, { success: () => `pr-${p.number} 로 바꿨습니다.` });
  }

  // ── PR 상세 드로어(GH-04) ──

  async function detail(number, focus) {
    openDrawer({
      glyph: 'pullRequest', title: `Pull Request #${number}`, anchor: ctx.sidebarElement(), width: 460,
      async build(body, close) {
        body.append(el('div', { class: 'muted small', text: '불러오는 중…' }));
        const draw = async () => {
          try {
            const [p, comments, reviews, files] = await Promise.all([
              api(`${repoPath()}/pulls/${number}`), api(`${repoPath()}/issues/${number}/comments?per_page=100`),
              api(`${repoPath()}/pulls/${number}/reviews?per_page=100`), api(`${repoPath()}/pulls/${number}/files?per_page=100`)]);
            const state = p.merged ? 'merged' : p.state === 'closed' ? 'closed' : p.draft ? 'draft' : 'open';
            const mergeable = p.mergeable == null ? 'GitHub 가 병합 가능 여부를 계산하는 중입니다.' : p.mergeable ? (p.mergeable_state === 'clean' ? '충돌 없이 병합할 수 있습니다.' : `병합할 수 있습니다(${p.mergeable_state}).`) : '충돌이 있어 병합할 수 없습니다.';
            const timeline = [...comments.map((c) => ({ at: c.created_at, who: c.user?.login, text: c.body, kind: '코멘트' })),
              ...reviews.filter((r) => r.state !== 'PENDING').map((r) => ({ at: r.submitted_at, who: r.user?.login, text: r.body, kind: { APPROVED: '승인', CHANGES_REQUESTED: '변경 요청', COMMENTED: '리뷰 코멘트', DISMISSED: '리뷰 취소' }[r.state] ?? r.state }))]
              .sort((a, b) => (a.at < b.at ? -1 : 1));
            const comment = el('textarea', { class: 'field', rows: 3, placeholder: '코멘트 쓰기 (⌘/Ctrl+Enter)' });
            const send = async () => {
              if (!comment.value.trim()) return;
              await ctx.act('코멘트를 보내는 중…', () => api(`${repoPath()}/issues/${number}/comments`, { method: 'POST', body: { body: comment.value } }), { success: () => '코멘트를 남겼습니다.' });
              draw();
            };
            comment.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isComposing(e)) send(); });
            const mergeButton = el('button', {
              class: 'btn small primary', disabled: state !== 'open' || p.mergeable === false,
              onclick: (e) => {
                const r = e.currentTarget.getBoundingClientRect();
                showMenu(r.left, r.bottom + 4, [['merge', '병합 커밋 만들기'], ['squash', 'Squash 하고 병합'], ['rebase', 'Rebase 하고 병합']].map(([method, label]) => ({
                  label,
                  action: async () => {
                    if (!(await confirmDialog({ title: label, glyph: 'merge', message: `#${number} "${p.title}" 를 ${p.base.ref} 에 병합합니다.`, ok: '병합' }))) return;
                    await ctx.act('병합하는 중…', () => api(`${repoPath()}/pulls/${number}/merge`, { method: 'PUT', body: { merge_method: method } }), { success: () => `#${number} 를 병합했습니다.` });
                    load(true);
                    draw();
                  },
                })));
              },
            }, 'Merge ', icon('chevronDown', 12));
            const people = (label, list) => (list?.length ? el('div', { class: 'pr-people' }, el('span', { class: 'muted small', text: label }), list.map((u) => el('span', { class: 'chip', text: u.login ?? u.name }))) : null);
            body.replaceChildren(
              el('div', { class: 'pr-head' }, el('span', { class: `pr-state st-${state}`, text: STATE[state] }), el('span', { class: 'pr-title', text: p.title })),
              el('div', { class: 'muted small', text: `${p.user?.login} · ${p.head.label} → ${p.base.ref} · ${relativeTime(Date.parse(p.created_at) / 1000)}` }),
              el('div', { class: `pr-mergeable${p.mergeable === false ? ' bad' : ''}`, text: mergeable }),
              el('div', { class: 'row pr-actions' }, mergeButton,
                state === 'open' || state === 'draft' ? el('button', { class: 'btn small', text: p.draft ? '리뷰 준비 완료' : '초안으로', onclick: () => toggleDraft(p).then(draw) }) : null,
                el('button', { class: 'btn small', text: p.state === 'open' ? '닫기' : '다시 열기', disabled: p.merged, onclick: async () => { await ctx.act('바꾸는 중…', () => api(`${repoPath()}/pulls/${number}`, { method: 'PATCH', body: { state: p.state === 'open' ? 'closed' : 'open' } })); load(true); draw(); } }),
                el('span', { class: 'spacer' }),
                el('button', { class: 'btn small', 'data-tip': 'GitHub 에서 보기', onclick: () => ctx.call('openUrl', { url: p.html_url }) }, icon('external', 14))),
              people('리뷰어', p.requested_reviewers), people('담당자', p.assignees), people('라벨', p.labels),
              p.body ? el('pre', { class: 'pr-body', text: p.body }) : el('div', { class: 'muted small', text: '설명이 없습니다.' }),
              el('div', { class: 'modal-label', text: `파일 ${files.length}개` }),
              el('div', { class: 'pr-files' }, files.map((f) => el('button', { class: 'pr-file link', onclick: () => ctx.call('openUrl', { url: `${p.html_url}/files` }) },
                el('span', { class: 'mono small', text: `+${f.additions} −${f.deletions}` }), el('span', { text: f.filename })))),
              el('div', { class: 'modal-label', text: '대화' }),
              el('div', { class: 'pr-timeline' }, timeline.length ? timeline.map((t) => el('div', { class: 'pr-comment' },
                el('div', { class: 'small' }, el('strong', { text: t.who }), el('span', { class: 'muted', text: ` · ${t.kind} · ${formatDate(Date.parse(t.at) / 1000, true)}` })),
                t.text ? el('div', { class: 'pr-comment-body', text: t.text }) : null)) : el('div', { class: 'muted small', text: '아직 대화가 없습니다.' })),
              comment, el('div', { class: 'modal-actions' }, el('button', { class: 'btn small primary', text: '코멘트', onclick: send })));
            if (focus === 'files') body.querySelector('.pr-files')?.scrollIntoView();
          } catch (error) {
            body.replaceChildren(el('div', { class: 'error-text small', text: error?.message ?? String(error) }));
          }
        };
        draw();
      },
    });
  }

  async function toggleDraft(p) {
    const mutation = p.draft
      ? 'mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { clientMutationId } }'
      : 'mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { clientMutationId } }';
    await ctx.act('바꾸는 중…', () => ctx.call('githubGraphql', { query: mutation, variables: { id: p.node_id } }), { success: () => (p.draft ? '리뷰 준비 완료로 바꿨습니다.' : '초안으로 바꿨습니다.') });
    load(true);
  }

  // ── PR 만들기·필터 드로어(GH-05) ──

  async function createPull(headBranch) {
    if (!info?.owner) await load(true);
    if (!info?.owner) return ctx.toast('GitHub 원격이 없습니다.', 'warning');
    const repo = await api(repoPath()).catch(() => null);
    openDrawer({
      glyph: 'pullRequest', title: 'Pull Request 만들기', anchor: ctx.sidebarElement(), width: 420,
      build(body, close) {
        const refs = ctx.state.refs ?? { local: [] };
        const branches = refs.local.map((b) => ({ value: b.name, label: b.name, icon: 'laptop' }));
        const head = searchSelect({ items: branches, value: headBranch ?? refs.local.find((b) => b.current)?.name, placeholder: '보낼 브랜치', onChange: () => autoTitle() });
        const base = searchSelect({ items: branches.concat((refs.remote ?? []).map((b) => ({ value: b.name.replace(/^[^/]+\//, ''), label: b.name.replace(/^[^/]+\//, ''), icon: 'cloud' }))), value: repo?.default_branch ?? 'main', placeholder: '받을 브랜치' });
        const title = el('input', { class: 'field', placeholder: '제목' });
        const desc = el('textarea', { class: 'field', rows: 6, placeholder: '설명 (선택)' });
        const draft = el('input', { type: 'checkbox' });
        let touched = false;
        title.addEventListener('input', () => { touched = true; });
        function autoTitle() {
          if (touched) return;
          const name = head.value ?? '';
          title.value = name.replace(/^(feature|fix|hotfix|chore)\//, '').replace(/[-_]/g, ' ');
        }
        autoTitle();
        const ok = el('button', { class: 'btn primary', text: '만들기' });
        ok.addEventListener('click', async () => {
          if (!title.value.trim() || !head.value || !base.value) return;
          const branch = refs.local.find((b) => b.name === head.value);
          // 올리지 않은 브랜치는 먼저 올린다.
          if (branch && !branch.upstream) {
            const remote = ctx.state.remotes.find((r) => /github\.com/i.test(r.fetchUrl))?.name ?? 'origin';
            const pushed = await ctx.act(`${branch.name} 를 올리는 중…`, () => ctx.call('pushBranch', { branch: branch.name, remote, setUpstream: true }).then(() => true));
            if (pushed !== true) return;
          }
          const created = await ctx.act('Pull Request 를 만드는 중…', () => api(`${repoPath()}/pulls`, { method: 'POST', body: { title: title.value.trim(), head: head.value, base: base.value, body: desc.value, draft: draft.checked } }),
            { success: (p) => `#${p.number} 를 만들었습니다.` });
          if (created) {
            close();
            load(true);
            detail(created.number);
          }
        });
        body.append(el('div', { class: 'drawer-form' },
          el('div', { class: 'modal-field' }, el('span', { class: 'modal-label', text: `보낼 브랜치 (From · ${info.owner}/${info.repo})` }), head.element),
          el('div', { class: 'modal-field' }, el('span', { class: 'modal-label', text: '받을 브랜치 (To)' }), base.element),
          el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: '제목' }), title),
          el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: '설명' }), desc),
          el('label', { class: 'check' }, draft, '초안으로 만들기'),
          el('div', { class: 'modal-actions' }, el('button', { class: 'btn', text: '취소', onclick: () => close() }), ok)));
      },
    });
  }

  function filterDrawer(existing) {
    openDrawer({
      glyph: 'filterAdd', title: existing ? '필터 고치기' : 'PR 필터 추가', anchor: ctx.sidebarElement(),
      build(body, close) {
        const name = el('input', { class: 'field', placeholder: '이름 (예: 내가 리뷰할 것)' });
        const query = el('input', { class: 'field', placeholder: 'is:open review-requested:@me label:bug' });
        name.value = existing?.name ?? '';
        query.value = existing?.query ?? 'is:open ';
        const ok = el('button', { class: 'btn primary', text: '저장', onclick: () => {
          if (!name.value.trim()) return;
          const list = filters().filter((f) => f.name !== existing?.name);
          list.push({ name: name.value.trim(), query: query.value.trim() });
          ctx.prefs.set('github.filters', list);
          close();
          load(true);
        } });
        body.append(el('div', { class: 'drawer-form' },
          el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: '이름' }), name),
          el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: 'GitHub 검색 문법' }), query,
            el('span', { class: 'muted small', text: 'is:open · is:draft · author:이름 · assignee:@me · review-requested:@me · label:이름 · base:main · head:브랜치 를 이어 쓸 수 있습니다.' })),
          el('div', { class: 'modal-actions' }, el('button', { class: 'btn', text: '취소', onclick: () => close() }), ok)));
      },
    });
  }

  // ── 원격 추가 드로어의 GitHub 탭(DLG-09 · GH-06) ──

  function remoteForm(closeDrawer) {
    const box = el('div', { class: 'drawer-form' }, el('div', { class: 'muted small', text: '불러오는 중…' }));
    (async () => {
      const me = await ctx.call('githubRepo').catch(() => null);
      if (!me?.me) {
        box.replaceChildren(el('div', { class: 'muted small', text: 'GitHub 에 로그인하면 내 저장소를 고르거나 새로 만들 수 있습니다.' }),
          el('button', { class: 'btn primary', text: 'GitHub 로그인…', onclick: async () => { if (await connect()) box.replaceWith(remoteForm(closeDrawer)); } }));
        return;
      }
      let mode = 'existing';
      const content = el('div', { class: 'drawer-form' });
      const seg = el('div', { class: 'seg' });
      const draw = async () => {
        seg.replaceChildren(
          el('button', { class: mode === 'existing' ? 'on' : '', text: '기존 저장소', onclick: () => { mode = 'existing'; draw(); } }),
          el('button', { class: mode === 'new' ? 'on' : '', text: '새로 만들기', onclick: () => { mode = 'new'; draw(); } }));
        const remoteName = el('input', { class: 'field', spellcheck: 'false' });
        remoteName.value = ctx.state.refs?.remotes.includes('origin') ? 'github' : 'origin';
        if (mode === 'existing') {
          content.replaceChildren(el('div', { class: 'muted small', text: '저장소 목록을 읽는 중…' }));
          const repos = await api('/user/repos?per_page=100&sort=updated').catch(() => []);
          const select = searchSelect({ items: repos.map((r) => ({ value: r.clone_url, label: r.full_name, hint: r.private ? '비공개' : '', icon: r.private ? 'lock' : 'github' })), placeholder: '저장소 찾기' });
          const ok = el('button', { class: 'btn primary', text: '원격 추가', onclick: async () => {
            if (!select.value) return;
            const added = await ctx.act('원격을 추가하는 중…', () => ctx.call('addRemote', { name: remoteName.value.trim(), url: select.value, pushUrl: '' }).then(() => true));
            if (added !== true) return;
            closeDrawer();
            await ctx.act('페치하는 중…', () => ctx.call('fetchRemote', { name: remoteName.value.trim() }), { success: () => '원격을 추가했습니다.' });
          } });
          content.replaceChildren(el('div', { class: 'modal-field' }, el('span', { class: 'modal-label', text: '저장소' }), select.element),
            el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: '원격 이름' }), remoteName), el('div', { class: 'modal-actions' }, ok));
        } else {
          const orgs = await api('/user/orgs').catch(() => []);
          const owner = el('select', { class: 'field' }, [el('option', { value: '', text: me.me }), ...orgs.map((o) => el('option', { value: o.login, text: o.login }))]);
          const name = el('input', { class: 'field', spellcheck: 'false' });
          name.value = ctx.state.repo?.name ?? '';
          const priv = el('input', { type: 'checkbox' });
          priv.checked = true;
          const pushNow = el('input', { type: 'checkbox' });
          pushNow.checked = true;
          const ok = el('button', { class: 'btn primary', text: '만들기', onclick: async () => {
            if (!name.value.trim()) return;
            const created = await ctx.act('GitHub 에 저장소를 만드는 중…', () => api(owner.value ? `/orgs/${owner.value}/repos` : '/user/repos', { method: 'POST', body: { name: name.value.trim(), private: priv.checked } }));
            if (!created) return;
            const added = await ctx.act('원격을 추가하는 중…', () => ctx.call('addRemote', { name: remoteName.value.trim(), url: created.clone_url, pushUrl: '' }).then(() => true));
            if (added !== true) return;
            closeDrawer();
            const branch = ctx.state.status?.branch;
            if (pushNow.checked && branch?.hasCommits && !branch.detached) {
              await ctx.act('올리는 중…', () => ctx.call('pushBranch', { branch: branch.name, remote: remoteName.value.trim(), setUpstream: true }), { success: () => `${created.full_name} 를 만들고 올렸습니다.` });
            } else ctx.toast(`${created.full_name} 를 만들었습니다.`, 'success');
          } });
          content.replaceChildren(el('div', { class: 'row' }, el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: '소유자' }), owner), el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: '이름' }), name)),
            el('label', { class: 'check' }, priv, '비공개 저장소'), el('label', { class: 'check' }, pushNow, '만든 뒤 바로 올리기'),
            el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: '원격 이름' }), remoteName), el('div', { class: 'modal-actions' }, ok));
        }
      };
      box.replaceChildren(seg, content);
      draw();
    })();
    return box;
  }

  return {
    connect, chooseAccount, section, load, detail, createPull, filterDrawer, remoteForm,
    get count() { return pulls.length; },
    get info() { return info; },
    reset() { loadedFor = null; pulls = []; info = null; },
  };
}
