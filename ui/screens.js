// 큰 창들: clone, 설정(일반·SSL 인증서·로그인), GitHub 가 아닌 서버 로그인.

import { el } from './util.js';
import { icon } from './icons.js';
import { onProgress } from './progress.js';
import { cloneStage } from './clonestage.js';
import { githubPicker } from './clonepicker.js';
import { sheetHead, sheetBody, sheetFoot, sheetMessage, sheetModes, morph } from './sheet.js';
import { showMenu } from './dialogs.js';

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
      // locked: 되돌릴 수 없는 일(Clone 등)이 도는 동안은 닫지 않는다.
      if (event.key === 'Escape' && !document.querySelector('.menu') && !dialog.classList.contains('locked')) {
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
  const path = input(s.gitPath, { placeholder: 'git 실행 파일 경로' });
  const customMeta = el('span', { class: 'git-choice-meta muted small' });
  const browse = el('button', { class: 'btn', text: '찾아보기…', onclick: async () => {
    const picked = await call('pick', { kind: 'file', title: 'git 실행 파일' });
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
    if (!value) { showVersion(customMeta, null, '경로를 고르세요.'); return; }
    customMeta.textContent = '확인 중…';
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
    meta[key] = el('span', { class: 'git-choice-meta muted small', text: '확인 중…' });
    const where = el('span', { class: 'git-choice-path muted small' });
    return { radio, where, node: el('div', { class: 'git-choice' },
      el('label', { class: 'check git-choice-head' }, radio, el('span', { class: 'git-choice-label', text: label }), key === 'custom' ? customMeta : meta[key]),
      key === 'custom' ? extra : where) };
  };
  const bundled = choice('bundled', '내장 git (권장)');
  const system = choice('system', '시스템 git');
  const custom = choice('custom', '직접 지정', el('div', { class: 'row git-choice-path' }, path, browse));
  pick(mode);
  check();
  call('gitInfo').then((info) => {
    for (const [key, choiceEl, missing] of [['bundled', bundled, '이 빌드에는 내장 git 이 없습니다'], ['system', system, '찾을 수 없음']]) {
      showVersion(meta[key], info[key], missing);
      choiceEl.where.textContent = info[key]?.path ?? '';
      choiceEl.radio.disabled = !info[key] && mode !== key;
      choiceEl.node.classList.toggle('missing', !info[key]);
    }
    const active = info.active;
    notice.hidden = !active?.fallback;
    notice.textContent = active?.fallback ? `${active.fallback} (지금 쓰는 git: ${active.path}${active.version ? ` · ${active.version}` : ''})` : '';
  }).catch((e) => { meta.bundled.textContent = e.message; });
  return {
    node: el('div', { class: 'git-choices' }, el('span', { class: 'modal-label', text: '쓸 git' }), bundled.node, system.node, custom.node, notice,
      el('div', { class: 'muted small', text: '내장 git 은 앱과 함께 배포되는 git(git-lfs·자격 증명 도우미 포함)입니다. 사용자 ~/.gitconfig 는 어느 git 을 골라도 그대로 읽습니다.' })),
    value: () => ({ gitMode: mode, gitPath: path.value.trim() }),
  };
}

/**
 * clone 창. 받으면 열린 레포지토리 정보, 이미 받아 둔 것을 고르면 {open: 폴더}, 취소하면 null.
 * GitHub 쪽(로그인한 계정의 레포지토리 목록)과 URL 쪽(주소를 직접 적기)을 위에서 바꾼다. 받을 폴더·이름 칸은 둘이 같이 쓴다.
 * signedIn: 앱 로그인을 했으면 GitHub 쪽으로 연다. login: github.login(Device Flow).
 */
export function cloneDialog({ call, cloneDir, withLogin, showError, login, signedIn }) {
  return modal('sheet wide clone-dialog', (dialog, done) => {
    let mode = signedIn ? 'github' : 'url';
    let picked = null; // GitHub 쪽에서 고른 레포지토리
    const url = input('', { placeholder: 'https://git.company.com/team/game.git 또는 user@nas.local:repos/game.git' });
    const parent = input(cloneDir);
    const name = input('');
    const sep = cloneDir.includes('\\') ? '\\' : '/';
    const target = el('div', { class: 'muted small sheet-target' });
    const updateTarget = () => { target.textContent = name.value ? `받을 곳: ${parent.value.replace(/[\\/]$/, '')}${sep}${name.value}` : ''; };
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
      class: 'btn', text: '찾아보기…',
      onclick: async () => {
        const picked = await call('pick', { kind: 'folder', start: parent.value, title: '받을 폴더 고르기' });
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
    const upstream = checkbox(true, '원본 레포지토리를 upstream 원격으로 추가');
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
    const urlField = field('레포지토리 주소', url);
    const form = el('div', { class: 'clone-form' },
      sheetHead('레포지토리 Clone', modes.node),
      sheetBody(
        picker.node,
        urlField,
        // 레포지토리를 고를 때마다 창 높이가 출렁이지 않게: "이미 받음" 안내와 upstream 체크는 늘 같은 높이의 한 칸에서 바뀌고,
        // 받을 곳 줄은 비어도 자리를 두며, 안내·오류는 바닥 왼쪽에 보인다.
        extra,
        el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: '받을 폴더' }), el('div', { class: 'row' }, parent, browse)),
        field('폴더 이름', name),
        target),
      sheetFoot(message, el('button', { class: 'btn', text: '취소', onclick: () => close(null) }), ok));

    /** 지금 쪽에서 받을 것: {url, github} 또는 null. 고른 GitHub 레포지토리를 이미 받아 두었으면 local. */
    const source = () => (mode === 'github'
      ? (picked ? { url: picked.url, account: picker.account(), local: picked.local ?? null, parent: picked.parent ?? null } : null)
      : (url.value.trim() ? { url: url.value.trim(), account: null, local: null, parent: null } : null));

    function validate() {
      const src = source();
      already.hidden = !src?.local;
      if (src?.local) already.replaceChildren(icon('check', 14), el('span', { text: '이미 받아 둔 레포지토리입니다: ' }), el('span', { class: 'clone-already-path', text: src.local }));
      ok.textContent = src?.local ? '열기' : 'Clone';
      upstream.row.hidden = !src?.parent?.url || !!src?.local;
      upstreamHint.textContent = src?.parent?.fullName ? ` ${src.parent.fullName}` : '';
      // 이미 받은 것을 열 때는 폴더 칸이 쓰이지 않는다.
      for (const n of [parent, name, browse]) n.disabled = !!src?.local;
      // 모자란 것이 있으면 바닥에 알리고 주 버튼을 잠근다(레포지토리 만들기 창과 같다).
      const reason = src?.local ? ''
        : !src ? (mode === 'github' ? '받을 레포지토리를 고르세요.' : '레포지토리 주소를 적어 주세요.')
          : !parent.value.trim() ? '받을 폴더를 정해 주세요.'
            : !name.value.trim() ? '폴더 이름을 적어 주세요.' : '';
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
      const dest = `${parent.value.replace(/[\\/]$/, '')}${sep}${name.value.trim()}`;
      // 받는 동안 폼을 걷고 진행 무대를 띄운다 — 큰 레포지토리는 오래 걸린다. git 에는 멈추는 길이 없어 닫지 못하게 한다.
      const stage = cloneStage({ name: name.value.trim(), where: dest });
      dialog.classList.add('locked');
      morph(dialog, () => { form.hidden = true; dialog.append(stage.node); });
      const stop = onProgress(stage.update);
      try {
        const upstreamUrl = src.parent?.url && upstream.box.checked ? src.parent.url : null;
        const repo = await withLogin(() => call('clone', { url: src.url, dest, account: src.account, upstream: upstreamUrl }));
        stop();
        await stage.finish();
        dialog.closest('.modal-backdrop')?.classList.add('leaving');
        setTimeout(() => close(repo), 260);
      } catch (e) {
        stop();
        stage.dispose();
        dialog.classList.remove('locked');
        morph(dialog, () => { stage.node.remove(); form.hidden = false; });
        showError(e);
      }
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
    const user = input(target.user ?? '', { readonly: ssh && !!target.user, placeholder: ssh ? '원격 주소의 계정' : '사용자 이름' });
    const password = input('', { type: 'password', placeholder: ssh ? 'SSH 계정 비밀번호' : '비밀번호 또는 액세스 토큰' });
    const error = el('div', { class: 'modal-error', hidden: true });
    const submit = async () => {
      if (!password.value) {
        error.textContent = '비밀번호를 적어 주세요.';
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
      el('div', { class: 'modal-title', text: ssh ? 'SSH 서버 로그인' : '서버 로그인' }),
      el('div', { class: 'modal-message', text: reason }),
      field('서버', host),
      field(ssh ? '계정' : '사용자 이름', user),
      field('비밀번호', password, ssh
        ? '비밀번호는 앱을 끌 때까지만 기억하고 파일에 쓰지 않습니다. 처음 접속하는 서버면 그 서버를 신뢰 목록에 넣습니다.'
        : '이 PC 의 자격 증명 저장소(키체인·자격 증명 관리자)에 넣어, 다음부터 git 이 스스로 씁니다.'),
      error,
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', text: '취소', onclick: () => close(false) }), el('button', { class: 'btn primary', text: '로그인하고 다시 시도', onclick: submit })));
    (target.host ? password : host).focus();
  });
}

const PULL_MODES = [
  { value: 'ffOnly', label: '앞으로 감기만 (기본)' },
  { value: 'merge', label: '병합' },
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
export function settingsDialog({ call, settings, onTheme, showError, toast, section, prefs, graph, onPrefs }) {
  return modal('sheet settings', async (dialog, close) => {
    const s = structuredClone(settings);
    const p = (key, fallback) => prefs?.get(key) ?? fallback;
    const windows = s.platform === 'windows';
    const mac = s.platform === 'macos';

    // ── 일반
    const theme = select([{ value: 'dark', label: 'JetBrains 다크' }, { value: 'light', label: 'JetBrains 라이트' }, { value: 'system', label: '시스템 따르기' }], s.theme);
    theme.addEventListener('change', () => onTheme(theme.value));
    const layout = select([{ value: 'gitkraken', label: 'GitKraken' }, { value: 'fork', label: 'Fork' }, { value: 'unity', label: 'Unity VCS' }], p('layout', 'gitkraken'));
    const explorer = select([{ value: 'fork', label: 'Fork' }, { value: 'unity', label: 'Unity VCS' }], p('explorer', 'fork'));
    const language = select([{ value: 'ko', label: '한국어' }, { value: 'en', label: 'English (준비 중)' }], p('language', 'ko'));
    language.querySelector('option[value="en"]').disabled = true;
    const scale = select([60, 70, 80, 90, 100, 110, 125, 150, 175, 200].map((n) => ({ value: String(n / 100), label: `${n}%` })), String(p('ui.scale', 1)));
    const fontSize = select([12, 13, 14, 15, 16].map((n) => ({ value: String(n), label: `${n}px` })), String(p('ui.fontSize', 13)));

    // ── 동기화
    const autoFetchOn = checkbox(s.autoFetchMinutes > 0, '자동 페치');
    // 원본 GitAutoFetch: 1~120분.
    const autoFetch = input(String(Math.min(120, s.autoFetchMinutes || 10)), { type: 'number', min: 1, max: 120 });
    autoFetchOn.box.addEventListener('change', () => { autoFetch.disabled = !autoFetchOn.box.checked; });
    autoFetch.disabled = !autoFetchOn.box.checked;
    const pullMode = select(PULL_MODES, s.pullMode);
    const focusRefresh = checkbox(p('sync.focusRefresh', true), '창에 포커스가 오면 새로고침');
    const watch = checkbox(p('sync.watch', true), '파일 감시 (편집기 저장·터미널 git 을 바로 반영)');

    // ── diff
    const diffView = select([{ value: 'hunk', label: 'Hunk — 바뀐 곳과 앞뒤 몇 줄' }, { value: 'inline', label: 'Inline — 파일 전체' }, { value: 'split', label: 'Split — 파일 전체를 나란히' }], p('diff.view', 'hunk'));
    const context = input(String(p('diff.context', 3)), { type: 'number', min: 0, max: 100 });
    const ignoreWs = checkbox(p('diff.ignoreWhitespace', false), '공백 바뀜 무시', '(켜면 줄 단위 Stage 를 끕니다)');
    const algorithm = select([{ value: '', label: 'git 기본값' }, { value: 'myers', label: 'Myers' }, { value: 'minimal', label: 'Minimal' }, { value: 'patience', label: 'Patience' }, { value: 'histogram', label: 'Histogram' }], p('diff.algorithm', ''));
    const editor = input(p('editor', ''), { placeholder: 'code -g {file}:{line}  (비우면 VS Code, 없으면 기본 프로그램)' });
    const difftool = input(p('difftool', ''), { placeholder: '비우면 git 설정의 diff.tool (예: opendiff, bc, meld)' });

    // ── 그래프
    const avatars = checkbox(p('graph.avatars', true), '작성자 사진(아바타)', '— GitHub·Gravatar 에서 받아 디스크에 7일 둡니다');
    const count = input(String(p('graph.count', 5000)), { type: 'number', min: 500, max: 100000, step: 500 });
    const stopRebase = checkbox(p('rebase.stop', true), 'Rebase 충돌 때 멈추기', '— 끄면 충돌 시 시작 전으로 되돌립니다');

    // ── 오류 표시
    const errorMode = select([{ value: 'friendly', label: '설명 (원인·해결)' }, { value: 'raw', label: 'git 원문' }], p('error.mode', 'friendly'));

    // ── SSL
    const verify = checkbox(s.ssl.verify, '인증서 확인', '(끄면 회사 프록시 인증서 문제는 사라지지만 안전하지 않습니다)');
    verify.box.addEventListener('change', async () => {
      if (verify.box.checked) return updateSsl();
      // 끄기 전에 한 번 더 확인한다.
      const { confirmDialog } = await import('./dialogs.js');
      if (!(await confirmDialog({ title: '인증서 확인 끄기', danger: true, message: '서버 인증서를 확인하지 않으면 중간에서 가로챈 연결도 받아들입니다. 회사 루트 인증서 파일을 지정하는 쪽을 먼저 권합니다. 그래도 끌까요?', ok: '끄기' }))) verify.box.checked = true;
      updateSsl();
    });
    const caFile = input(s.ssl.caFile, { placeholder: '회사 루트 인증서 PEM 파일 (비우면 git 기본값)' });
    const browseCa = el('button', {
      class: 'btn', text: '찾아보기…',
      onclick: async () => {
        const picked = await call('pick', { kind: 'file', title: '인증서 파일 고르기', filters: [{ name: '인증서', ext: ['pem', 'crt', 'cer'] }, { name: '모든 파일', ext: ['*'] }] });
        if (picked) caFile.value = picked;
      },
    });
    const systemStore = checkbox(s.ssl.useSystemStore, 'Windows 인증서 저장소 쓰기 (schannel)', '— 회사 인증서를 Windows 에 깔았으면 켜세요');
    const skipRevoke = checkbox(s.ssl.skipRevocationCheck, '인증서 해지 확인 끄기', '— schannel 이 "해지 확인을 할 수 없음" 으로 실패할 때');
    const keychain = mac ? el('button', {
      class: 'btn', text: '키체인 인증서로 CA 파일 만들기',
      onclick: async () => {
        try {
          caFile.value = await call('exportKeychain');
          toast('키체인의 인증서를 모아 CA 파일을 만들었습니다.', 'success');
        } catch (e) {
          showError(e);
        }
      },
    }) : null;
    const testUrl = input('', { placeholder: '비우면 열린 레포지토리의 원격' });
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
      class: 'btn', text: '연결 테스트',
      onclick: async () => {
        testResult.className = 'small muted';
        testResult.textContent = '붙어 보는 중…';
        try {
          // 테스트는 지금 화면의 SSL 값으로 한다 — 먼저 저장한다.
          await call('setSettings', { ssl: sslState() });
          const r = await call('testConnection', { url: testUrl.value });
          testResult.className = 'small success-text';
          testResult.textContent = `연결됐습니다: ${r.url} (브랜치 ${r.branches}개)`;
        } catch (e) {
          testResult.className = 'small error-text';
          testResult.textContent = `${e.ssl ? 'SSL 인증서 문제입니다. ' : e.login || e.auth ? '로그인이 필요합니다(연결 자체는 됨). ' : ''}${e.message}`;
        }
      },
    });

    // ── git: 내장(기본) · 시스템 · 직접 지정. 각 칸에 자리와 버전을 보이고, 직접 지정은 고르자마자 실제로 돌려 본다.
    const git = gitChoices(call, s);

    // ── 로그인
    const sshInfo = el('div', { class: 'row' });
    const renderSsh = () => {
      sshInfo.replaceChildren(...[s.sshLogin
        ? el('span', { text: `SSH: ${s.sshLogin} 의 비밀번호를 기억하는 중 (앱을 끄면 잊습니다)` })
        : el('span', { class: 'muted', text: '기억한 SSH 로그인이 없습니다. 비밀번호를 받는 서버에 접속하면 로그인 창이 뜹니다.' }),
      s.sshLogin ? el('button', { class: 'btn', text: '잊기', onclick: async () => { await call('forgetSshLogin'); s.sshLogin = null; renderSsh(); } }) : null].filter(Boolean));
    };
    renderSsh();
    const githubAccounts = el('div', { class: 'gh-accounts' });
    const renderGithub = async () => {
      const accounts = await call('githubAccounts').catch(() => null);
      if (!accounts) {
        githubAccounts.replaceChildren(el('span', { class: 'muted small', text: 'GitHub 계정 정보를 읽지 못했습니다.' }));
        return;
      }
      githubAccounts.replaceChildren(...(accounts.length ? accounts.map((a) => el('div', { class: 'row' },
        el('span', { text: `${a.login}${a.source === 'app' ? '' : ` (${a.source})`}` }),
        a.source === 'app' ? el('button', { class: 'btn', text: '로그아웃', onclick: async () => { await call('githubLogout', { login: a.login }); renderGithub(); } }) : null))
        : [el('span', { class: 'muted small', text: '로그인한 GitHub 계정이 없습니다. ⋮ 메뉴 > GitHub 로그인 으로 연결하세요.' })]));
    };
    renderGithub();

    const save = async () => {
      const minutes = autoFetchOn.box.checked ? Math.max(1, Math.min(120, parseInt(autoFetch.value, 10) || 10)) : 0;
      try {
        const saved = await call('setSettings', {
          theme: theme.value, pullMode: pullMode.value, diffLayout: diffView.value === 'split' ? 'split' : 'inline', autoFetchMinutes: minutes, ...git.value(), ssl: sslState(),
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
      sectionEl('general', '일반', field('테마', theme), field('배치', layout), field('탐색기 모양', explorer), field('언어', language), el('div', { class: 'row' }, field('UI 배율', scale), field('글꼴 크기', fontSize))),
      sectionEl('sync', '동기화', autoFetchOn.row, field('자동 페치 간격 (분)', autoFetch, '자동 fetch 사이의 시간(1~120분). 손으로 Fetch 하면 그때부터 다시 셉니다.'), field('풀 방식', pullMode), focusRefresh.row, watch.row),
      sectionEl('diff', 'diff', field('기본 보기', diffView), field('Hunk 보기의 문맥 줄 수', context), ignoreWs.row, field('diff 알고리즘', algorithm), field('외부 편집기', editor, '{file} 과 {line} 은 파일 경로와 줄 번호로 바뀝니다.'), field('외부 diff 도구', difftool)),
      sectionEl('graph', '그래프', avatars.row, field('처음 읽는 커밋 수', count, '끝에 닿으면 더 읽습니다.'), stopRebase.row),
      sectionEl('errors', '오류 표시', field('오류 대화상자 기본값', errorMode)),
      sectionEl('ssl', 'SSL 인증서 (회사망)',
        el('div', { class: 'muted small', text: '회사 보안 프록시가 SSL 을 가로채면 git 이 "SSL certificate problem" 으로 실패합니다. 여기 설정은 앱이 부르는 git 에만 붙고(-c), 사용자 .gitconfig 는 바꾸지 않습니다.' }),
        verify.row, windows ? systemStore.row : null, windows ? skipRevoke.row : null,
        el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: 'CA 인증서 파일' }), el('div', { class: 'row' }, caFile, browseCa)),
        keychain ? el('div', { class: 'row' }, keychain) : null, el('div', { class: 'row' }, testUrl, testButton), testResult),
      sectionEl('git', 'git', git.node),
      sectionEl('login', '로그인', el('div', { class: 'modal-label', text: 'GitHub' }), githubAccounts, el('div', { class: 'modal-label', text: 'GitHub 가 아닌 서버' }), sshInfo,
        el('div', { class: 'muted small', text: 'https 서버(사내 GitLab 등)의 계정은 이 PC 의 자격 증명 저장소에 들어갑니다. 지우려면 키체인 접근·자격 증명 관리자에서 지워 주세요.' })),
    ];
    const body = el('div', { class: 'settings-body' }, sections);
    // 왼쪽 목록: 누른 칸을 고른 채로 둔다. 맨 아래의 짧은 칸(git·로그인)은 머리가 위에 닿을 만큼 스크롤되지 않으므로
    // 스크롤 위치만으로 고르면 앞 칸이 계속 골라진다 — 누른 뒤에는 사용자가 직접 스크롤할 때까지 누른 칸을 지킨다.
    let picked = null;
    const mark = (active) => nav.querySelectorAll('.settings-tab').forEach((b, i) => b.classList.toggle('on', i === active));
    const nav = el('nav', { class: 'settings-nav' }, sections.map((sec, i) => el('button', {
      class: 'settings-tab', text: sec.querySelector('h3').textContent,
      onclick: () => {
        picked = i;
        mark(i);
        sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
      },
    })));
    const release = () => { picked = null; };
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) body.addEventListener(type, release, { passive: true });
    body.addEventListener('scroll', () => {
      if (picked != null) return;
      const top = body.scrollTop;
      let active = 0;
      sections.forEach((sec, i) => { if (sec.offsetTop - body.offsetTop - 20 <= top) active = i; });
      // 끝까지 내렸으면 마지막 칸.
      if (top + body.clientHeight >= body.scrollHeight - 2) active = sections.length - 1;
      mark(active);
    });
    dialog.append(
      sheetHead('설정'),
      sheetBody(el('div', { class: 'settings-layout' }, nav, body)),
      sheetFoot(sheetMessage(), el('button', { class: 'btn', text: '취소', onclick: () => close(null) }), el('button', { class: 'btn primary', text: '저장', onclick: save })));
    if (section) {
      const at = sections.findIndex((sec) => sec.dataset.section === section);
      if (at >= 0) {
        picked = at;
        mark(at);
        requestAnimationFrame(() => sections[at].scrollIntoView({ block: 'start' }));
      }
    }
    body.dispatchEvent(new Event('scroll'));
  });
}

/**
 * 탭 막대(GitKraken 모양). tabs: [{path, name}], active: 지금 열린 경로(없으면 null).
 * macOS 는 이 막대가 창 제목 막대를 겸한다 — 빈 곳을 끌면 창이 움직이고, 두 번 누르면 창을 키운다.
 */
export function renderTabs(container, { tabs, active, onOpen, onClose, onNew, onBrowse }) {
  container.replaceChildren(
    el('button', { class: 'tab-folder', 'data-tip': '레포지토리 열기…', onclick: onBrowse }, icon('folder', 16)),
    ...tabs.map((tab) => el('div', {
      class: `tab${tab.path === active ? ' active' : ''}`,
      onclick: () => tab.path !== active && onOpen(tab.path),
      onauxclick: (event) => { if (event.button === 1) onClose(tab.path); },
      oncontextmenu: (event) => {
        event.preventDefault();
        showMenu(event.clientX, event.clientY, [
          { label: '탭 닫기', action: () => onClose(tab.path) },
          { label: '경로 복사', action: () => navigator.clipboard?.writeText(tab.path) },
        ]);
      },
    }, icon('branch', 14, 'tab-icon'),
    el('span', { class: 'tab-name', text: tab.name }),
    el('button', { class: 'tab-close', 'aria-label': '탭 닫기', onclick: (event) => { event.stopPropagation(); onClose(tab.path); } }, icon('close', 10)))),
    el('button', { class: `tab-new${active ? '' : ' active'}`, 'data-tip': '새 탭 — 레포지토리 열기·Clone', onclick: onNew }, icon('plus', 16)),
    el('div', { class: 'tabs-drag' }));
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
