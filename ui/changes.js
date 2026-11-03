// 오른쪽 패널. WIP 를 고르면 스테이징(Unstaged·Staged 목록)과 커밋 상자, 커밋을 고르면 그 커밋의 정보와 바뀐 파일.
// 원본 Elements/StagingLists·CommitBox·GraphCommitDetail·FileActionMenu·CommitFileMenu 를 옮겼다.

import { el, formatDate, initials, isComposing } from './util.js';
import { icon } from './icons.js';
import { fileList, viewSwitch, CHANGE_STATE } from './files.js';
import { authorRgb } from './graph.js';

/** diff 를 연 파일을 알아보는 키. */
export const diffKey = (mode, path) => `${mode}:${path}`;

// 그리기 사이에 남는 것: 고른 파일, 접은 폴더, 찾기 글.
const ui = {
  unstaged: { selected: new Set(), anchor: null },
  staged: { selected: new Set(), anchor: null },
  commit: { selected: new Set(), anchor: null },
  filter: '',
  filterOpen: false,
};

const rgb = (c) => `rgb(${c.map(Math.round).join(',')})`;

/** '#' 으로 시작하는 줄(템플릿 안내)을 뺀다. */
export function stripComments(text) {
  return text.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
}

function headerButton(kind, count, total, onAll, onSome) {
  const verb = kind === 'stage' ? 'Stage' : 'Unstage';
  // Fork 배치: 무채색 "Stage"/"Unstage", Shift 를 누르는 동안 "… All".
  if (document.body.dataset.layout === 'fork') {
    return el('button', {
      class: 'btn small fork-head', disabled: total === 0,
      onclick: (event) => (event.shiftKey || !count ? onAll() : onSome()),
    }, el('span', { class: 'lbl-normal', text: verb }), el('span', { class: 'lbl-shift', text: `${verb} All` }));
  }
  // 고른 게 없으면 "모두 …", 하나면 "…", 여럿이면 "파일 n개 …".
  const label = count === 0 ? `모두 ${verb}` : count === 1 ? verb : `파일 ${count}개 ${verb}`;
  return el('button', { class: `btn small ${kind === 'stage' ? 'success' : 'danger'}`, disabled: total === 0, text: label, onclick: () => (count ? onSome() : onAll()) });
}

for (const type of ['keydown', 'keyup']) {
  window.addEventListener(type, (event) => document.body.classList.toggle('shift-held', event.shiftKey));
}
window.addEventListener('blur', () => document.body.classList.remove('shift-held'));

/** 스테이징 화면. `api` 는 app.js 가 주는 작업 함수들. */
export function renderStaging(container, status, draft, api) {
  const view = api.prefs.get('staging.view') ?? 'path';
  const collapsed = new Set(api.prefs.get('staging.collapsed') ?? []);
  const toggleFolder = (path) => {
    if (collapsed.has(path)) collapsed.delete(path);
    else collapsed.add(path);
    api.prefs.set('staging.collapsed', [...collapsed]);
    renderStaging(container, status, draft, api);
  };
  const rerender = () => renderStaging(container, status, draft, api);
  const q = ui.filter.trim().toLowerCase();
  const matches = (e) => !q || e.path.toLowerCase().includes(q);
  const operation = status.operation;
  const conflictMode = !!operation;
  const unstaged = status.unstaged.filter(matches);
  const staged = status.staged.filter(matches);
  const conflicts = unstaged.filter((e) => e.state === 'conflicted');

  const common = (mode, st) => ({
    view, state: st, collapsed, onToggleFolder: toggleFolder,
    keyOf: (e) => diffKey(mode, e.path),
    activeKey: api.activeDiffKey(),
    onOpen: (e) => api.openDiff(e, mode),
    onSelect: () => updateButtons(),
  });

  // ── Unstaged(충돌 중이면 "충돌 파일") ──
  const unstagedList = fileList({
    ...common('unstaged', ui.unstaged),
    entries: unstaged,
    empty: q ? '찾는 파일이 없습니다.' : conflictMode ? '남은 충돌이 없습니다.' : '바뀐 파일이 없습니다.',
    rowAction: {
      labelOf: (e) => (e.state === 'conflicted'
        ? { label: '해결됨으로 표시', kind: 'resolve', run: (x) => api.markResolved([x.path]) }
        : { label: 'Stage File', kind: 'success', run: (x) => api.stage([x.path]) }),
    },
    onActivate: (entries) => (entries.length === 1 && entries[0].state === 'conflicted' ? api.openDiff(entries[0], 'unstaged') : api.stage(entries.map((e) => e.path))),
    onMenu: (event, entries) => api.fileMenu(event, entries, 'unstaged'),
    onFolderMenu: (event, folder, entries) => api.folderMenu(event, folder, entries, 'unstaged'),
    onDelete: (entries) => api.discardMany(entries),
  });
  const stagedList = fileList({
    ...common('staged', ui.staged),
    entries: staged,
    empty: q ? '찾는 파일이 없습니다.' : conflictMode ? '아직 푼 파일이 없습니다.' : 'Stage 한 파일이 없습니다.',
    rowAction: { label: 'Unstage File', kind: 'danger', run: (e) => api.unstage([e.path]) },
    onActivate: (entries) => api.unstage(entries.map((e) => e.path)),
    onMenu: (event, entries) => api.fileMenu(event, entries, 'staged'),
    onFolderMenu: (event, folder, entries) => api.folderMenu(event, folder, entries, 'staged'),
  });

  const unstagedButton = el('span');
  const stagedButton = el('span');
  function updateButtons() {
    const pickU = unstaged.filter((e) => ui.unstaged.selected.has(e.path));
    const pickS = staged.filter((e) => ui.staged.selected.has(e.path));
    // 찾는 중이면 "모두 …" 는 보이는 것만.
    unstagedButton.replaceChildren(conflictMode && conflicts.length
      ? el('button', { class: 'btn small warning', text: '모두 해결됨으로 표시', onclick: () => api.markResolved(conflicts.map((e) => e.path)) })
      : headerButton('stage', pickU.length, unstaged.length, () => (q ? api.stage(unstaged.map((e) => e.path)) : api.stageAll()), () => api.stage(pickU.map((e) => e.path))));
    stagedButton.replaceChildren(headerButton('unstage', pickS.length, staged.length, () => (q ? api.unstage(staged.map((e) => e.path)) : api.unstageAll()), () => api.unstage(pickS.map((e) => e.path))));
  }
  updateButtons();

  const section = (title, list, button) => el('div', { class: 'stage-section' },
    el('div', { class: 'stage-header' }, el('span', { class: 'stage-title', text: title }), button),
    list);

  const conflictNote = status.conflicted ? ` · 충돌 ${status.conflicted}` : '';
  const unstagedTitle = conflictMode ? `충돌 파일 (${unstaged.length})` : `Unstaged (${unstaged.length})${conflictNote}`;
  const stagedTitle = conflictMode ? `해결한 파일 (${staged.length})` : `Staged (${staged.length})`;

  // ── 파일 찾기 ──
  const filterInput = el('input', { class: 'field filter-input', placeholder: '경로로 찾기', spellcheck: 'false', value: ui.filter });
  filterInput.value = ui.filter;
  filterInput.addEventListener('input', () => {
    ui.filter = filterInput.value;
    const caret = filterInput.selectionStart;
    rerender();
    const again = container.querySelector('.filter-input');
    again?.focus();
    again?.setSelectionRange(caret, caret);
  });
  filterInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      ui.filter = '';
      ui.filterOpen = false;
      rerender();
    }
  });
  const total = status.unstaged.length + status.staged.length;
  const head = el('div', { class: 'panel-title' },
    el('span', { class: 'panel-title-text', text: total ? `파일 ${total}개 변경` : '변경 없음' }),
    el('span', { class: 'muted small panel-branch', text: status.branch.name ? `on ${status.branch.name}` : '' }),
    el('span', { class: 'spacer' }),
    viewSwitch(view, (v) => { api.prefs.set('staging.view', v); rerender(); }),
    el('button', { class: `icon-btn${ui.filterOpen ? ' on' : ''}`, 'data-tip': '파일 찾기 (⌘/Ctrl+F)', onclick: () => { ui.filterOpen = !ui.filterOpen; if (!ui.filterOpen) ui.filter = ''; rerender(); if (ui.filterOpen) container.querySelector('.filter-input')?.focus(); } }, icon('search', 14)),
    el('button', { class: 'icon-btn', 'data-tip': '모든 변경 버리기', disabled: !total, onclick: () => api.discardAll() }, icon('trash', 14)));

  container.replaceChildren(...[
    head,
    ui.filterOpen ? el('div', { class: 'filter-row' }, icon('search', 14), filterInput) : null,
    el('div', { class: 'staging-lists' }, section(unstagedTitle, unstagedList, unstagedButton), section(stagedTitle, stagedList, stagedButton)),
    commitBox(status, draft, api),
  ].filter(Boolean));
}

/** 찾기 칸을 연다(⌘/Ctrl+F). */
export function openStagingFilter(container) {
  ui.filterOpen = true;
  container.querySelector('.icon-btn[data-tip^="파일 찾기"]')?.click();
}

/**
 * 커밋 상자: 제목 → 설명 → 작성자 경고 → 아래 한 줄 [Amend][중단][건너뛰기] … [커밋 후 푸시][커밋 (n)].
 * 진행 중인 병합·rebase 면 상자를 그대로 두고 버튼이 [병합 마치기]/[Rebase 이어가기], 빈 입력란에 MERGE_MSG.
 */
function commitBox(status, draft, api) {
  const op = status.operation;
  const OP = { merge: '병합', rebase: 'Rebase', cherryPick: 'Cherry-pick', revert: 'Revert' };
  const template = api.template();
  // 빈 입력란에 템플릿·MERGE_MSG 를 채운다.
  if (!draft.summary && !draft.description && !draft.touched) {
    const fill = op ? api.mergeMessage() : template;
    if (fill) {
      const [first, ...rest] = fill.split('\n');
      draft.summary = first;
      draft.description = rest.join('\n').replace(/^\n+/, '');
      draft.fromTemplate = !op;
    }
  }
  const summary = el('input', { class: 'field', id: 'commit-summary', placeholder: '커밋 제목', maxlength: 200 });
  summary.value = draft.summary;
  const description = el('textarea', { class: 'field', id: 'commit-description', placeholder: '설명 (선택)', rows: 4 });
  description.value = draft.description;
  const amend = el('input', { type: 'checkbox', id: 'commit-amend' });
  amend.checked = draft.amend;
  const counter = el('span', { class: 'muted small counter' });
  const commitButton = el('button', { class: 'btn primary', id: 'commit-button' });
  const hasRemote = api.hasRemote();
  const pushButton = el('button', { class: 'btn', id: 'commit-push', 'data-tip': hasRemote ? '커밋한 뒤 바로 푸시합니다.' : '원격이 없어 푸시할 수 없습니다. 원격을 먼저 추가하세요.' }, '커밋 후 푸시');

  const message = () => {
    const text = description.value.trim() ? `${summary.value.trim()}\n\n${description.value.trim()}` : summary.value.trim();
    return stripComments(text);
  };
  const update = () => {
    draft.summary = summary.value;
    draft.description = description.value;
    draft.amend = amend.checked;
    counter.textContent = `${summary.value.length}`;
    const hasMessage = stripComments(summary.value).trim().length > 0;
    if (op) {
      const blocked = status.conflicted > 0;
      commitButton.textContent = op === 'rebase' ? 'Rebase 이어가기' : `${OP[op]} 마치기`;
      commitButton.disabled = blocked;
      commitButton.dataset.tip = blocked ? `충돌 파일 ${status.conflicted}개를 먼저 풀어 주세요.` : '';
      pushButton.hidden = true;
    } else {
      const can = hasMessage && (status.staged.length > 0 || amend.checked);
      commitButton.disabled = !can;
      commitButton.textContent = amend.checked ? '고쳐 쓰기' : `커밋 (${status.staged.length})`;
      commitButton.dataset.tip = !hasMessage ? '커밋 제목을 적어 주세요.' : !status.staged.length && !amend.checked ? 'Stage 한 파일이 없습니다.' : '⌘/Ctrl+Enter';
      pushButton.disabled = !can || !hasRemote;
    }
  };
  summary.addEventListener('input', () => {
    draft.touched = true;
    update();
    api.onSummary?.(summary.value);
  });
  description.addEventListener('input', () => { draft.touched = true; update(); });
  // 다 지우고 나가면 템플릿을 다시 채운다.
  for (const field of [summary, description]) {
    field.addEventListener('blur', () => {
      if (!op && template && !summary.value.trim() && !description.value.trim()) {
        draft.touched = false;
        const [first, ...rest] = template.split('\n');
        summary.value = first;
        description.value = rest.join('\n').replace(/^\n+/, '');
        update();
      }
    });
  }
  amend.addEventListener('change', async () => {
    // Amend 를 켜면 마지막 커밋 메시지를 채운다(비어 있거나 템플릿일 때).
    if (amend.checked && (!summary.value.trim() || !draft.touched)) {
      const last = await api.lastMessage();
      const [first, ...rest] = last.split('\n');
      summary.value = first;
      description.value = rest.join('\n').replace(/^\n+/, '');
      draft.touched = true;
      api.onSummary?.(summary.value);
    }
    update();
  });
  const submit = (pushAfter) => {
    if (commitButton.disabled) return;
    if (op) api.continueOperation(message());
    else {
      draft.touched = false;
      api.commit(message(), amend.checked, pushAfter);
    }
  };
  commitButton.addEventListener('click', () => submit(false));
  pushButton.addEventListener('click', () => submit(true));
  for (const field of [summary, description]) {
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isComposing(event)) submit(false);
    });
  }
  update();

  const identity = api.identity();
  const who = identity.name && identity.email ? null
    : el('div', { class: 'author-warning' }, icon('warning', 14), el('span', { text: 'git 사용자 이름·이메일(user.name/user.email)이 없어 커밋할 수 없습니다.' }));

  return el('div', { class: 'commit-box' },
    el('div', { class: 'summary-wrap' }, summary, counter),
    description,
    who,
    el('div', { class: 'commit-actions' },
      op ? null : el('label', { class: 'check', 'data-tip': '마지막 커밋의 메시지·내용을 고칩니다.' }, amend, '마지막 커밋 고치기 (Amend)'),
      op ? el('button', { class: 'link danger-link', text: `${OP[op]} 중단`, onclick: () => api.abortOperation() }) : null,
      op === 'rebase' ? el('button', { class: 'link', text: '건너뛰기', onclick: () => api.skipOperation() }) : null,
      el('span', { class: 'spacer' }),
      pushButton,
      commitButton));
}

// ── 커밋 상세(원본 GraphCommitDetail) ───────────────────

const COAUTHOR = /^co-authored-by:\s*(.+?)\s*<([^>]+)>\s*$/gim;

function avatar(api, name, email, hash, size = 32) {
  const node = el('span', { class: 'avatar', style: { width: `${size}px`, height: `${size}px`, background: rgb(authorRgb(name)), fontSize: `${Math.round(size * 0.38)}px` }, text: initials(name) });
  api.avatarUrl?.(email, hash).then((url) => {
    if (url) node.replaceChildren(el('img', { src: url, alt: '' }));
  });
  return node;
}

/** 바뀐 파일 수를 종류별 색으로: ✎ n 수정 + n 추가 − n 삭제 → n 이름 바뀜 */
function fileSummary(files) {
  const count = (states) => files.filter((f) => states.includes(CHANGE_STATE[f.status] ?? 'modified')).length;
  const parts = [
    ['modified', 'pencil', count(['modified']), '수정'],
    ['added', 'plus', count(['added']), '추가'],
    ['deleted', 'minus', count(['deleted']), '삭제'],
    ['renamed', 'chevronRight', count(['renamed']), '이름 바뀜'],
  ].filter((p) => p[2]);
  return el('div', { class: 'file-summary' }, parts.map(([cls, glyph, n, label]) => el('span', { class: `fs fs-${cls}` }, icon(glyph, 12), `${n} ${label}`)));
}

/** 커밋 하나의 정보. detail.title 이 있으면(stash 등) 머리에 보인다. */
export function renderCommit(container, detail, api) {
  const [subject, ...body] = detail.message.split('\n');
  const bodyText = body.join('\n').trim();
  const coauthors = [...detail.message.matchAll(COAUTHOR)].map((m) => ({ name: m[1], email: m[2] }));
  const view = api.prefs.get('commit.view') ?? 'path';
  const collapsed = new Set(api.prefs.get('commit.collapsed') ?? []);
  const entries = detail.files.map((f) => ({ ...f, state: CHANGE_STATE[f.status] || 'modified' }));
  const rerender = () => renderCommit(container, detail, api);
  const copyHash = el('button', {
    class: 'detail-sha mono', 'data-tip': '눌러서 전체 해시 복사',
    onclick: () => {
      navigator.clipboard?.writeText(detail.hash);
      copyHash.dataset.tip = '복사했습니다';
    },
  }, icon('copy', 12), detail.hash.slice(0, 10));
  const list = fileList({
    view, collapsed, state: ui.commit, entries,
    onToggleFolder: (path) => {
      if (collapsed.has(path)) collapsed.delete(path);
      else collapsed.add(path);
      api.prefs.set('commit.collapsed', [...collapsed]);
      rerender();
    },
    keyOf: (e) => diffKey(`commit-${detail.hash}`, e.path),
    activeKey: api.activeDiffKey(),
    onOpen: (f) => api.openCommitDiff(detail.hash, f),
    onMenu: (event, files) => api.commitFileMenu(event, detail, files),
    empty: detail.parents.length > 1 ? '병합 커밋: 첫 부모와 다른 파일이 없습니다.' : '바뀐 파일이 없는 커밋입니다.',
  });
  container.replaceChildren(
    el('div', { class: 'commit-detail' },
      detail.title ? el('div', { class: 'detail-title muted small', text: detail.title }) : null,
      el('div', { class: 'detail-top' }, copyHash,
        detail.parents.length ? el('span', { class: 'detail-parents muted small' }, '부모 ', detail.parents.map((p) => el('button', { class: 'link mono', 'data-tip': '그래프에서 이 커밋으로 이동', text: p.slice(0, 7), onclick: () => api.revealCommit(p) })))
          : el('span', { class: 'muted small', text: '최초 커밋' })),
      el('h3', { class: 'detail-subject', text: subject }),
      bodyText ? el('pre', { class: 'detail-body', text: bodyText }) : null,
      el('div', { class: 'detail-author' },
        avatar(api, detail.authorName, detail.authorEmail, detail.hash),
        el('div', { class: 'detail-author-text' },
          el('div', { class: 'detail-author-name', text: detail.authorName, 'data-tip': detail.authorEmail }),
          el('div', { class: 'muted small', text: `authored ${formatDate(detail.time, true)}` }))),
      coauthors.length ? el('div', { class: 'coauthors' }, coauthors.map((c) => el('span', { class: 'coauthor', 'data-tip': `${c.name} <${c.email}>` }, avatar(api, c.name, c.email, detail.hash, 20), el('span', { text: c.name })))) : null,
      el('div', { class: 'detail-files-head' }, fileSummary(detail.files), el('span', { class: 'spacer' }),
        viewSwitch(view, (v) => { api.prefs.set('commit.view', v); rerender(); })),
      list));
}

/** 커밋 정보를 읽는 동안 같은 모양의 회색 막대. */
export function renderCommitSkeleton(container) {
  container.replaceChildren(el('div', { class: 'commit-detail' },
    ...[40, 85, 60, 30].map((w) => el('div', { class: 'sk-bar', style: { width: `${w}%`, height: '12px' } })),
    el('div', { class: 'sk-gap' }),
    ...Array.from({ length: 8 }, (_, i) => el('div', { class: 'sk-bar', style: { width: `${[70, 55, 80, 45][i % 4]}%` } }))));
}
