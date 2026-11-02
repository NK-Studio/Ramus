// 큰 창들: clone, 설정(일반·SSL 인증서·로그인), GitHub 가 아닌 서버 로그인.

import { el } from './util.js';
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

/** clone 창. 받으면 열린 저장소 정보, 취소하면 null. */
export function cloneDialog({ call, cloneDir, withLogin, showError }) {
  return modal('wide', (dialog, close) => {
    const url = input('', { placeholder: 'https://git.company.com/team/game.git 또는 user@nas.local:repos/game.git' });
    const parent = input(cloneDir);
    const name = input('');
    const sep = cloneDir.includes('\\') ? '\\' : '/';
    const target = el('div', { class: 'muted small' });
    const updateTarget = () => { target.textContent = name.value ? `받을 곳: ${parent.value.replace(/[\\/]$/, '')}${sep}${name.value}` : ''; };
    let nameTouched = false;
    name.addEventListener('input', () => { nameTouched = true; });
    url.addEventListener('input', async () => {
      if (nameTouched) return;
      name.value = url.value.trim() ? await call('cloneName', { url: url.value }) : '';
      updateTarget();
    });
    const browse = el('button', {
      class: 'btn', text: '찾아보기…',
      onclick: async () => {
        const picked = await call('pickFolder', { start: parent.value });
        if (picked) parent.value = picked;
      },
    });

    for (const n of [url, parent, name]) n.addEventListener('input', updateTarget);
    const error = el('div', { class: 'modal-error', hidden: true });
    const ok = el('button', { class: 'btn primary', text: 'Clone' });
    ok.addEventListener('click', async () => {
      if (!url.value.trim() || !name.value.trim() || !parent.value.trim()) {
        error.textContent = '주소·폴더·이름을 모두 적어 주세요.';
        error.hidden = false;
        return;
      }
      ok.disabled = true;
      ok.textContent = '받는 중…';
      error.hidden = true;
      try {
        const dest = `${parent.value.replace(/[\\/]$/, '')}${sep}${name.value.trim()}`;
        const repo = await withLogin(() => call('clone', { url: url.value.trim(), dest }));
        close(repo);
      } catch (e) {
        showError(e);
        ok.disabled = false;
        ok.textContent = 'Clone';
      }
    });
    dialog.append(
      el('div', { class: 'modal-title', text: '저장소 Clone' }),
      field('저장소 주소', url),
      el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: '받을 폴더' }), el('div', { class: 'row' }, parent, browse)),
      field('폴더 이름', name),
      target,
      error,
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', text: '취소', onclick: () => close(null) }), ok));
    url.focus();
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

/** 설정 화면. 바꾼 설정을 돌려준다(닫으면 null). */
export function settingsDialog({ call, settings, onTheme, showError, toast }) {
  return modal('settings', async (dialog, close) => {
    const s = structuredClone(settings);
    const windows = s.platform === 'windows';
    const mac = s.platform === 'macos';
    const gitVersion = el('span', { class: 'muted small', text: '확인 중…' });
    call('gitVersion').then((v) => { gitVersion.textContent = v; }).catch((e) => { gitVersion.textContent = `git 을 찾지 못했습니다: ${e.message}`; gitVersion.classList.add('error-text'); });

    // ── 일반
    const theme = el('select', { class: 'field' }, el('option', { value: 'dark', text: 'JetBrains 다크' }), el('option', { value: 'light', text: 'JetBrains 라이트' }));
    theme.value = s.theme;
    theme.addEventListener('change', () => onTheme(theme.value));
    const pullMode = el('select', { class: 'field' }, PULL_MODES.map((m) => el('option', { value: m.value, text: m.label })));
    pullMode.value = s.pullMode;
    const diffLayout = el('select', { class: 'field' }, el('option', { value: 'inline', text: 'Inline (한 칸)' }), el('option', { value: 'split', text: 'Split (나란히)' }));
    diffLayout.value = s.diffLayout;
    const autoFetch = input(String(s.autoFetchMinutes), { type: 'number', min: 0, max: 1440 });
    const gitPath = input(s.gitPath, { placeholder: '비우면 PATH 의 git' });

    // ── SSL
    const verify = checkbox(s.ssl.verify, '인증서 확인', '(끄면 회사 프록시 인증서 문제는 사라지지만 안전하지 않습니다)');
    const caFile = input(s.ssl.caFile, { placeholder: '회사 루트 인증서 PEM 파일 (비우면 git 기본값)' });
    const browseCa = el('button', {
      class: 'btn', text: '찾아보기…',
      onclick: async () => {
        const picked = await call('pickFile', {});
        if (picked) caFile.value = picked;
      },
    });
    const systemStore = checkbox(s.ssl.useSystemStore, 'Windows 인증서 저장소 쓰기 (schannel)', '— 회사 인증서를 Windows 에 깔았으면 켜세요');
    const skipRevoke = checkbox(s.ssl.skipRevocationCheck, '인증서 해지 확인 끄기', '— schannel 이 "해지 확인을 할 수 없음" 으로 실패할 때');
    const keychain = mac ? el('button', {
      class: 'btn small', text: '키체인 인증서로 CA 파일 만들기',
      onclick: async () => {
        try {
          caFile.value = await call('exportKeychain');
          toast('키체인의 인증서를 모아 CA 파일을 만들었습니다.', 'success');
        } catch (e) {
          showError(e);
        }
      },
    }) : null;
    const testUrl = input('', { placeholder: '비우면 열린 저장소의 원격' });
    const testResult = el('div', { class: 'small' });
    const sslState = () => ({ verify: verify.box.checked, caFile: caFile.value.trim(), useSystemStore: systemStore.box.checked, skipRevocationCheck: skipRevoke.box.checked });
    const updateSsl = () => {
      const off = !verify.box.checked;
      for (const node of [caFile, browseCa, systemStore.box, skipRevoke.box]) node.disabled = off;
      skipRevoke.box.disabled = off || !systemStore.box.checked;
      caFile.disabled = off || (windows && systemStore.box.checked);
      browseCa.disabled = caFile.disabled;
    };
    verify.box.addEventListener('change', updateSsl);
    systemStore.box.addEventListener('change', updateSsl);
    updateSsl();
    const testButton = el('button', {
      class: 'btn small', text: '연결 테스트',
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

    // ── 로그인
    const sshInfo = el('div', { class: 'row' });
    const renderSsh = () => {
      sshInfo.replaceChildren(...[s.sshLogin
        ? el('span', { text: `SSH: ${s.sshLogin} 의 비밀번호를 기억하는 중 (앱을 끄면 잊습니다)` })
        : el('span', { class: 'muted', text: '기억한 SSH 로그인이 없습니다. 비밀번호를 받는 서버에 접속하면 로그인 창이 뜹니다.' }),
      s.sshLogin ? el('button', {
        class: 'btn small', text: '잊기',
        onclick: async () => {
          await call('forgetSshLogin');
          s.sshLogin = null;
          renderSsh();
        },
      }) : null].filter(Boolean));
    };
    renderSsh();

    const save = async () => {
      const minutes = Math.max(0, Math.min(1440, parseInt(autoFetch.value, 10) || 0));
      try {
        const saved = await call('setSettings', {
          theme: theme.value, pullMode: pullMode.value, diffLayout: diffLayout.value, autoFetchMinutes: minutes, gitPath: gitPath.value, ssl: sslState(),
        });
        close(saved);
      } catch (e) {
        showError(e);
      }
    };

    const section = (title, ...children) => el('section', { class: 'settings-section' }, el('h3', { text: title }), children);
    dialog.append(
      el('div', { class: 'modal-title', text: '설정' }),
      el('div', { class: 'settings-body' },
        section('일반',
          field('테마', theme),
          field('풀 방식', pullMode),
          field('diff 배치', diffLayout),
          field('자동 페치 간격 (분)', autoFetch, '0 이면 끕니다. 다른 곳에서 푸시한 커밋을 미리 받아 와 ↓ 로 보여 줍니다.'),
          field('git 실행 파일', gitPath),
          gitVersion),
        section('SSL 인증서 (회사망)',
          el('div', { class: 'muted small', text: '회사 보안 프록시가 SSL 을 가로채면 git 이 "SSL certificate problem" 으로 실패합니다. 여기 설정은 앱이 부르는 git 에만 붙고(-c), 사용자 .gitconfig 는 바꾸지 않습니다.' }),
          verify.row,
          windows ? systemStore.row : null,
          windows ? skipRevoke.row : null,
          el('label', { class: 'modal-field' }, el('span', { class: 'modal-label', text: 'CA 인증서 파일' }), el('div', { class: 'row' }, caFile, browseCa)),
          keychain,
          el('div', { class: 'row' }, testUrl, testButton),
          testResult),
        section('로그인 (GitHub 가 아닌 서버)', sshInfo,
          el('div', { class: 'muted small', text: 'https 서버(사내 GitLab 등)의 계정은 이 PC 의 자격 증명 저장소에 들어갑니다. 지우려면 키체인 접근·자격 증명 관리자에서 지워 주세요.' }))),
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', text: '취소', onclick: () => close(null) }), el('button', { class: 'btn primary', text: '저장', onclick: save })));
  });
}

/** 탭 막대. tabs: [{path, name}], active: 지금 열린 경로(없으면 null). */
export function renderTabs(container, { tabs, active, onOpen, onClose, onNew }) {
  container.replaceChildren(
    ...tabs.map((tab) => el('div', {
      class: `tab${tab.path === active ? ' active' : ''}`,
      title: tab.path,
      onclick: () => tab.path !== active && onOpen(tab.path),
      onauxclick: (event) => { if (event.button === 1) onClose(tab.path); },
      oncontextmenu: (event) => {
        event.preventDefault();
        showMenu(event.clientX, event.clientY, [
          { label: '탭 닫기', action: () => onClose(tab.path) },
          { label: '경로 복사', action: () => navigator.clipboard?.writeText(tab.path) },
        ]);
      },
    }, el('span', { class: 'tab-name', text: tab.name }),
    el('button', { class: 'tab-close', title: '탭 닫기', text: '×', onclick: (event) => { event.stopPropagation(); onClose(tab.path); } }))),
    el('button', { class: `tab-new${active ? '' : ' active'}`, title: '저장소 열기·Clone', text: '+', onclick: onNew }));
}
