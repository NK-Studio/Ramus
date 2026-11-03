// 병합 충돌 편집기. 원본 Elements/GitMergeEditor.cs 를 옮겼다: 위 A(지금) | B(들어오는), 아래 출력.
// 충돌 덩어리마다 A·B 를 통째로 고르거나(덩어리 체크) 줄을 하나씩 넣고 뺀다(줄 앞 동그라미). 고른 차례대로 출력에 잇는다.
// 출력은 읽기 전용 줄 목록이고, 고르지 않은 자리에 "── 충돌 n: 위에서 A 나 B 를 고르세요 ──" 를 보인다.
// 손으로 고치기는 [직접 고치기] ↔ [고르기로 돌아가기] 전환으로만. 저장하면 파일에 쓰고 해결로 올린다(git add).

import { el } from './util.js';
import { icon } from './icons.js';
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

/** 세 상태 체크(모두 · 일부(−) · 없음). */
function triCheck(stateValue, onClick, tip) {
  return el('button', { class: `tri-check ${stateValue}`, 'data-tip': tip, onclick: (e) => { e.stopPropagation(); onClick(); } },
    stateValue === 'all' ? icon('check', 12) : stateValue === 'some' ? icon('minus', 12) : null);
}

export function createMergeView(container) {
  let state = null; // {path, doc, choices, manual, manualText, current, api, ratio}

  async function open(path, api) {
    state = { path, api, doc: null, choices: [], manual: false, manualText: '', current: 0, error: null, ratio: api.prefs?.get('merge.ratio') ?? 0.5 };
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

  const segmentsOf = () => state.doc.file.segments.filter((s) => s.kind === 'conflict');

  function change(index, fn) {
    fn(state.choices[index]);
    state.current = index;
    render();
  }

  function sideState(index, side) {
    const c = state.choices[index];
    if (!c.order.includes(side)) return 'none';
    return c[side].every(Boolean) ? 'all' : 'some';
  }

  function setSide(index, side, chosen) {
    change(index, (c) => {
      c.order = c.order.filter((s) => s !== side);
      if (chosen) {
        c.order.push(side);
        c[side] = c[side].map(() => true);
      }
    });
  }

  function toggleLine(index, side, line) {
    change(index, (c) => {
      if (!c.order.includes(side)) {
        c.order.push(side);
        c[side] = c[side].map((_, i) => i === line);
      } else {
        c[side][line] = !c[side][line];
        if (!c[side].some(Boolean)) c.order = c.order.filter((s) => s !== side);
      }
    });
  }

  /** 머리 줄 체크: 그 쪽을 모든 덩어리에서 켜거나 끈다. */
  function toggleAll(side) {
    const all = state.choices.every((_, i) => sideState(i, side) === 'all');
    state.choices.forEach((c) => {
      c.order = c.order.filter((s) => s !== side);
      if (!all) {
        c.order.push(side);
        c[side] = c[side].map(() => true);
      }
    });
    render();
  }

  function headerState(side) {
    const states = state.choices.map((_, i) => sideState(i, side));
    if (states.every((s) => s === 'all')) return 'all';
    if (states.every((s) => s === 'none')) return 'none';
    return 'some';
  }

  /** A·B 칸. 덩어리마다 짧은 쪽을 빈 줄로 채워 두 칸의 줄이 나란히 가게 한다. */
  function pane(side) {
    const file = state.doc.file;
    const rows = [];
    let k = 0;
    for (const segment of file.segments) {
      if (segment.kind === 'common') {
        for (const line of segment.lines) rows.push(el('div', { class: 'mrow common' }, el('span', { class: 'mgut' }), el('span', { class: 'mtx', text: line })));
        continue;
      }
      const index = k++;
      const choice = state.choices[index];
      const lines = segment[side];
      const height = Math.max(segment.a.length, segment.b.length, 1);
      const position = choice.order.includes(side) && choice.order.length > 1 ? choice.order.indexOf(side) + 1 : 0;
      const block = el('div', { class: `mchunk side-${side}${index === state.current ? ' current' : ''}`, 'data-conflict': index });
      // 덩어리 체크는 띠 밖 칸, 덩어리 가운데에.
      const check = el('div', { class: 'mchunk-check' }, triCheck(sideState(index, side), () => setSide(index, side, sideState(index, side) !== 'all'), `충돌 ${index + 1}: ${side.toUpperCase()} 쪽 모두 넣기·빼기`),
        position ? el('span', { class: 'morder', text: position }) : null);
      const body = el('div', { class: 'mchunk-lines' });
      if (!lines.length) {
        body.append(el('div', { class: 'mrow deleted-note' }, el('span', { class: 'mgut' }), el('span', { class: 'mtx', text: '(이 쪽은 이 줄들을 지웠습니다)' })));
      }
      for (let i = 0; i < lines.length; i++) {
        const on = choice.order.includes(side) && choice[side][i];
        body.append(el('div', { class: `mrow mline${on ? ' on' : ''}`, onclick: () => toggleLine(index, side, i) },
          el('span', { class: 'mgut' }, el('span', { class: `mdot${on ? ' on' : ''}` })), el('span', { class: 'mtx', text: lines[i] })));
      }
      for (let i = Math.max(lines.length, 1); i < height; i++) body.append(el('div', { class: 'mrow pad' }));
      block.append(check, body);
      rows.push(block);
    }
    const name = side === 'a' ? (state.api.oursName?.() ?? file.aLabel ?? 'HEAD') : (state.api.theirsName?.() ?? file.bLabel ?? '?');
    return el('div', { class: `mpane pane-${side}` },
      el('div', { class: 'mpane-title', onclick: () => toggleAll(side) },
        triCheck(headerState(side), () => toggleAll(side), `${side.toUpperCase()} 쪽을 모든 충돌에 넣기·빼기`),
        el('span', { class: `mbadge badge-${side}`, text: side.toUpperCase() }),
        el('span', { class: 'mname', text: side === 'a' ? `지금 — ${name}` : `들어오는 — ${name}` })),
      el('div', { class: 'mpane-body' }, rows));
  }

  /** 출력: 읽기 전용 줄 목록(고르지 않은 자리에 안내 줄). 직접 고치기면 글 칸. */
  function output() {
    const file = state.doc.file;
    if (state.manual) {
      const area = el('textarea', { class: 'moutput', spellcheck: 'false' });
      area.value = state.manualText;
      area.addEventListener('input', () => { state.manualText = area.value; });
      return area;
    }
    const rows = [];
    let k = 0;
    for (const segment of file.segments) {
      if (segment.kind === 'common') {
        for (const line of segment.lines) rows.push(el('div', { class: 'mrow common' }, el('span', { class: 'mtx', text: line })));
        continue;
      }
      const index = k++;
      const choice = state.choices[index];
      if (!choice.order.length) {
        rows.push(el('div', { class: `mrow placeholder${index === state.current ? ' current' : ''}`, 'data-conflict': index, onclick: () => jump(index - state.current) },
          el('span', { class: 'mtx', text: `── 충돌 ${index + 1}: 위에서 A 나 B 를 고르세요 ──` })));
        continue;
      }
      for (const side of choice.order) {
        segment[side].forEach((line, i) => {
          if (choice[side][i]) rows.push(el('div', { class: `mrow from-${side}`, 'data-conflict': index }, el('span', { class: 'mtx', text: line })));
        });
      }
    }
    return el('div', { class: 'moutput-list' }, rows);
  }

  async function save() {
    const undecided = state.choices.filter((c) => !c.order.length).length;
    if (undecided && !state.manual) {
      state.api.error({ message: `아직 고르지 않은 충돌이 ${undecided}개 있습니다.`, advice: { kind: 'conflict', cause: `아직 고르지 않은 충돌이 ${undecided}개 있습니다.`, fix: '위에서 A 나 B 를 고르거나 [직접 고치기] 로 출력을 고쳐 주세요.' } });
      return;
    }
    let text = state.manual ? state.manualText : buildOutput(state.doc.file, state.choices);
    if (state.doc.file.newline === '\r\n') text = text.replace(/\r?\n/g, '\r\n');
    if (await state.api.save(state.path, text)) close();
  }

  function jump(delta) {
    const count = state.choices.length;
    if (!count) return;
    state.current = (state.current + delta + count) % count;
    render();
    container.querySelector(`.pane-a [data-conflict="${state.current}"]`)?.scrollIntoView({ block: 'center' });
  }

  async function setManual(on) {
    if (on) {
      state.manualText = buildOutput(state.doc.file, state.choices);
      state.manual = true;
    } else {
      if (!(await confirmDialog({ title: '고르기로 돌아가기', danger: true, message: '직접 고친 출력은 버리고, 위에서 고른 대로 출력을 다시 만듭니다.', ok: '돌아가기' }))) return;
      state.manual = false;
    }
    render();
  }

  /** 바이너리·한쪽이 지운 충돌·이미지 충돌: 한쪽 고르기(또는 작업 사본 그대로 해결됨으로 표시). */
  function simple(doc, title) {
    const why = doc.oursDeleted ? '지금 브랜치(A)에서 지운 파일을 들어오는 쪽(B)이 고쳤습니다.'
      : doc.theirsDeleted ? '들어오는 쪽(B)에서 지운 파일을 지금 브랜치(A)가 고쳤습니다.'
        : doc.binary ? '바이너리 파일이라 줄 단위로 고를 수 없습니다.' : '충돌 표시를 찾지 못했습니다.';
    const image = /\.(png|jpe?g|gif|bmp|webp|tga)$/i.test(state.path) && state.api.imageSide;
    const sides = el('div', { class: 'merge-images' });
    if (image) {
      for (const side of ['a', 'b']) {
        const deleted = side === 'a' ? doc.oursDeleted : doc.theirsDeleted;
        const box = el('div', { class: `merge-image side-${side}` }, el('div', { class: 'mpane-title' }, el('span', { class: `mbadge badge-${side}`, text: side.toUpperCase() }), el('span', { text: side === 'a' ? '지금' : '들어오는' })));
        if (deleted) box.append(el('div', { class: 'muted image-note', text: '(이 쪽은 파일을 지웠습니다)' }));
        else state.api.imageSide(state.path, side).then((info) => box.append(info ? el('div', {}, info.img, el('div', { class: 'muted small', text: `${info.width} × ${info.height} · ${info.size}` })) : el('div', { class: 'muted image-note', text: 'LFS 원본이 없거나 읽을 수 없습니다.' })));
        box.append(el('button', { class: 'btn small', text: `이 이미지(${side.toUpperCase()})를 남깁니다`, onclick: () => state.api.resolve(state.path, side === 'a' ? 'ours' : 'theirs') }));
        sides.append(box);
      }
    }
    container.replaceChildren(el('div', { class: 'diff-bar' }, title, el('span', { class: 'spacer' }), el('button', { class: 'dbar-btn', 'data-tip': '닫기 (Esc)', onclick: () => state.api.close() }, icon('close', 14))),
      el('div', { class: 'merge-simple' },
        el('p', { text: why }),
        image ? sides : el('p', { class: 'muted', text: '어느 쪽을 남길지 골라 주세요. 지운 쪽을 고르면 파일이 지워집니다.' }),
        el('div', { class: 'merge-simple-actions' },
          image ? null : el('button', { class: 'btn small', text: '파일 전체를 A(지금)로', onclick: () => state.api.resolve(state.path, 'ours') }),
          image ? null : el('button', { class: 'btn small', text: '파일 전체를 B(들어오는)로', onclick: () => state.api.resolve(state.path, 'theirs') }),
          el('button', { class: 'btn small', 'data-tip': '작업 사본의 파일을 그대로 두고 해결로 표시합니다', text: '해결됨으로 표시', onclick: () => state.api.markResolved(state.path) }))));
  }

  function render() {
    if (!state) return;
    const { doc } = state;
    const total = state.choices.length;
    const title = el('div', { class: 'diff-title' }, el('span', { class: 'warn-glyph' }, icon('warning', 16)), el('span', { class: 'diff-path', text: state.path }),
      total ? el('span', { class: 'muted small', text: `(충돌 ${total}개)` }) : null);
    if (state.error || !doc) {
      container.replaceChildren(el('div', { class: 'diff-bar' }, title, el('span', { class: 'spacer' }), el('button', { class: 'dbar-btn', onclick: () => state.api.close() }, icon('close', 14))),
        el('div', { class: `diff-empty ${state.error ? 'error-text' : 'muted'}`, text: state.error ?? '불러오는 중…' }));
      return;
    }
    if (!doc.file) {
      simple(doc, title);
      return;
    }
    const undecided = state.choices.filter((c) => !c.order.length).length;
    const saveButton = el('button', {
      class: 'btn small primary', text: '저장하고 해결로 표시',
      'data-tip': state.manual ? '직접 고친 출력으로 저장합니다' : undecided ? `아직 고르지 않은 충돌 ${undecided}개` : '모든 충돌을 골랐습니다',
      onclick: save,
    });
    const header = el('div', { class: 'diff-bar' }, title,
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn small', text: '파일 전체를 A로', onclick: () => state.api.resolve(state.path, 'ours') }),
      el('button', { class: 'btn small', text: '파일 전체를 B로', onclick: () => state.api.resolve(state.path, 'theirs') }),
      saveButton,
      el('button', { class: 'dbar-btn', 'data-tip': '닫기 (Esc)', onclick: () => state.api.close() }, icon('close', 14)));
    const scroll = container.querySelector('.pane-a .mpane-body')?.scrollTop ?? 0;
    const outScroll = container.querySelector('.moutput-list, .moutput')?.scrollTop ?? 0;
    const a = pane('a');
    const b = pane('b');
    const splitter = el('div', { class: 'msplit', 'data-tip': '끌어서 비율 바꾸기 · 두 번 누르면 반반' });
    const top = el('div', { class: 'merge-top', style: { gridTemplateColumns: `${state.ratio}fr 6px ${1 - state.ratio}fr` } }, a, splitter, b);
    splitter.addEventListener('pointerdown', (e) => {
      splitter.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const r = top.getBoundingClientRect();
        state.ratio = Math.min(0.85, Math.max(0.15, (ev.clientX - r.left) / r.width));
        top.style.gridTemplateColumns = `${state.ratio}fr 6px ${1 - state.ratio}fr`;
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', () => {
        splitter.removeEventListener('pointermove', move);
        state.api.prefs?.set('merge.ratio', state.ratio);
      }, { once: true });
    });
    splitter.addEventListener('dblclick', () => {
      state.ratio = 0.5;
      state.api.prefs?.set('merge.ratio', null);
      top.style.gridTemplateColumns = '1fr 6px 1fr';
    });
    const outputHead = el('div', { class: 'mpane-title out-title' },
      el('span', { text: '출력' }),
      total ? el('span', { class: 'muted', text: `충돌 ${state.current + 1} / ${total}` }) : null,
      el('button', { class: 'btn tiny', 'data-tip': '이전 충돌', onclick: () => jump(-1) }, icon('chevronRight', 12, 'flip')),
      el('button', { class: 'btn tiny', 'data-tip': '다음 충돌', onclick: () => jump(1) }, icon('chevronRight', 12)),
      el('button', { class: 'btn tiny', text: '처음으로', 'data-tip': '고른 것을 모두 지웁니다', disabled: state.manual, onclick: () => { state.choices = segmentsOf().map(emptyChoice); render(); } }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn tiny', text: state.manual ? '고르기로 돌아가기' : '직접 고치기', onclick: () => setManual(!state.manual) }));
    container.replaceChildren(...[header,
      doc.recovered ? el('div', { class: 'lfs-banner' }, icon('info', 16), el('span', { text: '작업 사본에서 충돌 표시가 지워져 있어, git 이 기억하는 세 판(공통 조상·A·B)으로 충돌을 다시 만들었습니다.' })) : null,
      top,
      el('div', { class: 'merge-bottom' }, outputHead, output())].filter(Boolean));
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
    const out = container.querySelector('.moutput-list, .moutput');
    if (out) out.scrollTop = outScroll;
    if (!scroll) requestAnimationFrame(() => container.querySelector(`.pane-a [data-conflict="${state.current}"]`)?.scrollIntoView({ block: 'center' }));
  }

  return { open, close, get isOpen() { return state != null; }, get path() { return state?.path; } };
}
