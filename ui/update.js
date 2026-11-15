// 앱 업데이트 창. Rust(updater.rs)가 새 판을 찾으면 updateAvailable 로 알리고, 메뉴의 "업데이트 확인…" 은 updateCheck 로 묻는다.
// 창에는 새 판 번호와 지금 판 사이에 바뀐 내용(ChangeLog.md 항목)을 보이고, [업데이트]를 누르면 앱이 받아서 바꿔 넣고 다시 켠다
// (진행 막대 → "다시 시작합니다"). 앱 안에서 바꿀 수 없는 경우(zip 판·쓸 수 없는 폴더)는 내려받기 페이지를 연다.
import { el } from './util.js';
import { call, on } from './bridge.js';
import { scoped } from './i18n.js';

/** 이 모듈의 글(locales/en/update.js 를 먼저 본다). */
const t = scoped('update');

/** 바이트 → "12.3 MB". */
const megabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** 오류 값(GitError 또는 글)의 글. */
const message = (error) => (typeof error === 'string' ? error : error?.message ?? String(error));

/**
 * 업데이트 기능을 붙인다. prefs: 설정 파일의 ui 값(update.auto · update.skip · update.lastVersion), toast: 알림, version: 지금 판.
 * 돌려주는 check() 는 메뉴의 "업데이트 확인…".
 */
export function createUpdater({ prefs, toast, version }) {
  // 업데이트하고 다시 켰다 — 한 번 알린다.
  const last = prefs.get('update.lastVersion');
  if (version && last !== version) {
    if (last) toast(t('Ramus {version}(으)로 업데이트했습니다.', { version }), 'success');
    prefs.set('update.lastVersion', version);
  }

  // 자동 확인으로 찾은 판은 첫 화면을 다 그린 뒤에 띄운다(켜는 중에 창이 끼어들지 않게). 같은 판은 한 번만.
  let started = false;
  let waiting = null;
  let shown = null;
  const offer = (info) => {
    if (!info?.available || prefs.get('update.skip') === info.version || shown === info.version) return;
    if (!started) {
      waiting = info;
      return;
    }
    shown = info.version;
    showUpdate(info, prefs);
  };
  on('updateAvailable', offer);

  return {
    /** 첫 화면을 다 그렸다. 그 전에 온 알림이나, 화면이 뜨기 전에 Rust 가 찾아 둔 판(updatePending)을 띄운다. */
    async start() {
      if (started) return;
      started = true;
      const info = waiting ?? (await call('updatePending').catch(() => null));
      waiting = null;
      offer(info);
    },
    async check() {
      try {
        const info = await call('updateCheck');
        if (info.disabled) toast(t('이 빌드는 업데이트를 확인하지 않습니다.'), 'info');
        else if (!info.available) toast(t('최신 버전입니다 (Ramus {version}).', { version: info.current }), 'success');
        else showUpdate(info, prefs);
      } catch (e) {
        toast(message(e), 'error');
      }
    },
  };
}

/** 업데이트 창을 띄운다. 이미 떠 있으면 아무것도 하지 않는다. */
function showUpdate(info, prefs) {
  if (document.querySelector('.modal.update')) return;
  let busy = false;

  const notes = el('div', { class: 'update-notes' }, info.releases.map((r) => el('section', { class: 'update-release' },
    el('div', { class: 'update-release-title' }, el('span', { text: `Ramus ${r.version}` }), r.date ? el('span', { class: 'muted', text: r.date }) : null),
    // Rust 가 마크다운을 HTML 로 바꾸며 안전한 태그만 남겼다(ramus_core::markdown).
    Object.assign(el('div', { class: 'markdown' }), { innerHTML: r.html || '' }))));
  // 글 속 링크는 브라우저로 연다(웹뷰 안에서는 열지 않는다).
  notes.addEventListener('click', (event) => {
    const a = event.target.closest?.('a[href]');
    if (!a) return;
    event.preventDefault();
    if (a.href.startsWith('https://')) call('openUrl', { url: a.href }).catch(() => {});
  });

  const status = el('div', { class: 'update-status', hidden: true });
  const bar = el('div', { class: 'update-bar-fill' });
  const progress = el('div', { class: 'update-bar', hidden: true }, bar);
  const problem = el('div', { class: 'modal-error' });

  const backdrop = el('div', { class: 'modal-backdrop' });
  const box = el('div', { class: 'modal card update', role: 'dialog', 'aria-label': t('새 버전이 있습니다') });
  const close = () => {
    if (busy || !backdrop.isConnected) return;
    document.removeEventListener('keydown', onKey, true);
    backdrop.classList.add('leaving');
    setTimeout(() => backdrop.remove(), 260);
  };
  const onKey = (event) => {
    if (event.key === 'Escape' || event.key === 'Esc') { event.preventDefault(); event.stopPropagation(); close(); }
  };

  const skip = el('button', { class: 'btn card-cancel update-skip', text: t('이 버전 건너뛰기'), onclick: () => { prefs.set('update.skip', info.version); close(); } });
  const later = el('button', { class: 'btn card-cancel', text: t('나중에'), onclick: close });
  const openPage = () => {
    const url = info.page;
    if (url) call('openUrl', { url }).catch((e) => { problem.textContent = message(e); });
    close();
  };
  const install = async () => {
    busy = true;
    problem.textContent = '';
    for (const b of [skip, later, ok]) b.disabled = true;
    status.hidden = false;
    progress.hidden = false;
    status.textContent = t('내려받는 중…');
    const off = onProgress(({ received, total }) => {
      if (total > 0) {
        bar.style.width = `${Math.min(100, (received / total) * 100)}%`;
        status.textContent = t('내려받는 중… {done} / {total}', { done: megabytes(received), total: megabytes(total) });
      }
    });
    try {
      await call('updateInstall', { version: info.version });
      bar.style.width = '100%';
      status.textContent = t('설치를 시작했습니다. Ramus 를 다시 시작합니다…');
    } catch (e) {
      busy = false;
      progress.hidden = true;
      status.hidden = true;
      problem.textContent = message(e);
      for (const b of [skip, later, ok]) b.disabled = false;
    } finally {
      off();
    }
  };
  const ok = el('button', {
    class: 'btn card-ok default',
    text: info.canInstall ? t('업데이트하고 다시 시작') : t('내려받기 페이지 열기'),
    onclick: info.canInstall ? install : openPage,
  });

  box.append(
    el('div', { class: 'update-head' },
      el('div', { class: 'update-title', text: t('새 버전이 있습니다') }),
      el('div', { class: 'update-sub', text: t('Ramus {version}을(를) 쓸 수 있습니다. 지금은 {current}입니다.', { version: info.version, current: info.current }) })),
    el('div', { class: 'update-label', text: t('새로 바뀐 내용') }),
    notes,
    status,
    progress,
    problem,
    el('div', { class: 'modal-actions' }, skip, el('div', { class: 'spacer' }), later, ok));
  backdrop.append(box);
  backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  ok.focus();
}

/** 내려받기 진행(updateProgress)을 받는다. 돌려주는 함수로 그만 받는다. */
const progressHandlers = new Set();
on('updateProgress', (data) => { for (const handler of progressHandlers) handler(data); });
function onProgress(handler) {
  progressHandlers.add(handler);
  return () => progressHandlers.delete(handler);
}
