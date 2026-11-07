// GitHub: 연결 화면(Device Flow), 이 레포지토리의 계정 고르기, Pull Request(사이드바 구역·상세·만들기·필터), 원격 추가의 GitHub 탭(기존 레포지토리·새로 만들기).
// 원본 Elements/GitHubConnectPanel·Window/GitAccountDialog·Elements/PullRequest*Drawer·CreatePullRequestDrawer·RefTreeBuilder(PR 구역)·
// Core/GitPullRequestFilter 를 옮겼다. 토큰은 Rust 가 들고 있다 — 여기서는 경로만 넘겨 부른다.

import { el, formatDate } from './util.js';
import { icon } from './icons.js';
import { openDrawer, showMenu, confirmDialog, searchSelect } from './dialogs.js';
import { branchNameProblem } from './graph.js';

const GITHUB_REMOTE = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

// ── PR 묶음(필터)과 조건 문법 — 원본 Core/GitPullRequestFilter.cs ──

/** 기본 묶음. 이름 대신 nameKey 로 두어, 고치지 않으면 기본 이름을 그대로 보인다. */
const DEFAULT_NAMES = { mine: '내 Pull Request', assigned: '나에게 배정됨', review: '내 리뷰 대기', all: '모든 Pull Request' };
const DEFAULT_FILTERS = [
  { nameKey: 'mine', query: 'author:@me' },
  { nameKey: 'assigned', query: 'assignee:@me' },
  { nameKey: 'review', query: 'review-requested:@me' },
  { nameKey: 'all', query: '' },
];
const filterName = (f) => (f.nameKey ? DEFAULT_NAMES[f.nameKey] ?? f.name : f.name);

/** 목록에서 바로 거를 수 있는 조건. 나머지는 검색 API 로 거른다. */
const LOCAL_QUALIFIERS = new Set(['author', 'assignee', 'involves', 'review-requested', 'base', 'head', 'draft', 'label', 'no', 'is']);

/** "author:@me label:\"needs review\" 로그인" → [{key, value}]. 따옴표 안의 공백은 나누지 않는다. */
export function parseQuery(query) {
  const terms = [];
  const text = query ?? '';
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    const start = i;
    let quoted = false;
    while (i < text.length && (quoted || !/\s/.test(text[i]))) {
      if (text[i] === '"') quoted = !quoted;
      i++;
    }
    const token = text.slice(start, i);
    const colon = token.indexOf(':');
    if (colon > 0) terms.push({ key: token.slice(0, colon).toLowerCase(), value: token.slice(colon + 1).replace(/^"|"$/g, '') });
    else terms.push({ key: null, value: token.replace(/^"|"$/g, '') });
  }
  return terms;
}

export function needsSearch(query) {
  return parseQuery(query).some(({ key, value }) => key != null && (!LOCAL_QUALIFIERS.has(key)
    || (key === 'no' && value !== 'assignee' && value !== 'label')
    || (key === 'is' && !['pr', 'open', 'draft'].includes(value))));
}

/** pr: 원본 GitPullRequestInfo 모양 {number, title, author, assignees, reviewers, headRef, baseRef, draft, labels}. */
export function matchesQuery(pr, query, login) {
  return parseQuery(query).every(({ key, value: raw }) => {
    const value = raw === '@me' ? login : raw;
    const same = (a) => !!a && !!value && a.toLowerCase() === value.toLowerCase();
    switch (key) {
      case null: {
        const needle = (value ?? '').toLowerCase();
        return !needle || pr.title.toLowerCase().includes(needle) || (pr.headRef ?? '').toLowerCase().includes(needle) || `#${pr.number}` === value || String(pr.number) === value;
      }
      case 'author': return same(pr.author);
      case 'assignee': return pr.assignees.some(same);
      case 'review-requested': return pr.reviewers.some(same);
      case 'involves': return same(pr.author) || pr.assignees.some(same) || pr.reviewers.some(same);
      case 'base': return same(pr.baseRef);
      case 'head': return same(pr.headRef);
      case 'draft': return pr.draft === (String(value).toLowerCase() === 'true');
      case 'label': return pr.labels.some(same);
      case 'no': return value === 'assignee' ? !pr.assignees.length : value === 'label' ? !pr.labels.length : true;
      case 'is': return value !== 'draft' || pr.draft;
      default: return true; // 검색 API 로 거르는 조건
    }
  });
}

/** REST 응답 → 원본 GitPullRequestInfo 모양. */
function pullInfo(p) {
  return {
    number: p.number, title: p.title ?? '', author: p.user?.login ?? '', draft: !!p.draft, url: p.html_url,
    assignees: (p.assignees ?? []).map((a) => a.login), reviewers: (p.requested_reviewers ?? []).map((r) => r.login),
    labels: (p.labels ?? []).map((l) => l.name), headRef: p.head?.ref ?? '', baseRef: p.base?.ref ?? '', headSha: p.head?.sha ?? null,
    nodeId: p.node_id,
  };
}

/**
 * ctx: { call, act, prefs, state, showError, toast, sidebarElement(), onChanged(), revealCommit(hash), refsUi, compare(a, b, options),
 *        connect() — 연결 화면을 띄운다 }
 */
export function createGitHub(ctx) {
  let info = null; // {owner, repo, me, signedIn}
  /** 원본 GitPullRequestSet: {loading, needsSignIn, noRemote, error, all, search: Map(query → Set(number)), remote, repository, login} */
  let set = null;
  let loadedFor = null;
  let loadToken = 0;
  let signedIn = null; // 앱 로그인 여부(null = 아직 모름)

  const api = (path, { method = 'GET', body } = {}) => ctx.call('githubApi', { method, path, body });
  const repoPath = () => `/repos/${info.owner}/${info.repo}`;
  const filters = () => ctx.prefs.get('github.filters') ?? DEFAULT_FILTERS;
  const saveFilters = (list) => {
    ctx.prefs.set('github.filters', list);
    ctx.onChanged();
  };

  /** 이 레포지토리의 GitHub 원격 {name, owner, repo}. 고른 레포지토리(Rust 가 기본 원격으로 정한 것)와 같은 원격을 먼저. */
  function githubRemote() {
    const list = (ctx.state.remotes ?? []).map((r) => {
      const m = GITHUB_REMOTE.exec(r.fetchUrl ?? '');
      return m ? { name: r.name, owner: m[1], repo: m[2] } : null;
    }).filter(Boolean);
    return list.find((r) => info && r.owner.toLowerCase() === info.owner?.toLowerCase() && r.repo.toLowerCase() === info.repo?.toLowerCase())
      ?? list.find((r) => r.name === 'origin') ?? list[0] ?? null;
  }

  async function refreshSignedIn() {
    const status = await ctx.call('githubStatus').catch(() => null);
    signedIn = !!status?.signedIn;
    return status;
  }

  // ── 연결 화면(GH-01) — 원본 GitHubConnectPanel + GitHubDeviceLogin ──

  /** 하나뿐인 Device Flow 로그인. 연결 화면과 설정이 같이 쓴다. */
  const login = (() => {
    let step = 'idle'; // idle | requesting | waiting | failed
    let code = null;
    let error = '';
    let openedPage = false;
    let run = 0;
    let completed = 0; // 로그인을 마친 횟수 — 기다리는 쪽이 "취소" 와 "마침" 을 가른다.
    let lastLogin = null;
    let expiresAt = 0;
    const listeners = new Set();
    const emit = () => listeners.forEach((f) => f());
    const copy = () => code && navigator.clipboard?.writeText(code.user_code);
    async function start() {
      const id = ++run;
      step = 'requesting';
      code = null;
      error = '';
      openedPage = false;
      emit();
      try {
        code = await ctx.call('githubDeviceStart');
        if (id !== run) return;
        let interval = (code.interval ?? 5) * 1000;
        const deadline = Date.now() + (code.expires_in ?? 900) * 1000;
        expiresAt = deadline;
        step = 'waiting';
        emit();
        while (id === run) {
          await new Promise((r) => setTimeout(r, interval));
          if (id !== run) return;
          if (Date.now() > deadline) throw new Error('코드 입력 시간이 지났습니다. 다시 시도하세요.');
          const r = await ctx.call('githubDevicePoll', { deviceCode: code.device_code });
          if (id !== run) return;
          if (r.status === 'slowDown') interval += 5000;
          if (r.status === 'done') {
            step = 'idle';
            code = null;
            signedIn = true;
            completed++;
            lastLogin = r.login;
            emit();
            ctx.toast(`GitHub 에 @${r.login} 로 로그인했습니다.`, 'success');
            info = null;
            loadedFor = null;
            ctx.onSignedIn?.(r.login);
            return;
          }
        }
      } catch (e) {
        if (id !== run) return;
        step = 'failed';
        error = e?.message ?? String(e);
        emit();
      }
    }
    return {
      start,
      cancel() { run++; step = 'idle'; code = null; emit(); },
      copy,
      openPage() {
        if (!code) return;
        copy();
        openedPage = true;
        ctx.call('openUrl', { url: code.verification_uri }).catch(ctx.showError);
        emit();
      },
      get running() { return step === 'requesting' || step === 'waiting'; },
      get step() { return step; },
      get code() { return code?.user_code ?? null; },
      get error() { return error; },
      get openedPage() { return openedPage; },
      get completed() { return completed; },
      get lastLogin() { return lastLogin; },
      /** 코드가 만료되는 때(ms). */
      get expiresAt() { return expiresAt; },
      /** 로그인 전용 창을 띄운다(아래 deviceLogin). 마치면 {login}, 취소·실패로 닫으면 null. */
      dialog: () => deviceLogin(),
      on(f) { listeners.add(f); return () => listeners.delete(f); },
    };
  })();

  /**
   * GitHub Device Flow 로그인 전용 창. 뒤는 어둡게 흐리고, 가운데 창에 GitHub 마크 · 제목 · 큰 코드 칸 · 세 단계 · 기다림 표시.
   * 코드가 나오면 미리 클립보드에 복사해 둔다. 주 버튼은 [GitHub 페이지 열기](실패하면 [다시 시도]), 보조는 [취소](Esc).
   * 승인되면 아바타와 "○○ 로 연결됐습니다" 로 바뀌고 잠깐 뒤 저절로 닫힌다. 결과: {login} 또는 null.
   * 앱의 모든 Device Flow 로그인(연결 화면·계정 고르기·PR 읽기 실패·원격 추가·레포지토리 만들기)이 이 창 하나를 쓴다.
   */
  let loginDialogOpen = null;
  function deviceLogin() {
    if (loginDialogOpen) return loginDialogOpen;
    const L = 'gh-login';
    loginDialogOpen = new Promise((resolve) => {
      const before = login.completed;
      let done = false;
      let copiedTimer = 0;
      let tick = 0;
      const backdrop = el('div', { class: `${L}-backdrop` });
      const mark = el('div', { class: `${L}-mark` }, icon('github', 36));
      const title = el('div', { class: `${L}-title`, text: 'GitHub 로 로그인' });
      const lead = el('div', { class: `${L}-lead` });
      const codeBox = el('button', { class: `${L}-code`, 'data-tip': '눌러서 코드 복사', onclick: () => copyCode() });
      const copied = el('div', { class: `${L}-copied` });
      const stepRow = (n, text) => el('div', { class: `${L}-step` }, el('span', { class: `${L}-step-num` }, el('span', { class: `${L}-step-n`, text: String(n) }), icon('check', 12)), el('span', { class: `${L}-step-text`, text }));
      const steps = [stepRow(1, '코드 복사됨'), stepRow(2, 'GitHub 페이지에서 코드를 붙여넣고 승인'), stepRow(3, '연결 완료')];
      const stepsBox = el('div', { class: `${L}-steps` }, steps);
      const waitText = el('span', { text: '승인을 기다리는 중…' });
      const expiry = el('span', { class: `${L}-expiry` });
      const waiting = el('div', { class: `${L}-wait` }, el('span', { class: `${L}-spinner` }), waitText, expiry);
      const errorLine = el('div', { class: `${L}-error`, hidden: true });
      const primary = el('button', { class: `${L}-primary`, onclick: () => (login.step === 'failed' ? login.start() : login.openPage()) });
      const cancel = el('button', { class: `${L}-secondary`, text: '취소', onclick: () => finish(null) });
      const main = el('div', { class: `${L}-main` }, codeBox, copied, stepsBox, waiting, errorLine, primary, cancel);
      const avatar = el('div', { class: `${L}-avatar` });
      const successText = el('div', { class: `${L}-success-text` });
      const success = el('div', { class: `${L}-success`, hidden: true }, avatar, successText);
      const box = el('div', { class: `${L}-window`, role: 'dialog', 'aria-label': 'GitHub 로 로그인' },
        el('button', { class: `card-close ${L}-close`, 'data-tip': '취소', onclick: () => finish(null) }, icon('close', 14)),
        mark, title, lead, main, success);
      backdrop.append(box);
      document.body.append(backdrop);
      requestAnimationFrame(() => backdrop.classList.add('in'));

      function copyCode() {
        if (!login.code) return;
        login.copy();
        copied.textContent = '복사됨 — GitHub 페이지에 붙여넣으세요';
        copied.classList.add('flash');
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => copied.classList.remove('flash'), 1400);
        [...codeBox.querySelectorAll(`.${L}-cell`)].forEach((cell, i) => {
          setTimeout(() => cell.classList.add('flash'), i * 40);
          setTimeout(() => cell.classList.remove('flash'), i * 40 + 220);
        });
      }

      let shownCode = null;
      let precopied = false;
      function render() {
        if (done) return;
        const step = login.step;
        const hasCode = step === 'waiting';
        const failed = step === 'failed';
        // 코드가 나오면 한 번 미리 복사해 둔다.
        if (hasCode && !precopied) {
          precopied = true;
          login.copy();
        }
        const value = hasCode ? login.code ?? '' : '';
        if (value !== shownCode || (!value && !codeBox.childElementCount)) {
          shownCode = value;
          const chars = value ? [...value] : [...'XXXX-XXXX'];
          codeBox.replaceChildren(...chars.map((ch) => el('span', { class: ch === '-' ? `${L}-dash` : `${L}-cell${value ? '' : ' empty'}`, text: value || ch === '-' ? ch : '' })));
        }
        codeBox.disabled = !hasCode;
        codeBox.classList.toggle('failed', failed);
        lead.textContent = step === 'requesting' ? 'GitHub 에 로그인 코드를 요청하는 중…' : failed ? '새 코드를 받아 다시 시도하세요.' : '아래 코드를 GitHub 페이지에 입력하면 연결됩니다.';
        if (!copied.classList.contains('flash')) copied.textContent = hasCode ? '코드를 클립보드에 복사해 두었습니다. 누르면 다시 복사합니다.' : '';
        copied.hidden = !hasCode;
        steps[0].className = `${L}-step${hasCode ? ' done' : step === 'requesting' ? ' active' : ''}`;
        steps[1].className = `${L}-step${hasCode ? ' active' : ''}`;
        steps[2].className = `${L}-step`;
        waiting.hidden = !hasCode;
        updateExpiry();
        errorLine.textContent = failed ? (login.error || '로그인하지 못했습니다.') : '';
        errorLine.hidden = !failed;
        primary.textContent = failed ? '다시 시도' : login.openedPage ? 'GitHub 페이지 다시 열기' : 'GitHub 페이지 열기';
        primary.disabled = step === 'requesting';
        primary.classList.toggle('busy', step === 'requesting');
      }
      function updateExpiry() {
        const left = login.expiresAt - Date.now();
        expiry.textContent = login.step === 'waiting' && left > 0 ? `코드 만료까지 ${Math.max(1, Math.ceil(left / 60000))}분` : '';
      }

      function finish(result) {
        if (backdrop.classList.contains('out')) return;
        done = true;
        off();
        clearInterval(tick);
        document.removeEventListener('keydown', onKey, true);
        if (!result && login.running) login.cancel();
        backdrop.classList.remove('in');
        backdrop.classList.add('out');
        setTimeout(() => backdrop.remove(), 180);
        loginDialogOpen = null;
        resolve(result);
      }
      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          event.preventDefault();
          if (!done) finish(null);
        }
      };
      document.addEventListener('keydown', onKey, true);
      const off = login.on(() => {
        if (done) return;
        if (login.completed !== before && !login.running) {
          // 승인됨: 아바타와 "○○ 로 연결됐습니다" 로 바꾸고 잠깐 뒤 닫는다.
          const name = login.lastLogin ?? '';
          done = true;
          off();
          clearInterval(tick);
          steps.forEach((s) => { s.className = `${L}-step done`; });
          const img = el('img', { src: `https://avatars.githubusercontent.com/${encodeURIComponent(name)}?s=128`, alt: '', onerror: (e) => { e.target.remove(); } });
          avatar.replaceChildren(el('span', { class: `${L}-avatar-letter`, text: (name[0] ?? '?').toUpperCase() }), img);
          successText.replaceChildren(el('strong', { text: name }), ' 로 연결됐습니다');
          title.textContent = 'GitHub 에 연결됨';
          lead.textContent = '';
          main.hidden = true;
          mark.hidden = true;
          success.hidden = false;
          box.classList.add('succeeded');
          setTimeout(() => {
            done = false;
            finish({ login: name });
          }, 1400);
          return;
        }
        render();
      });
      tick = setInterval(updateExpiry, 15000);
      render();
      if (!login.running) login.start();
    });
    return loginDialogOpen;
  }

  /**
   * 창 전체를 덮는 연결 카드. 로그인하거나 "이번에는 연결하지 않고 계속" 을 누르면 onLeave(signedIn) 를 부른다.
   * 카드가 살짝 작아지며 사라진 뒤 본체가 조금 아래에서 올라오며 나타난다(원본 LeaveConnect·EnterShell).
   */
  function connectScreen(host, onLeave) {
    const B = 'github-connect';
    const title = el('div', { class: `${B}__title`, text: 'GitHub 연결' });
    const text = el('div', { class: `${B}__text`, text: 'Ramus 를 쓰기 전에 GitHub 계정을 연결하세요. 로그인하면 비공개 레포지토리에서도 커밋 작성자의 아바타가 보이고 Pull Request 를 보고 만들 수 있습니다. 한 번 로그인하면 이 PC 의 모든 레포지토리에 적용됩니다.' });
    // 로그인은 전용 창(deviceLogin)에서 한다. 마치면 이 화면을 떠난다.
    const signIn = el('button', { class: `${B}__primary`, text: 'GitHub 로 로그인', onclick: () => deviceLogin().then((r) => { if (r) leave(true); }) });
    const startStep = el('div', { class: `${B}__step` }, signIn);
    const waitingText = el('div', { class: `${B}__text` });
    const codeBox = el('div', { class: `${B}__code` });
    const copyButton = el('button', { class: `${B}__secondary`, text: '코드 복사' });
    const cancelButton = el('button', { class: `${B}__secondary`, text: '취소', onclick: () => login.cancel() });
    const openButton = el('button', { class: `${B}__primary ${B}__next`, onclick: () => login.openPage() });
    const waitingStep = el('div', { class: `${B}__step` }, waitingText, codeBox, el('div', { class: `${B}__row` }, copyButton, cancelButton), openButton);
    const errorText = el('div', { class: `${B}__error` });
    const skip = el('button', { class: `${B}__link`, text: '이번에는 연결하지 않고 계속', onclick: () => leave(false) });
    const card = el('div', { class: `${B}__card` }, title, text, startStep, waitingStep, errorText, skip);
    host.replaceChildren(card);
    host.hidden = false;

    let copiedTimer = 0;
    copyButton.addEventListener('click', () => {
      login.copy();
      copyButton.textContent = '복사됨';
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => { copyButton.textContent = '코드 복사'; }, 1500);
      // 칸이 왼쪽부터 차례로 잠깐 반짝인다.
      [...codeBox.querySelectorAll(`.${B}__code-cell`)].forEach((cell, i) => {
        setTimeout(() => cell.classList.add(`${B}__code-cell--flash`), i * 45);
        setTimeout(() => cell.classList.remove(`${B}__code-cell--flash`), i * 45 + 240);
      });
    });

    let shownCode = null;
    function render() {
      // 코드·기다림은 로그인 창이 보인다. 이 화면에는 시작 버튼만 둔다.
      const running = false;
      const hasCode = false;
      startStep.hidden = running;
      waitingStep.hidden = !running;
      waitingText.textContent = !hasCode ? 'GitHub 에 로그인 코드를 요청하는 중…'
        : login.openedPage ? '열린 GitHub 페이지에 코드를 붙여넣고 승인하세요. 승인하면 자동으로 연결됩니다(코드는 클립보드에 복사되어 있습니다).'
          : "아래 코드를 복사한 뒤 '다음' 을 눌러 GitHub 페이지를 여세요. 그 페이지에 코드를 붙여넣고 승인하면 자동으로 연결됩니다.";
      openButton.textContent = login.openedPage ? 'GitHub 페이지 다시 열기' : '다음: GitHub 페이지 열기';
      const value = hasCode ? login.code : '';
      if (value !== shownCode) {
        shownCode = value;
        codeBox.replaceChildren(...[...(value ?? '')].map((ch) => el('span', { class: ch === '-' ? `${B}__code-dash` : `${B}__code-cell`, text: ch })));
      }
      codeBox.hidden = !hasCode;
      copyButton.hidden = !hasCode;
      openButton.hidden = !hasCode;
      errorText.textContent = '';
      errorText.hidden = true;
    }
    const off = login.on(() => render());
    render();

    // 제목·설명·단계·건너뛰기가 차례로 떠오른다.
    const reveal = [title, text, startStep, waitingStep, skip];
    reveal.forEach((node) => node.classList.add(`${B}__reveal`));
    reveal.forEach((node, i) => setTimeout(() => node.classList.add(`${B}__reveal--in`), 60 + i * 70));

    let leaving = false;
    function leave(done) {
      if (leaving) return;
      leaving = true;
      off();
      if (!done) login.cancel();
      card.classList.add(`${B}__card--leave`);
      setTimeout(() => {
        host.hidden = true;
        host.replaceChildren();
        onLeave(done);
      }, 200);
    }
  }

  // ── 계정 고르기(GH-02) — 원본 Window/GitAccountDialog ──

  /** failure 가 있으면 원격이 계정을 거부한 뒤라 "이 계정으로 다시". 고르면 true(부른 쪽이 그 작업을 다시 한다). */
  function chooseAccount(failure = null) {
    const SOURCE = { app: '앱 로그인(설정 > 로그인)', credential: 'git 이 쓰는 계정' };
    return new Promise((resolve) => {
      const backdrop = el('div', { class: 'modal-backdrop' });
      const card = el('div', { class: 'modal card account-dialog', role: 'dialog' });
      let busy = false;
      const finish = (value) => {
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        resolve(value);
      };
      const onKey = (event) => {
        if (backdrop.hidden) return; // 로그인 창이 떠 있는 동안은 그 창이 Esc 를 받는다.
        if (event.key === 'Escape') {
          event.stopPropagation();
          finish(false);
        }
      };
      document.addEventListener('keydown', onKey, true);
      const message = el('div', { class: 'modal-message', text: '계정을 확인하는 중…' });
      const list = el('div', { class: 'account-list' });
      const status = el('div', { class: 'account-status error-text small', hidden: true });
      const buttons = el('div', { class: 'modal-actions' });
      // 목록에 맞는 계정이 없을 때 새 계정을 바로 연결한다. 로그인 창이 떠 있는 동안 이 카드는 숨기고,
      // 연결되면 그 계정을 이 레포지토리에 쓰도록 고른 뒤 닫는다(실패 흐름이면 부른 쪽이 작업을 다시 한다).
      buttons.append(el('span', { class: 'spacer' }), el('button', {
        class: 'btn primary', text: signedIn ? '새 계정 연결…' : 'GitHub 로 로그인…',
        'data-tip': 'GitHub 에 다른 계정으로 로그인합니다. 연결한 계정을 이 레포지토리에 씁니다.',
        onclick: async () => {
          if (busy) return;
          busy = true;
          backdrop.hidden = true;
          const result = await deviceLogin().catch(() => null);
          if (result?.login) {
            try {
              await ctx.call('githubChoose', { source: 'app', login: result.login });
              accountChanged();
              busy = false;
              finish(true);
              return;
            } catch (e) {
              status.textContent = e?.message ?? String(e);
              status.hidden = false;
            }
          }
          backdrop.hidden = false;
          busy = false;
        },
      }));
      buttons.append(
        el('button', {
          class: 'btn', text: 'git 기본으로', 'data-tip': '고른 계정을 지우고 자격 증명 도우미(gh·Git Credential Manager·키체인)가 정하는 계정을 씁니다.',
          onclick: async () => {
            if (busy) return;
            busy = true;
            await ctx.call('githubChoose', { source: '' }).catch(ctx.showError);
            busy = false;
            accountChanged();
            finish(failure != null);
          },
        }),
        el('button', { class: 'btn', text: failure != null ? '닫기' : '취소', onclick: () => finish(false) }));
      card.append(
        el('div', { class: 'card-head' },
          el('span', { class: `card-badge tone-${failure != null ? 'danger' : 'accent'}` }, icon('cloud', 18)),
          el('div', { class: 'modal-title', text: failure != null ? '원격 레포지토리에 접근하지 못했습니다' : '이 레포지토리의 GitHub 계정' })),
        // ✕ 는 다른 카드처럼 오른쪽 위 구석에(.card > .card-close).
        el('button', { class: 'card-close', 'data-tip': failure != null ? '닫기' : '취소', onclick: () => finish(false) }, icon('close', 14)),
        message, list, status, buttons);
      backdrop.append(card);
      document.body.append(backdrop);

      const firstLines = (text) => (text ?? '').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(0, 3).join('\n');
      (async () => {
        const repo = await ctx.call('githubRepo').catch(() => null);
        if (!repo?.owner) {
          // GitHub 가 아닌 원격: 계정 목록은 못 보이고 원인과 git 오류만 알린다.
          message.textContent = `GitHub 가 아닌 원격이라 계정을 고를 수 없습니다. 자격 증명 도우미(키체인·Git Credential Manager)에서 계정을 확인하세요.\n\n${firstLines(failure)}`;
          return;
        }
        const name = `${repo.owner}/${repo.repo}`;
        list.replaceChildren(el('div', { class: 'account-empty muted', text: '이 PC 의 계정과 접근 권한을 확인하는 중…' }));
        const accounts = await ctx.call('githubAccounts').catch((e) => { status.textContent = e?.message ?? String(e); status.hidden = false; return []; });
        const current = accounts.find((a) => a.inUse)?.login;
        message.textContent = failure == null ? `${name} 에 쓸 계정을 고릅니다. 이 레포지토리에만 적용됩니다(다른 레포지토리는 그대로).`
          : current ? `${current} 계정으로 ${name} 에 접속했지만 거부됐습니다. GitHub 는 권한 없는 계정에게 비공개 레포지토리를 "없다" 고 답합니다.\n이 레포지토리에 접근할 수 있는 계정을 고르면 이 레포지토리에만 적용하고 다시 시도합니다.`
            : `${name} 에 접속할 계정을 찾지 못했습니다(로그인이 없거나 만료됨). 접근할 수 있는 계정을 고르거나 로그인하세요.`;
        if (!accounts.length) {
          list.replaceChildren(el('div', { class: 'account-empty muted', text: '이 PC 에서 GitHub 계정을 찾지 못했습니다. 아래에서 앱으로 로그인하세요.' }));
          return;
        }
        // 접근할 수 있는 계정을 위로.
        const rank = (a) => (a.canAccess === true ? 0 : a.canAccess == null ? 1 : 2);
        list.replaceChildren(...[...accounts].sort((a, b) => rank(a) - rank(b)).map((a) => el('div', { class: 'account-row' },
          el('div', { class: 'account-names' },
            el('div', { class: 'account-login', text: a.login }),
            el('div', { class: 'account-source', text: `${SOURCE[a.source] ?? a.source}${a.inUse ? ' · 지금 사용 중' : ''}` })),
          el('div', { class: `account-access ${a.canAccess === true ? 'yes' : a.canAccess === false ? 'no' : 'unknown'}` },
            a.canAccess === true ? icon('check', 13) : null,
            el('span', { text: a.canAccess === true ? '접근 가능' : a.canAccess === false ? '✗ 권한 없음' : '? 확인 못 함' })),
          el('button', {
            class: `btn small${a.canAccess === true ? ' primary' : ''}`, text: failure != null ? '이 계정으로 다시' : '이 계정 쓰기', disabled: a.inUse,
            onclick: async () => {
              if (busy) return;
              busy = true;
              try {
                await ctx.call('githubChoose', { source: a.source, login: a.login });
                accountChanged();
                finish(true);
              } catch (e) {
                status.textContent = e?.message ?? String(e);
                status.hidden = false;
              } finally {
                busy = false;
              }
            },
          }))));
      })();
    });
  }

  /** 이 레포지토리의 계정을 바꿨다: 아래쪽 계정 표시와 PR 목록을 그 계정으로 다시. */
  function accountChanged() {
    info = null;
    load(true);
  }

  // ── Pull Request 읽기 ──

  async function load(force = false) {
    const key = ctx.state.repo?.path ?? null;
    if (!force && loadedFor === key) return;
    loadedFor = key;
    const token = ++loadToken;
    const remote = (ctx.state.remotes ?? []).some((r) => GITHUB_REMOTE.test(r.fetchUrl ?? ''));
    if (!key || !remote) {
      set = { noRemote: true, all: [] };
      ctx.onChanged();
      return;
    }
    set = { ...(set ?? {}), loading: !set?.all?.length, all: set?.all ?? [] };
    ctx.onChanged();
    try {
      if (signedIn == null) await refreshSignedIn();
      info = await ctx.call('githubRepo');
      if (token !== loadToken) return;
      const r = githubRemote();
      const base = { remote: r?.name ?? null, repository: info.owner ? `${info.owner}/${info.repo}` : null, login: info.me };
      if (!info.owner) {
        set = { ...base, noRemote: true, all: [] };
        return;
      }
      if (!info.me) {
        set = { ...base, needsSignIn: true, all: [] };
        return;
      }
      const all = (await api(`${repoPath()}/pulls?state=open&per_page=100`)).map(pullInfo);
      const search = new Map();
      for (const f of filters()) {
        if (!needsSearch(f.query) || search.has(f.query)) continue;
        const q = encodeURIComponent(`repo:${info.owner}/${info.repo} is:pr is:open ${f.query}`);
        const found = await api(`/search/issues?q=${q}&per_page=100`).catch(() => ({ items: [] }));
        search.set(f.query, new Set((found.items ?? []).map((i) => i.number)));
      }
      if (token !== loadToken) return;
      set = { ...base, all, search };
    } catch (error) {
      if (token !== loadToken) return;
      const message = error?.message ?? String(error);
      const access = isAccessError(message);
      set = { remote: githubRemote()?.name ?? null, repository: info?.owner ? `${info.owner}/${info.repo}` : null, login: info?.me ?? null, error: message, access, all: [] };
      // 계정·권한 문제면 레포지토리마다 이번 실행에서 한 번만 저절로 카드를 띄운다(자동 새로 고침마다 뜨지 않게). 줄을 두 번 누르면 언제든 다시.
      if (access && !prompted.has(key)) {
        setTimeout(() => {
          if (token !== loadToken || prompted.has(key) || (ctx.state.repo?.path ?? null) !== key) return;
          // 다른 카드·연결 화면이 떠 있으면 미룬다(다음 읽기에서 다시 본다).
          if (document.querySelector('.modal-backdrop') || !(document.getElementById('connect')?.hidden ?? true)) return;
          prompted.add(key);
          readFailureCard();
        }, 0);
      }
    } finally {
      if (token === loadToken) ctx.onChanged();
    }
  }

  /** 계정·권한 때문에 못 읽었는지: 401(토큰 만료·잘못됨) · 403(권한·SSO) · 404(권한 없는 비공개 레포지토리를 GitHub 는 "없다" 고 답한다) · 로그인 없음. */
  function isAccessError(message) {
    return /GitHub (401|403|404)\b/.test(message ?? '') || /로그인해 주세요/.test(message ?? '');
  }

  /** 카드를 이미 저절로 띄운 레포지토리(경로). 이번 실행 동안만 기억한다. */
  const prompted = new Set();

  /**
   * PR 을 읽지 못했을 때(계정·권한)의 카드: 어떤 계정으로 어떤 레포지토리를 읽다 실패했는지, 비공개면 접근할 수 있는 계정이 필요하다는 안내, 원인 원문.
   * [다른 계정으로 로그인](카드 안에서 Device Flow — 마치면 그 계정을 이 레포지토리에 쓰도록 고르고 다시 읽는다) · [계정 고르기](다른 계정이 있으면) · [닫기].
   */
  function readFailureCard() {
    if (!set?.error) return;
    const failure = set.error;
    const repository = set.repository ?? (info?.owner ? `${info.owner}/${info.repo}` : '이 레포지토리');
    const account = set.login ?? info?.me ?? null;
    const backdrop = el('div', { class: 'modal-backdrop' });
    const card = el('div', { class: 'modal card account-dialog pr-read-failure', role: 'dialog' });
    const finish = () => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        finish();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const fact = (name, value, muted = false) => el('div', { class: 'pr-read-fact' },
      el('span', { class: 'pr-read-fact-name', text: name }), el('span', { class: `pr-read-fact-value${muted ? ' muted' : ''}`, text: value }));
    // 경우마다 한 문장. GitHub 원문(예: "GitHub 404: Not Found")은 문장에 마우스를 올렸을 때만 보인다.
    const sentence = !account || /로그인해 주세요/.test(failure) ? 'GitHub 에 로그인해야 Pull Request 를 볼 수 있습니다.'
      : /GitHub 401\b/.test(failure) ? '로그인이 만료됐습니다. 다시 로그인하세요.'
        : '이 계정으로는 이 레포지토리에 접근할 수 없습니다.';
    const explain = el('div', { class: 'modal-message pr-read-explain', text: sentence, 'data-tip': failure });

    const signIn = el('button', { class: 'btn card-ok', text: '다른 계정으로 로그인', onclick: () => {
      finish();
      // 로그인 전용 창. 마치면 그 계정을 이 레포지토리에 쓰도록 고르고 PR 을 다시 읽는다.
      deviceLogin().then((r) => {
        if (!r) return;
        ctx.call('githubChoose', { source: 'app', login: r.login }).catch(() => {}).finally(() => accountChanged());
      });
    } });
    const choose = el('button', { class: 'btn card-cancel', text: '계정 고르기', hidden: true, 'data-tip': '이 PC 에서 쓸 수 있는 다른 GitHub 계정 중 이 레포지토리에 쓸 것을 고릅니다.',
      onclick: () => { finish(); chooseAccount(failure); } });
    const closeButton = el('button', { class: 'btn card-cancel', text: '닫기', onclick: () => finish() });
    card.append(
      el('button', { class: 'card-close', 'data-tip': '닫기', onclick: () => finish() }, icon('close', 14)),
      el('div', { class: 'card-head' },
        el('span', { class: 'card-badge tone-danger' }, icon('pullRequest', 26)),
        el('div', { class: 'modal-title', text: 'Pull Request 를 읽지 못했습니다' })),
      el('div', { class: 'pr-read-facts' }, fact('계정', account ?? '로그인하지 않음', !account), fact('레포지토리', repository)),
      explain,
      el('div', { class: 'modal-actions' }, signIn, choose, closeButton));
    backdrop.append(card);
    document.body.append(backdrop);

    // 이 레포지토리에 쓸 수 있는 다른 계정이 있으면 [계정 고르기] 를 보인다.
    ctx.call('githubAccounts').then((accounts) => {
      if (backdrop.isConnected) choose.hidden = !(accounts ?? []).some((a) => !a.inUse);
    }, () => {});
  }

  const inFilter = (f) => {
    let list = set.all.filter((p) => matchesQuery(p, f.query, set.login));
    const numbers = needsSearch(f.query) ? set.search?.get(f.query) : null;
    if (numbers) list = list.filter((p) => numbers.has(p.number));
    return list;
  };

  /** 구역 머리·아래쪽 상태 줄의 개수(원본 RefTreeBuilder.PullRequestCount). 못 읽었으면 0. */
  const count = () => (!set || set.loading || set.needsSignIn || set.noRemote || set.error ? 0 : set.all.length);

  /** 아래쪽 상태 줄 왼쪽 칸(원본 GitFooter.SetPullRequests). */
  function footer() {
    const n = count();
    return {
      text: !set || set.loading ? '읽는 중…' : n > 0 ? `풀 리퀘스트 ${n}개` : '풀 리퀘스트 없음',
      tip: !set ? null : set.needsSignIn ? 'GitHub 에 로그인하면 Pull Request 가 보입니다(두 번 눌러 로그인).'
        : set.noRemote ? 'GitHub 원격이 없습니다.' : set.error ? `Pull Request 를 읽지 못했습니다: ${set.error}` : set.repository,
    };
  }

  /** PR 의 보내는 브랜치를 받아 둔 원격 브랜치. 없으면(아직 Fetch 안 함) null. */
  function headBranch(p) {
    const remoteBranches = ctx.state.refs?.remote ?? [];
    return remoteBranches.find((b) => b.name === `${set?.remote}/${p.headRef}`) ?? remoteBranches.find((b) => b.name.endsWith(`/${p.headRef}`)) ?? null;
  }

  // PR 구역 맨 위 검색 칸. 사이드바를 다시 그려도 같은 칸을 써서 쓰던 글·포커스가 남는다.
  const searchInput = el('input', { class: 'pr-search-input', placeholder: 'Pull Request 검색', spellcheck: 'false', autocomplete: 'off' });
  searchInput.value = ctx.prefs.get('github.search') ?? '';
  let searchTimer = 0;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => ctx.prefs.set('github.search', searchInput.value), 400);
    ctx.onChanged();
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && searchInput.value) {
      event.stopPropagation();
      searchInput.value = '';
      ctx.onChanged();
    }
  });
  const searchRow = el('div', { class: 'pr-search' },
    el('div', { class: 'pr-search-box' }, icon('search', 13), searchInput),
    el('button', { class: 'icon-btn', 'data-tip': '필터 추가', onclick: () => filterDrawer() }, icon('filterAdd', 15)));

  /**
   * 사이드바 구역(GH-03). GitHub 원격이 없으면 null.
   * tree: { isOpen(key, defaultOpen), toggle(key, defaultOpen), filter } — 사이드바가 넘긴다.
   */
  function section(tree) {
    if (!(ctx.state.remotes ?? []).some((r) => GITHUB_REMOTE.test(r.fetchUrl ?? ''))) return null;
    if (loadedFor !== (ctx.state.repo?.path ?? null)) load();
    const needle = (tree.filter ?? '').trim().toLowerCase() || null;
    const matches = (text) => !needle || (text ?? '').toLowerCase().includes(needle);
    const rows = [];
    const infoText = !set || set.loading ? '읽는 중…' : set.needsSignIn ? 'GitHub 에 로그인하면 Pull Request 가 보입니다(두 번 눌러 로그인).'
      : set.noRemote ? 'GitHub 원격이 없습니다.' : set.error ? `Pull Request 를 읽지 못했습니다: ${set.error}` : null;
    if (infoText) {
      if (!needle) {
        rows.push({
          key: 'pr:info', depth: 1, info: true, label: infoText,
          tip: set?.access ? `${infoText}\n두 번 눌러 다른 계정으로 로그인하거나 계정을 고릅니다.` : set?.error ? `${infoText}\n두 번 눌러 다시 읽습니다.` : infoText,
          activate: set?.needsSignIn ? () => ctx.connect() : set?.access ? () => readFailureCard() : set?.error ? () => load(true) : null,
        });
      }
    } else {
      if (!needle) rows.push({ key: 'pr:search', element: searchRow });
      const search = searchInput.value.trim() || null;
      const list = filters();
      list.forEach((f, index) => {
        const name = filterName(f);
        const pulls = inFilter(f)
          .filter((p) => matches(p.title) || matches(`#${p.number}`) || matches(p.author) || matches(p.headRef))
          .filter((p) => !search || matchesQuery(p, search, set.login));
        if (needle && !pulls.length) return;
        const key = `pr:group:${index}:${name}/`;
        const expanded = !!needle || tree.isOpen(key, true);
        rows.push({
          // 원본 RefSidebar: PR 묶음 줄은 GitKraken 처럼 아이콘 없이 글자만(ref-tree__row--plain).
          key, depth: 1, folder: true, plain: true, label: name, count: pulls.length, expanded,
          tip: f.query ? `${name}\n${f.query}` : name,
          toggle: () => tree.toggle(key, true),
          menu: (e) => filterMenu(e, index, name, list.length),
        });
        if (!expanded || !pulls.length) return;
        const remoteKey = `pr:remote:${index}:${set.remote}/`;
        const remoteOpen = !!needle || tree.isOpen(remoteKey, true);
        rows.push({ key: remoteKey, depth: 2, folder: true, label: set.remote ?? set.repository, glyph: 'github', tip: set.repository, expanded: remoteOpen, toggle: () => tree.toggle(remoteKey, true), count: pulls.length });
        if (!remoteOpen) return;
        for (const p of pulls) {
          rows.push({
            key: `pr:${index}:${p.number}`, depth: 3, label: `#${p.number} ${p.title}`, glyph: 'pullRequest',
            tip: `#${p.number} ${p.title}${p.draft ? ' (초안)' : ''}\n${p.author}  ·  ${p.headRef} → ${p.baseRef}`,
            onClick: () => detail(p),
            activate: () => ctx.call('openUrl', { url: p.url }).catch(ctx.showError),
            menu: (e) => pullMenu(e, p),
          });
        }
      });
    }
    return { id: 'prs', title: '풀 리퀘스트', glyph: 'pullRequest', count: count(), rows, empty: '열린 Pull Request 가 없습니다', add: 'Pull Request 만들기…' };
  }

  /** 구역 머리 우클릭(원본 RefSidebar PopulateMenu 의 PullRequests). */
  const sectionMenu = () => [
    { label: 'Pull Request 만들기…', action: () => createPull() },
    { label: 'Pull Request 새로고침', action: () => load(true) },
  ];

  /** GitKraken 의 PR ⋮ 메뉴: GitHub 에서 보기·링크 복사 / 바뀐 것 보기·그래프에서 보기 / 체크아웃·워크트리 만들기. */
  function pullMenu(event, p) {
    const head = headBranch(p);
    const busy = !!ctx.state.status?.operation;
    showMenu(event.clientX, event.clientY, [
      { label: `GitHub 에서 Pull Request #${p.number} 보기`, action: () => ctx.call('openUrl', { url: p.url }).catch(ctx.showError) },
      { label: `Pull Request #${p.number} 링크 복사`, action: () => navigator.clipboard?.writeText(p.url) },
      '-',
      { label: `#${p.number} 의 변경 보기`, disabled: !head, action: () => viewChanges(p, head) },
      { label: `그래프에서 ${p.headRef} 로 가기`, disabled: !head, action: () => ctx.revealCommit(head.hash) },
      '-',
      { label: head ? `${head.name} 체크아웃` : '체크아웃 (먼저 Fetch 하세요)', disabled: !head || busy, action: () => ctx.refsUi.checkout(head.name, true) },
      { label: 'Pull Request 에서 워크트리 만들기', disabled: !head || busy, action: () => ctx.refsUi.addWorktree(head.name) },
    ]);
  }

  /** PR 이 바꾼 것: 받는 브랜치와 갈라진 곳부터 보내는 브랜치 끝까지(GitHub 의 Files changed 와 같다). */
  function viewChanges(p, head) {
    const base = set?.remote ? `${set.remote}/${p.baseRef}` : p.baseRef;
    ctx.compare(base, head.name, { range: true, title: `#${p.number} ${p.title}` });
  }

  /** PR 묶음 ⋮: 고치기·지우기 / 위로·아래로(맨 위·맨 아래면 그쪽은 없다). */
  function filterMenu(event, index, name, total) {
    const list = [...filters()];
    const move = (delta) => {
      [list[index], list[index + delta]] = [list[index + delta], list[index]];
      saveFilters(list);
    };
    showMenu(event.clientX, event.clientY, [
      { label: '이 필터 고치기', action: () => filterDrawer(index) },
      { label: '이 필터 지우기', danger: true, action: async () => {
        if (!(await confirmDialog({ title: '필터 지우기', glyph: 'pullRequest', message: `'${name}' 필터를 지울까요?`, ok: '지우기', danger: true }))) return;
        list.splice(index, 1);
        saveFilters(list);
      } },
      '-',
      index > 0 ? { label: '이 필터를 위로', action: () => move(-1) } : null,
      index < total - 1 ? { label: '이 필터를 아래로', action: () => move(1) } : null,
    ].filter(Boolean));
  }

  // ── PR 상세 서랍(GH-04) — 원본 Elements/PullRequestDetailDrawer + Core/GitPullRequestDetail ──

  /** 원본 GitPullRequestReadiness 와 그 문구(prDetail.readiness*). */
  const READINESS = {
    ready: '받는 브랜치와 충돌 없이 병합할 수 있습니다.',
    unstable: '병합할 수 있지만 일부 검사가 실패했습니다.',
    checking: 'GitHub 가 병합 가능 여부를 확인하는 중입니다…',
    conflicts: '받는 브랜치와 충돌합니다. 충돌을 해결해야 병합할 수 있습니다.',
    blocked: '브랜치 보호 규칙(리뷰·필수 검사)을 아직 만족하지 않습니다.',
    behind: '받는 브랜치보다 뒤처졌습니다. 먼저 브랜치를 갱신하세요.',
    draft: 'Draft 입니다. Ready for review 를 누르면 병합할 수 있습니다.',
    closed: '닫힌 Pull Request 입니다.',
    merged: '이미 병합되었습니다.',
  };
  /** 원본 GitPullRequestMergeMethod 셋(GitHub 의 merge_method 이름 · prDetail.method*). */
  const MERGE_METHODS = [['merge', '병합 커밋 만들기'], ['squash', 'Squash 후 병합'], ['rebase', 'Rebase 후 병합']];
  /** GitHub 가 병합 가능 여부를 계산하는 동안 다시 읽는 횟수와 간격. */
  const CHECKING_RETRIES = 4;
  const CHECKING_DELAY_MS = 1500;
  /** 스켈레톤을 적어도 이만큼은 보인다(원본 MinSkeletonMs) — 금방 읽혀도 깜박 스치듯 바뀌지 않게. */
  const MIN_SKELETON_MS = 900;
  /** 고른 병합 방식은 서랍을 다시 열어도 남는다(원본 _method). */
  let mergeMethod = 'merge';
  let detailToken = 0;

  /** 원본 GitPullRequestDetails.Readiness. */
  function readinessOf(p) {
    if (p.merged) return 'merged';
    if (p.state !== 'open') return 'closed';
    if (p.draft) return 'draft';
    if (p.mergeable == null) return 'checking';
    switch ((p.mergeable_state ?? '').toLowerCase()) {
      case 'dirty': return 'conflicts';
      case 'blocked': return 'blocked';
      case 'behind': return 'behind';
      case 'unstable': return 'unstable';
      case 'unknown': return 'checking';
      default: return p.mergeable ? 'ready' : 'conflicts';
    }
  }
  const canMerge = (r) => r === 'ready' || r === 'unstable';

  /** 포크에서 온 PR 은 GitHub 처럼 "owner:branch"(원본 HeadLabel). */
  function headLabel(p) {
    const owner = p.head?.repo?.full_name?.split('/')[0];
    const baseOwner = (p.html_url ?? '').split('/')[3];
    return owner && baseOwner && owner.toLowerCase() !== baseOwner.toLowerCase() ? `${owner}:${p.head?.ref}` : p.head?.ref ?? '?';
  }

  /** 세 응답(코멘트·리뷰·코드 줄 코멘트)을 시간순 한 줄로(원본 Timeline). 본문 없는 "코멘트" 리뷰와 PENDING 은 뺀다. */
  function timelineOf(comments, reviews, lineComments) {
    const clean = (s) => (s ?? '').replace(/\r\n/g, '\n').trim();
    const items = [
      ...comments.map((c) => ({ kind: 'comment', author: c.user?.login, body: clean(c.body), at: c.created_at })),
      ...reviews.map((r) => ({ kind: 'review', author: r.user?.login, body: clean(r.body), state: (r.state ?? '').toUpperCase(), at: r.submitted_at }))
        .filter((r) => r.state !== 'PENDING' && !(r.state === 'COMMENTED' && !r.body)),
      ...lineComments.map((c) => ({ kind: 'reviewcomment', author: c.user?.login, body: clean(c.body), path: c.path, line: c.line > 0 ? c.line : c.original_line, at: c.created_at })),
    ];
    const time = (i) => Date.parse(i.at ?? '') || 0;
    // 같은 시각이면 리뷰가 그 리뷰의 줄 코멘트보다 앞에.
    return items.sort((a, b) => time(a) - time(b) || (a.kind === 'reviewcomment') - (b.kind === 'reviewcomment'));
  }

  function eventAction(item) {
    if (item.kind === 'review') {
      return { APPROVED: '승인', CHANGES_REQUESTED: '변경 요청', DISMISSED: '리뷰 철회됨' }[item.state] ?? '리뷰';
    }
    if (item.kind === 'reviewcomment') return `${item.line > 0 ? `${item.path}:${item.line}` : item.path} 에 코멘트`;
    return '코멘트';
  }

  /** 페이지를 넘기며 다 읽는다(원본 FilesAsync — 100개씩). */
  async function allPages(path, limit = 30) {
    const out = [];
    for (let page = 1; page <= limit; page++) {
      const items = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  /** 실패를 알리는 카드(원본 Dialogs.AlertAsync): 확인 하나. */
  const alertCard = (title, error) => confirmDialog({ title, message: error?.message ?? String(error), ok: '확인', cancel: null, glyph: 'pullRequest', tone: 'danger' });

  function detail(pr) {
    const number = pr.number;
    const token = ++detailToken;
    openDrawer({
      glyph: 'pullRequest', title: `Pull Request #${number}`, anchor: ctx.sidebarElement(), width: 640,
      build(body, close) {
        const P = 'pr-detail';
        body.classList.add(P);
        const stale = () => token !== detailToken || !body.isConnected;
        const root = repoPath();

        if (!info?.me) {
          body.append(el('div', { class: 'drawer-form' },
            el('div', { class: 'drawer-note', text: 'Pull Request 를 보려면 GitHub 에 로그인하세요.' }),
            el('button', { class: 'btn drawer-secondary', text: 'GitHub 로그인…', onclick: () => { close(); deviceLogin().then(async (r) => { if (!r) return; info = await ctx.call('githubRepo').catch(() => info); detail(pr); }); } })));
          return;
        }

        let current = null; // 읽은 PR(REST 응답)
        let merging = false;
        let posting = false;
        const head = () => (current ? headBranch(pullInfo(current)) : null);

        // ── 스켈레톤: 실제 내용과 같은 섹션·간격(원본 BuildSkeleton) ──
        const bar = (width, height, extra = '') => el('div', { class: `sk-bar ${extra}`.trim(), style: { width: typeof width === 'number' ? `${width}px` : width, height: `${height}px` } });
        const timelineSkeleton = () => el('div', { class: `${P}-sk-events` }, bar('100%', 52, `${P}-sk-event`), bar('100%', 52, `${P}-sk-event`));
        const skeleton = el('div', { class: `${P}-skeleton` },
          el('div', { class: 'drawer-section' },
            el('div', { class: `${P}-title-row` }, bar(52, 20, `${P}-sk-badge`), bar('55%', 20, `${P}-sk-title`)),
            bar('78%', 12, `${P}-sk-line`), bar('42%', 12, `${P}-sk-line`)),
          el('div', { class: 'drawer-section' },
            bar(36, 12, `${P}-sk-caption`), bar('55%', 12, `${P}-sk-line`),
            el('div', { class: `${P}-sk-methods` }, bar('auto', 26, `${P}-sk-method`), bar('auto', 26, `${P}-sk-method`), bar('auto', 26, `${P}-sk-method`)),
            bar('100%', 30, `${P}-sk-merge`)),
          el('div', { class: `${P}-sk-actions` }, bar(112, 28), bar(90, 28), bar(72, 28)),
          el('div', { class: 'drawer-section' }, bar(36, 12, `${P}-sk-caption`), bar('100%', 36, `${P}-sk-box`)),
          el('div', { class: 'drawer-section' }, bar(52, 12, `${P}-sk-caption`), timelineSkeleton()));
        const skeletonSince = performance.now();
        let skeletonShowing = true;

        const error = problemLine();
        const content = el('div', { class: `${P}-content`, hidden: true });

        // 머리: 상태 배지 · 제목, "누가 어디로 합치려 한다", 숫자.
        const badge = el('span', { class: `${P}-badge` });
        const title = el('div', { class: `${P}-title`, text: pr.title ?? '' });
        const summary = el('div', { class: 'drawer-note' });
        const stats = el('div', { class: 'drawer-note' });

        // 병합: 안내 · 방식 셋 · Merge.
        const readiness = el('div', { class: `${P}-readiness` });
        const methodButtons = MERGE_METHODS.map(([method, label]) => el('button', {
          class: `${P}-method`, text: label, 'data-method': method,
          onclick: () => { mergeMethod = method; syncMethods(); },
        }));
        const syncMethods = () => methodButtons.forEach((b) => b.classList.toggle('on', b.dataset.method === mergeMethod));
        const mergeButton = el('button', { class: 'btn drawer-primary', text: 'Merge Pull Request', onclick: () => merge() });

        // 작업 버튼 줄.
        const secondary = (text, onclick) => el('button', { class: 'btn drawer-secondary', text, onclick });
        const viewOnGitHub = secondary('GitHub 에서 보기', () => ctx.call('openUrl', { url: current?.html_url ?? pr.url }).catch(ctx.showError));
        const viewChangesButton = secondary('바뀐 것 보기', () => { const h = head(); if (h) viewChanges(pullInfo(current), h); });
        const checkout = secondary('체크아웃', () => { const h = head(); if (h) ctx.refsUi.checkout(h.name, true); });
        const draftToggle = secondary('', () => toggleDraft());
        const openToggle = secondary('', () => toggleOpen());

        const descriptionBody = el('div', { class: `${P}-body` });

        const timelineCaption = el('span', { class: 'drawer-caption', text: '대화' });
        const timeline = el('div', { class: `${P}-timeline` }, timelineSkeleton());
        const reply = el('textarea', { class: 'field drawer-multiline', placeholder: '내용을 쓰세요(Markdown)', spellcheck: 'false' });
        const replyProblem = problemLine();
        const commentButton = secondary('코멘트', () => post(null));
        const approveButton = secondary('승인', () => post('APPROVE'));
        approveButton.classList.add(`${P}-approve`);
        const requestChangesButton = secondary('변경 요청', () => post('REQUEST_CHANGES'));
        requestChangesButton.classList.add(`${P}-danger`);
        reply.addEventListener('input', () => validate());

        const facts = el('div', { class: 'drawer-section' });
        const filesCaption = el('span', { class: 'drawer-caption' });
        const files = el('div', { class: `${P}-files` });

        content.append(
          el('div', { class: 'drawer-section' }, el('div', { class: `${P}-title-row` }, badge, title), summary, stats),
          el('div', { class: 'drawer-section' }, caption('병합'), readiness, el('div', { class: `${P}-methods` }, methodButtons), mergeButton),
          el('div', { class: `drawer-buttons ${P}-actions` }, viewOnGitHub, viewChangesButton, checkout, draftToggle, openToggle),
          el('div', { class: 'drawer-section' }, caption('설명'), descriptionBody),
          el('div', { class: 'drawer-section' }, timelineCaption, timeline, caption('코멘트·리뷰 남기기'), reply, replyProblem,
            el('div', { class: `drawer-buttons ${P}-reply-buttons` }, commentButton, approveButton, requestChangesButton)),
          facts,
          el('div', { class: 'drawer-section' }, filesCaption, files));
        body.append(el('div', { class: 'drawer-form' }, error, skeleton, content));
        syncMethods();

        function hideSkeleton() {
          skeletonShowing = false;
          skeleton.hidden = true;
        }
        /** 스켈레톤을 내용으로 바꾼다. 내용은 투명·살짝 아래에서 시작해 제자리로 서서히 올라온다(원본 SwapToContent). */
        function reveal() {
          if (!skeletonShowing) {
            content.hidden = false;
            return;
          }
          const swap = () => {
            if (stale() || !skeletonShowing) return;
            hideSkeleton();
            content.classList.add('entering');
            content.hidden = false;
            setTimeout(() => content.classList.remove('entering'), 30);
          };
          const remaining = MIN_SKELETON_MS - (performance.now() - skeletonSince);
          if (remaining <= 0) swap();
          else setTimeout(swap, remaining);
        }

        function fact(name, values) {
          facts.append(el('div', { class: `${P}-fact` },
            el('span', { class: `${P}-fact-name`, text: name }),
            el('span', { class: `${P}-fact-value${values.length ? '' : ' empty'}`, text: values.length ? values.join(', ') : '없음' })));
        }

        function showDetail(p) {
          current = p;
          reveal();
          title.textContent = p.title ?? '';
          const r = readinessOf(p);
          const state = p.merged ? 'merged' : p.state !== 'open' ? 'closed' : p.draft ? 'draft' : 'open';
          badge.textContent = { merged: 'Merged', closed: 'Closed', draft: 'Draft', open: 'Open' }[state];
          badge.className = `${P}-badge ${state}`;
          summary.textContent = `${p.user?.login ?? '?'} 님이 ${headLabel(p)} 의 커밋 ${p.commits ?? 0}개를 ${p.base?.ref ?? '?'} 에 합치려 합니다.`;
          stats.textContent = `바뀐 파일 ${p.changed_files ?? 0}개 · +${p.additions ?? 0} −${p.deletions ?? 0} · 댓글 ${(p.comments ?? 0) + (p.review_comments ?? 0)}개`;
          readiness.textContent = READINESS[r];
          readiness.className = `${P}-readiness${canMerge(r) ? ' ok' : ['conflicts', 'blocked', 'behind'].includes(r) ? ' bad' : ''}`;
          const text = (p.body ?? '').replace(/\r\n/g, '\n').trim();
          descriptionBody.textContent = text || '설명이 없습니다.';
          descriptionBody.classList.toggle('empty', !text);
          facts.replaceChildren();
          fact('리뷰어', (p.requested_reviewers ?? []).map((u) => u.login).filter(Boolean));
          fact('담당자', (p.assignees ?? []).map((u) => u.login).filter(Boolean));
          fact('라벨', (p.labels ?? []).map((l) => l.name).filter(Boolean));
          fact('브랜치', [`${headLabel(p)} → ${p.base?.ref}`]);
          validate();
        }

        function showTimeline(items, failure) {
          timelineCaption.textContent = `대화 ${items.length}개`;
          timeline.replaceChildren(
            ...(!items.length && !failure ? [el('div', { class: 'drawer-note', text: '아직 코멘트나 리뷰가 없습니다.' })] : []),
            ...items.map((item) => el('div', { class: `${P}-event ${item.kind}` },
              el('div', { class: `${P}-event-head` },
                el('span', { class: `${P}-event-author`, text: item.author ?? '?' }),
                el('span', { class: `${P}-event-action${item.kind === 'review' ? ` ${item.state.toLowerCase().replace(/_/g, '-')}` : ''}`, text: eventAction(item) }),
                el('span', { class: `${P}-event-time`, text: item.at ? formatDate(Date.parse(item.at) / 1000, true) : '' })),
              item.body ? el('div', { class: `${P}-event-body`, text: item.body }) : null)),
            ...(failure ? [el('div', { class: 'drawer-problem', text: failure })] : []));
        }

        const STATUS_LETTER = { added: 'A', removed: 'D', renamed: 'R', copied: 'C' };
        function showFiles(list, total, failure) {
          filesCaption.textContent = `바뀐 파일 ${Math.max(total ?? 0, list.length)}개`;
          files.replaceChildren(...list.map((f) => el('div', { class: `${P}-file` },
            el('span', { class: `${P}-file-status ${f.status || 'modified'}`, text: STATUS_LETTER[f.status] ?? 'M' }),
            el('span', { class: `${P}-file-path`, text: f.previous_filename ? `${f.previous_filename} → ${f.filename}` : f.filename, 'data-tip': f.filename }),
            el('span', { class: `${P}-file-counts`, text: `+${f.additions ?? 0} −${f.deletions ?? 0}` }))),
          ...(failure ? [el('div', { class: 'drawer-problem', text: failure })] : []));
        }

        const readTimeline = () => Promise.all([
          api(`${root}/issues/${number}/comments?per_page=100`), api(`${root}/pulls/${number}/reviews?per_page=100`), api(`${root}/pulls/${number}/comments?per_page=100`)])
          .then(([c, r, l]) => ({ items: timelineOf(c, r, l), failure: null }), (e) => ({ items: [], failure: e?.message ?? String(e) }));

        async function start() {
          const filesTask = allPages(`${root}/pulls/${number}/files`).then((list) => ({ list, failure: null }), (e) => ({ list: [], failure: e?.message ?? String(e) }));
          const timelineTask = readTimeline();
          let p;
          try {
            p = await api(`${root}/pulls/${number}`);
            // 병합 가능 여부는 GitHub 가 PR 을 처음 열 때 뒤에서 계산한다. 계산 중이면 잠시 뒤 다시 읽는다.
            for (let retry = 0; retry < CHECKING_RETRIES && p.mergeable == null && p.state === 'open' && !stale(); retry++) {
              showDetail(p);
              await new Promise((r) => setTimeout(r, CHECKING_DELAY_MS));
              p = await api(`${root}/pulls/${number}`);
            }
          } catch (e) {
            if (stale()) return;
            hideSkeleton();
            error.set(e?.message || 'Pull Request 를 읽지 못했습니다.');
            return;
          }
          if (stale()) return;
          showDetail(p);
          const t = await timelineTask;
          if (stale()) return;
          showTimeline(t.items, t.failure);
          const f = await filesTask;
          if (!stale()) showFiles(f.list, p.changed_files, f.failure);
        }

        /** 코멘트·리뷰·상태를 바꾼 뒤 대화와 상태만 다시 읽는다(원본 ReloadAfterPostAsync). */
        async function reloadAfterPost() {
          const timelineTask = readTimeline();
          const p = await api(`${root}/pulls/${number}`).catch(() => null);
          const t = await timelineTask;
          if (stale()) return;
          if (p) showDetail(p);
          showTimeline(t.items, t.failure);
        }

        function validate() {
          const r = current ? readinessOf(current) : 'checking';
          const open = current?.state === 'open';
          mergeButton.disabled = merging || !canMerge(r);
          mergeButton.textContent = merging ? '병합하는 중…' : 'Merge Pull Request';
          methodButtons.forEach((b) => { b.disabled = !open || merging; });
          const h = current ? head() : null;
          viewChangesButton.disabled = !h;
          checkout.disabled = !h || !!ctx.state.busy;
          const idle = !!current && !posting && !merging;
          draftToggle.textContent = current?.draft ? 'Ready for review' : 'Draft 로 되돌리기';
          draftToggle.hidden = !open;
          draftToggle.disabled = !idle || !current?.node_id;
          openToggle.textContent = open ? 'Pull Request 닫기' : 'Pull Request 다시 열기';
          openToggle.hidden = !current || !!current.merged;
          openToggle.disabled = !idle;
          openToggle.classList.toggle(`${P}-danger`, open);
          const hasText = !!reply.value.trim();
          commentButton.disabled = !idle || !hasText;
          // 승인·변경 요청은 열린 PR 에만. 승인은 글 없이 된다.
          approveButton.disabled = !idle || !open;
          requestChangesButton.disabled = !idle || !open || !hasText;
        }

        /** decision: null 이면 일반 코멘트, 아니면 그 결정의 리뷰(APPROVE · REQUEST_CHANGES). */
        async function post(decision) {
          const p = current;
          const text = reply.value.trim();
          if (!p || posting) return;
          if (decision !== 'APPROVE' && !text) {
            replyProblem.set(decision == null ? '코멘트 내용을 쓰세요.' : '변경 요청에는 내용이 필요합니다.');
            return;
          }
          posting = true;
          validate();
          try {
            if (decision == null) await api(`${root}/issues/${number}/comments`, { method: 'POST', body: { body: text } });
            else await api(`${root}/pulls/${number}/reviews`, { method: 'POST', body: { body: text, event: decision } });
          } catch (e) {
            posting = false;
            if (stale() || p !== current) return;
            validate();
            await alertCard(decision == null ? '코멘트를 남기지 못함' : '리뷰를 남기지 못함', e);
            return;
          }
          posting = false;
          if (stale() || p !== current) return;
          // 보냈으면 쓴 글을 비운다(실패하면 남겨 다시 보낼 수 있게).
          reply.value = '';
          replyProblem.set(null);
          validate();
          await reloadAfterPost();
        }

        async function changeState(p, change, failedTitle) {
          posting = true;
          validate();
          try {
            await change();
          } catch (e) {
            posting = false;
            if (stale() || p !== current) return;
            validate();
            await alertCard(failedTitle, e);
            return;
          }
          posting = false;
          if (stale()) return;
          load(true);
          await reloadAfterPost();
        }

        /** Draft ↔ Ready. REST 에는 없어 GraphQL 로 한다. */
        function toggleDraft() {
          const p = current;
          if (!p || p.state !== 'open' || posting) return;
          const toDraft = !p.draft;
          const mutation = toDraft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
          changeState(p, () => ctx.call('githubGraphql', { query: `mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`, variables: { id: p.node_id } }),
            toDraft ? `Pull Request #${number}을(를) Draft 로 되돌리지 못함` : `Pull Request #${number}을(를) Ready for review 로 바꾸지 못함`);
        }

        async function toggleOpen() {
          const p = current;
          if (!p || p.merged || posting) return;
          const reopen = p.state !== 'open';
          if (!reopen && !(await confirmDialog({
            title: `Pull Request #${number} 닫기`, glyph: 'pullRequest', danger: true, ok: 'Pull Request 닫기',
            message: `#${number} ${p.title}\n\nGitHub 에서 이 Pull Request 를 병합하지 않고 닫습니다. 나중에 다시 열 수 있습니다.`,
          }))) return;
          changeState(p, () => api(`${root}/pulls/${number}`, { method: 'PATCH', body: { state: reopen ? 'open' : 'closed' } }),
            reopen ? `Pull Request #${number} 다시 열기 실패` : `Pull Request #${number} 닫기 실패`);
        }

        /** 병합은 GitHub 에 바로 반영되므로 늘 확인 카드를 거치고, 본 때의 head 커밋을 함께 보내 그 사이 새 커밋이 올라왔으면 GitHub 가 거절하게 한다. */
        async function merge() {
          const p = current;
          if (!p || merging) return;
          const method = MERGE_METHODS.find(([m]) => m === mergeMethod)?.[1];
          const ok = await confirmDialog({
            title: `Pull Request #${number} 병합`, glyph: 'pullRequest', ok: 'Merge Pull Request',
            message: `#${number} ${p.title}\n\n${headLabel(p)} → ${p.base?.ref}을(를) '${method}' 방식으로 GitHub(${info.owner}/${info.repo})에서 병합합니다. 되돌리려면 GitHub 에서 Revert 해야 합니다.`,
          });
          if (!ok || p !== current || stale()) return;
          merging = true;
          validate();
          try {
            await api(`${root}/pulls/${number}/merge`, { method: 'PUT', body: p.head?.sha ? { merge_method: mergeMethod, sha: p.head.sha } : { merge_method: mergeMethod } });
          } catch (e) {
            merging = false;
            if (stale()) return;
            validate();
            await alertCard(`Pull Request #${number} 병합 실패`, e);
            return;
          }
          merging = false;
          // 사이드바 PR 목록을 다시 읽고, 병합 커밋이 그래프·Pull 숫자에 보이게 원격을 받는다.
          load(true);
          ctx.fetch?.();
          if (stale()) return;
          // 병합된 상태(Merged 배지·버튼 끔)로 처음부터 다시 읽는다.
          current = null;
          content.hidden = true;
          skeleton.hidden = false;
          skeletonShowing = true;
          timeline.replaceChildren(timelineSkeleton());
          start();
        }

        validate();
        start();
      },
    });
  }

  // ── PR 만들기 서랍(GH-05) — 원본 Elements/CreatePullRequestDrawer + Core/GitDrawerForms.GitPullRequestForm ──

  /** 이 레포지토리의 GitHub 원격들(origin 먼저, 그다음 원격 이름 순). 원본 GitPullRequestForm.GitHubRemotes. */
  function gitHubRepos() {
    return (ctx.state.remotes ?? []).map((r) => {
      const m = GITHUB_REMOTE.exec(r.fetchUrl ?? '');
      return m ? { remote: r.name, owner: m[1], repository: m[2], fullName: `${m[1]}/${m[2]}` } : null;
    }).filter(Boolean)
      .sort((a, b) => (a.remote === 'origin' ? 0 : 1) - (b.remote === 'origin' ? 0 : 1) || a.remote.localeCompare(b.remote, undefined, { sensitivity: 'base' }));
  }

  /** 그 원격의 브랜치 이름(원격 이름 뗀 것, HEAD 제외). */
  function remoteBranchNames(remote) {
    const prefix = `${remote}/`;
    return (ctx.state.refs?.remote ?? []).filter((b) => b.name.startsWith(prefix) && b.name !== `${prefix}HEAD`)
      .map((b) => b.name.slice(prefix.length)).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  /** 받을 레포지토리의 기본 브랜치 짐작: main → master → develop → 첫 브랜치(원격 HEAD 는 참조 목록에 없다). */
  function defaultBase(remote) {
    const names = remoteBranchNames(remote);
    return ['main', 'master', 'develop'].find((n) => names.includes(n)) ?? names[0] ?? null;
  }

  /** 브랜치 이름으로 만든 PR 제목: 마지막 '/' 뒤, '-'·'_' 는 띄어쓰기("origin/feature/pr-menu" → "pr menu"). */
  const titleFromBranch = (branch) => (branch ?? '').split('/').pop().replace(/[-_]/g, ' ').trim();

  /** 병합 커밋을 건너뛴 제목(보내는 끝 커밋·받는 브랜치별). 다시 열 때 바로 쓴다. */
  const titleCache = new Map();

  /** git log --no-merges -1 --format=%s base..head 와 같은 것을 읽어 둔 그래프 커밋으로 찾는다. 못 찾으면 null. */
  function lastNonMergeSubject(headHash, baseHash) {
    const commits = ctx.state.history?.commits ?? [];
    const byHash = new Map(commits.map((c) => [c.hash, c]));
    if (!byHash.has(headHash)) return null;
    const reach = (start) => {
      const seen = new Set();
      const stack = start ? [start] : [];
      while (stack.length) {
        const h = stack.pop();
        if (seen.has(h)) continue;
        seen.add(h);
        for (const parent of byHash.get(h)?.parents ?? []) stack.push(parent);
      }
      return seen;
    };
    const fromHead = reach(headHash);
    const fromBase = reach(baseHash);
    // 그래프 커밋은 날짜 순이라 처음 걸리는 것이 git log -1 과 같다.
    return commits.find((c) => fromHead.has(c.hash) && !fromBase.has(c.hash) && c.parents.length < 2)?.subject ?? null;
  }

  /** 커밋 제목: 그래프에 있으면 바로, 없으면 git 에서 읽는다. */
  function subjectOf(hash) {
    const found = (ctx.state.history?.commits ?? []).find((c) => c.hash === hash);
    if (found) return found.subject;
    return ctx.call('commitDetail', { hash }).then((d) => (d?.message ?? '').split('\n')[0].trim(), () => '');
  }

  /** headName: 보낼 브랜치(로컬 또는 원격). 없으면 지금 브랜치. */
  async function createPull(headName) {
    if (!info) {
      try {
        info = await ctx.call('githubRepo');
      } catch {
        // 아래에서 로그인 안내로 보인다.
      }
    }
    openDrawer({
      glyph: 'pullRequest', title: 'Pull Request 만들기', anchor: ctx.sidebarElement(),
      build(body, close) {
        const box = el('div', { class: 'drawer-form' });
        body.append(box);
        if (!info?.me) {
          box.append(el('div', { class: 'drawer-note', text: 'Pull Request 를 만들려면 먼저 GitHub 에 로그인하세요.' }),
            el('button', { class: 'btn drawer-secondary', text: 'GitHub 로그인…', onclick: () => { close(); deviceLogin().then((r) => { if (r) { info = null; createPull(headName); } }); } }));
          return;
        }
        const refs = ctx.state.refs ?? { local: [], remote: [] };
        const repos = gitHubRepos();
        const repoItems = repos.map((r) => ({ value: r.remote, label: r.fullName, hint: r.remote, icon: 'github' }));
        const repoOf = (remote) => repos.find((r) => r.remote === remote) ?? null;
        const initial = (headName && (refs.local.find((b) => b.name === headName) ?? (refs.remote ?? []).find((b) => b.name === headName)))
          ?? refs.local.find((b) => b.current) ?? null;
        const initialIsRemote = !!initial && !refs.local.includes(initial);
        let titleEdited = false;
        let creating = false;
        let serverError = null;

        const fromRepo = searchSelect({ items: repoItems, placeholder: '선택…', onChange: () => { fillBranches(fromRepo, fromBranch, preferredFromBranch()); fillTitle(); inputChanged(); } });
        const fromBranch = searchSelect({ items: [], placeholder: '선택…', onChange: () => { fillTitle(); inputChanged(); } });
        const toRepo = searchSelect({ items: repoItems, placeholder: '선택…', onChange: () => { fillBranches(toRepo, toBranch, toRepo.value ? defaultBase(toRepo.value) : null); inputChanged(); } });
        const toBranch = searchSelect({ items: [], placeholder: '선택…', onChange: () => inputChanged() });
        const title = textField();
        title.placeholder = 'Pull Request 제목';
        title.spellcheck = true;
        const description = el('textarea', { class: 'field drawer-multiline', placeholder: 'Pull Request 설명' });
        const draft = toggle('초안(Draft)으로 올리기', false);
        draft.dataset.tip = '초안은 검토 요청 전까지 병합할 수 없습니다.';
        const noteLine = note();
        const problem = problemLine();
        const create = el('button', { class: 'btn drawer-primary', text: 'Pull Request 만들기', onclick: () => submit() });

        box.append(
          el('div', { class: 'drawer-columns' },
            el('div', { class: 'drawer-column' }, caption('보낼 레포지토리'), fromRepo.element, caption('브랜치'), fromBranch.element),
            el('div', { class: 'drawer-arrow', text: '→' }),
            el('div', { class: 'drawer-column' }, caption('받을 레포지토리'), toRepo.element, caption('브랜치'), toBranch.element)),
          caption('제목'), title,
          caption('설명'), description,
          draft, noteLine, problem,
          el('div', { class: 'drawer-row-buttons' }, el('button', { class: 'btn drawer-secondary', text: '취소', onclick: () => close() }), create));

        title.addEventListener('input', () => { titleEdited = true; inputChanged(); });

        /** From 브랜치 기본값: 연 브랜치의 upstream 이 그 원격에 있으면 그것, 아니면 같은 이름. */
        function preferredFromBranch() {
          const repo = repoOf(fromRepo.value);
          if (!initial || !repo) return null;
          const tracked = initialIsRemote ? initial.name : initial.upstream;
          if (tracked) {
            const at = tracked.indexOf('/');
            if (tracked.slice(0, at) === repo.remote) return tracked.slice(at + 1);
          }
          return initialIsRemote ? initial.name.slice(initial.name.indexOf('/') + 1) : initial.name;
        }

        function fillBranches(repoSelect, branchSelect, preferred) {
          const names = repoSelect.value ? remoteBranchNames(repoSelect.value) : [];
          branchSelect.setItems(names.map((n) => ({ value: n, label: n })));
          branchSelect.set(preferred != null && names.includes(preferred) ? preferred : null);
        }

        /** 제목은 From 브랜치 끝 커밋의 첫 줄. 끝 커밋이 병합 커밋이면 병합이 아닌 마지막 커밋 제목(없으면 브랜치 이름). */
        function fillTitle() {
          if (titleEdited || !fromRepo.value || !fromBranch.value) return;
          const full = `${fromRepo.value}/${fromBranch.value}`;
          const tip = (refs.remote ?? []).find((b) => b.name === full);
          if (!tip) return;
          const apply = (subject) => {
            if (titleEdited || full !== `${fromRepo.value}/${fromBranch.value}`) return;
            if (subject.startsWith('Merge ') && toRepo.value && toBranch.value) {
              const baseRef = `${toRepo.value}/${toBranch.value}`;
              const key = `${tip.hash}..${baseRef}`;
              if (!titleCache.has(key)) {
                const baseHash = (refs.remote ?? []).find((b) => b.name === baseRef)?.hash;
                titleCache.set(key, lastNonMergeSubject(tip.hash, baseHash) || titleFromBranch(full));
              }
              title.value = titleCache.get(key);
            } else title.value = subject;
            validate();
          };
          const subject = subjectOf(tip.hash);
          if (typeof subject === 'string') apply(subject);
          else subject.then(apply);
        }

        /** 연 로컬 브랜치가 고른 원격에 아직 없으면 먼저 Push 하라고 알린다. */
        function pushHint() {
          if (!initial || initialIsRemote || !fromRepo.value || fromBranch.value) return null;
          return `'${initial.name}' 가 ${fromRepo.value} 에 아직 없습니다. 먼저 Push 하세요.`;
        }

        function applyDefaults() {
          const upstream = initialIsRemote ? initial.name : initial?.upstream;
          const upstreamRemote = upstream ? upstream.slice(0, upstream.indexOf('/')) : null;
          const from = repos.find((r) => r.remote === upstreamRemote) ?? repos[0] ?? null;
          // 포크에서 일하면 upstream 원격이 받는 쪽이다.
          const to = repos.find((r) => r.remote === 'upstream' && r !== from) ?? from;
          fromRepo.set(from?.remote ?? null);
          toRepo.set(to?.remote ?? null);
          fillBranches(fromRepo, fromBranch, preferredFromBranch());
          fillBranches(toRepo, toBranch, to ? defaultBase(to.remote) : null);
          if (!titleEdited) title.value = '';
          fillTitle();
          noteLine.set(!repos.length ? 'GitHub 원격이 없습니다. 먼저 원격을 추가하세요.' : pushHint());
          validate();
        }

        function inputChanged() {
          serverError = null;
          validate();
        }

        function validate() {
          const fr = repoOf(fromRepo.value);
          const tr = repoOf(toRepo.value);
          const same = fr && tr && fromBranch.value && fr.fullName === tr.fullName && fromBranch.value === toBranch.value;
          problem.set(same ? '보낼 브랜치와 받을 브랜치가 같습니다.' : serverError);
          create.disabled = creating || !!same || !fr || !fromBranch.value || !tr || !toBranch.value || !title.value.trim();
        }

        async function submit() {
          const from = repoOf(fromRepo.value);
          const to = repoOf(toRepo.value);
          const head = fromBranch.value;
          const base = toBranch.value;
          if (creating || create.disabled || !from || !to || !head || !base) return;
          creating = true;
          serverError = null;
          noteLine.set('만드는 중…');
          validate();
          let created;
          try {
            // 같은 레포지토리면 브랜치 이름만, 포크에서 보내면 "owner:branch".
            const headSpec = from.owner.toLowerCase() === to.owner.toLowerCase() ? head : `${from.owner}:${head}`;
            created = await api(`/repos/${to.fullName}/pulls`, { method: 'POST', body: { title: title.value.trim(), body: description.value, head: headSpec, base, draft: draft.input.checked } });
          } catch (e) {
            creating = false;
            noteLine.set(null);
            serverError = `GitHub 가 거절했습니다: ${e?.message ?? e}`;
            validate();
            return;
          }
          creating = false;
          noteLine.set(null);
          const done = `${to.fullName} 에 Pull Request #${created.number} 를 만들었습니다.`;
          ctx.toast(done, 'success');
          load(true);
          close();
          // 브라우저를 멋대로 앞으로 가져오지 않는다. 열지 고르게 한다.
          if (created.html_url && await confirmDialog({ title: 'Pull Request 를 만들었습니다', message: done, ok: '브라우저에서 열기', cancel: '닫기', glyph: 'pullRequest' })) {
            ctx.call('openUrl', { url: created.html_url }).catch(ctx.showError);
          }
        }

        applyDefaults();
        title.focus();
      },
    });
  }

  // ── PR 필터 서랍 — 원본 Elements/PullRequestFilterDrawer ──

  const FILTER_SYNTAX = '작성자: author:아이디\n담당자: assignee:아이디\n관련: involves:아이디\n리뷰 요청: review-requested:아이디\n리뷰한 사람: reviewed-by:아이디\n받는 브랜치: base:브랜치\n보내는 브랜치: head:브랜치\n초안: draft:true / draft:false\n라벨: label:라벨\n리뷰 상태: review:approved / changes_requested / none\n검사 상태: status:success / pending / failure\n없음: no:assignee / no:label / no:milestone\n만든 날: created:2026-10-01 / created:>2026-10-01\n고친 날: updated:2026-10-01\n\n@me 는 로그인한 계정입니다.';

  /** 이름과 GitHub 검색 문법 조건으로 사이드바 PR 묶음을 만들거나 고친다. index 가 있으면 그 묶음을 고친다. 아래에 쓸 수 있는 조건을 늘 보인다. */
  function filterDrawer(index = -1) {
    const existing = index >= 0 ? filters()[index] ?? null : null;
    const editing = !!existing;
    openDrawer({
      glyph: 'pullRequest', title: editing ? 'Pull Request 필터 고치기' : 'Pull Request 필터 만들기', anchor: ctx.sidebarElement(),
      build(body, close) {
        const name = textField(existing ? filterName(existing) : '');
        name.placeholder = '필터 이름을 쓰세요';
        const query = textField(existing?.query ?? '');
        query.placeholder = '조건을 쓰세요 (예: author:@me draft:false)';
        const problem = problemLine();
        const submitButton = el('button', { class: 'btn drawer-primary', text: editing ? '필터 고치기' : '필터 만들기', onclick: () => submit() });
        const validate = () => {
          const hasName = !!name.value.trim();
          problem.set(hasName ? null : '이름을 쓰세요.');
          submitButton.disabled = !hasName;
        };
        function submit() {
          const text = name.value.trim();
          if (!text) return;
          const next = [...filters()];
          // 기본 묶음 이름을 그대로 두었으면 기본 이름(nameKey)을 남긴다.
          const keepKey = existing?.nameKey && text === filterName(existing);
          const item = keepKey ? { nameKey: existing.nameKey, query: query.value.trim() } : { name: text, query: query.value.trim() };
          if (editing) next[index] = item;
          else next.push(item);
          saveFilters(next);
          close();
          load(true);
        }
        name.addEventListener('input', validate);
        query.addEventListener('input', validate);
        body.append(el('div', { class: 'drawer-form' },
          el('div', { class: 'drawer-section' }, caption('필터 이름'), name, caption('Pull Request 거르기'), query, problem, submitButton),
          el('div', { class: 'drawer-section' }, caption('Pull Request 필터 문법'), el('div', { class: 'drawer-note pr-filter-syntax', text: FILTER_SYNTAX }))));
        validate();
      },
    });
  }

  // ── 원격 추가 드로어의 GitHub 탭(DLG-09 · GH-06, 원본 AddRemoteDrawer) ──

  const NAME_HELP = "이 컴퓨터에서 이 원격을 부를 짧은 별명입니다. 원격 브랜치가 'origin/main' 처럼 이 이름 뒤에 붙어 보입니다.\n처음 연결하는 원격이면 보통 'origin' 을 씁니다. 이 레포지토리 안에서만 쓰는 이름이라 서버에는 영향이 없습니다.";
  const REPO_NAME_PROBLEM = {
    tooLong: '레포지토리 이름은 100자를 넘을 수 없습니다.',
    invalid: '레포지토리 이름에는 영문·숫자와 . - _ 만 쓸 수 있습니다.',
    reserved: "'.' 이나 '..' 은 레포지토리 이름으로 쓸 수 없습니다.",
  };
  const isRepoChar = (c) => /[A-Za-z0-9._-]/.test(c);

  /** 원본 GitRemoteForm.CheckRepositoryName: GitHub 가 받는 이름인지, 이미 아는 레포지토리와 겹치는지. */
  function repoNameProblem(name, owner, known) {
    if (!name) return 'empty';
    if (name.length > 100) return 'tooLong';
    if ([...name].some((c) => !isRepoChar(c))) return 'invalid';
    if (name === '.' || name === '..') return 'reserved';
    if (known.some((r) => r.full_name.toLowerCase() === `${owner}/${name}`.toLowerCase())) return 'exists';
    return null;
  }

  /** 원본 SuggestRepositoryName: 폴더 이름에서 쓸 수 없는 글자를 '-' 로, 겹친 '-' 와 앞뒤 '-'·'.' 정리. 남는 게 없으면 "unity-project". */
  function suggestRepoName(folder) {
    let out = '';
    for (const c of folder ?? '') {
      const next = isRepoChar(c) ? c : '-';
      if (next === '-' && out.endsWith('-')) continue;
      out += next;
    }
    out = out.replace(/^[-.]+|[-.]+$/g, '').slice(0, 100).replace(/[-.]+$/, '');
    return out || 'unity-project';
  }

  /** 원본 SuggestName: origin 이 비었으면 origin, 아니면 소유자 이름(쓸 수 없으면 remote), 겹치면 뒤에 2, 3, … */
  function suggestRemoteName(existing, owner) {
    const taken = (n) => existing.some((o) => o.toLowerCase() === n.toLowerCase());
    if (!taken('origin')) return 'origin';
    const stem = !owner?.trim() || branchNameProblem(owner, []) ? 'remote' : owner;
    if (!taken(stem)) return stem;
    for (let i = 2; ; i++) if (!taken(`${stem}${i}`)) return `${stem}${i}`;
  }

  /** 원본 CheckName: 비면 null(버튼만 끔), 같은 이름이면 그 문구, 그 밖에는 브랜치 이름 규칙. */
  function remoteNameProblem(name, existing) {
    if (!name) return null;
    if (existing.includes(name)) return '같은 이름의 원격이 이미 있습니다.';
    if (name.includes('/')) return '원격 이름에 / 는 쓸 수 없습니다.';
    return branchNameProblem(name, []) || null;
  }

  /** 원본 PickDefaultBranch: 로컬에 main → master → 현재 브랜치 → 첫 브랜치. */
  const pickDefaultBranch = (locals, current) => ['main', 'master'].find((b) => locals.includes(b)) ?? current ?? locals[0] ?? null;

  /** 원본 PublishBranches: 기본 브랜치를 맨 앞에, 그다음 현재, 그다음 나머지(겹치면 한 번). */
  function publishBranches(defaultBranch, current, withCurrent, withOthers, locals) {
    const out = [];
    const add = (b) => { if (b && !out.includes(b)) out.push(b); };
    add(defaultBranch);
    if (withCurrent) add(current);
    if (withOthers) locals.forEach(add);
    return out;
  }

  // 서랍 부품(원본 SideDrawer 의 Caption · Field(help) · Note · Problem · 토글).
  const caption = (text, help) => el('div', { class: 'drawer-caption-row' }, el('span', { class: 'drawer-caption', text }),
    help ? el('span', { class: 'drawer-help', 'data-tip': help }, icon('info', 14)) : null);
  const note = () => {
    const node = el('div', { class: 'drawer-note', hidden: true });
    node.set = (text) => { node.textContent = text ?? ''; node.hidden = !text; };
    return node;
  };
  const problemLine = () => {
    const node = el('div', { class: 'drawer-problem', hidden: true });
    node.set = (text) => { node.textContent = text ?? ''; node.hidden = !text; };
    return node;
  };
  const toggle = (text, checked) => {
    const input = el('input', { type: 'checkbox' });
    input.checked = checked;
    const label = el('span', { text });
    const row = el('label', { class: 'check drawer-toggle' }, input, label);
    row.input = input;
    row.setText = (t) => { label.textContent = t; };
    return row;
  };
  const textField = (value = '') => {
    const input = el('input', { class: 'field', spellcheck: 'false', autocomplete: 'off' });
    input.value = value;
    return input;
  };

  function remoteForm(closeDrawer) {
    const box = el('div', { class: 'drawer-form' });
    if (signedIn === false) {
      // 원본 SignInPrompt: 안내 + 보조 버튼.
      box.append(el('div', { class: 'drawer-note', text: 'GitHub 레포지토리를 고르거나 새로 만들려면 먼저 GitHub 에 로그인하세요.' }),
        el('button', { class: 'btn drawer-secondary', text: 'GitHub 로그인…', onclick: () => { closeDrawer(); deviceLogin(); } }));
      return box;
    }
    const busy = () => !!ctx.state.busy;
    const refs = ctx.state.refs ?? { local: [], remotes: [], tags: [] };
    let existing = [...(refs.remotes ?? [])];
    const suggested = suggestRemoteName(existing, null);
    const branch = ctx.state.status?.branch;
    const current = branch && !branch.detached && branch.hasCommits && branch.name ? branch.name : null;
    const locals = (refs.local ?? []).map((b) => b.name);
    const tracked = new Set((refs.local ?? []).filter((b) => b.upstream).map((b) => b.name));
    const tagCount = refs.tags?.length ?? 0;
    const canPublish = locals.length > 0 && !!current;
    let me = info?.me ?? '';
    let known = [];
    let created = null;

    // ── [기존 레포지토리 | 새로 만들기] (원본 diff 막대의 칸 묶음 모양, 반씩) ──
    const existingMode = el('button', { class: 'dbar-btn', text: '기존 레포지토리', onclick: () => selectMode(false) });
    const createMode = el('button', { class: 'dbar-btn', text: '새로 만들기', onclick: () => selectMode(true) });
    const modes = el('div', { class: 'dbar-seg drawer-modes' }, existingMode, createMode);

    // ── 기존 레포지토리 ──
    const repoNote = note();
    let nameEdited = false;
    const gitHubName = textField(suggested);
    const gitHubProblem = problemLine();
    const gitHubAdd = el('button', { class: 'btn drawer-primary', text: '원격 추가' });
    const repoSelect = searchSelect({
      items: [], placeholder: '선택…',
      onChange: (value) => {
        const repo = known.find((r) => r.full_name === value);
        if (repo && !nameEdited) gitHubName.value = suggestRemoteName(existing, repo.owner?.login);
        validate();
        if (repo) setTimeout(() => gitHubName.focus());
      },
    });
    const existingPanel = el('div', { class: 'drawer-section' },
      caption('GitHub 레포지토리'), repoSelect.element, repoNote,
      caption('이름', NAME_HELP), gitHubName, gitHubProblem, gitHubAdd);

    // ── 새로 만들기 ──
    const ownerSelect = searchSelect({ items: me ? [{ value: me, label: me, hint: '내 계정' }] : [], value: me || null, placeholder: '선택…', onChange: () => validate() });
    const repoName = textField(suggestRepoName((ctx.state.repo?.path ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop()));
    const repoNameNote = problemLine();
    const priv = toggle('비공개 레포지토리', true);
    const createRemoteName = textField(suggested);
    const createRemoteProblem = problemLine();
    const pushAfter = toggle('만든 뒤 브랜치 올리기 (Push)', true);
    const defaultSelect = searchSelect({
      items: locals.map((b) => ({ value: b, label: b, hint: b === current ? '현재' : '' })),
      value: pickDefaultBranch(locals, current), placeholder: '선택…', onChange: () => validate(),
    });
    const pushCurrent = toggle('', true);
    const pushOthers = toggle('', false);
    const pushTags = toggle(`태그 ${tagCount}개도 올리기`, false);
    const pushOptions = el('div', { class: 'drawer-suboptions' }, caption('기본 브랜치'), defaultSelect.element,
      el('div', { class: 'drawer-note', text: 'GitHub 레포지토리의 기본 브랜치가 되며 맨 먼저 올라갑니다.' }), pushCurrent, pushOthers, pushTags);
    const createNote = note();
    const createButton = el('button', { class: 'btn drawer-primary', text: '레포지토리 만들기' });
    const createPanel = el('div', { class: 'drawer-section' },
      caption('소유자'), ownerSelect.element,
      caption('레포지토리 이름'), repoName, repoNameNote, priv,
      caption('원격 이름', NAME_HELP), createRemoteName, createRemoteProblem,
      pushAfter, pushOptions, createNote, createButton);

    const plan = () => {
      const def = defaultSelect.value;
      if (!canPublish || !pushAfter.input.checked || !def) return { branches: [], tags: false };
      const withCurrent = !!current && current !== def && pushCurrent.input.checked;
      return { branches: publishBranches(def, current, withCurrent, pushOthers.input.checked, locals), tags: tagCount > 0 && pushTags.input.checked };
    };

    function validate() {
      const gitHubText = remoteNameProblem(gitHubName.value.trim(), existing);
      gitHubProblem.set(gitHubText);
      gitHubAdd.disabled = busy() || !gitHubName.value.trim() || !!gitHubText || !repoSelect.value;

      const owner = ownerSelect.value;
      const name = repoName.value.trim();
      const already = created && created.full_name.toLowerCase() === `${owner}/${name}`.toLowerCase();
      const nameProblem = already ? null : repoNameProblem(name, owner, known);
      repoNameNote.set(nameProblem === 'exists' ? `${owner} 에 같은 이름의 레포지토리가 이미 있습니다. 있는 레포지토리는 "기존 레포지토리" 에서 고르세요.` : REPO_NAME_PROBLEM[nameProblem] ?? null);
      const remoteText = remoteNameProblem(createRemoteName.value.trim(), existing);
      createRemoteProblem.set(remoteText);
      pushAfter.hidden = !canPublish;
      pushOptions.hidden = !canPublish || !pushAfter.input.checked;
      const def = defaultSelect.value;
      const differs = !!current && !!def && current !== def;
      pushCurrent.hidden = !differs;
      if (differs) pushCurrent.setText(`현재 브랜치 '${current}' 도 올리기`);
      const others = publishBranches(def, current, true, true, locals).length - 1 - (differs ? 1 : 0);
      pushOthers.hidden = others <= 0;
      pushOthers.setText(`다른 로컬 브랜치 ${others}개도 올리기`);
      pushTags.hidden = tagCount <= 0;
      const { branches, tags } = plan();
      const ready = !!owner && !nameProblem && !!createRemoteName.value.trim() && !remoteText && (!canPublish || !pushAfter.input.checked || !!def);
      let preview = null;
      if (ready) {
        preview = `github.com/${owner}/${name} 에 빈 레포지토리를 만들고 원격 '${createRemoteName.value.trim()}' 로 추가합니다.`;
        if (branches.length) preview += `\n올릴 브랜치: ${branches[0]} (기본)${branches.slice(1).map((b) => `, ${b}`).join('')}${tags ? ` · 태그 ${tagCount}개` : ''}`;
      }
      createNote.set(preview);
      createButton.disabled = busy() || !ready;
    }

    function selectMode(create) {
      existingMode.classList.toggle('on', !create);
      createMode.classList.toggle('on', create);
      existingPanel.hidden = create;
      createPanel.hidden = !create;
      validate();
      // 고르기 칸은 포커스만 받아도 목록을 펼쳐 아래 칸을 가리므로, 새로 만들기 쪽 이름 칸에만 포커스를 준다.
      if (create) setTimeout(() => repoName.focus());
    }

    gitHubName.addEventListener('input', () => { nameEdited = true; validate(); });
    createRemoteName.addEventListener('input', validate);
    repoName.addEventListener('input', validate);
    for (const t of [priv, pushAfter, pushCurrent, pushOthers, pushTags]) t.input.addEventListener('change', validate);

    // 원격을 더하고 그 원격만 Fetch 한 뒤 닫는다. 더하기부터 실패했으면 고칠 수 있게 열어 둔다(원본 Add).
    async function add(name, url) {
      if (busy()) return;
      const added = await ctx.act(`원격 '${name}' 를 추가하는 중…`, () => ctx.call('addRemote', { name, url, pushUrl: '' }).then(() => true));
      if (added !== true) { validate(); return; }
      closeDrawer();
      await ctx.act(`'${name}' 에서 Fetch 하는 중…`, () => ctx.call('fetchRemote', { name }), { success: () => `원격 '${name}' 를 추가했습니다.` });
    }
    gitHubAdd.addEventListener('click', () => {
      const repo = known.find((r) => r.full_name === repoSelect.value);
      if (repo && !gitHubAdd.disabled) add(gitHubName.value.trim(), repo.clone_url);
    });

    // 빈 레포지토리를 만들고 → 원격으로 더하고 → 기본 브랜치부터 올리고 → 태그 → 기본 브랜치를 한 번 더 정한다(원본 CreateOnGitHub).
    // 만들기는 됐는데 그 뒤가 실패하면 다시 눌렀을 때 또 만들지 않고 방금 만든 것을 쓴다.
    createButton.addEventListener('click', async () => {
      if (createButton.disabled) return;
      const owner = ownerSelect.value;
      const name = repoName.value.trim();
      const remote = createRemoteName.value.trim();
      const { branches, tags } = plan();
      const ok = await ctx.act(`GitHub 레포지토리 ${owner}/${name} 만드는 중…`, async () => {
        if (!created || created.full_name.toLowerCase() !== `${owner}/${name}`.toLowerCase()) {
          created = await api(owner === me ? '/user/repos' : `/orgs/${owner}/repos`, { method: 'POST', body: { name, private: priv.input.checked } })
            .catch((error) => { throw { ...error, message: `GitHub 레포지토리를 만들지 못했습니다: ${error?.message ?? error}` }; });
        }
        await ctx.call('addRemote', { name: remote, url: created.clone_url, pushUrl: '' });
        for (const b of branches) await ctx.call('pushBranch', { branch: b, remote, setUpstream: !tracked.has(b) });
        if (tags) for (const t of refs.tags) await ctx.call('pushTag', { remote, name: t.name ?? t });
        if (branches.length > 1) {
          await api(`/repos/${created.full_name}`, { method: 'PATCH', body: { default_branch: branches[0] } })
            .catch((error) => console.warn(`GitHub 기본 브랜치를 '${branches[0]}' 로 정하지 못했습니다: ${error?.message ?? error}`));
        }
        return true;
      }, { success: () => `${created.full_name} 를 만들었습니다.` });
      // 원격까지 더해졌으면(뒤의 Push 만 실패해도) 닫는다. 화면이 다시 읽은 원격 목록으로 판단한다.
      await new Promise((r) => setTimeout(r, 300));
      existing = [...(ctx.state.refs?.remotes ?? existing)];
      if (ok === true || existing.includes(remote)) {
        closeDrawer();
        load(true);
      } else validate();
    });

    // 열 때마다 레포지토리 목록과 소유자(내 계정 + 조직)를 다시 읽는다.
    (async () => {
      if (!me) {
        me = await ctx.call('githubStatus').then((st) => st?.login ?? '').catch(() => '');
        if (me) {
          ownerSelect.setItems([{ value: me, label: me, hint: '내 계정' }]);
          ownerSelect.set(me);
        }
      }
      repoNote.set('읽는 중…');
      try {
        known = await api('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member');
        repoSelect.setItems(known.map((r) => ({ value: r.full_name, label: r.full_name, hint: r.private ? '비공개' : '', icon: r.private ? 'lock' : 'github' })));
        repoNote.set(known.length ? null : '이 계정에서 볼 수 있는 레포지토리가 없습니다.');
      } catch (error) {
        repoNote.set(`레포지토리 목록을 읽지 못했습니다: ${error?.message ?? error}`);
      }
      validate();
      const orgs = await api('/user/orgs').catch(() => []);
      const owners = [me, ...orgs.map((o) => o.login).filter((o) => o.toLowerCase() !== me.toLowerCase())].filter(Boolean);
      ownerSelect.setItems(owners.map((o) => ({ value: o, label: o, hint: o === me ? '내 계정' : '' })));
      validate();
    })();

    box.append(modes, existingPanel, createPanel);
    selectMode(false);
    return box;
  }

  return {
    connectScreen, chooseAccount, refreshSignedIn, section, sectionMenu, load, detail, createPull, filterDrawer, remoteForm, footer, login,
    get count() { return count(); },
    get info() { return info; },
    get signedIn() { return signedIn; },
    /** 아래쪽 상태 줄 계정 칸(원본 GitAccounts.ApiLogin — 고른 계정, 없으면 앱 로그인). */
    get account() { return info?.me ?? null; },
    reset() { loadedFor = null; loadToken++; set = null; info = null; },
  };
}
