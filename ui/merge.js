// 병합 충돌 편집기. 원본 Elements/GitMergeEditor.cs 를 옮겼다: 위 A | B, 아래 출력.
// 충돌 덩어리마다 A·B 를 통째로 고르거나(덩어리 체크) 줄을 하나씩 넣고 뺀다(줄 앞 동그라미). 고른 차례대로 출력에 잇는다.
// 출력은 읽기 전용 줄 목록이고, 고르지 않은 자리에 "── 충돌 n: 위에서 A 나 B 를 고르세요 ──" 를 보인다.
// 손으로 고치기는 [직접 고치기] ↔ [고르기로 돌아가기] 전환으로만. 저장하면 파일에 쓰고 해결로 올린다(git add).
// A·B 이름은 작업마다 다르다(원본 inprogress.ours/theirs.{작업}): rebase 에서 A 는 바탕 브랜치, B 는 다시 쌓는 내 커밋이다.

import { el } from './util.js';
import { scoped } from './i18n.js';
import { icon } from './icons.js';
import { confirmDialog } from './dialogs.js';

/** 이 모듈의 글(locales/en/merge.js 를 먼저 본다). */
const t = scoped('merge');

const ROW = 18;
const SIDE_NAMES = {
  merge: [t('현재 브랜치'), t('병합해 오는')],
  cherryPick: [t('현재 브랜치'), t('가져오는 커밋')],
  revert: [t('현재 브랜치'), t('되돌리는 변경')],
  rebase: [t('바탕 브랜치'), t('다시 쌓는 내 커밋')],
};
const sideTitle = (name, label) => (label ? `${name} · ${label}` : name);
/** 원본 GitImageDiff.FormatBytes. */
const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1).replace(/\.0$/, '')} KB` : `${(n / 1048576).toFixed(1).replace(/\.0$/, '')} MB`);

/** 덩어리 하나에서 고른 것: 고른 쪽 차례와 쪽마다 켠 줄. */
function emptyChoice(segment) {
  return { order: [], a: segment.a.map(() => true), b: segment.b.map(() => true) };
}

const decided = (choice) => choice.order.length > 0;

/** 고른 대로 출력 글. keepUndecided 면 아직 고르지 않은 덩어리를 충돌 표시 그대로 둔다. */
export function buildOutput(file, choices, keepUndecided = true) {
  const lines = [];
  let k = 0;
  for (const segment of file.segments) {
    if (segment.kind === 'common') {
      lines.push(...segment.lines);
      continue;
    }
    const choice = choices[k++];
    if (!decided(choice)) {
      if (keepUndecided) lines.push(`<<<<<<< ${file.aLabel}`.trimEnd(), ...segment.a, '=======', ...segment.b, `>>>>>>> ${file.bLabel}`.trimEnd());
    } else {
      for (const side of choice.order) segment[side].forEach((line, i) => choice[side][i] && lines.push(line));
    }
  }
  return lines.join('\n') + (file.endsWithNewline && lines.length ? '\n' : '');
}

/** 세 상태 체크(모두 · 일부(−) · 없음). 원본 Toggle(showMixedValue). */
function triCheck(stateValue, onClick, tip) {
  return el('button', { class: `tri-check ${stateValue}`, 'data-tip': tip, onclick: (e) => { e.stopPropagation(); onClick(); } },
    stateValue === 'all' ? icon('check', 12) : stateValue === 'some' ? icon('minus', 12) : null);
}

export function createMergeView(container) {
  let state = null;

  async function open(path, api) {
    state = { path, api, doc: null, choices: [], manual: false, manualText: '', current: 0, error: null, ratio: api.prefs?.get('merge.ratio') ?? 0.5, imageChoice: null, images: null };
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
    requestAnimationFrame(scrollToCurrent);
  }

  function close() {
    state = null;
    container.replaceChildren();
  }

  const names = () => SIDE_NAMES[state.api.operation?.()] ?? [t('현재'), t('상대')];
  const segmentsOf = () => state.doc.file.segments.filter((s) => s.kind === 'conflict');

  function sideState(index, side) {
    const c = state.choices[index];
    if (!c.order.includes(side)) return 'none';
    return c[side].every(Boolean) ? 'all' : 'some';
  }

  function setSide(index, side, chosen) {
    const c = state.choices[index];
    c.order = c.order.filter((s) => s !== side);
    if (chosen) {
      c.order.push(side);
      c[side] = c[side].map(() => true);
    }
    state.current = index;
    render();
  }

  function toggleLine(index, side, line) {
    const c = state.choices[index];
    if (!c.order.includes(side)) {
      c.order.push(side);
      c[side] = c[side].map((_, i) => i === line);
    } else {
      c[side][line] = !c[side][line];
      if (!c[side].some(Boolean)) c.order = c.order.filter((s) => s !== side);
    }
    state.current = index;
    render();
  }

  /** 머리 체크: 그 쪽을 모든 덩어리에서 켜거나 끈다("일부" 는 켜기, 원본 ChooseAll). */
  function chooseAll(side) {
    const on = headerState(side) !== 'all';
    state.choices.forEach((c) => {
      const has = c.order.includes(side);
      if (has === on && (!on || c[side].every(Boolean))) return;
      c.order = c.order.filter((s) => s !== side);
      if (on) {
        c.order.push(side);
        c[side] = c[side].map(() => true);
      }
    });
    render();
  }

  function headerState(side) {
    const every = state.choices.length > 0 && state.choices.every((_, i) => sideState(i, side) === 'all');
    if (every) return 'all';
    return state.choices.some((c) => c.order.includes(side)) ? 'some' : 'none';
  }

  /** 줄 하나: [덩어리 체크 칸] [번호] [줄 체크] [글]. 색 띠·왼쪽 막대는 몸통에만(원본 merge-row). */
  function row({ text, number, side, conflict = -1, check = null, placeholder = false, unresolved = false, gutter = true, onClick }) {
    const tinted = conflict >= 0 && side && !unresolved;
    return el('div', {
      class: `mrow${tinted ? ` m-${side}` : ''}${conflict >= 0 && conflict === state.current ? ' current' : ''}${placeholder ? ' placeholder' : ''}${unresolved ? ' unresolved' : ''}${onClick ? ' clickable' : ''}`,
      'data-conflict': conflict >= 0 ? conflict : null,
      onclick: onClick,
    },
    gutter ? el('span', { class: 'mgut' }) : null,
    el('span', { class: 'mbody' },
      el('span', { class: 'mnum', text: number ?? '' }),
      el('span', { class: `mcheck${check === true ? ' on' : check === false ? ' off' : ''}` }, check === true ? icon('check', 11) : null),
      el('span', { class: 'mtx', text })));
  }

  /** A·B 칸. 줄 번호는 그 쪽 판의 줄 번호(원본 BuildSideRows). */
  function pane(side) {
    const file = state.doc.file;
    const rows = [];
    let number = 1;
    let k = 0;
    for (const segment of file.segments) {
      if (segment.kind === 'common') {
        for (const line of segment.lines) rows.push(row({ text: line, number: number++, side }));
        continue;
      }
      const index = k++;
      const choice = state.choices[index];
      const lines = segment[side];
      const chosen = choice.order.includes(side);
      const block = el('div', { class: 'mblock', 'data-conflict': index });
      if (!lines.length) {
        // 이 쪽은 그 자리를 비웠다(지웠다). 고르면 "아무것도 넣지 않음" 이다.
        block.append(row({ text: t('(이 쪽은 이 줄들을 지웠습니다)'), side: chosen ? side : null, conflict: index, placeholder: true, onClick: () => setSide(index, side, !chosen) }));
      }
      lines.forEach((line, i) => {
        block.append(row({ text: line, number: number++, side, conflict: index, check: chosen && choice[side][i], onClick: () => toggleLine(index, side, i) }));
      });
      // 덩어리 체크는 띠 밖 칸, 덩어리 가운데에.
      block.append(el('span', { class: 'mblock-check' }, triCheck(sideState(index, side), () => setSide(index, side, sideState(index, side) !== 'all'), t('충돌 {n}: {side} 쪽 모두 넣기·빼기', { n: index + 1, side: side.toUpperCase() }))));
      rows.push(block);
    }
    const [ours, theirs] = names();
    const title = side === 'a' ? sideTitle(ours, file.aLabel) : sideTitle(theirs, file.bLabel);
    return el('div', { class: `mpane pane-${side}${state.manual ? ' disabled' : ''}` },
      paneHeader(side, title, headerState(side), () => chooseAll(side), side === 'a' ? t('모든 충돌에서 A 쪽을 고릅니다.') : t('모든 충돌에서 B 쪽을 고릅니다.')),
      el('div', { class: 'mpane-body' }, rows));
  }

  /** 칸 머리: 체크 · A/B 배지 · 이름. 머리 아무 곳이나 누르면 체크를 누른 것과 같다. */
  function paneHeader(side, title, check, onToggle, tip) {
    return el('div', { class: 'mpane-title', onclick: onToggle },
      triCheck(check, onToggle, tip),
      el('span', { class: `mbadge badge-${side}`, text: side.toUpperCase() }),
      el('span', { class: 'mname', text: title, 'data-tip': title }));
  }

  /** 출력: 읽기 전용 줄 목록. 고르지 않은 자리에 안내 줄, 지운 쪽을 고른 자리에 빈 자리 표시(원본 BuildOutputRows). */
  function output() {
    const file = state.doc.file;
    if (state.manual) {
      const area = el('textarea', { class: 'moutput', spellcheck: 'false' });
      area.value = state.manualText;
      area.addEventListener('input', () => { state.manualText = area.value; });
      requestAnimationFrame(() => area.focus());
      return area;
    }
    const rows = [];
    let number = 1;
    let k = 0;
    for (const segment of file.segments) {
      if (segment.kind === 'common') {
        for (const line of segment.lines) rows.push(row({ text: line, number: number++, gutter: false }));
        continue;
      }
      const index = k++;
      const choice = state.choices[index];
      if (!decided(choice)) {
        rows.push(row({ text: t('── 충돌 {n}: 위에서 A 나 B 를 고르세요 ──', { n: index + 1 }), conflict: index, placeholder: true, unresolved: true, gutter: false }));
        continue;
      }
      let any = false;
      for (const side of choice.order) {
        segment[side].forEach((line, i) => {
          if (!choice[side][i]) return;
          any = true;
          rows.push(row({ text: line, number: number++, side, conflict: index, check: true, gutter: false }));
        });
      }
      if (!any) rows.push(row({ text: t('(지운 쪽을 골라 이 자리는 비웁니다)'), side: choice.order[0], conflict: index, placeholder: true, gutter: false }));
    }
    return el('div', { class: 'moutput-list' }, rows);
  }

  async function save() {
    const { doc } = state;
    if (state.manual) {
      const text = state.manualText.replace(/\r\n/g, '\n').replace(/\n/g, doc.file.newline);
      let force = false;
      // 충돌 표시를 남긴 채 저장하면 해결되지 않은 파일이 해결됨으로 올라간다. 한 번 묻는다.
      if (/^(<{7}|>{7})( |$)/m.test(text)) {
        if (!(await confirmDialog({ title: t('저장'), glyph: 'warning', tone: 'warning', message: t("'{name}' 에 충돌 표시(<<<<<<< … >>>>>>>)가 아직 남아 있습니다. 그래도 해결됨으로 표시할까요?", { name: state.path.split('/').pop() }), ok: t('저장') }))) return;
        force = true;
      }
      if (await state.api.save(state.path, text, force)) close();
      return;
    }
    if (!state.choices.every(decided)) return;
    let text = buildOutput(doc.file, state.choices, false);
    if (doc.file.newline !== '\n') text = text.replace(/\n/g, doc.file.newline);
    if (await state.api.save(state.path, text)) close();
  }

  /** 덩어리가 칸 가운데쯤 오게 몇 줄 위부터 보인다(원본 ScrollToCurrent: A·B·출력 모두). */
  function scrollToCurrent() {
    if (!state) return;
    for (const host of container.querySelectorAll('.mpane-body, .moutput-list')) {
      const target = host.querySelector(`[data-conflict="${state.current}"]`);
      if (target) host.scrollTop = Math.max(0, target.offsetTop - host.offsetTop - ROW * 4);
    }
  }

  function move(delta) {
    const count = state.choices.length;
    if (!count) return;
    state.current = (state.current + delta + count) % count;
    render();
    scrollToCurrent();
  }

  function toggleManual() {
    if (!state.manual) state.manualText = buildOutput(state.doc.file, state.choices, true);
    state.manual = !state.manual;
    render();
  }

  function reset() {
    state.manual = false;
    state.choices = segmentsOf().map(emptyChoice);
    state.current = 0;
    render();
    scrollToCurrent();
  }

  function headerBar({ count = '', saveEnabled = false, saveTip = '', showSave = true }) {
    return el('div', { class: 'merge-head' },
      el('span', { class: 'warn-glyph' }, icon('warning', 15)),
      el('span', { class: 'merge-path', text: state.path, 'data-tip': state.path }),
      el('span', { class: 'merge-count', text: count }),
      el('span', { class: 'spacer' }),
      showSave ? el('button', { class: 'merge-save', text: t('저장'), disabled: !saveEnabled, 'data-tip': saveTip, onclick: () => (state.images ? saveImage() : save()) }) : null,
      el('button', { class: 'merge-close', text: '×', 'data-tip': t('닫기'), onclick: () => state.api.close() }));
  }

  /** 줄 단위로 고칠 수 없는 충돌(바이너리·한쪽이 지운 파일): 한쪽으로 해결하거나 작업 사본 그대로 해결됨 표시. */
  function binary() {
    const [ours, theirs] = names();
    container.replaceChildren(headerBar({ showSave: false }),
      el('div', { class: 'merge-binary' },
        el('p', { class: 'merge-binary-message', text: t('이 파일은 줄 단위로 고칠 수 없는 충돌입니다(바이너리 에셋이거나 한쪽이 파일을 지웠습니다). 한쪽으로 해결하세요.') }),
        el('div', { class: 'merge-binary-buttons' },
          el('button', { class: 'btn', text: t('{name} 쪽으로 해결 (ours)', { name: ours }), onclick: () => state.api.resolve(state.path, 'ours', false) }),
          el('button', { class: 'btn', text: t('{name} 쪽으로 해결 (theirs)', { name: theirs }), onclick: () => state.api.resolve(state.path, 'theirs', false) }),
          el('button', { class: 'btn', text: t('충돌 해결됨으로 표시'), onclick: () => state.api.markResolved(state.path) }))));
  }

  // ── 이미지 충돌(원본 ShowImages·ImagePane): 위 A·B 이미지, 아래 고른 이미지(출력). ──

  async function loadImages() {
    const doc = state.doc;
    const load = async (side) => {
      if (side === 'a' ? doc.oursDeleted : doc.theirsDeleted) return { deleted: true };
      return (await state.api.imageSide(state.path, side)) ?? { missing: true };
    };
    const [a, b] = await Promise.all([load('a'), load('b')]);
    if (!state || state.doc !== doc) return;
    state.images = { a, b };
    render();
  }

  function imageStage(info, onClick) {
    const stage = el('div', { class: 'merge-image-stage', onclick: onClick });
    if (info?.src) stage.append(el('div', { class: 'merge-image-frame img-checker' }, el('img', { src: info.src, alt: '' })));
    return stage;
  }

  function images() {
    const [ours, theirs] = names();
    const loaded = state.images;
    const choose = (side) => {
      state.imageChoice = state.imageChoice === side ? null : side;
      render();
    };
    const sidePane = (side) => {
      const info = loaded?.[side];
      const stage = imageStage(info, () => choose(side));
      const hint = !loaded ? t('이미지를 읽는 중…') : info.deleted ? t('이 쪽에서는 파일을 지웠습니다') : info.missing ? t('LFS 원본을 받지 않아 이미지를 볼 수 없습니다') : '';
      if (hint) stage.append(el('div', { class: 'merge-image-hint', text: hint }));
      const title = sideTitle(side === 'a' ? ours : theirs, side === 'a' ? state.api.oursName?.() : state.api.theirsName?.());
      return el('div', { class: `mpane pane-${side}${state.imageChoice === side ? ' chosen' : ''}` },
        paneHeader(side, title, state.imageChoice === side ? 'all' : 'none', () => choose(side), side === 'a' ? t('이 이미지(A)를 남깁니다') : t('이 이미지(B)를 남깁니다')),
        stage,
        el('div', { class: 'merge-image-info', text: info?.src ? `${info.width} × ${info.height} · ${formatBytes(info.bytes)}` : '' }));
    };
    const chosen = state.imageChoice ? loaded?.[state.imageChoice] : null;
    const outStage = imageStage(chosen, null);
    if (!chosen?.src) outStage.append(el('div', { class: 'merge-image-hint', text: !state.imageChoice ? t('A 나 B 중 남길 이미지를 고르세요.') : t('파일을 지웁니다') }));
    const top = topSplit(sidePane('a'), sidePane('b'));
    container.replaceChildren(
      headerBar({ saveEnabled: !!state.imageChoice, saveTip: state.imageChoice ? t('고른 쪽 이미지로 파일을 바꾸고 충돌 해결됨으로 표시합니다(git add).') : t('A 나 B 중 남길 이미지를 고르세요.') }),
      top,
      el('div', { class: 'merge-bottom' },
        el('div', { class: 'mpane-title out-title' }, el('span', { class: 'mout-title', text: t('출력') }), el('span', { class: 'spacer' }),
          el('button', { class: 'mnav', text: t('충돌 해결됨으로 표시'), 'data-tip': t('작업 사본의 파일을 그대로 두고 해결됨으로 표시합니다. 다른 프로그램(포토샵 등)에서 직접 합쳐 둔 경우에 씁니다.'), onclick: () => state.api.markResolved(state.path) })),
        outStage));
  }

  function saveImage() {
    if (!state.imageChoice) return;
    state.api.resolve(state.path, state.imageChoice === 'a' ? 'ours' : 'theirs', false);
  }

  /** A | B 칸. 경계를 끌어 비율을 바꾸고 기억한다. 두 번 누르면 반반. */
  function topSplit(a, b) {
    const splitter = el('div', { class: 'msplit', 'data-tip': t('끌어서 비율 바꾸기 · 두 번 누르면 반반') });
    const top = el('div', { class: 'merge-top', style: { gridTemplateColumns: `${state.ratio}fr 5px ${1 - state.ratio}fr` } }, a, splitter, b);
    splitter.addEventListener('pointerdown', (e) => {
      splitter.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const r = top.getBoundingClientRect();
        state.ratio = Math.min(0.85, Math.max(0.15, (ev.clientX - r.left) / r.width));
        top.style.gridTemplateColumns = `${state.ratio}fr 5px ${1 - state.ratio}fr`;
      };
      const up = () => {
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', up);
        state.api.prefs?.set('merge.ratio', state.ratio);
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', up);
    });
    splitter.addEventListener('dblclick', () => {
      state.ratio = 0.5;
      state.api.prefs?.set('merge.ratio', null);
      top.style.gridTemplateColumns = '1fr 5px 1fr';
    });
    return top;
  }

  function render() {
    if (!state) return;
    const { doc } = state;
    if (state.error || !doc) {
      container.replaceChildren(headerBar({ showSave: false }),
        el('div', { class: `diff-empty ${state.error ? 'error-text' : 'muted'}`, text: state.error ?? t('불러오는 중…') }));
      return;
    }
    if (!doc.file) {
      if (/\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(state.path) && state.api.imageSide) {
        if (!state.images && !state.loadingImages) {
          state.loadingImages = true;
          loadImages();
        }
        images();
      } else {
        binary();
      }
      return;
    }
    const total = state.choices.length;
    const left = state.choices.filter((c) => !decided(c)).length;
    const saveTip = state.manual ? t('고친 글을 파일에 쓰고 충돌 해결됨으로 표시합니다(git add).')
      : left ? t('아직 고르지 않은 충돌이 {n}개 있습니다. A 나 B 를 골라 주세요.', { n: left }) : t('출력 내용을 파일에 쓰고 충돌 해결됨으로 표시합니다(git add).');
    const scrolls = [...container.querySelectorAll('.mpane-body, .moutput-list, .moutput')].map((n) => n.scrollTop);
    const outputHead = el('div', { class: 'mpane-title out-title' },
      el('span', { class: 'mout-title', text: t('출력') }),
      el('span', { class: 'spacer' }),
      total ? el('span', { class: 'mposition', text: t('충돌 {current} / {total}', { current: Math.min(state.current + 1, total), total }) }) : null,
      el('button', { class: 'mnav', text: '▲', 'data-tip': t('이전 충돌'), onclick: () => move(-1) }),
      el('button', { class: 'mnav', text: '▼', 'data-tip': t('다음 충돌'), onclick: () => move(1) }),
      el('button', {
        class: 'mnav wide', text: state.manual ? t('고르기로 돌아가기') : t('직접 고치기'),
        'data-tip': state.manual ? t('고친 글을 버리고 A·B 고르기로 돌아갑니다.') : t('출력 글을 손으로 고칩니다. 지금 고른 결과에서 시작하고, 고르지 않은 충돌은 표시 그대로 둡니다.'),
        onclick: toggleManual,
      }),
      el('button', { class: 'mnav wide', text: t('처음으로'), 'data-tip': t('고른 것을 모두 지우고 처음 상태로 돌아갑니다.'), onclick: reset }));
    container.replaceChildren(...[
      headerBar({ count: t('(충돌 {n}개)', { n: total }), saveEnabled: state.manual || left === 0, saveTip }),
      doc.recovered ? el('div', { class: 'merge-notice', text: t('작업 파일에 충돌 표시가 없어 git 이 기록한 양쪽 판으로 다시 보입니다. 저장하면 지금 파일을 덮어씁니다.') }) : null,
      topSplit(pane('a'), pane('b')),
      el('div', { class: 'merge-bottom' }, outputHead, output())].filter(Boolean));
    [...container.querySelectorAll('.mpane-body, .moutput-list, .moutput')].forEach((n, i) => { n.scrollTop = scrolls[i] ?? 0; });
  }

  return { open, close, get isOpen() { return state != null; }, get path() { return state?.path; } };
}
