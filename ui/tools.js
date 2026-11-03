// 가운데를 덮는 도구 화면: 파일 히스토리 · Blame · 비교 · 코드 편집기 · 이미지 diff.
// 원본 FileHistoryPanel·GitBlameWindow·GitCompareWindow·GitCodeEditor·GitImageDiffView 를 옮겼다.

import { el, relativeTime, formatDate, initials, isComposing } from './util.js';
import { icon } from './icons.js';
import { createDiffView } from './diff.js';
import { fileList, viewSwitch, CHANGE_STATE, fileIcon } from './files.js';
import { confirmDialog, choiceDialog } from './dialogs.js';
import { highlight, languageOf } from './syntax.js';
import { authorRgb } from './graph.js';

const rgb = (c) => `rgb(${c.map(Math.round).join(',')})`;
const ZERO = /^0+$/;

/**
 * ctx: { host(tool-view 요소), call, prefs, showError, act, diffApi, revealCommit(hash), onOpen(), onClose(), avatarUrl(email, hash), openEditor(path, line) }
 */
export function createTools(ctx) {
  const host = ctx.host;
  let current = null; // { kind, dispose }

  function open(kind, build) {
    close(true);
    host.hidden = false;
    host.replaceChildren();
    current = { kind };
    build(host, current);
    ctx.onOpen();
  }

  function close(silent = false) {
    if (!current) return true;
    if (current.beforeClose && !silent) {
      // 저장하지 않은 편집기 등.
      return current.beforeClose().then((ok) => {
        if (ok) finish();
        return ok;
      });
    }
    finish();
    return true;
  }

  function finish() {
    current?.dispose?.();
    current = null;
    host.hidden = true;
    host.replaceChildren();
    ctx.onClose();
  }

  const header = (glyph, title, extra = []) => el('div', { class: 'tool-head' }, icon(glyph, 16), el('span', { class: 'tool-title', text: title, 'data-tip': title }), el('span', { class: 'spacer' }), extra,
    el('button', { class: 'dbar-btn', 'data-tip': '닫기 (Esc)', onclick: () => close() }, icon('close', 14)));

  function avatar(name, email, hash, size = 24) {
    const node = el('span', { class: 'avatar', style: { width: `${size}px`, height: `${size}px`, background: rgb(authorRgb(name)), fontSize: `${Math.round(size * 0.4)}px` }, text: initials(name) });
    ctx.avatarUrl?.(email, hash).then((url) => { if (url) node.replaceChildren(el('img', { src: url, alt: '' })); });
    return node;
  }

  // ── 파일 히스토리(TL-05) ──

  const HISTORY_MAX = 300;

  function fileHistory(path) {
    open('history', async (root, me) => {
      const list = el('div', { class: 'fh-list' }, el('div', { class: 'muted small fh-empty', text: '불러오는 중…' }));
      const diffHost = el('div', { class: 'fh-diff diff-view embedded' });
      const diff = createDiffView(diffHost);
      root.append(header('history', `파일 히스토리: ${path}`), el('div', { class: 'fh-body' }, list, el('div', { class: 'splitter fixed' }), diffHost));
      me.dispose = () => diff.close();
      try {
        const revisions = await ctx.call('fileLog', { path, maxCount: HISTORY_MAX });
        if (!revisions.length) {
          list.replaceChildren(el('div', { class: 'muted small fh-empty', text: '이 파일의 커밋이 없습니다(아직 커밋하지 않은 새 파일).' }));
          return;
        }
        let active = null;
        const choose = (rev, row) => {
          active?.classList.remove('active');
          active = row;
          row.classList.add('active');
          diff.open({ target: { kind: 'commit', hash: rev.commit.hash, path: rev.path, originalPath: rev.originalPath ?? null }, mode: 'commit', title: rev.path, api: { ...ctx.diffApi, close: () => close() } });
        };
        const rows = revisions.map((rev) => {
          const row = el('div', { class: 'fh-row', 'data-tip': `${rev.commit.subject}\n${rev.commit.authorName} · ${formatDate(rev.commit.time, true)}${rev.originalPath ? `\n${rev.originalPath} → ${rev.path}` : ''}` },
            avatar(rev.commit.authorName, rev.commit.authorEmail, rev.commit.hash),
            el('div', { class: 'fh-text' },
              el('div', { class: 'fh-subject', text: rev.commit.subject }),
              el('div', { class: 'muted small', text: `${relativeTime(rev.commit.time)} · ${rev.commit.authorName}${rev.status === 'R' ? ' · 이름 바뀜' : rev.status === 'A' ? ' · 추가' : rev.status === 'D' ? ' · 삭제' : ''}` })),
            el('span', { class: 'mono muted small', text: rev.commit.shortHash }));
          row.addEventListener('click', () => choose(rev, row));
          row.addEventListener('dblclick', () => { close(); ctx.revealCommit(rev.commit.hash); });
          return row;
        });
        list.replaceChildren(...rows, revisions.length >= HISTORY_MAX ? el('div', { class: 'muted small fh-empty', text: `최근 ${HISTORY_MAX}개까지만 보입니다.` }) : null);
        choose(revisions[0], rows[0]);
      } catch (error) {
        list.replaceChildren(el('div', { class: 'error-text small fh-empty', text: error?.message ?? String(error) }));
      }
    });
  }

  // ── Blame(TL-06) ──

  function blame(path, revision) {
    open('blame', async (root) => {
      const body = el('div', { class: 'blame-body' }, el('div', { class: 'muted small fh-empty', text: '불러오는 중…' }));
      const title = header('blame', `Blame: ${path}${revision ? ` @ ${revision.slice(0, 7)}` : ''}`);
      root.append(title, body);
      try {
        const lines = await ctx.call('blame', { path, revision });
        title.querySelector('.tool-title').textContent = `${path} — ${lines.length}줄${revision ? ` @ ${revision.slice(0, 7)}` : ''}`;
        const lang = languageOf(path);
        const colored = highlight(lines.map((l) => l.text).join('\n'), lang);
        let group = -1;
        let last = null;
        const rows = lines.map((line, k) => {
          const first = line.hash !== last;
          if (first) group++;
          last = line.hash;
          const uncommitted = ZERO.test(line.hash);
          const info = first ? [
            el('span', { class: 'bl-hash mono', text: uncommitted ? '커밋 안 됨' : line.hash.slice(0, 7) }),
            el('span', { class: 'bl-author', text: uncommitted ? '' : line.author }),
            el('span', { class: 'bl-date', text: uncommitted ? '' : formatDate(line.time) }),
          ] : [el('span', { class: 'bl-hash' }), el('span', { class: 'bl-author' }), el('span', { class: 'bl-date' })];
          const code = el('span', { class: 'bl-code' });
          if (colored) code.innerHTML = colored[k] || '';
          else code.textContent = line.text;
          return el('div', {
            class: `bl-row${group % 2 ? ' alt' : ''}${first ? ' first' : ''}${uncommitted ? ' uncommitted' : ''}`,
            'data-tip': uncommitted ? '아직 커밋하지 않은 줄' : `${line.hash.slice(0, 10)} ${line.summary}\n${line.author} <${line.email}> · ${formatDate(line.time, true)}`,
            onclick: () => { if (!uncommitted) { close(); ctx.revealCommit(line.hash); } },
          }, el('div', { class: 'bl-info' }, info), el('span', { class: 'bl-ln', text: line.line }), code);
        });
        body.replaceChildren(...rows);
      } catch (error) {
        body.replaceChildren(el('div', { class: 'error-text small fh-empty', text: error?.message ?? String(error) }));
      }
    });
  }

  // ── 비교(TL-07) ──

  /** from ↔ to(없으면 작업 사본). range 면 공통 조상부터(From...To). */
  function compare(from, to, { range = false, title } = {}) {
    open('compare', async (root, me) => {
      const label = title ?? `${from} ↔ ${to ?? '작업 사본'}`;
      const head = header('split', label);
      const top = el('div', { class: 'cmp-files' }, el('div', { class: 'muted small fh-empty', text: '불러오는 중…' }));
      const diffHost = el('div', { class: 'cmp-diff diff-view embedded' });
      const diff = createDiffView(diffHost);
      root.append(head, top, diffHost);
      me.dispose = () => diff.close();
      let view = ctx.prefs.get('compare.view') ?? 'path';
      const st = { selected: new Set(), anchor: null };
      try {
        const files = (await ctx.call('compareFiles', { from, to, range })).map((f) => ({ ...f, state: CHANGE_STATE[f.status] ?? 'modified' }));
        head.querySelector('.tool-title').textContent = `${label} · 파일 ${files.length}개`;
        const openFile = (f) => diff.open({ target: { kind: 'range', from, to: to ?? null, range, path: f.path, originalPath: f.originalPath ?? null }, mode: 'commit', title: f.path, api: { ...ctx.diffApi, close: () => close() } });
        const draw = () => top.replaceChildren(
          el('div', { class: 'cmp-bar' }, el('span', { class: 'muted small', text: range ? '갈라진 뒤 바뀐 것(From...To)' : '두 판 사이' }), el('span', { class: 'spacer' }), viewSwitch(view, (v) => { view = v; ctx.prefs.set('compare.view', v); draw(); })),
          fileList({ entries: files, view, state: st, onOpen: openFile, empty: '두 판이 같습니다.' }));
        draw();
        if (files[0]) openFile(files[0]);
      } catch (error) {
        top.replaceChildren(el('div', { class: 'error-text small fh-empty', text: error?.message ?? String(error) }));
      }
    });
  }

  // ── 코드 편집기(TL-01·02·03) ──

  function editFile(path) {
    open('editor', async (root, me) => {
      let file;
      try {
        file = await ctx.call('readText', { path });
      } catch (error) {
        ctx.showError(error);
        finish();
        return;
      }
      const lang = file.text.length < 400000 ? languageOf(path) : null;
      let saved = file.text;
      const status = el('span', { class: 'ed-status' });
      const textarea = el('textarea', { class: 'ed-input', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off' });
      textarea.value = file.text;
      const pre = el('pre', { class: 'ed-hl', 'aria-hidden': 'true' });
      const gutter = el('div', { class: 'ed-gutter' });
      const currentLine = el('div', { class: 'ed-current' });
      const scroller = el('div', { class: 'ed-scroll' }, currentLine, pre, textarea);
      const saveButton = el('button', { class: 'btn small primary', text: '저장', 'data-tip': '⌘/Ctrl+S', onclick: () => save() });
      root.append(
        el('div', { class: 'tool-head ed-head' }, icon('pencil', 16), fileIcon(path), el('span', { class: 'tool-title', text: path }), status,
          el('span', { class: 'spacer' }),
          el('span', { class: 'muted small', text: `${file.encoding.toUpperCase()}${file.bom ? ' BOM' : ''} · ${file.eol === '\r\n' ? 'CRLF' : 'LF'} · ${file.indent === '\t' ? '탭' : `공백 ${file.indent.length}`}` }),
          saveButton,
          el('button', { class: 'btn small', text: '취소', 'data-tip': 'Esc', onclick: () => close() }),
          el('button', { class: 'btn small', text: '외부 편집기', onclick: () => ctx.openEditor(path, caretLine()) })),
        el('div', { class: 'ed-body' }, gutter, scroller));

      // 작업 사본에서 바뀐 줄(HEAD 대비 더한 줄) 초록 띠.
      let changed = new Set();
      ctx.call('diff', { target: { kind: 'unstaged', path, untracked: false }, options: { context: 1000000 } })
        .then((doc) => { changed = new Set(doc.lines.filter((l) => l.kind === 'added').map((l) => l.new)); paint(); }).catch(() => {});

      const dirty = () => textarea.value !== saved;
      const caretLine = () => textarea.value.slice(0, textarea.selectionStart).split('\n').length;
      let frame = 0;
      function paint() {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          const text = textarea.value;
          const lines = text.split('\n');
          const colored = lang ? highlight(text, lang) : null;
          const html = colored ?? lines.map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
          // 들여쓰기 선은 줄 앞 공백에만 긋는다.
          pre.innerHTML = html.map((h, i) => {
            const lead = lines[i].match(/^[ \t]*/)[0];
            const body = lead && h.startsWith(lead) ? `<span class="ed-ind">${lead}</span>${h.slice(lead.length)}` : h;
            return `<div class="ed-line">${body || ' '}</div>`;
          }).join('');
          const caret = caretLine();
          gutter.replaceChildren(...lines.map((_, i) => el('div', { class: `ed-ln${i + 1 === caret ? ' cur' : ''}${changed.has(i + 1) ? ' changed' : ''}`, text: i + 1 })));
          currentLine.style.top = `${(caret - 1) * 20 + 6}px`;
          status.textContent = dirty() ? '편집 중 · 저장 안 됨' : '편집 중';
          status.classList.toggle('dirty', dirty());
          saveButton.disabled = !dirty();
        });
      }
      scroller.addEventListener('scroll', () => { gutter.scrollTop = scroller.scrollTop; });
      textarea.addEventListener('input', paint);
      textarea.addEventListener('keyup', paint);
      textarea.addEventListener('click', paint);
      textarea.addEventListener('keydown', (event) => {
        const mod = event.metaKey || event.ctrlKey;
        if (isComposing(event)) return;
        if (mod && event.key.toLowerCase() === 's') {
          event.preventDefault();
          save();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (event.key === 'Tab') {
          event.preventDefault();
          indent(event.shiftKey);
        } else if (event.key === 'Enter' && !mod) {
          // 새 줄은 앞 줄 들여쓰기를 이어 받는다.
          event.preventDefault();
          const start = textarea.selectionStart;
          const lineStart = textarea.value.lastIndexOf('\n', start - 1) + 1;
          const lead = textarea.value.slice(lineStart, start).match(/^[ \t]*/)[0];
          document.execCommand('insertText', false, `\n${lead}`);
        }
      });
      function indent(outdent) {
        const unit = file.indent;
        const { selectionStart: s, selectionEnd: e, value } = textarea;
        const lineStart = value.lastIndexOf('\n', s - 1) + 1;
        if (!outdent && s === e) {
          document.execCommand('insertText', false, unit);
          return;
        }
        const block = value.slice(lineStart, e);
        const next = outdent
          ? block.split('\n').map((l) => (l.startsWith(unit) ? l.slice(unit.length) : l.replace(/^[ \t]/, ''))).join('\n')
          : block.split('\n').map((l) => unit + l).join('\n');
        textarea.setSelectionRange(lineStart, e);
        document.execCommand('insertText', false, next);
        textarea.setSelectionRange(lineStart, lineStart + next.length);
      }
      async function save(force = false) {
        if (!dirty() && !force) return true;
        try {
          const stamp = await ctx.call('writeText', { path, text: textarea.value, original: file, force });
          file = { ...file, modified: stamp };
          saved = textarea.value;
          paint();
          ctx.onSaved?.(path);
          return true;
        } catch (error) {
          if (error?.message === 'CHANGED_ON_DISK') {
            const choice = await choiceDialog({ title: '다른 곳에서 파일이 바뀌었습니다', glyph: 'warning', tone: 'warning', message: `${path}\n\n편집하는 동안 디스크의 파일이 바뀌었습니다. 내 편집으로 덮어쓸까요, 디스크의 내용을 다시 읽을까요?`, ok: '덮어쓰기', alt: '다시 읽기' });
            if (choice === 'ok') return save(true);
            if (choice === 'alt') {
              file = await ctx.call('readText', { path });
              textarea.value = file.text;
              saved = file.text;
              paint();
            }
            return false;
          }
          ctx.showError(error);
          return false;
        }
      }
      me.beforeClose = async () => {
        if (!dirty()) return true;
        const choice = await choiceDialog({ title: '저장하지 않은 편집', glyph: 'pencil', message: `${path} 의 편집을 저장할까요?`, ok: '저장', alt: '버리기' });
        if (choice === 'ok') return save();
        return choice === 'alt';
      };
      paint();
      textarea.focus();
    });
  }

  async function newFile(folder) {
    const { formDialog } = await import('./dialogs.js');
    const values = await formDialog({ title: '새 파일', glyph: 'file', message: `${folder}/ 에 만듭니다.`, fields: [{ name: 'name', placeholder: '이름.txt' }], ok: '만들기', validate: (v) => (!v.name.trim() ? '이름을 적어 주세요.' : /[\\:*?"<>|]/.test(v.name) ? '쓸 수 없는 글자가 있습니다.' : null) });
    if (!values) return;
    const path = `${folder}/${values.name.trim()}`;
    try {
      await ctx.call('createFile', { path });
      editFile(path);
    } catch (error) {
      ctx.showError(error);
    }
  }

  // ── 이미지 diff(TL-04) ──

  /** 두 판의 (판, 경로). */
  function revisions(target) {
    const old = target.originalPath ?? target.path;
    switch (target.kind) {
      case 'staged': return [['HEAD', old], [':0', target.path]];
      case 'commit': return [[`${target.hash}^`, old], [target.hash, target.path]];
      case 'range': return [[target.from, old], [target.to ?? '', target.path]];
      default: return [target.untracked ? null : [':0', target.path], ['', target.path]];
    }
  }

  async function loadImage(rev) {
    if (!rev) return null;
    try {
      const data = await ctx.call('fileBytes', { revision: rev[0], path: rev[1] });
      const img = new Image();
      img.src = `data:${data.mime === 'application/octet-stream' ? 'image/png' : data.mime};base64,${data.base64}`;
      await img.decode();
      return { img, size: data.size, mime: data.mime };
    } catch {
      return null;
    }
  }

  /** diff 보기가 이미지 파일이면 부른다. 그림을 그렸으면 true. */
  async function imageDiff(target, container, diffState) {
    const [before, after] = await Promise.all(revisions(target).map(loadImage));
    if (!before && !after) return false;
    let mode = ctx.prefs.get('image.mode') ?? 'side';
    let zoom = 0; // 0 = 화면에 맞춤
    let pan = { x: 0, y: 0 };
    let split = 0.5;
    let opacity = 0.5;
    let props = false;
    const stage = el('div', { class: 'img-stage checker' });
    const info = el('div', { class: 'img-info muted small' });
    const modes = { side: '나란히', swipe: '스와이프', onion: '겹쳐 보기', diff: '차이 강조', invert: '반전 차이' };
    const bar = el('div', { class: 'diff-bar' });
    const caption = (label, item, kind) => el('div', { class: `img-cap ${kind}` }, el('span', { text: label }), item ? el('span', { class: 'muted', text: `${item.img.naturalWidth} × ${item.img.naturalHeight}` }) : el('span', { class: 'muted', text: kind === 'before' ? '(없음 — 추가된 그림)' : '(없음 — 지운 그림)' }));

    const fitScale = () => {
      const w = Math.max(before?.img.naturalWidth ?? 0, after?.img.naturalWidth ?? 0) * (mode === 'side' ? 2 : 1) + 40;
      const h = Math.max(before?.img.naturalHeight ?? 0, after?.img.naturalHeight ?? 0) + 60;
      return Math.min(1, (stage.clientWidth - 20) / w, (stage.clientHeight - 20) / h) || 1;
    };
    const scale = () => (zoom || fitScale());
    function frame(item, kind) {
      const box = el('div', { class: `img-frame ${kind}${item ? '' : ' missing'}` });
      if (item) {
        const node = item.img.cloneNode();
        node.style.width = `${item.img.naturalWidth * scale()}px`;
        box.append(node);
      }
      return box;
    }
    function diffCanvas(invert) {
      const a = before?.img;
      const b = after?.img;
      const w = Math.max(a?.naturalWidth ?? 0, b?.naturalWidth ?? 0);
      const h = Math.max(a?.naturalHeight ?? 0, b?.naturalHeight ?? 0);
      const canvas = el('canvas', { width: w, height: h });
      canvas.style.width = `${w * scale()}px`;
      const ctx2 = canvas.getContext('2d');
      const read = (img) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const x = c.getContext('2d');
        if (img) x.drawImage(img, 0, 0);
        return x.getImageData(0, 0, w, h).data;
      };
      const pa = read(a);
      const pb = read(b);
      const out = ctx2.createImageData(w, h);
      let changed = 0;
      for (let i = 0; i < pa.length; i += 4) {
        const d = Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) + Math.abs(pa[i + 3] - pb[i + 3]);
        if (d > 0) changed++;
        if (invert) {
          out.data[i] = 255 - Math.abs(pa[i] - pb[i]);
          out.data[i + 1] = 255 - Math.abs(pa[i + 1] - pb[i + 1]);
          out.data[i + 2] = 255 - Math.abs(pa[i + 2] - pb[i + 2]);
          out.data[i + 3] = 255;
        } else {
          // 바뀐 픽셀은 빨갛게, 그대로인 픽셀은 흐리게.
          const g = (pb[i] + pb[i + 1] + pb[i + 2]) / 3;
          out.data[i] = d ? 255 : g * 0.35;
          out.data[i + 1] = d ? 60 : g * 0.35;
          out.data[i + 2] = d ? 60 : g * 0.35;
          out.data[i + 3] = 255;
        }
      }
      ctx2.putImageData(out, 0, 0);
      info.textContent = `바뀐 픽셀 ${changed.toLocaleString('ko-KR')} / ${(w * h).toLocaleString('ko-KR')} (${((changed / (w * h || 1)) * 100).toFixed(2)}%)`;
      return canvas;
    }
    function draw() {
      ctx.prefs.set('image.mode', mode);
      bar.replaceChildren(
        el('div', { class: 'dbar-left' }, fileIcon(target.path), el('span', { class: 'diff-path', text: target.path }),
          el('span', { class: 'muted small', text: before && after ? '수정' : before ? '삭제' : '추가' })),
        el('div', { class: 'dbar-seg' }, Object.entries(modes).map(([key, label]) => el('button', { class: `dbar-text${mode === key ? ' on' : ''}`, text: label, disabled: (key !== 'side') && !(before && after), onclick: () => { mode = key; draw(); } }))),
        el('div', { class: 'dbar-right' },
          el('button', { class: 'dbar-btn', 'data-tip': '확대', onclick: () => { zoom = Math.min(16, scale() * 1.25); draw(); } }, icon('zoomIn', 16)),
          el('button', { class: 'dbar-btn', 'data-tip': '축소', onclick: () => { zoom = Math.max(0.05, scale() / 1.25); draw(); } }, icon('zoomOut', 16)),
          el('button', { class: 'dbar-text', text: '화면에 맞춤', onclick: () => { zoom = 0; pan = { x: 0, y: 0 }; draw(); } }),
          el('button', { class: `dbar-text${props ? ' on' : ''}`, text: '속성 보기', onclick: () => { props = !props; draw(); } }),
          el('button', { class: 'dbar-text', text: '글로 보기', onclick: () => diffState.showText?.() }),
          el('button', { class: 'dbar-btn', 'data-tip': '닫기 (Esc)', onclick: () => diffState.api.close() }, icon('close', 14))));
      info.textContent = `${Math.round(scale() * 100)}%`;
      let content;
      if (mode === 'side' || !(before && after)) {
        content = el('div', { class: 'img-side' }, el('div', { class: 'img-col' }, caption('이전', before, 'before'), frame(before, 'before')), el('div', { class: 'img-col' }, caption('이후', after, 'after'), frame(after, 'after')));
      } else if (mode === 'swipe') {
        const wrapB = frame(after, 'after');
        const wrapA = frame(before, 'before');
        wrapA.classList.add('swipe-top');
        wrapA.style.clipPath = `inset(0 ${(1 - split) * 100}% 0 0)`;
        const handle = el('div', { class: 'swipe-handle', style: { left: `${split * 100}%` } }, el('span', { class: 'swipe-knob' }, el('span', { class: 'png-icon', style: { '--png': 'url(icons/SwipeArrows.png)' } })));
        const box = el('div', { class: 'img-stack' }, wrapB, wrapA, handle);
        box.addEventListener('pointerdown', (e) => {
          box.setPointerCapture(e.pointerId);
          const move = (ev) => {
            const r = box.getBoundingClientRect();
            split = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
            wrapA.style.clipPath = `inset(0 ${(1 - split) * 100}% 0 0)`;
            handle.style.left = `${split * 100}%`;
          };
          move(e);
          box.addEventListener('pointermove', move);
          box.addEventListener('pointerup', () => box.removeEventListener('pointermove', move), { once: true });
        });
        content = el('div', { class: 'img-single' }, el('div', { class: 'img-caps' }, caption('이전 ◀', before, 'before'), caption('▶ 이후', after, 'after')), box);
      } else if (mode === 'onion') {
        const top = frame(after, 'after');
        top.classList.add('swipe-top');
        top.style.opacity = opacity;
        const slider = el('input', { type: 'range', min: 0, max: 100, value: opacity * 100, class: 'onion-slider' });
        slider.addEventListener('input', () => { opacity = slider.value / 100; top.style.opacity = opacity; });
        content = el('div', { class: 'img-single' }, el('div', { class: 'img-caps' }, el('span', { class: 'muted small', text: '이전' }), slider, el('span', { class: 'muted small', text: '이후' })), el('div', { class: 'img-stack' }, frame(before, 'before'), top));
      } else {
        content = el('div', { class: 'img-single' }, el('div', { class: 'img-frame' }, diffCanvas(mode === 'invert')));
      }
      content.style.transform = `translate(${pan.x}px, ${pan.y}px)`;
      const table = props ? el('table', { class: 'img-props' },
        el('tr', {}, el('th'), el('th', { text: '이전' }), el('th', { text: '이후' })),
        [['크기', (x) => (x ? `${x.img.naturalWidth} × ${x.img.naturalHeight}` : '—')], ['형식', (x) => x?.mime.replace('image/', '').toUpperCase() ?? '—'], ['파일 크기', (x) => (x ? `${x.size.toLocaleString('ko-KR')} B` : '—')]]
          .map(([label, f]) => el('tr', {}, el('td', { text: label }), el('td', { class: f(before) !== f(after) ? 'diff' : '', text: f(before) }), el('td', { class: f(before) !== f(after) ? 'diff' : '', text: f(after) })))) : null;
      stage.replaceChildren(content, table ?? '', info);
    }
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoom = Math.min(16, Math.max(0.05, scale() * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      draw();
    }, { passive: false });
    stage.addEventListener('dblclick', () => { zoom = 0; pan = { x: 0, y: 0 }; draw(); });
    stage.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.img-stack, input, table')) return;
      const start = { x: e.clientX - pan.x, y: e.clientY - pan.y };
      stage.setPointerCapture(e.pointerId);
      const move = (ev) => {
        pan = { x: ev.clientX - start.x, y: ev.clientY - start.y };
        stage.firstChild.style.transform = `translate(${pan.x}px, ${pan.y}px)`;
      };
      stage.addEventListener('pointermove', move);
      stage.addEventListener('pointerup', () => stage.removeEventListener('pointermove', move), { once: true });
    });
    container.replaceChildren(bar, stage);
    requestAnimationFrame(draw);
    return true;
  }

  return {
    fileHistory, blame, compare, editFile, newFile, imageDiff,
    close: () => close(),
    get isOpen() { return current != null; },
  };
}
