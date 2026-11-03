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

/** 아바타에 넣을 이니셜(한글 이름은 첫 글자, 영문은 단어 첫 글자 둘). */
export function initials(name) {
  const trimmed = (name || '?').trim();
  if (/^[가-힣]/.test(trimmed)) return trimmed.slice(0, 1);
  const words = trimmed.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : trimmed.slice(0, 2);
  return letters.toUpperCase();
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
