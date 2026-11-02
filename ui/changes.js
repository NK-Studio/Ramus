// 오른쪽 패널. WIP 를 고르면 스테이징(Unstaged·Staged 목록)과 커밋 상자, 커밋을 고르면 그 커밋의 정보와 바뀐 파일.

import { el, splitPath, formatDate, authorColor, initials } from './util.js';

const STATE_LETTER = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: '!' };
const STATE_LABEL = { modified: '수정', added: '추가', deleted: '삭제', renamed: '이름 바뀜', untracked: '새 파일', conflicted: '충돌' };
const CHANGE_STATE = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'renamed', T: 'modified' };

/**
 * 파일 한 줄. 누르면 `onOpen`(diff 보기), 더블클릭하면 `onActivate`(Stage·Unstage), 우클릭하면 `onMenu`.
 * `key` 가 지금 열린 diff 와 같으면 고른 줄로 표시한다.
 */
function fileRow(entry, state, actions, { onOpen, onActivate, onMenu, key, activeKey } = {}) {
  const { dir, name } = splitPath(entry.path);
  const notButton = (fn) => fn && ((event) => { if (!event.target.closest('button')) fn(event); });
  return el('div', {
    class: `file-row${key && key === activeKey ? ' active' : ''}`,
    title: entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path,
    onclick: notButton(onOpen),
    ondblclick: notButton(onActivate),
    oncontextmenu: onMenu && ((event) => { event.preventDefault(); onMenu(event); }),
  },
    el('span', { class: `state-badge state-${state}`, title: STATE_LABEL[state], text: STATE_LETTER[state] }),
    el('span', { class: 'file-name', text: name }),
    el('span', { class: 'file-dir', text: dir }),
    actions);
}

/** diff 를 연 파일을 알아보는 키. */
export const diffKey = (mode, path) => `${mode}:${path}`;

/** 스테이징 화면. `api` 는 app.js 가 주는 작업 함수들. */
export function renderStaging(container, status, draft, api) {
  const unstagedSection = section('Unstaged Files', status.unstaged.length,
    el('button', { class: 'btn small success', disabled: status.unstaged.length === 0, onclick: () => api.stageAll(), text: 'Stage All Changes' }),
    status.unstaged.map((e) => fileRow(e, e.state, [
      el('button', { class: 'row-action plain', title: '변경 버리기', onclick: () => api.discard(e), text: '버리기' }),
      el('button', { class: 'row-action success', title: 'Stage', onclick: () => api.stage([e.path]), text: 'Stage' }),
    ], {
      onOpen: () => api.openDiff(e, 'unstaged'),
      onActivate: () => api.stage([e.path]),
      onMenu: (event) => api.fileMenu(event, e, 'unstaged'),
      key: diffKey('unstaged', e.path),
      activeKey: api.activeDiffKey(),
    })),
    '바뀐 파일이 없습니다.');

  const stagedSection = section('Staged Files', status.staged.length,
    el('button', { class: 'btn small danger', disabled: status.staged.length === 0, onclick: () => api.unstageAll(), text: 'Unstage All' }),
    status.staged.map((e) => fileRow(e, e.state,
      el('button', { class: 'row-action danger', title: 'Unstage', onclick: () => api.unstage([e.path]), text: 'Unstage' }), {
        onOpen: () => api.openDiff(e, 'staged'),
        onActivate: () => api.unstage([e.path]),
        onMenu: (event) => api.fileMenu(event, e, 'staged'),
        key: diffKey('staged', e.path),
        activeKey: api.activeDiffKey(),
      })),
    'Stage 한 파일이 없습니다.');

  const summary = el('input', { class: 'field', id: 'commit-summary', placeholder: '커밋 요약', maxlength: 200 });
  summary.value = draft.summary;
  const description = el('textarea', { class: 'field', id: 'commit-description', placeholder: '설명 (선택)', rows: 4 });
  description.value = draft.description;
  const amend = el('input', { type: 'checkbox', id: 'commit-amend' });
  amend.checked = draft.amend;
  const pushAfter = el('input', { type: 'checkbox', id: 'commit-push' });
  pushAfter.checked = draft.pushAfter;
  const counter = el('span', { class: 'muted small counter' });
  const commitButton = el('button', { class: 'btn primary wide', id: 'commit-button' });

  const update = () => {
    draft.summary = summary.value;
    draft.description = description.value;
    draft.amend = amend.checked;
    draft.pushAfter = pushAfter.checked;
    counter.textContent = `${summary.value.length}`;
    const canCommit = summary.value.trim().length > 0 && (status.staged.length > 0 || amend.checked);
    commitButton.disabled = !canCommit;
    const verb = amend.checked ? 'Amend' : `Commit changes to ${status.staged.length} file${status.staged.length === 1 ? '' : 's'}`;
    commitButton.textContent = pushAfter.checked ? `${verb} & Push` : verb;
  };
  summary.addEventListener('input', update);
  description.addEventListener('input', update);
  pushAfter.addEventListener('change', update);
  amend.addEventListener('change', async () => {
    // Amend 를 켜면 마지막 커밋 메시지를 채운다(비어 있을 때만).
    if (amend.checked && !summary.value.trim()) {
      const message = await api.lastMessage();
      const [first, ...rest] = message.split('\n');
      summary.value = first;
      description.value = rest.join('\n').replace(/^\n+/, '');
    }
    update();
  });
  const submit = () => {
    if (commitButton.disabled) return;
    const message = description.value.trim() ? `${summary.value.trim()}\n\n${description.value.trim()}` : summary.value.trim();
    api.commit(message, amend.checked, pushAfter.checked);
  };
  commitButton.addEventListener('click', submit);
  for (const field of [summary, description]) {
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
    });
  }
  update();

  const identity = api.identity();
  const who = identity.name
    ? el('div', { class: 'muted small' }, `작성자: ${identity.name} <${identity.email}>`)
    : el('div', { class: 'warning small' }, 'git 사용자 이름(user.name)·이메일이 없어 커밋할 수 없습니다. 터미널에서 git config --global user.name "이름" 으로 정해 주세요.');

  const conflictNote = status.conflicted > 0
    ? el('div', { class: 'warning small' }, `충돌한 파일 ${status.conflicted}개가 있습니다. 충돌 해결은 다음 단계에서 지원합니다.`)
    : null;

  container.replaceChildren(...[
    el('div', { class: 'panel-title' }, el('span', { text: status.unstaged.length + status.staged.length ? `파일 ${status.unstaged.length + status.staged.length}개 변경` : '변경 없음' }),
      el('span', { class: 'muted small', text: status.branch.name ? `on ${status.branch.name}` : '' })),
    conflictNote,
    el('div', { class: 'staging-lists' }, unstagedSection, stagedSection),
    el('div', { class: 'commit-box' },
      el('div', { class: 'commit-box-title' }, el('span', { text: '커밋' }),
        el('label', { class: 'check' }, amend, 'Amend')),
      el('div', { class: 'summary-wrap' }, summary, counter),
      description,
      who,
      el('label', { class: 'check' }, pushAfter, '커밋 후 푸시'),
      commitButton),
  ].filter(Boolean));
}

function section(title, count, headerButton, rows, emptyText) {
  return el('div', { class: 'stage-section' },
    el('div', { class: 'stage-header' },
      el('span', { class: 'stage-title' }, title, el('span', { class: 'count', text: count })),
      headerButton),
    el('div', { class: 'stage-files' }, rows.length ? rows : el('div', { class: 'empty muted small', text: emptyText })));
}

/** 커밋 하나의 정보. */
export function renderCommit(container, detail, api) {
  const [subject, ...body] = detail.message.split('\n');
  container.replaceChildren(
    el('div', { class: 'commit-detail' }, // el() 은 null 자식을 건너뛴다.
      el('div', { class: 'detail-sha mono muted small' }, `commit: ${detail.hash.slice(0, 10)}`,
        el('button', { class: 'link small', onclick: () => navigator.clipboard?.writeText(detail.hash), text: '복사' })),
      el('h3', { class: 'detail-subject', text: subject }),
      body.join('\n').trim() ? el('pre', { class: 'detail-body', text: body.join('\n').trim() }) : null,
      el('div', { class: 'detail-author' },
        el('span', { class: 'avatar', style: { background: authorColor(detail.authorName) }, text: initials(detail.authorName) }),
        el('div', {},
          el('div', { text: detail.authorName }),
          el('div', { class: 'muted small', text: `${detail.authorEmail} · ${formatDate(detail.time, true)}` }))),
      detail.parents.length
        ? el('div', { class: 'muted small' }, `부모: ${detail.parents.map((p) => p.slice(0, 7)).join(', ')}`)
        : el('div', { class: 'muted small', text: '최초 커밋' }),
      el('div', { class: 'stage-header' }, el('span', { class: 'stage-title' }, '바뀐 파일', el('span', { class: 'count', text: detail.files.length }))),
      el('div', { class: 'stage-files' }, detail.files.map((f) => fileRow(f, CHANGE_STATE[f.status] || 'modified', null, {
        onOpen: () => api.openCommitDiff(detail.hash, f),
        key: diffKey(`commit-${detail.hash}`, f.path),
        activeKey: api.activeDiffKey(),
      })))));
}
