// 레포지토리 만들기 창(원본에 없음 · 확장). GitKraken 의 "Initialize a Repository" 처럼 왼쪽에 [로컬만][GitHub.com], 오른쪽에 그 양식.
// 로컬만: 폴더 만들기 → git init → .gitignore·LICENSE → (LFS) → 첫 커밋 → 새 탭.
// GitHub.com: GitHub 에 만들기 → (만든 뒤 clone) → 새 탭. clone 하지 않으면 주소를 알리고 브라우저로 열 수 있게 한다.

import { el, isComposing } from './util.js';
import { icon } from './icons.js';
import { searchSelect, confirmDialog } from './dialogs.js';

const COPYRIGHT = { value: 'copyright', label: 'Copyright (C) [year] [name]' };
/** 내장 틀에만 있는 이름(GitHub 에는 없다 — GitHub 에 만들 때는 뺀다). */
const BUILTIN_ONLY = new Set(['Basic']);
/** 쓰는 동안 폴더 상태를 묻는 간격(ms). */
const PATH_CHECK_MS = 150;

/** 레포지토리 목록·본문은 앱이 켜져 있는 동안 Rust 가 기억한다. 화면도 한 번 받은 목록을 다시 쓴다. */
let templatesCache = null;

const splitParts = (path) => path.replace(/[\\/]+$/, '').split(/[\\/]/);
const parentOf = (path) => {
  const trimmed = path.replace(/[\\/]+$/, '');
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return at <= 0 ? trimmed.slice(0, at + 1) : trimmed.slice(0, at);
};
const sepOf = (path) => (path.includes('\\') && !path.includes('/') ? '\\' : '/');
const join = (dir, name) => {
  const base = dir.trim().replace(/[\\/]+$/, '');
  return name.trim() ? `${base}${sepOf(dir)}${name.trim()}` : base;
};

/** 폴더 이름으로 쓸 수 없는 이름이면 그 까닭. */
function folderNameProblem(name) {
  if (/[\\/]/.test(name)) return '이름에 / 나 \\ 는 쓸 수 없습니다.';
  if (name === '.' || name === '..') return '쓸 수 없는 이름입니다.';
  return '';
}

/**
 * 레포지토리 만들기 창. 만들어 연 레포지토리 정보를 돌려준다(새 탭으로 여는 것은 부른 쪽 enterRepo). 닫거나 clone 하지 않았으면 null.
 * ctx: { call, state, prefs, login(github.login — Device Flow), showError, toast }
 * preset.path: 시작 화면의 "git init…" 처럼 정해진 폴더 — 로컬 탭을 그 폴더로 채우고, 그 폴더는 비어 있지 않아도(.git 만 없으면) 만든다.
 */
export function newRepoDialog(ctx, preset = {}) {
  const { call, state, prefs } = ctx;
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const box = el('div', { class: 'modal newrepo', role: 'dialog' });
    let busy = false;
    let closed = false;
    const cleanups = [];
    const close = (value) => {
      if (closed) return;
      closed = true;
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      cleanups.forEach((f) => f());
      resolve(value);
    };

    // ── 기본값 ──
    const repoParent = state.repo?.path ? parentOf(state.repo.path) : '';
    const presetPath = preset.path ? preset.path.replace(/[\\/]+$/, '') : '';
    const localDir = presetPath ? parentOf(presetPath) : (prefs.get('newRepo.dir') || repoParent || state.settings.cloneDir || '');
    const cloneDir = state.settings.cloneDir || prefs.get('newRepo.dir') || repoParent || '';

    // ── 공통 부품 ──
    const row = (label, control, extra) => [el('label', { class: 'newrepo-label', text: label }), el('div', { class: 'newrepo-control' }, control, extra ?? null)];
    const text = (value = '', attrs = {}) => {
      const node = el('input', { class: 'field', autocomplete: 'off', spellcheck: 'false', ...attrs });
      node.value = value;
      return node;
    };
    const check = (checked, label) => {
      const box = el('input', { type: 'checkbox' });
      box.checked = box.defaultChecked = checked;
      return { box, node: el('label', { class: 'check' }, box, label) };
    };
    const browseButton = (target, title, after) => el('button', {
      class: 'btn', text: '찾아보기',
      onclick: async () => {
        const picked = await call('pick', { kind: 'folder', start: target.value, title }).catch(() => null);
        if (picked) {
          target.value = picked;
          after();
        }
      },
    });
    const okButton = (label) => el('button', { class: 'btn newrepo-ok', text: label });
    const setBusy = (button, on, label) => {
      button.disabled = on;
      button.replaceChildren(...(on ? [el('span', { class: 'spinner' }), el('span', { text: '만드는 중…' })] : [label]));
    };
    /** 폴더 상태(Rust). 앱을 다시 켜기 전이라 명령이 없으면 null(검사를 건너뛴다). */
    const pathState = (path) => call('newRepoPath', { path }).catch(() => null);
    const pathProblem = (info, allowExisting) => {
      if (!info) return '';
      if (info.exists && !info.isDir) return '같은 이름의 파일이 있습니다.';
      if (info.hasGit) return '이미 git 레포지토리인 폴더입니다.';
      if (!info.empty && !allowExisting) return '이미 파일이 있는 폴더입니다. 다른 이름이나 위치를 고르세요.';
      return '';
    };
    const templateSelects = [];
    const licenseSelects = [];
    const gitignoreSelect = (githubOnly) => {
      const s = searchSelect({ items: [], value: null, placeholder: '없음', clearable: true });
      templateSelects.push({ s, githubOnly });
      return s;
    };
    const licenseSelect = () => {
      const s = searchSelect({ items: [COPYRIGHT], value: null, placeholder: '없음', clearable: true });
      licenseSelects.push(s);
      return s;
    };

    // ── 로컬만 ──
    const local = (() => {
      const name = text(presetPath ? splitParts(presetPath).pop() : '', { placeholder: '레포지토리 이름' });
      const dir = text(localDir, { placeholder: '만들 위치' });
      const full = text('', { readonly: true, tabindex: '-1' });
      const branch = text('', { placeholder: 'main' });
      const gitignore = gitignoreSelect(false);
      const license = licenseSelect();
      const lfs = check(false, 'LFS 로 초기화');
      const problem = el('div', { class: 'newrepo-problem' });
      const ok = okButton('레포지토리 만들기');
      let reason = '';
      let checkId = 0;
      let timer = 0;
      const update = () => {
        full.value = join(dir.value, name.value);
        const n = name.value.trim();
        reason = !n ? '레포지토리 이름을 적어 주세요.' : folderNameProblem(n) || (!dir.value.trim() ? '만들 위치를 정해 주세요.' : '');
        problem.textContent = reason;
        ok.disabled = busy || !!reason;
        clearTimeout(timer);
        if (reason) return;
        const id = ++checkId;
        const path = full.value;
        timer = setTimeout(async () => {
          const info = await pathState(path);
          if (id !== checkId) return;
          reason = pathProblem(info, !!presetPath && path === presetPath);
          problem.textContent = reason;
          ok.disabled = busy || !!reason;
        }, PATH_CHECK_MS);
      };
      for (const node of [name, dir]) node.addEventListener('input', update);
      const submit = async () => {
        update();
        if (reason || busy) return;
        const path = full.value;
        // 마지막 폴더 검사가 아직이면 지금 한 번 더(Rust 도 다시 확인한다).
        const late = pathProblem(await pathState(path), !!presetPath && path === presetPath);
        if (late) {
          reason = late;
          problem.textContent = late;
          ok.disabled = true;
          return;
        }
        busy = true;
        setBusy(ok, true);
        try {
          const repo = await call('createLocalRepo', {
            path, branch: branch.value.trim(), gitignore: gitignore.value ?? '', license: license.value ?? '', lfs: lfs.box.checked,
            allowExisting: !!presetPath && path === presetPath,
          });
          if (!presetPath) prefs.set('newRepo.dir', dir.value.trim());
          if (repo.warning) ctx.toast(`레포지토리는 만들었지만 ${repo.warning}`, 'warning');
          else ctx.toast(`${repo.name} 레포지토리를 만들었습니다.`, 'success');
          close(repo);
        } catch (error) {
          busy = false;
          setBusy(ok, false, '레포지토리 만들기');
          update();
          ctx.showError(error, '레포지토리를 만들지 못했습니다');
        }
      };
      ok.addEventListener('click', submit);
      const pane = el('div', { class: 'newrepo-pane' },
        el('div', { class: 'newrepo-grid' },
          ...row('이름', name),
          ...row('만들 위치', el('div', { class: 'newrepo-inline' }, dir, browseButton(dir, '레포지토리를 만들 위치', update))),
          ...row('전체 경로', full),
          ...row('기본 브랜치 이름', branch),
          ...row('.gitignore 템플릿', gitignore.element),
          ...row('라이선스', license.element),
          el('span'), el('div', { class: 'newrepo-control' }, lfs.node)),
        el('div', { class: 'newrepo-foot' }, problem, ok));
      update();
      return { pane, submit, focus: () => (name.value ? dir : name).focus() };
    })();

    // ── GitHub.com ──
    const hub = (() => {
      let info = null; // {signedIn, login, avatarUrl, orgs, missingScopes}
      const account = searchSelect({ items: [], value: null, placeholder: '계정', onChange: () => update() });
      const accountArea = el('div', { class: 'newrepo-account' });
      const name = text('', { placeholder: '레포지토리 이름' });
      const description = text('', { placeholder: '(선택)' });
      const visibility = el('div', { class: 'newrepo-radios' });
      const radio = (value, label) => {
        const input = el('input', { type: 'radio', name: 'newrepo-visibility', value });
        return { input, node: el('label', { class: 'check' }, input, label) };
      };
      const publicRadio = radio('public', '공개');
      const privateRadio = radio('private', '비공개');
      privateRadio.input.checked = privateRadio.input.defaultChecked = true;
      visibility.append(publicRadio.node, privateRadio.node);
      const cloneAfter = check(true, '만든 뒤 클론');
      const dir = text(cloneDir, { placeholder: '클론할 위치' });
      const browse = browseButton(dir, '클론할 위치', () => update());
      const prefix = el('span', { class: 'newrepo-prefix' });
      const folder = text('', { placeholder: '폴더 이름' });
      const branch = text('', { placeholder: 'main' });
      const gitignore = gitignoreSelect(true);
      const license = licenseSelect();
      const lfs = check(false, 'LFS 로 초기화');
      const problem = el('div', { class: 'newrepo-problem' });
      const ok = okButton('레포지토리 만들고 클론');
      let folderTouched = false;
      let reason = '';
      let checkId = 0;
      let timer = 0;
      folder.addEventListener('input', () => { folderTouched = !!folder.value.trim(); update(); });
      name.addEventListener('input', () => {
        if (!folderTouched) folder.value = name.value.trim();
        update();
      });
      dir.addEventListener('input', () => update());
      cloneAfter.box.addEventListener('change', () => update());
      const okLabel = () => (cloneAfter.box.checked ? '레포지토리 만들고 클론' : '레포지토리 만들기');
      function update() {
        const cloning = cloneAfter.box.checked;
        for (const node of [dir, browse, folder]) node.disabled = !cloning || busy;
        lfs.box.disabled = !cloning;
        lfs.node.classList.toggle('disabled', !cloning);
        // 긴 경로는 앞을 줄인다(rtl 상자) — LRM 으로 감싸 '/' 가 엉뚱한 쪽으로 가지 않게.
        const parentText = `${dir.value.trim().replace(/[\\/]+$/, '')}${sepOf(dir.value)}`;
        prefix.textContent = `\u200E${parentText}\u200E`;
        prefix.dataset.tip = parentText;
        if (!busy) setBusy(ok, false, okLabel());
        const n = name.value.trim();
        reason = !info ? '계정을 읽는 중…'
          : !info.signedIn ? 'GitHub 에 로그인해 주세요.'
          : !n ? '레포지토리 이름을 적어 주세요.'
            : /[^A-Za-z0-9._-]/.test(n) ? 'GitHub 레포지토리 이름에는 영문·숫자·. _ - 만 쓸 수 있습니다.'
              : !cloning ? ''
                : !dir.value.trim() ? '클론할 위치를 정해 주세요.'
                  : !folder.value.trim() ? '폴더 이름을 적어 주세요.'
                    : folderNameProblem(folder.value.trim());
        problem.textContent = reason;
        ok.disabled = busy || !!reason;
        clearTimeout(timer);
        if (reason || !cloning) return;
        const id = ++checkId;
        const path = join(dir.value, folder.value);
        timer = setTimeout(async () => {
          const state = await pathState(path);
          if (id !== checkId) return;
          reason = pathProblem(state, false);
          problem.textContent = reason;
          ok.disabled = busy || !!reason;
        }, PATH_CHECK_MS);
      }

      // 로그인(설정·연결 화면과 같은 Device Flow). 창 안에서 코드를 보이고 승인하면 계정을 다시 읽는다.
      const login = ctx.login;
      const loginBox = el('div', { class: 'newrepo-login' });
      const drawLogin = (again) => {
        const running = login.running;
        const waiting = login.step === 'waiting';
        loginBox.replaceChildren(...[
          !running ? el('button', { class: 'btn newrepo-signin', onclick: () => login.dialog() }, icon('github', 14), again ? '다시 로그인' : 'GitHub 로 로그인') : null,
          running && !waiting ? el('span', { class: 'muted small', text: 'GitHub 에 로그인 코드를 요청하는 중…' }) : null,
          waiting ? el('div', { class: 'newrepo-code' },
            el('span', { class: 'newrepo-code-text', text: login.code ?? '' }),
            el('button', { class: 'btn small', text: login.openedPage ? 'GitHub 페이지 다시 열기' : '코드 복사하고 GitHub 열기', onclick: () => login.openPage() }),
            el('button', { class: 'btn small', text: '취소', onclick: () => login.cancel() })) : null,
          waiting ? el('div', { class: 'muted small', text: '열린 GitHub 페이지에 코드를 붙여넣고 승인하면 자동으로 이어집니다.' }) : null,
          login.step === 'failed' ? el('div', { class: 'newrepo-warn', text: `로그인하지 못했습니다: ${login.error}` }) : null,
        ].filter(Boolean));
      };
      let wasRunning = false;
      cleanups.push(login.on(() => {
        drawAccount();
        // 승인이 끝났으면(돌던 로그인이 멈추고 실패가 아니면) 계정을 다시 읽는다.
        if (wasRunning && !login.running && login.step === 'idle') load();
        wasRunning = login.running;
      }));

      function drawAccount() {
        if (!info) {
          accountArea.replaceChildren(el('span', { class: 'muted small', text: '계정을 읽는 중…' }));
          return;
        }
        if (!info.signedIn) {
          drawLogin(false);
          accountArea.replaceChildren(loginBox);
          return;
        }
        const missing = info.missingScopes ?? [];
        if (missing.length) drawLogin(true);
        accountArea.replaceChildren(...[account.element,
          missing.length ? el('div', { class: 'newrepo-warn' },
            `로그인 권한이 모자랍니다(${missing.join(', ')}). 다시 로그인하면 조직 목록을 보고 조직에 레포지토리를 만들 수 있습니다.`) : null,
          missing.length ? loginBox : null].filter(Boolean));
      }

      async function load() {
        info = null;
        drawAccount();
        update();
        try {
          info = await call('githubCreateInfo');
        } catch (error) {
          info = { signedIn: false };
          accountArea.replaceChildren(el('div', { class: 'newrepo-warn', text: `계정을 읽지 못했습니다: ${error?.message ?? error}` }));
          update();
          return;
        }
        if (info.signedIn) {
          const avatar = (url) => (url ? `${url}${url.includes('?') ? '&' : '?'}s=40` : null);
          account.setItems([
            { value: '', label: info.login, image: avatar(info.avatarUrl), icon: 'user' },
            ...(info.orgs ?? []).map((o) => ({ value: o.login, label: o.login, image: avatar(o.avatarUrl), icon: 'github', hint: '조직' })),
          ]);
          account.set('');
        }
        drawAccount();
        update();
      }

      const submit = async () => {
        update();
        if (reason || busy) return;
        const cloning = cloneAfter.box.checked;
        const dest = join(dir.value, folder.value);
        if (cloning) {
          const late = pathProblem(await pathState(dest), false);
          if (late) {
            reason = late;
            problem.textContent = late;
            ok.disabled = true;
            return;
          }
        }
        busy = true;
        setBusy(ok, true);
        let created;
        try {
          created = await call('githubCreateRepo', {
            owner: account.value ?? '', name: name.value.trim(), description: description.value.trim(), private: privateRadio.input.checked,
            gitignore: gitignore.value ?? '', license: license.value ?? '', branch: branch.value.trim(), lfs: cloning && lfs.box.checked,
          });
        } catch (error) {
          busy = false;
          update();
          ctx.showError(error, 'GitHub 에 레포지토리를 만들지 못했습니다');
          return;
        }
        if (created.warning) ctx.toast(created.warning, 'warning');
        if (!cloning) {
          close(null);
          if (await confirmDialog({ title: 'GitHub 에 레포지토리를 만들었습니다', message: created.htmlUrl, ok: '브라우저로 열기', cancel: '닫기', glyph: 'github' })) {
            call('openUrl', { url: created.htmlUrl }).catch(ctx.showError);
          }
          return;
        }
        try {
          const repo = await call('githubCloneNew', { url: created.cloneUrl, dest, branch: branch.value.trim(), empty: created.empty, lfs: lfs.box.checked });
          ctx.toast(`${created.fullName} 를 만들고 받았습니다.`, 'success');
          close(repo);
        } catch (error) {
          close(null);
          ctx.toast(`${created.fullName} 는 GitHub 에 만들었지만 받지 못했습니다. ${created.htmlUrl}`, 'warning');
          ctx.showError(error, '만든 레포지토리를 클론하지 못했습니다');
        }
      };
      ok.addEventListener('click', submit);

      const pane = el('div', { class: 'newrepo-pane' },
        el('div', { class: 'newrepo-grid' },
          ...row('계정', accountArea),
          ...row('이름', name),
          ...row('설명', description),
          ...row('공개 범위', visibility),
          el('span'), el('div', { class: 'newrepo-control' }, cloneAfter.node),
          ...row('클론할 위치', el('div', { class: 'newrepo-inline' }, dir, browse)),
          ...row('전체 경로', el('div', { class: 'newrepo-inline newrepo-path' }, prefix, folder)),
          ...row('기본 브랜치 이름', branch),
          ...row('.gitignore 템플릿', gitignore.element),
          ...row('라이선스', license.element),
          el('span'), el('div', { class: 'newrepo-control' }, lfs.node)),
        el('div', { class: 'newrepo-foot' }, problem, ok));
      let loaded = false;
      return {
        pane, submit,
        focus: () => (info?.signedIn ? name : accountArea.querySelector('button') ?? name).focus(),
        show() {
          if (loaded) return;
          loaded = true;
          load();
        },
      };
    })();

    // ── 틀 ──
    const TABS = [
      { id: 'local', label: '로컬만', glyph: 'laptop', form: local },
      { id: 'github', label: 'GitHub.com', glyph: 'github', form: hub },
    ];
    let tab = presetPath ? 'local' : (prefs.get('newRepo.tab') === 'github' ? 'github' : 'local');
    const nav = el('div', { class: 'newrepo-nav' });
    const body = el('div', { class: 'newrepo-panes' });
    const select = (id, focus = true) => {
      tab = id;
      if (!presetPath) prefs.set('newRepo.tab', id);
      nav.replaceChildren(...TABS.map((t) => el('button', { class: `newrepo-tab${t.id === tab ? ' on' : ''}`, onclick: () => select(t.id) }, icon(t.glyph, 16), el('span', { text: t.label }))));
      for (const t of TABS) t.form.pane.hidden = t.id !== tab;
      const form = TABS.find((t) => t.id === tab).form;
      form.show?.();
      if (focus) form.focus();
    };
    body.append(local.pane, hub.pane);
    box.append(
      el('div', { class: 'newrepo-head' },
        el('div', { class: 'modal-title', text: '레포지토리 만들기' }),
        el('button', { class: 'card-close', 'data-tip': '닫기', onclick: () => { if (!busy) close(null); } }, icon('close', 14))),
      el('div', { class: 'newrepo-body' }, nav, body));
    backdrop.append(box);
    document.body.append(backdrop);

    const onKey = (event) => {
      // 위에 다른 카드(오류 등)가 떠 있으면 그쪽 키다.
      const top = [...document.querySelectorAll('.modal-backdrop')].pop();
      if (top !== backdrop) return;
      // 고르기 칸의 목록이 열려 있으면 Esc·Enter 는 목록 몫이다.
      if (event.target instanceof Element && event.target.closest('.search-select.open')) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        if (!busy) close(null);
      } else if (event.key === 'Enter' && !isComposing(event)) {
        if (event.target instanceof HTMLButtonElement) return;
        event.preventDefault();
        TABS.find((t) => t.id === tab).form.submit();
      }
    };
    document.addEventListener('keydown', onKey, true);

    select(tab);

    // 템플릿·라이선스 목록(GitHub API, 앱이 켜져 있는 동안 기억). 인터넷이 안 되면 내장 .gitignore 틀만, 라이선스는 끈다.
    (async () => {
      const list = templatesCache ?? await call('newRepoTemplates').catch(() => null);
      if (closed) return;
      if (list?.online) templatesCache = list;
      const names = list?.gitignore ?? ['Basic', 'Node', 'Rust', 'Unity'];
      for (const { s, githubOnly } of templateSelects) {
        s.setItems(names.filter((n) => !(githubOnly && BUILTIN_ONLY.has(n))).map((n) => ({ value: n, label: n })));
      }
      for (const s of licenseSelects) {
        if (list?.online) s.setItems([COPYRIGHT, ...list.licenses.map((l) => ({ value: l.key, label: l.name }))]);
        else {
          s.setItems([]);
          s.setDisabled(true);
          s.element.querySelector('.ss-input').placeholder = '인터넷에 연결되지 않아 고를 수 없습니다';
        }
      }
    })();
  });
}
