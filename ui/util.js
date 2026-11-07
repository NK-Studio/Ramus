// 화면 여러 곳에서 쓰는 작은 도구.

/** 태그·속성·자식으로 요소를 만든다. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'style' && typeof value === 'object') {
      for (const [name, v] of Object.entries(value)) {
        if (name.startsWith('--')) node.style.setProperty(name, v);
        else node.style[name] = v;
      }
    }
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** "3분 전" 처럼 지금부터 얼마 전인지. 일주일이 넘으면 날짜. */
export function relativeTime(unixSeconds) {
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return '방금';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`;
  return formatDate(unixSeconds);
}

export function formatDate(unixSeconds, withTime = false) {
  const d = new Date(unixSeconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}

/** 작성자마다 같은 색이 나오는 아바타 바탕색. */
export function authorColor(name) {
  let hash = 0;
  for (const ch of name || '?') hash = (hash * 31 + ch.codePointAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 45% 45%)`;
}

/**
 * 아바타에 넣을 머리글자(원본 GitDisplay.Initials). 공백·`.`·`_`·`-` 로 나눠 두 마디 이상이면 앞 두 마디의 첫 글자,
 * 아니면 앞 두 글자("김한용" → "김한", "nk-studio" → "NS", "octocat" → "OC").
 */
export function initials(name) {
  const words = (name || '').trim().split(/[ ._-]+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return words[0].slice(0, 2).toUpperCase();
}

/**
 * 받침에 맞는 조사(을/를, 이/가 등). 한글은 받침으로, 영문은 끝 글자가 모음인지로 고른다("Rebase를", "Revert을").
 */
export function josa(word, withBatchim, without) {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0);
  const batchim = code >= 0xac00 && code <= 0xd7a3 ? (code - 0xac00) % 28 !== 0 : !/[aeiouyAEIOUY]/.test(last);
  return word + (batchim ? withBatchim : without);
}

/** 경로를 폴더와 파일 이름으로 나눈다. */
export function splitPath(path) {
  const at = path.lastIndexOf('/');
  return at < 0 ? { dir: '', name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}

/** 한글 IME 조합 중인 키인가(조합 중 Enter 를 확인으로 처리하지 않으려고). */
export function isComposing(event) {
  return event.isComposing || event.keyCode === 229;
}

/**
 * 여러 줄 칸의 가로 스크롤 막대를 긴 줄이 실제로 넘칠 때만 켠다. 긴 줄은 접지 않고 가로로 민다(white-space: pre).
 * 빈 칸은 넘칠 내용이 없으니 늘 끈다 — WebKit 은 페이지 확대(예: 110%)가 걸리면 placeholder 폭을 확대 비율만큼 더 넓게 잡아
 * 빈 칸도 넘친다고 본다. 글이 있을 때도 1~2px 의 오차가 나므로 몇 px 의 여유는 넘침으로 치지 않는다.
 * 입력·크기 변화뿐 아니라 코드가 value 를 바꿀 때도 다시 잰다.
 */
export function autoHorizontalScroll(textarea) {
  textarea.style.whiteSpace = 'pre';
  textarea.style.overflowWrap = 'normal';
  textarea.style.overflowX = 'hidden';
  const fit = () => {
    const over = textarea.value !== '' && textarea.scrollWidth - textarea.clientWidth > 4;
    textarea.style.overflowX = over ? 'auto' : 'hidden';
  };
  const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  Object.defineProperty(textarea, 'value', {
    configurable: true,
    get() { return proto.get.call(this); },
    set(v) { proto.set.call(this, v); fit(); },
  });
  textarea.addEventListener('input', fit);
  new ResizeObserver(fit).observe(textarea);
  return textarea;
}

/**
 * GitHub 사진. 첫 글자 바탕 위에 그림을 얹고, 그림을 못 받으면 글자만 남는다.
 * url 이 없으면 avatars.githubusercontent.com 의 로그인 사진. size: 'small'(18) · 기본(20) · 'large'(40).
 */
export function githubAvatar(login, { url, size } = {}) {
  const px = size === 'large' ? 80 : 40;
  const src = url ? `${url}${url.includes('?') ? '&' : '?'}s=${px}` : `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=${px}`;
  return el('span', { class: `cgh-avatar${size ? ` ${size}` : ''}` },
    el('span', { text: (login[0] ?? '?').toUpperCase() }), el('img', { src, alt: '', onerror: (e) => e.target.remove() }));
}
