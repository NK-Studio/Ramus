// 병합 충돌 편집기(GitKraken 과 같은 배치): 위 왼쪽 A(지금 브랜치), 위 오른쪽 B(들어오는 쪽), 아래 출력.
// 충돌 덩어리마다 A·B 를 통째로 고르거나 줄을 하나씩 켜고 끈다. 고른 차례대로 출력에 잇는다(B 를 먼저 고르면 B 가 위).
// 출력은 직접 고칠 수도 있다 — 그 뒤에 다시 고르면 덮어쓸지 묻는다. 저장하면 파일에 쓰고 해결로 올린다(git add).

import { el } from './util.js';
import { confirmDialog } from './dialogs.js';

/** 덩어리 하나에서 고른 것: 고른 쪽 차례와 쪽마다 켠 줄. */
function emptyChoice(segment) {
  return { order: [], a: segment.a.map(() => true), b: segment.b.map(() => true) };
}

function chosenLines(segment, choice) {
  const out = [];
  for (const side of choice.order) segment[side].forEach((line, i) => choice[side][i] && out.push(line));
  return out;
}

/** 고른 대로 출력 글. 아직 고르지 않은 덩어리는 충돌 표시 그대로 둔다(저장할 때 Rust 가 막는다). */
export function buildOutput(file, choices) {
  const lines = [];
  let k = 0;
  for (const segment of file.segments) {
    if (segment.kind === 'common') {
      lines.push(...segment.lines);
      continue;
    }
    const choice = choices[k++];
    if (!choice.order.length) {
      lines.push(`<<<<<<< ${file.aLabel}`.trimEnd(), ...segment.a, '=======', ...segment.b, `>>>>>>> ${file.bLabel}`.trimEnd());
    } else {
      lines.push(...chosenLines(segment, choice));
    }
  }
  return lines.join('\n') + (file.endsWithNewline && lines.length ? '\n' : '');
}

export function createMergeView(container) {
  let state = null; // {path, doc, choices, manual, current, api}

  async function open(path, api) {
    state = { path, api, doc: null, choices: [], manual: false, current: 0, error: null };
    render();
    try {
      const doc = await api.load(path);
      if (!state || state.path !== path) return;
      state.doc = doc;
      state.choices = (doc.file?.segments ?? []).filter((s) => s.kind === 'conflict').map(emptyChoice);
    } catch (error) {
      if (state) state.error = error?.message ?? String(error);
    }
    render();
  }

  function close() {
    state = null;
    container.replaceChildren();
  }

  async function changeChoice(index, change) {
    if (state.manual && !(await confirmDialog({ title: '출력 덮어쓰기', message: '출력을 직접 고쳤습니다. 고른 대로 출력을 다시 만들면 고친 내용이 사라집니다.', ok: '다시 만들기', danger: true }))) return;
    state.manual = false;
    change(state.choices[index]);
    state.current = index;
    render();
  }

  function setSide(index, side, chosen) {
    return changeChoice(index, (c) => {
      c.order = c.order.filter((s) => s !== side);
      if (chosen) {
        c.order.push(side);
        c[side] = c[side].map(() => true);
      }
    });
  }

  function toggleLine(index, side, line) {
    return changeChoice(index, (c) => {
      if (!c.order.includes(side)) {
        c.order.push(side);
        c[side] = c[side].map((_, i) => i === line);
      } else {
        c[side][line] = !c[side][line];
        if (!c[side].some(Boolean)) c.order = c.order.filter((s) => s !== side);
      }
    });
  }

  function all(side) {
    return changeChoice(0, () => {
      for (const c of state.choices) {
        c.order = [side];
        c[side] = c[side].map(() => true);
      }
    });
  }

  /** A·B 칸. 덩어리마다 짧은 쪽을 빈 줄로 채워 두 칸의 줄이 나란히 가게 한다. */
  function pane(side) {
    const file = state.doc.file;
    const rows = [];
    let k = 0;
    for (const segment of file.segments) {
      if (segment.kind === 'common') {
        for (const line of segment.lines) rows.push(el('div', { class: 'mrow common' }, el('span', { class: 'mtx', text: line })));
        continue;
      }
      const index = k++;
      const choice = state.choices[index];
      const chosen = choice.order.includes(side);
      const position = chosen ? choice.order.indexOf(side) + 1 : 0;
      const checkbox = el('input', { type: 'checkbox' });
      checkbox.checked = chosen;
      checkbox.addEventListener('change', () => setSide(index, side, checkbox.checked));
      rows.push(el('div', { class: `mrow mhead${index === state.current ? ' current' : ''}`, 'data-conflict': index },
        el('label', { class: 'check' }, checkbox, `충돌 ${index + 1}`),
        position && choice.order.length > 1 ? el('span', { class: 'morder', text: `${position}번째` }) : null));
      const lines = segment[side];
      const height = Math.max(segment.a.length, segment.b.length);
      for (let i = 0; i < height; i++) {
        if (i >= lines.length) {
          rows.push(el('div', { class: 'mrow pad' }));
          continue;
        }
        const on = chosen && choice[side][i];
        rows.push(el('div', {
          class: `mrow mline side-${side}${on ? ' on' : ''}`,
          title: '눌러서 이 줄만 넣기·빼기',
          onclick: () => toggleLine(index, side, i),
        }, el('span', { class: 'mmark', text: on ? '✓' : '' }), el('span', { class: 'mtx', text: lines[i] })));
      }
    }
    const label = side === 'a' ? `A — 지금 (${file.aLabel || 'HEAD'})` : `B — 들어오는 (${file.bLabel || '?'})`;
    return el('div', { class: `mpane pane-${side}` },
      el('div', { class: 'mpane-title' }, label),
      el('div', { class: 'mpane-body' }, rows));
  }

  async function save() {
    const undecided = state.choices.filter((c) => !c.order.length).length;
    if (undecided && !state.manual) {
      state.api.error({ message: `아직 고르지 않은 충돌이 ${undecided}개 있습니다.` });
      return;
    }
    let text = container.querySelector('.moutput').value;
    if (state.doc.file.newline === '\r\n') text = text.replace(/\r?\n/g, '\r\n');
    if (await state.api.save(state.path, text)) close();
  }

  function jump(delta) {
    const count = state.choices.length;
    if (!count) return;
    state.current = (state.current + delta + count) % count;
    const head = container.querySelector(`.pane-a [data-conflict="${state.current}"]`);
    head?.scrollIntoView({ block: 'center' });
    for (const node of container.querySelectorAll('.mhead')) node.classList.toggle('current', Number(node.dataset.conflict) === state.current);
  }

  function render() {
    if (!state) return;
    const { doc } = state;
    const closeButton = el('button', { class: 'icon-btn', title: '닫기 (Esc)', text: '✕', onclick: () => state.api.close() });
    const sideButtons = [
      el('button', { class: 'btn small', text: '파일 전체를 A(지금)로', onclick: () => state.api.resolve(state.path, 'ours') }),
      el('button', { class: 'btn small', text: '파일 전체를 B(들어오는)로', onclick: () => state.api.resolve(state.path, 'theirs') }),
    ];
    const title = el('div', { class: 'diff-title' }, el('span', { class: 'diff-mode mode-conflict', text: '충돌' }), el('span', { class: 'diff-path', text: state.path }));
    if (state.error || !doc) {
      container.replaceChildren(el('div', { class: 'diff-header' }, title, el('div', { class: 'diff-tools' }, closeButton)),
        el('div', { class: `diff-empty ${state.error ? 'error-text' : 'muted'}`, text: state.error ?? '불러오는 중…' }));
      return;
    }
    if (!doc.file) {
      const why = doc.oursDeleted ? '지금 브랜치(A)에서 지운 파일을 들어오는 쪽(B)이 고쳤습니다.'
        : doc.theirsDeleted ? '들어오는 쪽(B)에서 지운 파일을 지금 브랜치(A)가 고쳤습니다.'
          : doc.binary ? '바이너리 파일이라 줄 단위로 고를 수 없습니다.' : '충돌 표시를 찾지 못했습니다.';
      container.replaceChildren(el('div', { class: 'diff-header' }, title, el('div', { class: 'diff-tools' }, closeButton)),
        el('div', { class: 'merge-simple' },
          el('p', { text: why }),
          el('p', { class: 'muted', text: '어느 쪽을 남길지 골라 주세요. 지운 쪽을 고르면 파일이 지워집니다.' }),
          el('div', { class: 'merge-simple-actions' }, sideButtons)));
      return;
    }
    const decided = state.choices.filter((c) => c.order.length).length;
    const output = el('textarea', { class: 'moutput', spellcheck: 'false' });
    output.value = state.manual ? container.querySelector('.moutput')?.value ?? buildOutput(doc.file, state.choices) : buildOutput(doc.file, state.choices);
    output.addEventListener('input', () => { state.manual = true; });
    const header = el('div', { class: 'diff-header' }, title,
      el('div', { class: 'diff-tools' },
        el('span', { class: 'muted small', text: `충돌 ${state.choices.length}개 중 ${decided}개 고름` }),
        el('button', { class: 'btn small', text: '◀', title: '이전 충돌', onclick: () => jump(-1) }),
        el('button', { class: 'btn small', text: '▶', title: '다음 충돌', onclick: () => jump(1) }),
        el('button', { class: 'btn small', text: 'A 모두', onclick: () => all('a') }),
        el('button', { class: 'btn small', text: 'B 모두', onclick: () => all('b') }),
        sideButtons,
        el('button', { class: 'btn small primary', text: '저장하고 해결로 표시', onclick: save }),
        closeButton));
    const scroll = container.querySelector('.pane-a .mpane-body')?.scrollTop ?? 0;
    const a = pane('a');
    const b = pane('b');
    container.replaceChildren(header,
      el('div', { class: 'merge-top' }, a, b),
      el('div', { class: 'merge-bottom' }, el('div', { class: 'mpane-title' }, '출력 (직접 고칠 수 있습니다)'), output));
    // A·B 스크롤을 함께 움직인다.
    const [bodyA, bodyB] = [a, b].map((p) => p.querySelector('.mpane-body'));
    let syncing = false;
    const sync = (from, to) => from.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      to.scrollTop = from.scrollTop;
      requestAnimationFrame(() => { syncing = false; });
    });
    sync(bodyA, bodyB);
    sync(bodyB, bodyA);
    bodyA.scrollTop = scroll;
    bodyB.scrollTop = scroll;
    if (!scroll) requestAnimationFrame(() => jump(0));
  }

  return { open, close, get isOpen() { return state != null; }, get path() { return state?.path; } };
}
