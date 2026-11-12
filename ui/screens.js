// 큰 창들: clone, 설정(일반·SSL 인증서·로그인), GitHub 가 아닌 서버 로그인.

import { el, githubAvatar } from './util.js';
import { icon } from './icons.js';
import { githubPicker } from './clonepicker.js';
import { sheetHead, sheetBody, sheetFoot, sheetMessage, sheetModes, morph } from './sheet.js';
import { showMenu } from './dialogs.js';
import { LANGUAGES, scoped } from './i18n.js';

/** 이 모듈의 글(locales/en/screens.js 를 먼저 본다). */
const t = scoped('screens');

/** 빈 모달 틀. close(value) 로 닫으면 그 값으로 풀린다. */
function modal(className, build) {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const close = (value) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape' && !document.querySelector('.menu')) {
        event.stopPropagation();
        close(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    const dialog = el('div', { class: `modal ${className}`, role: 'dialog' });
    backdrop.append(dialog);
    document.body.append(backdrop);
    build(dialog, close);
  });
}

function field(label, input, hint) {
  return el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: label }), input, hint ? el('span', { class: 'muted small', text: hint }) : null);
}

function input(value = '', attrs = {}) {
  const node = el('input', { class: 'field', autocomplete: 'off', spellcheck: 'false', ...attrs });
  node.value = value;
  return node;
}

function checkbox(checked, label, hint) {
  const box = el('input', { type: 'checkbox' });
  box.checked = !!checked;
  return { box, row: el('label', { class: 'check modal-check' }, box, label, hint ? el('span', { class: 'muted small', text: ` ${hint}` }) : null) };
}

/**
 * 설정의 git 칸. Rust gitInfo 로 내장·시스템 git 의 자리·버전을 읽어 라디오 세 줄로 보인다.
 * value() 는 setSettings 에 넘길 {gitMode, gitPath}. 직접 지정이 실제로 도는지는 저장할 때 Rust 가 한 번 더 본다.
 */
function gitChoices(call, s) {
  let mode = s.gitMode ?? 'bundled';
  const radios = {};
  const meta = {};
  const notice = el('div', { class: 'small git-notice', hidden: true });
  const path = input(s.gitPath, { placeholder: t('git 실행 파일 경로') });
  const customMeta = el('span', { class: 'git-choice-meta muted small' });
  const browse = el('button', { class: 'btn', text: t('찾아보기…'), onclick: async () => {
    const picked = await call('pick', { kind: 'file', title: t('git 실행 파일') });
    if (picked) { path.value = picked; pick('custom'); check(); }
  } });
  const showVersion = (node, info, missing) => {
    node.classList.toggle('error-text', !!info?.error);
    node.textContent = !info ? missing : info.error ? info.error : info.version;
  };
  let checking = 0;
  const check = async () => {
    const value = path.value.trim();
    const ticket = ++checking;
    if (!value) { showVersion(customMeta, null, t('경로를 고르세요.')); return; }
    customMeta.textContent = t('확인 중…');
    customMeta.classList.remove('error-text');
    const info = await call('checkGit', { path: value }).then((version) => ({ version }), (e) => ({ error: e.message }));
    if (ticket === checking) showVersion(customMeta, info);
  };
  path.addEventListener('change', check);
  path.addEventListener('input', () => pick('custom'));
  const pick = (next) => {
    mode = next;
    for (const [key, radio] of Object.entries(radios)) radio.checked = key === mode;
  };
  const choice = (key, label, extra) => {
    const radio = el('input', { type: 'radio', name: 'git-mode', onchange: () => pick(key) });
    radios[key] = radio;
    meta[key] = el('span', { class: 'git-choice-meta muted small', text: t('확인 중…') });
    const where = el('span', { class: 'git-choice-path muted small' });
    return { radio, where, node: el('div', { class: 'git-choice' },
      el('label', { class: 'check git-choice-head' }, radio, el('span', { class: 'git-choice-label', text: label }), key === 'custom' ? customMeta : meta[key]),
      key === 'custom' ? extra : where) };
  };
  const bundled = choice('bundled', t('내장 git (권장)'));
  const system = choice('system', t('시스템 git'));
  const custom = choice('custom', t('직접 지정'), el('div', { class: 'row git-choice-path' }, path, browse));
  pick(mode);
  check();
  call('gitInfo').then((info) => {
    for (const [key, choiceEl, missing] of [['bundled', bundled, t('이 빌드에는 내장 git 이 없습니다')], ['system', system, t('찾을 수 없음')]]) {
      showVersion(meta[key], info[key], missing);
      choiceEl.where.textContent = info[key]?.path ?? '';
      choiceEl.radio.disabled = !info[key] && mode !== key;
      choiceEl.node.classList.toggle('missing', !info[key]);
    }
    const active = info.active;
    notice.hidden = !active?.fallback;
    notice.textContent = active?.fallback ? t('{fallback} (지금 쓰는 git: {path}{version})', { fallback: active.fallback, path: active.path, version: active.version ? ` · ${active.version}` : '' }) : '';
  }).catch((e) => { meta.bundled.textContent = e.message; });
  return {
    node: el('div', { class: 'git-choices' }, el('span', { class: 'modal-label', text: t('쓸 git') }), bundled.node, system.node, custom.node, notice,
      el('div', { class: 'muted small', text: t('내장 git 은 앱과 함께 배포되는 git(git-lfs·자격 증명 도우미 포함)입니다. 사용자 ~/.gitconfig 는 어느 git 을 골라도 그대로 읽습니다.') })),
    value: () => ({ gitMode: mode, gitPath: path.value.trim() }),
  };
}

/**
 * clone 창. Clone 을 누르면 {clone: {url, dest, name, account, upstream}} 로 바로 닫힌다 — 받기는 작업 목록(jobs.js)이 뒤에서 한다.
 * 이미 받아 둔 것을 고르면 {open: 폴더}, 취소하면 null.
 * GitHub 쪽(로그인한 계정의 레포지토리 목록)과 URL 쪽(주소를 직접 적기)을 위에서 바꾼다. 받을 폴더·이름 칸은 둘이 같이 쓴다.
 * signedIn: 앱 로그인을 했으면 GitHub 쪽으로 연다. login: github.login(Device Flow). busyDests: 지금 받는 중인 받을 곳들.
 */
export function cloneDialog({ call, cloneDir, login, signedIn, busyDests = new Set() }) {
  return modal('sheet wide clone-dialog', (dialog, done) => {
    let mode = signedIn ? 'github' : 'url';
    let picked = null; // GitHub 쪽에서 고른 레포지토리
    const url = input('', { placeholder: t('https://git.company.com/team/game.git 또는 user@nas.local:repos/game.git') });
    const parent = input(cloneDir);
    const name = input('');
    const sep = cloneDir.includes('\\') ? '\\' : '/';
    const target = el('div', { class: 'muted small sheet-target' });
    // 받을 곳에 이미 파일이 있으면 git 이 거절한다 — 누르기 전에 알린다. 묻는 사이 칸이 바뀌면 늦게 온 답은 버린다.
    let occupied = null; // 파일이 있는 받을 곳의 경로
    let destAsked = '';
    const destPath = () => `${parent.value.replace(/[\\/]$/, '')}${sep}${name.value.trim()}`;
    const checkDest = async () => {
      const path = parent.value.trim() && name.value.trim() ? destPath() : '';
      destAsked = path;
      const state = path ? await call('newRepoPath', { path }).catch(() => null) : null;
      if (destAsked !== path) return;
      occupied = state && !state.empty ? path : null;
      validate();
    };
    const updateTarget = () => {
      target.textContent = name.value ? t('받을 곳: {path}', { path: `${parent.value.replace(/[\\/]$/, '')}${sep}${name.value}` }) : '';
      checkDest();
    };
    // 폴더 이름은 사람이 고치지 않았으면(비었거나 지난번에 채운 그대로면) 주소·고른 레포지토리를 따라간다.
    let autoName = '';
    const suggestName = (value) => {
      if (name.value && name.value !== autoName) return;
      name.value = autoName = value;
      updateTarget();
    };
    url.addEventListener('input', async () => {
      const text = url.value.trim();
      suggestName(text ? await call('cloneName', { url: url.value }) : '');
      validate();
    });
    const browse = el('button', {
      class: 'btn', text: t('찾아보기…'),
      onclick: async () => {
        const picked = await call('pick', { kind: 'folder', start: parent.value, title: t('받을 폴더 고르기') });
        if (picked) {
          parent.value = picked;
          updateTarget();
        }
      },
    });

    for (const n of [url, parent, name]) n.addEventListener('input', updateTarget);
    for (const n of [parent, name]) n.addEventListener('input', () => validate());
    const message = sheetMessage();
    const already = el('div', { class: 'clone-already', hidden: true });
    // fork 를 고르면: 원본을 upstream 원격으로 붙일지(기본 켬). 원본의 새 커밋을 받아 오기 쉽게.
    const upstream = checkbox(true, t('원본 레포지토리를 upstream 원격으로 추가'));
    const upstreamHint = el('span', { class: 'muted small' });
    upstream.row.append(upstreamHint);
    upstream.row.classList.add('clone-upstream');
    upstream.row.hidden = true;
    const extra = el('div', { class: 'clone-extra' }, already, upstream.row);
    const ok = el('button', { class: 'btn primary', text: 'Clone' });
    const close = (value) => {
      picker.dispose();
      done(value);
    };

    const picker = githubPicker({
      call, login,
      onSelect: (repo) => {
        picked = repo;
        // 고른 것이 없어지면(걸러져 사라짐 등) 따라 채웠던 이름도 비운다 — 사람이 고친 이름은 그대로.
        suggestName(repo?.name ?? '');
        validate();
      },
      onActivate: () => ok.click(),
      // 찾기 칸에 주소를 붙여 넣었으면 URL 쪽으로 옮겨 그 주소로 받는다.
      onUrl: (text) => {
        setMode('url');
        url.value = text;
        url.dispatchEvent(new Event('input'));
        url.focus();
      },
    });

    const modes = sheetModes([{ value: 'github', label: 'GitHub', icon: 'github' }, { value: 'url', label: 'URL', icon: 'globe' }], (value) => setMode(value, true));
    const urlField = field(t('레포지토리 주소'), url);
    const form = el('div', { class: 'clone-form' },
      sheetHead(t('레포지토리 Clone'), modes.node),
      sheetBody(
        picker.node,
        urlField,
        // 레포지토리를 고를 때마다 창 높이가 출렁이지 않게: "이미 받음" 안내와 upstream 체크는 늘 같은 높이의 한 칸에서 바뀌고,
        // 받을 곳 줄은 비어도 자리를 두며, 안내·오류는 바닥 왼쪽에 보인다.
        extra,
        el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: t('받을 폴더') }), el('div', { class: 'row' }, parent, browse)),
        field(t('폴더 이름'), name),
        target),
      sheetFoot(message, el('button', { class: 'btn', text: t('취소'), onclick: () => close(null) }), ok));

    /** 지금 쪽에서 받을 것: {url, github} 또는 null. 고른 GitHub 레포지토리를 이미 받아 두었으면 local. */
    const source = () => (mode === 'github'
      ? (picked ? { url: picked.url, account: picker.account(), local: picked.local ?? null, parent: picked.parent ?? null } : null)
      : (url.value.trim() ? { url: url.value.trim(), account: null, local: null, parent: null } : null));

    function validate() {
      const src = source();
      already.hidden = !src?.local;
      if (src?.local) already.replaceChildren(icon('check', 14), el('span', { text: t('이미 받아 둔 레포지토리입니다: ') }), el('span', { class: 'clone-already-path', text: src.local }));
      ok.textContent = src?.local ? t('열기') : 'Clone';
      upstream.row.hidden = !src?.parent?.url || !!src?.local;
      upstreamHint.textContent = src?.parent?.fullName ? ` ${src.parent.fullName}` : '';
      // 이미 받은 것을 열 때는 폴더 칸이 쓰이지 않는다.
      for (const n of [parent, name, browse]) n.disabled = !!src?.local;
      // 모자란 것이 있으면 바닥에 알리고 주 버튼을 잠근다(레포지토리 만들기 창과 같다).
      const reason = src?.local ? ''
        : !src ? (mode === 'github' ? t('받을 레포지토리를 고르세요.') : t('레포지토리 주소를 적어 주세요.'))
          : !parent.value.trim() ? t('받을 폴더를 정해 주세요.')
            : !name.value.trim() ? t('폴더 이름을 적어 주세요.')
              : busyDests.has(destPath()) ? t('이 자리로 이미 받는 중입니다. 폴더 이름을 바꾸거나 다른 곳을 고르세요.')
                : occupied === destPath() ? t('받을 곳에 이미 파일이 있습니다. 폴더 이름을 바꾸거나 다른 곳을 고르세요.') : '';
      message.say(reason);
      ok.disabled = !!reason;
    }

    function setMode(next, focus = false) {
      if (next === mode && dialog.contains(form)) {
        if (focus) (mode === 'github' ? picker.focus() : url.focus());
        return;
      }
      const change = () => {
        mode = next;
        modes.set(mode);
        picker.hideCard();
        picker.node.hidden = mode !== 'github';
        extra.hidden = mode !== 'github';
        urlField.hidden = mode !== 'url';
        // 폴더 이름도 이 쪽의 것으로.
        suggestName(mode === 'github' ? (picked?.name ?? '') : name.value === autoName ? '' : name.value);
        if (mode === 'url' && url.value.trim()) url.dispatchEvent(new Event('input'));
        validate();
      };
      if (dialog.contains(form)) morph(dialog, change);
      else change();
      if (focus) (mode === 'github' ? picker.focus() : url.focus());
    }

    ok.addEventListener('click', async () => {
      picker.hideCard();
      const src = source();
      if (src?.local) {
        close({ open: src.local });
        return;
      }
      validate();
      if (ok.disabled) return;
      const upstreamUrl = src.parent?.url && upstream.box.checked ? src.parent.url : null;
      close({ clone: { url: src.url, dest: destPath(), name: name.value.trim(), account: src.account, upstream: upstreamUrl } });
    });
    setMode(mode);
    dialog.append(form);
    if (mode === 'github') picker.focus();
    else url.focus();
  });
}

/** 로그인 창. 넣었으면 true. target: {kind:'ssh'|'https', host, user} */
export function loginDialog({ call, target, reason }) {
  return modal('', (dialog, close) => {
    const ssh = target.kind === 'ssh';
    const host = input(target.host ?? '', { readonly: !!target.host });
    const user = input(target.user ?? '', { readonly: ssh && !!target.user, placeholder: ssh ? t('원격 주소의 계정') : t('사용자 이름') });
    const password = input('', { type: 'password', placeholder: ssh ? t('SSH 계정 비밀번호') : t('비밀번호 또는 액세스 토큰') });
    const error = el('div', { class: 'modal-error', hidden: true });
    const submit = async () => {
      if (!password.value) {
        error.textContent = t('비밀번호를 적어 주세요.');
        error.hidden = false;
        return;
      }
      try {
        await call('remoteLogin', { kind: target.kind, protocol: target.protocol ?? 'https', host: host.value, user: user.value, password: password.value });
        close(true);
      } catch (e) {
        error.textContent = e?.message ?? String(e);
        error.hidden = false;
      }
    };
    password.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) submit(); });
    dialog.append(
      el('div', { class: 'modal-title', text: ssh ? t('SSH 서버 로그인') : t('서버 로그인') }),
      el('div', { class: 'modal-message', text: reason }),
      field(t('서버'), host),
      field(ssh ? t('계정') : t('사용자 이름'), user),
      field(t('비밀번호'), password, ssh
        ? t('비밀번호는 앱을 끌 때까지만 기억하고 파일에 쓰지 않습니다. 처음 접속하는 서버면 그 서버를 신뢰 목록에 넣습니다.')
        : t('이 PC 의 자격 증명 저장소(키체인·자격 증명 관리자)에 넣어, 다음부터 git 이 스스로 씁니다.')),
      error,
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', text: t('취소'), onclick: () => close(false) }), el('button', { class: 'btn primary', text: t('로그인하고 다시 시도'), onclick: submit })));
    (target.host ? password : host).focus();
  });
}

const PULL_MODES = [
  { value: 'ffOnly', label: t('앞으로 감기만 (기본)') },
  { value: 'merge', label: t('병합') },
  { value: 'rebase', label: 'Rebase' },
];

function select(options, value) {
  const node = el('select', { class: 'field' }, options.map((o) => el('option', { value: o.value, text: o.label })));
  node.value = value;
  return node;
}

/**
 * 설정 화면. 바꾼 설정을 돌려준다(닫으면 null). 왼쪽 구역: 일반 · 동기화 · diff · 그래프 · 오류 표시 · SSL 인증서 · git · 로그인.
 * Rust 가 쓰는 값(테마·풀 방식·자동 페치·SSL·git 경로)은 setSettings, 화면만 쓰는 값은 prefs(설정 파일의 ui).
 */
export function settingsDialog({ call, settings, onTheme, showError, toast, section, prefs, graph, onPrefs, githubLogin }) {
  return modal('sheet settings', async (dialog, close) => {
    const s = structuredClone(settings);
    const p = (key, fallback) => prefs?.get(key) ?? fallback;
    const windows = s.platform === 'windows';
    const mac = s.platform === 'macos';

    // ── 일반
    const theme = select([{ value: 'dark', label: t('다크') }, { value: 'light', label: t('라이트') }, { value: 'system', label: t('시스템 따르기') }], s.theme);
    theme.addEventListener('change', () => onTheme(theme.value));
    const layout = select([{ value: 'gitkraken', label: 'GitKraken' }, { value: 'fork', label: 'Fork' }, { value: 'unity', label: 'Unity VCS' }], p('layout', 'gitkraken'));
    const explorer = select([{ value: 'fork', label: 'Fork' }, { value: 'unity', label: 'Unity VCS' }], p('explorer', 'fork'));
    // 언어 이름은 그 언어로 적는다(어느 언어 화면에서도 자기 언어를 찾게).
    const language = select(LANGUAGES, p('language', 'ko'));
    const scale = select([60, 70, 80, 90, 100, 110, 125, 150, 175, 200].map((n) => ({ value: String(n / 100), label: `${n}%` })), String(p('ui.scale', 1)));
    const fontSize = select([12, 13, 14, 15, 16].map((n) => ({ value: String(n), label: `${n}px` })), String(p('ui.fontSize', 13)));

    // ── 동기화
    const autoFetchOn = checkbox(s.autoFetchMinutes > 0, t('자동 페치'));
    // 원본 GitAutoFetch: 1~120분.
    const autoFetch = input(String(Math.min(120, s.autoFetchMinutes || 10)), { type: 'number', min: 1, max: 120 });
    autoFetchOn.box.addEventListener('change', () => { autoFetch.disabled = !autoFetchOn.box.checked; });
    autoFetch.disabled = !autoFetchOn.box.checked;
    const pullMode = select(PULL_MODES, s.pullMode);
    const focusRefresh = checkbox(p('sync.focusRefresh', true), t('창에 포커스가 오면 새로고침'));
    const watch = checkbox(p('sync.watch', true), t('파일 감시 (편집기 저장·터미널 git 을 바로 반영)'));

    // ── diff
    const diffView = select([{ value: 'hunk', label: t('Hunk — 바뀐 곳과 앞뒤 몇 줄') }, { value: 'inline', label: t('Inline — 파일 전체') }, { value: 'split', label: t('Split — 파일 전체를 나란히') }], p('diff.view', 'hunk'));
    const context = input(String(p('diff.context', 3)), { type: 'number', min: 0, max: 100 });
    const ignoreWs = checkbox(p('diff.ignoreWhitespace', false), t('공백 바뀜 무시'), t('(켜면 줄 단위 Stage 를 끕니다)'));
    const algorithm = select([{ value: '', label: t('git 기본값') }, { value: 'myers', label: 'Myers' }, { value: 'minimal', label: 'Minimal' }, { value: 'patience', label: 'Patience' }, { value: 'histogram', label: 'Histogram' }], p('diff.algorithm', ''));
    const editor = input(p('editor', ''), { placeholder: t('code -g {file}:{line}  (비우면 VS Code, 없으면 기본 프로그램)') });
    const difftool = input(p('difftool', ''), { placeholder: t('비우면 git 설정의 diff.tool (예: opendiff, bc, meld)') });

    // ── 그래프
    const avatars = checkbox(p('graph.avatars', true), t('작성자 사진(아바타)'), t('— GitHub·Gravatar 에서 받아 디스크에 7일 둡니다'));
    const count = input(String(p('graph.count', 5000)), { type: 'number', min: 500, max: 100000, step: 500 });
    const stopRebase = checkbox(p('rebase.stop', true), t('Rebase 충돌 때 멈추기'), t('— 끄면 충돌 시 시작 전으로 되돌립니다'));

    // ── 오류 표시
    const errorMode = select([{ value: 'friendly', label: t('설명 (원인·해결)') }, { value: 'raw', label: t('git 원문') }], p('error.mode', 'friendly'));

    // ── SSL
    const verify = checkbox(s.ssl.verify, t('인증서 확인'), t('(끄면 회사 프록시 인증서 문제는 사라지지만 안전하지 않습니다)'));
    verify.box.addEventListener('change', async () => {
      if (verify.box.checked) return updateSsl();
      // 끄기 전에 한 번 더 확인한다.
      const { confirmDialog } = await import('./dialogs.js');
      if (!(await confirmDialog({ title: t('인증서 확인 끄기'), danger: true, message: t('서버 인증서를 확인하지 않으면 중간에서 가로챈 연결도 받아들입니다. 회사 루트 인증서 파일을 지정하는 쪽을 먼저 권합니다. 그래도 끌까요?'), ok: t('끄기') }))) verify.box.checked = true;
      updateSsl();
    });
    const caFile = input(s.ssl.caFile, { placeholder: t('회사 루트 인증서 PEM 파일 (비우면 git 기본값)') });
    const browseCa = el('button', {
      class: 'btn', text: t('찾아보기…'),
      onclick: async () => {
        const picked = await call('pick', { kind: 'file', title: t('인증서 파일 고르기'), filters: [{ name: t('인증서'), ext: ['pem', 'crt', 'cer'] }, { name: t('모든 파일'), ext: ['*'] }] });
        if (picked) caFile.value = picked;
      },
    });
    const systemStore = checkbox(s.ssl.useSystemStore, t('Windows 인증서 저장소 쓰기 (schannel)'), t('— 회사 인증서를 Windows 에 깔았으면 켜세요'));
    const skipRevoke = checkbox(s.ssl.skipRevocationCheck, t('인증서 해지 확인 끄기'), t('— schannel 이 "해지 확인을 할 수 없음" 으로 실패할 때'));
    const keychain = mac ? el('button', {
      class: 'btn', text: t('키체인 인증서로 CA 파일 만들기'),
      onclick: async () => {
        try {
          caFile.value = await call('exportKeychain');
          toast(t('키체인의 인증서를 모아 CA 파일을 만들었습니다.'), 'success');
        } catch (e) {
          showError(e);
        }
      },
    }) : null;
    const testUrl = input('', { placeholder: t('비우면 열린 레포지토리의 원격') });
    const testResult = el('div', { class: 'small' });
    const sslState = () => ({ verify: verify.box.checked, caFile: caFile.value.trim(), useSystemStore: systemStore.box.checked, skipRevocationCheck: skipRevoke.box.checked });
    function updateSsl() {
      const off = !verify.box.checked;
      for (const node of [caFile, browseCa, systemStore.box, skipRevoke.box]) node.disabled = off;
      skipRevoke.box.disabled = off || !systemStore.box.checked;
      caFile.disabled = off || (windows && systemStore.box.checked);
      browseCa.disabled = caFile.disabled;
    }
    systemStore.box.addEventListener('change', updateSsl);
    updateSsl();
    const testButton = el('button', {
      class: 'btn', text: t('연결 테스트'),
      onclick: async () => {
        testResult.className = 'small muted';
        testResult.textContent = t('붙어 보는 중…');
        try {
          // 테스트는 지금 화면의 SSL 값으로 한다 — 먼저 저장한다.
          await call('setSettings', { ssl: sslState() });
          const r = await call('testConnection', { url: testUrl.value });
          testResult.className = 'small success-text';
          testResult.textContent = t('연결됐습니다: {url} (브랜치 {n}개)', { url: r.url, n: r.branches });
        } catch (e) {
          testResult.className = 'small error-text';
          testResult.textContent = `${e.ssl ? t('SSL 인증서 문제입니다. ') : e.login || e.auth ? t('로그인이 필요합니다(연결 자체는 됨). ') : ''}${e.message}`;
        }
      },
    });

    // ── git: 내장(기본) · 시스템 · 직접 지정. 각 칸에 자리와 버전을 보이고, 직접 지정은 고르자마자 실제로 돌려 본다.
    const git = gitChoices(call, s);

    // ── 로그인: GitHub 계정 카드 + SSH 키. 네트워크를 쓰므로 로그인 페이지를 처음 볼 때 읽는다(loadLogin).
    const sshInfo = el('div', { class: 'row' });
    const renderSsh = () => {
      sshInfo.replaceChildren(...[s.sshLogin
        ? el('span', { text: t('SSH: {login} 의 비밀번호를 기억하는 중 (앱을 끄면 잊습니다)', { login: s.sshLogin }) })
        : el('span', { class: 'muted small', text: t('기억한 SSH 비밀번호가 없습니다. 비밀번호를 받는 서버에 접속하면 로그인 창이 뜹니다.') }),
      s.sshLogin ? el('button', { class: 'btn', text: t('잊기'), onclick: async () => { await call('forgetSshLogin'); s.sshLogin = null; renderSsh(); } }) : null].filter(Boolean));
    };
    renderSsh();
    const SOURCES = { app: t('앱 로그인'), credential: t('자격 증명') };
    const signIn = async () => {
      if (!githubLogin) return;
      await githubLogin.dialog();
      renderGithub();
      renderKeys();
    };
    const githubAccounts = el('div', { class: 'gh-accounts' });
    const renderGithub = async () => {
      githubAccounts.replaceChildren(el('div', { class: 'gh-card loading' }, el('span', { class: 'muted small', text: t('GitHub 계정을 읽는 중…') })));
      const accounts = await call('githubAccounts').catch(() => null);
      if (!accounts) {
        githubAccounts.replaceChildren(el('span', { class: 'muted small', text: t('GitHub 계정 정보를 읽지 못했습니다.') }));
        return;
      }
      const cards = accounts.map((a) => el('div', { class: 'gh-card' },
        githubAvatar(a.login, { url: a.avatarUrl, size: 'large' }),
        el('div', { class: 'gh-card-who' },
          el('div', { class: 'gh-card-name', text: a.name || a.login }),
          el('div', { class: 'gh-card-login muted small', text: `@${a.login}` })),
        el('div', { class: 'gh-card-state' },
          el('span', { class: 'gh-status ok' }, icon('check', 12), el('span', { text: t('연결됨') })),
          el('div', { class: 'gh-badges' },
            el('span', { class: 'gh-badge', text: SOURCES[a.source] ?? a.source }),
            a.inUse ? el('span', { class: 'gh-badge accent', text: t('이 레포에서 사용 중') }) : null,
            a.canAccess === false ? el('span', { class: 'gh-badge warn', text: t('이 레포를 읽을 수 없음') }) : null)),
        a.source === 'app'
          ? el('button', { class: 'btn danger', text: t('로그아웃'), onclick: async () => { await call('githubLogout', { login: a.login }); renderGithub(); renderKeys(); } })
          : el('span', { class: 'muted small gh-card-note', text: t('자격 증명 저장소에서 지웁니다') })));
      const hasApp = accounts.some((a) => a.source === 'app');
      githubAccounts.replaceChildren(...[
        ...(cards.length ? cards : [el('div', { class: 'gh-card empty' },
          el('span', { class: 'cgh-avatar large' }, icon('github', 20)),
          el('div', { class: 'gh-card-who' }, el('div', { class: 'gh-card-name', text: t('GitHub 에 연결되지 않음') }), el('div', { class: 'muted small', text: t('로그인하면 비공개 레포지토리를 받고 SSH 키를 올릴 수 있습니다.') })),
          el('button', { class: 'btn primary', text: t('GitHub 로그인'), onclick: signIn }))]),
        cards.length && !hasApp ? el('div', { class: 'row' }, el('button', { class: 'btn', text: t('앱으로 GitHub 로그인'), onclick: signIn })) : null,
      ].filter(Boolean)); // replaceChildren 은 null 을 "null" 글로 넣는다.
    };

    // SSH 키. 고른 키(sshKey)는 저장할 때 반영한다. 만들기·올리기는 누르면 바로 한다.
    let sshKey = s.sshKey ?? '';
    const sshKeys = el('div', { class: 'ssh-keys' });
    const keyTitle = input('', { placeholder: t('(선택) 새 SSH 키의 이름 — 비우면 Ramus (사용자 이름)') });
    const keyMessage = el('div', { class: 'small', hidden: true });
    const note = (text, kind = 'muted') => { keyMessage.hidden = !text; keyMessage.className = `small ${kind}`; keyMessage.textContent = text ?? ''; };
    const generate = el('button', { class: 'btn success' });
    const busy = async (button, work) => {
      button.disabled = true;
      try { await work(); } catch (e) { note(e.message ?? String(e), 'error-text'); } finally { button.disabled = false; }
    };
    const usePicked = async (path, publicPath = '') => {
      const key = await call('sshKeyRead', { path, public: publicPath });
      sshKey = key.path;
      note(t('{name} 을(를) 고르셨습니다. 저장하면 앱이 부르는 git 이 이 키를 씁니다.', { name: key.name }));
      renderKeys();
    };
    const browsePrivate = el('button', { class: 'btn', text: t('개인 키 찾아보기…'), onclick: () => busy(browsePrivate, async () => {
      const picked = await call('pick', { kind: 'file', title: t('SSH 개인 키 고르기') });
      if (!picked) return;
      try {
        await usePicked(picked);
      } catch (e) {
        // 옆에 .pub 가 없고 암호가 걸린 키 — 공개 키를 따로 고르게 한다.
        note(t('{error} 아래 "공개 키 찾아보기…" 로 골라 주세요.', { error: e.message ?? e }), 'error-text');
        browsePublic.hidden = false;
        browsePublic.dataset.private = picked;
      }
    }) });
    const browsePublic = el('button', { class: 'btn', text: t('공개 키 찾아보기…'), hidden: true, onclick: () => busy(browsePublic, async () => {
      const picked = await call('pick', { kind: 'file', title: t('SSH 공개 키(.pub) 고르기'), filters: [{ name: t('공개 키'), ext: ['pub'] }, { name: t('모든 파일'), ext: ['*'] }] });
      if (!picked) return;
      await usePicked(browsePublic.dataset.private, picked);
      browsePublic.hidden = true;
    }) });
    let keyInfo = null;
    const renderKeys = async () => {
      sshKeys.replaceChildren(el('span', { class: 'muted small', text: t('SSH 키를 읽는 중…') }));
      keyInfo = await call('sshKeys').catch((e) => ({ error: e.message ?? String(e) }));
      if (keyInfo.error) {
        sshKeys.replaceChildren(el('span', { class: 'muted small', text: t('SSH 키를 읽지 못했습니다: {error}', { error: keyInfo.error }) }));
        return;
      }
      const canUpload = keyInfo.signedIn && !keyInfo.missingScopes.length;
      generate.textContent = canUpload ? t('만들어서 GitHub 에 올리기') : t('만들기');
      generate.disabled = !keyInfo.keygen;
      const upload = (k, button) => busy(button, async () => {
        await call('sshKeyUpload', { path: k.path });
        toast(t('{name} 을(를) GitHub({login})에 올렸습니다.', { name: k.name, login: keyInfo.login }), 'success');
        renderKeys();
      });
      const rows = keyInfo.keys.map((k) => {
        const chosen = sshKey === k.path;
        const up = el('button', { class: 'btn small', text: t('GitHub 에 올리기') });
        up.onclick = () => upload(k, up);
        return el('div', { class: `ssh-key${chosen ? ' on' : ''}` },
          icon('lock', 16),
          el('div', { class: 'ssh-key-who' },
            el('div', { class: 'ssh-key-name' }, el('span', { text: k.name }), el('span', { class: 'muted small', text: k.kind })),
            el('div', { class: 'muted small ssh-key-fp', text: [k.fingerprint, k.comment].filter(Boolean).join(' · ') || k.path })),
          el('div', { class: 'gh-badges' },
            k.onGithub === true ? el('span', { class: 'gh-badge ok', text: t('GitHub 에 등록됨') }) : null,
            chosen ? el('span', { class: 'gh-badge accent', text: t('앱이 사용 중') }) : null),
          canUpload && k.onGithub === false ? up : null,
          el('button', { class: 'btn small', text: chosen ? t('쓰지 않기') : t('이 키 쓰기'), onclick: () => { sshKey = chosen ? '' : k.path; note(chosen ? t('저장하면 ssh 설정(~/.ssh/config·ssh-agent)을 그대로 따릅니다.') : t('저장하면 앱이 부르는 git 이 {name} 을(를) 씁니다.', { name: k.name })); renderKeys(); } }));
      });
      sshKeys.replaceChildren(...[
        el('div', { class: 'muted small', text: sshKey ? t('앱이 부르는 git 은 고른 키만 씁니다(-i {key}).', { key: sshKey }) : t('고른 키가 없으면 ssh 설정(~/.ssh/config·ssh-agent)을 그대로 따릅니다.') }),
        ...(rows.length ? rows : [el('div', { class: 'muted', text: t('SSH 키가 없습니다. 아래에서 새로 만들 수 있습니다.') })]),
        keyInfo.signedIn && keyInfo.missingScopes.length
          ? el('div', { class: 'row ssh-scope' }, icon('warning', 14), el('span', { class: 'small', text: t('지금 로그인으로는 SSH 키를 GitHub 에 올릴 수 없습니다(권한 부족).') }), el('button', { class: 'btn small primary', text: t('권한 추가 — 다시 로그인'), onclick: signIn }))
          : null,
        keyInfo.keygen ? null : el('div', { class: 'small error-text', text: t('ssh-keygen 을 찾지 못해 키를 만들 수 없습니다. OpenSSH 를 깔아 주세요.') }),
      ].filter(Boolean));
    };
    generate.onclick = () => busy(generate, async () => {
      const upload = keyInfo?.signedIn && !keyInfo.missingScopes.length;
      const key = await call('sshKeyGenerate', { title: keyTitle.value.trim(), upload });
      keyTitle.value = '';
      sshKey = key.path;
      if (key.uploadError) note(t('{name} 을(를) 만들었지만 올리지 못했습니다: {error}', { name: key.name, error: key.uploadError }), 'error-text');
      else note(upload ? t('{path} 을(를) 만들었습니다. GitHub 에도 올렸습니다. 저장하면 앱이 이 키를 씁니다.', { path: key.path }) : t('{path} 을(를) 만들었습니다. 저장하면 앱이 이 키를 씁니다.', { path: key.path }));
      renderKeys();
    });
    let loginLoaded = false;
    const loadLogin = () => {
      if (loginLoaded) return;
      loginLoaded = true;
      renderGithub();
      renderKeys();
    };

    const save = async () => {
      const minutes = autoFetchOn.box.checked ? Math.max(1, Math.min(120, parseInt(autoFetch.value, 10) || 10)) : 0;
      try {
        const saved = await call('setSettings', {
          theme: theme.value, pullMode: pullMode.value, diffLayout: diffView.value === 'split' ? 'split' : 'inline', autoFetchMinutes: minutes, ...git.value(), ssl: sslState(), sshKey,
        });
        const values = {
          layout: layout.value, explorer: explorer.value, language: language.value, 'ui.scale': Number(scale.value), 'ui.fontSize': Number(fontSize.value),
          'sync.focusRefresh': focusRefresh.box.checked, 'sync.watch': watch.box.checked,
          'diff.view': diffView.value, 'diff.context': Math.max(0, Math.min(100, Number.isNaN(parseInt(context.value, 10)) ? 3 : parseInt(context.value, 10))), 'diff.ignoreWhitespace': ignoreWs.box.checked,
          'diff.algorithm': algorithm.value, editor: editor.value.trim(), difftool: difftool.value.trim(),
          'graph.avatars': avatars.box.checked, 'graph.count': Math.max(500, parseInt(count.value, 10) || 5000), 'rebase.stop': stopRebase.box.checked, 'error.mode': errorMode.value,
        };
        for (const [key, value] of Object.entries(values)) prefs?.set(key, value);
        saved.ui = { ...(saved.ui ?? {}), ...values };
        onPrefs?.(values);
        close(saved);
      } catch (e) {
        showError(e);
      }
    };

    const sectionEl = (id, title, ...children) => el('section', { class: 'settings-section', 'data-section': id }, el('h3', { text: title }), children);
    const sections = [
      sectionEl('general', t('일반'), field(t('테마'), theme), field(t('배치'), layout), field(t('탐색기 모양'), explorer), field(t('언어'), language), el('div', { class: 'row' }, field(t('UI 배율'), scale), field(t('글꼴 크기'), fontSize))),
      sectionEl('sync', t('동기화'), autoFetchOn.row, field(t('자동 페치 간격 (분)'), autoFetch, t('자동 fetch 사이의 시간(1~120분). 손으로 Fetch 하면 그때부터 다시 셉니다.')), field(t('풀 방식'), pullMode), focusRefresh.row, watch.row),
      sectionEl('diff', 'diff', field(t('기본 보기'), diffView), field(t('Hunk 보기의 문맥 줄 수'), context), ignoreWs.row, field(t('diff 알고리즘'), algorithm), field(t('외부 편집기'), editor, t('{file} 과 {line} 은 파일 경로와 줄 번호로 바뀝니다.')), field(t('외부 diff 도구'), difftool)),
      sectionEl('graph', t('그래프'), avatars.row, field(t('처음 읽는 커밋 수'), count, t('끝에 닿으면 더 읽습니다.')), stopRebase.row),
      sectionEl('errors', t('오류 표시'), field(t('오류 대화상자 기본값'), errorMode)),
      sectionEl('ssl', t('SSL 인증서 (회사망)'),
        el('div', { class: 'muted small', text: t('회사 보안 프록시가 SSL 을 가로채면 git 이 "SSL certificate problem" 으로 실패합니다. 여기 설정은 앱이 부르는 git 에만 붙고(-c), 사용자 .gitconfig 는 바꾸지 않습니다.') }),
        verify.row, windows ? systemStore.row : null, windows ? skipRevoke.row : null,
        el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: t('CA 인증서 파일') }), el('div', { class: 'row' }, caFile, browseCa)),
        keychain ? el('div', { class: 'row' }, keychain) : null, el('div', { class: 'row' }, testUrl, testButton), testResult),
      sectionEl('git', 'git', git.node),
      sectionEl('login', t('로그인'),
        el('div', { class: 'modal-label', text: 'GitHub' }), githubAccounts,
        el('div', { class: 'modal-label', text: t('SSH 키') }), sshKeys,
        el('div', { class: 'ssh-form' },
          el('span', { class: 'ssh-form-label', text: t('새 SSH 키 만들기') }), el('div', { class: 'ssh-form-body' }, keyTitle, el('div', { class: 'row' }, generate)),
          el('span', { class: 'ssh-form-label', text: t('가진 키 고르기') }), el('div', { class: 'ssh-form-body' }, el('div', { class: 'row' }, browsePrivate, browsePublic))),
        keyMessage,
        el('div', { class: 'modal-label', text: t('GitHub 가 아닌 서버') }), sshInfo,
        el('div', { class: 'muted small', text: t('https 서버(사내 GitLab 등)의 계정은 이 PC 의 자격 증명 저장소에 들어갑니다. 지우려면 키체인 접근·자격 증명 관리자에서 지워 주세요.') })),
    ];
    const body = el('div', { class: 'settings-body' }, sections);
    // 왼쪽 목록은 페이지 넘김: 고른 칸 하나만 오른쪽에 보이고, 나머지는 숨긴다(한 줄로 이어 스크롤하지 않는다).
    const show = (active) => {
      sections.forEach((sec, i) => { sec.hidden = i !== active; });
      if (sections[active].dataset.section === 'login') loadLogin();
      nav.querySelectorAll('.settings-tab').forEach((b, i) => b.classList.toggle('on', i === active));
      body.scrollTop = 0;
    };
    const nav = el('nav', { class: 'settings-nav' }, sections.map((sec, i) => el('button', {
      class: 'settings-tab', text: sec.querySelector('h3').textContent,
      onclick: () => show(i),
    })));
    dialog.append(
      sheetHead(t('설정')),
      sheetBody(el('div', { class: 'settings-layout' }, nav, body)),
      sheetFoot(sheetMessage(), el('button', { class: 'btn', text: t('취소'), onclick: () => close(null) }), el('button', { class: 'btn primary', text: t('저장'), onclick: save })));
    show(Math.max(0, sections.findIndex((sec) => sec.dataset.section === section)));
  });
}

/**
 * 탭 막대(GitKraken 모양). tabs: [{path, name}], active: 지금 열린 경로(없으면 null).
 * macOS 는 이 막대가 창 제목 막대를 겸한다 — 빈 곳을 끌면 창이 움직이고, 두 번 누르면 창을 키운다.
 */
export function renderTabs(container, { tabs, active, onOpen, onClose, onNew, onBrowse, extra = null }) {
  container.replaceChildren(
    el('button', { class: 'tab-folder', 'data-tip': t('레포지토리 열기…'), onclick: onBrowse }, icon('folder', 16)),
    ...tabs.map((tab) => el('div', {
      class: `tab${tab.path === active ? ' active' : ''}`,
      onclick: () => tab.path !== active && onOpen(tab.path),
      onauxclick: (event) => { if (event.button === 1) onClose(tab.path); },
      oncontextmenu: (event) => {
        event.preventDefault();
        showMenu(event.clientX, event.clientY, [
          { label: t('탭 닫기'), action: () => onClose(tab.path) },
          { label: t('경로 복사'), action: () => navigator.clipboard?.writeText(tab.path) },
        ]);
      },
    }, icon('branch', 14, 'tab-icon'),
    el('span', { class: 'tab-name', text: tab.name }),
    el('button', { class: 'tab-close', 'aria-label': t('탭 닫기'), onclick: (event) => { event.stopPropagation(); onClose(tab.path); } }, icon('close', 10)))),
    el('button', { class: `tab-new${active ? '' : ' active'}`, 'data-tip': t('새 탭 — 레포지토리 열기·Clone'), onclick: onNew }, icon('plus', 16)),
    el('div', { class: 'tabs-drag' }),
    // 오른쪽 끝: 원격 작업 버튼(jobs.js). 늘 같은 노드를 다시 붙인다.
    ...(extra ? [extra] : []));
}

/** macOS: 탭 막대의 빈 곳(막대 자체·끝의 여백)을 끌면 창을 옮기고, 두 번 누르면 창을 키운다. */
export function bindTitlebar(container, call) {
  const empty = (event) => event.target === container || event.target.classList?.contains('tabs-drag');
  container.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.detail > 1 || !empty(event)) return;
    call('windowDrag').catch(() => {});
  });
  container.addEventListener('dblclick', (event) => {
    if (empty(event)) call('windowZoom').catch(() => {});
  });
}
