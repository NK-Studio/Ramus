// 문법 색칠. 원본 Core/GitSyntax.cs 처럼 C 계열 · CSS(USS) · JSON · YAML · XML(UXML·HTML) 을 가볍게 나눈다.
// 줄 단위로 HTML 조각을 돌려준다(여러 줄 주석·문자열은 줄을 넘어 이어 간다).

const C_KEYWORDS = new Set(('abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event '
  + 'explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override '
  + 'params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong '
  + 'unchecked unsafe ushort using var virtual void volatile while yield let function import export from extends implements package super fn pub mut impl trait '
  + 'match mod crate self Self where loop dyn move type undefined func go defer chan map range select struct val fun when nil elif def lambda pass raise with '
  + 'and or not None True False auto inline template typename constexpr nullptr include define ifdef endif pragma').split(' '));

const LANGS = [
  [/\.(cs|js|mjs|cjs|ts|tsx|jsx|java|c|cc|cpp|cxx|h|hpp|m|mm|rs|go|swift|kt|kts|dart|shader|hlsl|cginc|compute|glsl|cg|php|py)$/i, 'c'],
  [/\.(css|uss|scss|less)$/i, 'css'],
  [/\.(json|asmdef|asmref|jsonc)$/i, 'json'],
  [/\.(ya?ml|unity|prefab|asset|mat|anim|controller|meta)$/i, 'yaml'],
  [/\.(xml|uxml|html?|xaml|csproj|svg|plist)$/i, 'xml'],
];

export function languageOf(path) {
  return LANGS.find(([re]) => re.test(path))?.[1] ?? null;
}

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls, t) => `<span class="sx-${cls}">${esc(t)}</span>`;

function cLine(line, st) {
  let out = '';
  let i = 0;
  const python = st.python;
  while (i < line.length) {
    if (st.block) {
      const end = line.indexOf('*/', i);
      if (end < 0) {
        out += span('comment', line.slice(i));
        return out;
      }
      out += span('comment', line.slice(i, end + 2));
      i = end + 2;
      st.block = false;
      continue;
    }
    const rest = line.slice(i);
    let m;
    if (rest.startsWith('//') || (python && rest.startsWith('#'))) {
      out += span('comment', rest);
      break;
    }
    if (rest.startsWith('/*')) {
      st.block = true;
      continue;
    }
    if ((m = rest.match(/^(@?"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)/))) {
      out += span('string', m[0]);
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^(0x[0-9a-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?[fFdDmMuUlL]*)/))) {
      out += span('number', m[0]);
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^#\s*\w+/)) && !python) {
      out += span('keyword', m[0]);
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^[A-Za-z_]\w*/))) {
      out += C_KEYWORDS.has(m[0]) ? span('keyword', m[0]) : esc(m[0]);
      i += m[0].length;
      continue;
    }
    out += esc(line[i]);
    i++;
  }
  return out;
}

function cssLine(line, st) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (st.block) {
      const end = line.indexOf('*/', i);
      if (end < 0) return out + span('comment', line.slice(i));
      out += span('comment', line.slice(i, end + 2));
      i = end + 2;
      st.block = false;
      continue;
    }
    const rest = line.slice(i);
    let m;
    if (rest.startsWith('/*')) {
      st.block = true;
      continue;
    }
    if ((m = rest.match(/^("[^"]*"?|'[^']*'?)/))) { out += span('string', m[0]); i += m[0].length; continue; }
    if ((m = rest.match(/^(#[0-9a-fA-F]{3,8}\b|-?\d+(\.\d+)?(px|em|rem|%|s|ms|deg)?)/))) { out += span('number', m[0]); i += m[0].length; continue; }
    if ((m = rest.match(/^(--?[A-Za-z][\w-]*)(\s*:)/))) { out += span('key', m[1]) + esc(m[2]); i += m[0].length; continue; }
    if ((m = rest.match(/^[.#]?[A-Za-z_][\w-]*/))) { out += span(st.depth > 0 ? 'plain' : 'keyword', m[0]); i += m[0].length; continue; }
    if (line[i] === '{') st.depth = (st.depth ?? 0) + 1;
    if (line[i] === '}') st.depth = Math.max(0, (st.depth ?? 0) - 1);
    out += esc(line[i]);
    i++;
  }
  return out;
}

function jsonLine(line) {
  return line.replace(/("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(\.\d+)?([eE][+-]?\d+)?)|\b(true|false|null)\b|([^"\d\-tfn]+|.)/g,
    (all, str, colon, num, _a, _b, word, other) => {
      if (str) return colon ? span('key', str) + esc(colon) : span('string', str);
      if (num) return span('number', num);
      if (word) return span('keyword', word);
      return esc(other ?? all);
    });
}

function yamlLine(line) {
  const comment = line.match(/(^|\s)#.*$/);
  const body = comment ? line.slice(0, comment.index + comment[1].length) : line;
  const tail = comment ? span('comment', comment[0].slice(comment[1].length)) : '';
  const m = body.match(/^(\s*-?\s*)([\w.\-/ ]+?)(\s*:)(\s*)(.*)$/);
  if (!m) return esc(body) + tail;
  const value = m[5];
  const v = /^(-?\d+(\.\d+)?|true|false|null|~)$/.test(value.trim()) ? span('number', value)
    : /^["']/.test(value) ? span('string', value) : esc(value);
  return esc(m[1]) + span('key', m[2]) + esc(m[3]) + esc(m[4]) + v + tail;
}

function xmlLine(line, st) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (st.comment) {
      const end = line.indexOf('-->', i);
      if (end < 0) return out + span('comment', line.slice(i));
      out += span('comment', line.slice(i, end + 3));
      i = end + 3;
      st.comment = false;
      continue;
    }
    const rest = line.slice(i);
    let m;
    if (rest.startsWith('<!--')) { st.comment = true; continue; }
    if ((m = rest.match(/^<\/?[\w:.-]+/))) { out += span('keyword', m[0]); i += m[0].length; st.tag = true; continue; }
    if (st.tag && (m = rest.match(/^([\w:.-]+)(=)/))) { out += span('key', m[1]) + esc(m[2]); i += m[0].length; continue; }
    if (st.tag && (m = rest.match(/^("[^"]*"?|'[^']*'?)/))) { out += span('string', m[0]); i += m[0].length; continue; }
    if (rest.startsWith('>') || rest.startsWith('/>')) st.tag = false;
    out += esc(line[i]);
    i++;
  }
  return out;
}

/** 글 전체를 줄별 HTML 로. 언어를 모르면 null(색칠하지 않음). */
export function highlight(text, lang) {
  if (!lang) return null;
  const st = { python: false };
  const fn = { c: cLine, css: cssLine, json: jsonLine, yaml: yamlLine, xml: xmlLine }[lang];
  return text.split('\n').map((line) => fn(line, st));
}
