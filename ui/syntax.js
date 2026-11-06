// 문법 색칠. 원본 Core/GitSyntax.cs · Core/GitUnityApi.cs(1.2.0)를 그대로 옮겼다.
// 편집기용 가벼운 줄 단위 색칠이다. 정확한 파서가 아니라 한 줄씩 훑고, 여러 줄에 걸치는 것(블록 주석 · HTML 의 여러 줄 태그 · <script> · <style>)은
// 줄 끝 상태를 다음 줄에 넘긴다. 조각 갈래(kind)는 원본 GitSyntaxKind 의 소문자 이름이고, 색은 app.css 의 --git-code-* 토큰(.sx-<kind>)에서 온다.

// 말 갈래(원본 GitSyntaxLanguage): 'csharp' · 'clike' · 'css' · 'json' · 'yaml' · 'xml' · 'html'. 색칠하지 않는 말은 null.
// 조각 갈래(원본 GitSyntaxKind): keyword · string · number · comment · key · tag · attribute · punctuation · type · function(plain 은 조각으로 내지 않는다).

/** 줄 시작 상태: 보통. */
export const STATE_NORMAL = 0;
/** 줄 시작 상태: 블록 주석(C 계열 · CSS 의 블록 주석, XML · HTML 의 <!-- -->) 안. */
export const STATE_BLOCK_COMMENT = 1;
// HTML 줄 끝 상태. <script> · <style> 안(그 안의 블록 주석 안), 여러 줄에 걸친 여는 태그 안.
const STATE_HTML_SCRIPT = 2;
const STATE_HTML_SCRIPT_COMMENT = 3;
const STATE_HTML_STYLE = 4;
const STATE_HTML_STYLE_COMMENT = 5;
const STATE_HTML_TAG = 6;
const STATE_HTML_SCRIPT_TAG = 7;
const STATE_HTML_STYLE_TAG = 8;

const CSHARP_KEYWORDS = new Set([
  'abstract', 'as', 'async', 'await', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const', 'continue',
  'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float',
  'for', 'foreach', 'get', 'goto', 'if', 'implicit', 'in', 'init', 'int', 'interface', 'internal', 'is', 'let', 'lock', 'long', 'nameof', 'namespace',
  'new', 'null', 'object', 'operator', 'out', 'override', 'params', 'partial', 'private', 'protected', 'public', 'readonly', 'record', 'ref',
  'return', 'sbyte', 'sealed', 'set', 'short', 'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort', 'using', 'value', 'var', 'virtual', 'void', 'volatile', 'when', 'where', 'while', 'yield',
  // 셰이더 · C · JS 에 흔한 낱말.
  'float2', 'float3', 'float4', 'float4x4', 'half', 'half2', 'half3', 'half4', 'fixed2', 'fixed3', 'fixed4', 'int2', 'int3', 'int4',
  'sampler2D', 'uniform', 'inout', 'function', 'let', 'export', 'import', 'from', 'undefined', 'unsigned', 'signed', 'auto', 'include', 'define',
  'instanceof', 'delete', 'of',
]);

// C# 에만 있는 문맥 키워드 가운데 변수 이름으로는 거의 안 쓰는 것(file · with · or 처럼 이름과 겹치기 쉬운 것은 넣지 않는다).
const CSHARP_ONLY_KEYWORDS = new Set(['required', 'scoped', 'unmanaged', 'notnull', 'nint', 'nuint', 'dynamic']);

// Unity 메시지 메서드의 반환 타입(void Update() · IEnumerator Start() · Awaitable Start()).
const MESSAGE_RETURN_TYPES = new Set(['void', 'IEnumerator', 'Awaitable']);

const LITERAL_KEYWORDS = new Set(['true', 'false', 'null', 'True', 'False', 'Null', 'NULL', 'yes', 'no', 'on', 'off', '~']);

// 파일 확장자 → 말 갈래(원본 LanguageOf 의 표).
const LANGUAGE_BY_EXTENSION = new Map();
for (const [language, extensions] of [
  ['csharp', '.cs'],
  ['clike', '.shader .hlsl .cginc .compute .glsl .js .ts .java .c .h .cpp .hpp .mm .m .rs .go .kt .swift .jslib .jspre'],
  ['css', '.uss .tss .css .scss'],
  ['json', '.json .asmdef .asmref .inputactions .shadergraph .shadersubgraph .vfx'],
  ['yaml', '.yaml .yml .asset .prefab .unity .meta .mat .anim .controller .overridecontroller .mask .physicmaterial .lighting .playable .signal'
    + ' .preset .spriteatlas .spriteatlasv2'],
  ['xml', '.xml .uxml .csproj .props .targets .xaml .svg'],
  ['html', '.html .htm .xhtml'],
]) {
  for (const extension of extensions.split(' ')) LANGUAGE_BY_EXTENSION.set(extension, language);
}

/** 파일 확장자로 말 갈래를 고른다. 색칠하지 않는 파일은 null. */
export function languageOf(path) {
  return LANGUAGE_BY_EXTENSION.get(extensionOf(path ?? '').toLowerCase()) ?? null;
}

// .NET Path.GetExtension 처럼 마지막 경로 조각의 마지막 . 부터(. 로 끝나면 빈 글).
function extensionOf(path) {
  for (let i = path.length - 1; i >= 0; i--) {
    const c = path[i];
    if (c === '.') return i === path.length - 1 ? '' : path.slice(i);
    if (c === '/' || c === '\\') break;
  }
  return '';
}

/**
 * 한 줄을 훑어 색칠 조각을 돌려준다(plain 은 넣지 않는다).
 * state 는 줄 시작 상태(앞 줄이 돌려준 state, 첫 줄은 STATE_NORMAL), 돌려주는 state 는 줄 끝 상태.
 */
export function tokenize(line, language, state = STATE_NORMAL) {
  const spans = [];
  const end = tokenizeInto(line ?? '', language, state, spans);
  return { spans, state: end };
}

/** 줄마다 색칠한 HTML(글은 이스케이프, 색 조각은 <span class="sx-<kind>">). 줄 끝 상태를 다음 줄에 넘긴다. */
export function highlightLines(lines, language, state = STATE_NORMAL) {
  const out = new Array(lines.length);
  const spans = [];
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] ?? '';
    spans.length = 0;
    state = tokenizeInto(line, language, state, spans);
    out[n] = render(line, spans);
  }
  return out;
}

/**
 * 글 전체를 색칠한다. ui/tools.js 의 블레임 · 코드 편집기가 줄 번호로 꺼내 쓰므로 줄별 HTML 배열이고,
 * 글로 바꾸면(innerHTML · 템플릿 문자열) 줄을 "\n" 으로 이은 HTML 전체가 된다.
 */
export function highlight(text, language) {
  const lines = highlightLines(String(text ?? '').split('\n'), language);
  Object.defineProperty(lines, 'toString', { value() { return this.join('\n'); } });
  return lines;
}

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 원본 GitCodeEditor.RenderLine 처럼 조각 사이는 그냥 글, 조각은 색으로 감싼다.
function render(line, spans) {
  let html = '';
  let position = 0;
  for (const span of spans) {
    const start = Math.max(span.start, position);
    const end = span.start + span.length;
    if (end <= start) continue;
    if (start > position) html += esc(line.slice(position, start));
    html += `<span class="sx-${span.kind}">${esc(line.slice(start, end))}</span>`;
    position = end;
  }
  if (position < line.length) html += esc(line.slice(position));
  return html;
}

function tokenizeInto(line, language, state, spans) {
  switch (language) {
    case 'clike':
      return tokenizeCLike(line, state, spans);
    case 'csharp':
      return tokenizeCLike(line, state, spans, true);
    case 'css':
      return tokenizeCss(line, state, spans);
    case 'json':
      tokenizeJson(line, spans);
      return STATE_NORMAL;
    case 'yaml':
      tokenizeYaml(line, spans);
      return STATE_NORMAL;
    case 'xml':
      return tokenizeXml(line, state, spans);
    case 'html':
      return tokenizeHtml(line, state, spans);
    default:
      return STATE_NORMAL;
  }
}

// ── C 계열 · C# ──

/** csharp 이면 Unity · C# 타입 · 어트리뷰트 · 메시지 메서드도 칠한다(classifyCSharpName). */
function tokenizeCLike(line, state, spans, csharp = false) {
  let i = 0;
  const length = line.length;
  // C# 어트리뷰트 줄([SerializeField] · [Header("a"), Range(0, 1)]): [ ] 와 ( ) 깊이로 어트리뷰트 이름 자리를 고른다.
  let attributeLine = false;
  let bracketDepth = 0;
  let parenDepth = 0;
  if (state === STATE_BLOCK_COMMENT) {
    const close = line.indexOf('*/');
    if (close < 0) {
      add(spans, 0, length, 'comment');
      return STATE_BLOCK_COMMENT;
    }
    add(spans, 0, close + 2, 'comment');
    i = close + 2;
  }
  // 줄 첫 글자가 #(전처리기 · 셰이더 #pragma)이면 그 낱말을 키워드 색으로.
  const firstNonSpace = skipWhitespace(line, 0);
  if (i <= firstNonSpace && firstNonSpace < length && line[firstNonSpace] === '#') {
    let end = firstNonSpace + 1;
    while (end < length && isLetter(line[end])) end++;
    add(spans, firstNonSpace, end - firstNonSpace, 'keyword');
    i = end;
  }
  if (csharp && i <= firstNonSpace && firstNonSpace < length && line[firstNonSpace] === '[') attributeLine = true;
  while (i < length) {
    const c = line[i];
    if (c === '/' && i + 1 < length && line[i + 1] === '/') {
      add(spans, i, length - i, 'comment');
      return STATE_NORMAL;
    }
    if (c === '/' && i + 1 < length && line[i + 1] === '*') {
      const close = line.indexOf('*/', i + 2);
      if (close < 0) {
        add(spans, i, length - i, 'comment');
        return STATE_BLOCK_COMMENT;
      }
      add(spans, i, close + 2 - i, 'comment');
      i = close + 2;
      continue;
    }
    if (c === '"' || c === '\'') {
      // C# 의 @"..." 는 \ 를 풀지 않는다.
      const verbatim = i > 0 && line[i - 1] === '@';
      const end = stringEnd(line, i, c, !verbatim);
      const start = verbatim ? i - 1 : i;
      add(spans, start, end - start, 'string');
      i = end;
      continue;
    }
    if (isDigit(c) && (i === 0 || !isWordChar(line[i - 1]))) {
      const end = numberEnd(line, i);
      add(spans, i, end - i, 'number');
      i = end;
      continue;
    }
    if (isWordStart(c)) {
      let end = i + 1;
      while (end < length && isWordChar(line[end])) end++;
      const word = line.slice(i, end);
      if (CSHARP_KEYWORDS.has(word) || (csharp && CSHARP_ONLY_KEYWORDS.has(word))) {
        add(spans, i, end - i, 'keyword');
      } else if (csharp) {
        const attributeSlot = attributeLine && bracketDepth > 0 && parenDepth === 0;
        const kind = classifyCSharpName(line, i, end, word, attributeSlot);
        if (kind !== 'plain') add(spans, i, end - i, kind);
      }
      i = end;
      continue;
    }
    if (csharp) {
      if (c === '[') bracketDepth++;
      else if (c === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (c === '(') parenDepth++;
      else if (c === ')') parenDepth = Math.max(0, parenDepth - 1);
    }
    i++;
  }
  return STATE_NORMAL;
}

/**
 * C# 낱말 하나(키워드가 아닌 것)를 Unity · C# 타입(type) · 메시지 메서드(function)로 칠할지 고른다.
 * 줄 하나만 보고 고르므로, 애매하면 칠하지 않는다.
 * - 타입 표(isUnityType)에 있어도 . 바로 뒤(arr.Length) · 호출(Foo()) · 대입(X = 1) · 선언된 이름(Camera Camera)은 칠하지 않는다.
 * - 예외: UnityEngine.Debug 처럼 . 앞이 네임스페이스면 타입, new Vector3( 는 타입.
 * - 어트리뷰트 줄의 [ 바로 뒤 · , 뒤 이름은 어트리뷰트 표(isUnityAttribute)로 본다.
 * - 메시지 메서드는 void · IEnumerator · Awaitable 뒤의 선언(void Update())만.
 */
function classifyCSharpName(line, start, end, word, attributeSlot) {
  // Unity · C# 타입과 메시지는 모두 대문자로 시작한다. 지역 변수 · 필드는 여기서 바로 빠진다.
  if (!isUpper(word[0])) return 'plain';
  const before = previousNonWhitespaceIndex(line, start);
  const previous = before >= 0 ? line[before] : '\0';
  if (attributeSlot && (previous === '[' || previous === ',' || previous === ':') && isUnityAttribute(word)) return 'type';
  const previousWord = wordEndingAt(line, before);
  const after = skipWhitespace(line, end);
  const next = after < line.length ? line[after] : '\0';
  if (next === '(') {
    if (previousWord != null && MESSAGE_RETURN_TYPES.has(previousWord) && isUnityMessage(word)) return 'function';
    return previousWord === 'new' && isUnityType(word) ? 'type' : 'plain';
  }
  if (previous === '.') {
    // . 앞 낱말이 네임스페이스 조각(UnityEngine · SceneManagement · Generic)일 때만 타입. 그 밖은 멤버(arr.Length · transform.position).
    const qualifier = wordEndingAt(line, previousNonWhitespaceIndex(line, before));
    if (qualifier == null || !isUnityNamespaceSegment(qualifier)) return 'plain';
  } else if (previousWord != null && !CSHARP_KEYWORDS.has(previousWord) && !CSHARP_ONLY_KEYWORDS.has(previousWord)) {
    // 앞이 키워드가 아닌 이름이면 이 낱말은 선언된 이름이다(public Camera Camera { get; }).
    return 'plain';
  }
  if (next === '=' && (after + 1 >= line.length || (line[after + 1] !== '=' && line[after + 1] !== '>'))) {
    // Rigidbody = x 는 같은 이름의 속성 · 변수에 대입하는 것.
    return 'plain';
  }
  return isUnityType(word) ? 'type' : 'plain';
}

/** index 앞(그 자리는 빼고)에서 공백이 아닌 마지막 글자 자리. 없으면 -1. */
function previousNonWhitespaceIndex(line, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (line[i] !== ' ' && line[i] !== '\t') return i;
  }
  return -1;
}

/** last 자리에서 끝나는 낱말. 그 자리가 낱말 글자가 아니면 null. */
function wordEndingAt(line, last) {
  if (last < 0 || !isWordChar(line[last])) return null;
  let first = last;
  while (first > 0 && isWordChar(line[first - 1])) first--;
  return isWordStart(line[first]) ? line.slice(first, last + 1) : null;
}

// ── CSS · USS · TSS ──

/**
 * CSS · USS · TSS 한 줄. 선택자 자리와 선언 자리를 나눠 칠한다.
 * - 선택자: 타입(Button) = 태그 색, .클래스 · #아이디 = 속성 색, :hover · :root = 키워드 색, > * = 기호 색.
 * - 선언: 속성 이름(color · -unity-font-style · --변수) = 키 색, 숫자 · 단위 · #색 = 숫자 색, url() · resource() · var() 같은 함수 이름 = 키워드 색.
 * - @import 같은 at-규칙 = 키워드 색.
 * diff 는 묶음 중간(블록 안)부터 보이기도 하므로 { · } 깊이를 줄 사이에 넘기지 않고 줄 모양으로 고른다:
 * { 앞은 선택자, { 뒤 · } 앞은 선언, 괄호 없는 줄은 ", " 로 끝나고 ": " 가 없으면 선택자 목록의 한 줄, 아니면 선언.
 */
function tokenizeCss(line, state, spans) {
  let i = 0;
  const length = line.length;
  if (state === STATE_BLOCK_COMMENT) {
    const close = line.indexOf('*/');
    if (close < 0) {
      add(spans, 0, length, 'comment');
      return STATE_BLOCK_COMMENT;
    }
    add(spans, 0, close + 2, 'comment');
    i = close + 2;
  }
  let selector = startsInSelector(line, i);
  // 선언 자리에서 ':' 를 지났는지(값 자리). 값 자리의 낱말은 속성 이름이 아니다.
  const value = { inValue: false };
  while (i < length) {
    const c = line[i];
    if (c === '/' && i + 1 < length && line[i + 1] === '*') {
      const close = line.indexOf('*/', i + 2);
      if (close < 0) {
        add(spans, i, length - i, 'comment');
        return STATE_BLOCK_COMMENT;
      }
      add(spans, i, close + 2 - i, 'comment');
      i = close + 2;
      continue;
    }
    if (c === '"' || c === '\'') {
      const end = stringEnd(line, i, c, true);
      add(spans, i, end - i, 'string');
      i = end;
      continue;
    }
    if (c === '{') {
      selector = false;
      value.inValue = false;
      i++;
      continue;
    }
    if (c === '}') {
      selector = true;
      i++;
      continue;
    }
    if (c === '@' && i + 1 < length && isWordStart(line[i + 1])) {
      const end = cssIdentifierEnd(line, i + 1);
      add(spans, i, end - i, 'keyword');
      // @import url(...) 의 뒤는 값처럼 칠한다(함수 이름 · 문자열).
      selector = false;
      value.inValue = true;
      i = end;
      continue;
    }
    i = selector ? tokenizeCssSelector(line, i, spans) : tokenizeCssDeclaration(line, i, value, spans);
  }
  return STATE_NORMAL;
}

/** 줄의 start 자리가 선택자 자리인지. 처음 만나는 { · } · ; 로 고르고, 없으면 줄 모양으로 고른다. */
function startsInSelector(line, start) {
  for (let i = start; i < line.length; i++) {
    const c = line[i];
    if (c === '"' || c === '\'') {
      i = stringEnd(line, i, c, true) - 1;
      continue;
    }
    if (c === '/' && i + 1 < line.length && line[i + 1] === '*') {
      const close = line.indexOf('*/', i + 2);
      if (close < 0) break;
      i = close + 1;
      continue;
    }
    if (c === '{') return true;
    if (c === '}' || c === ';') return false;
  }
  // 괄호 · ; 가 없는 줄: "Button:hover," 처럼 , 로 끝나는 선택자 목록 줄. "a: b," 처럼 ": " 가 있으면 여러 줄 값.
  const trimmed = stripCssComments(line, start).trimEnd();
  return trimmed.endsWith(',') && !trimmed.includes(': ');
}

function stripCssComments(line, start) {
  let out = '';
  for (let i = start; i < line.length; i++) {
    if (line[i] === '/' && i + 1 < line.length && line[i + 1] === '*') {
      const close = line.indexOf('*/', i + 2);
      if (close < 0) break;
      i = close + 1;
      continue;
    }
    out += line[i];
  }
  return out;
}

/** 선택자 조각 하나를 칠하고 다음에 볼 자리를 돌려준다(공백 · { · } 앞에서 멈춘다). */
function tokenizeCssSelector(line, i, spans) {
  const length = line.length;
  const c = line[i];
  if ((c === '.' || c === '#') && i + 1 < length && isCssIdentifierStart(line[i + 1])) {
    const end = cssIdentifierEnd(line, i + 1);
    add(spans, i, end - i, 'attribute');
    return end;
  }
  if (c === ':' && i + 1 < length && (isWordStart(line[i + 1]) || line[i + 1] === ':')) {
    const start = i;
    let end = i + 1;
    if (line[end] === ':') end++;
    end = cssIdentifierEnd(line, end);
    add(spans, start, end - start, 'keyword');
    return end;
  }
  if (isCssIdentifierStart(c)) {
    const end = cssIdentifierEnd(line, i);
    add(spans, i, end - i, 'tag');
    return end;
  }
  if (c === '>' || c === '*' || c === '+' || c === '~' || c === ',') add(spans, i, 1, 'punctuation');
  return i + 1;
}

/** 선언 조각 하나(속성 이름, 값 안의 숫자 · #색 · 함수 이름 · 따옴표 없는 url(...))를 칠하고 다음에 볼 자리를 돌려준다. */
function tokenizeCssDeclaration(line, i, value, spans) {
  const length = line.length;
  const c = line[i];
  if (c === ':') {
    value.inValue = true;
    return i + 1;
  }
  if (c === ';') {
    value.inValue = false;
    return i + 1;
  }
  if (!value.inValue && (isCssIdentifierStart(c) || c === '-')) {
    const end = cssIdentifierEnd(line, i);
    const next = skipWhitespace(line, end);
    // color · -unity-text-align · --git-text 모두 속성 이름.
    if (end > i && next < length && line[next] === ':') add(spans, i, end - i, 'key');
    return Math.max(end, i + 1);
  }
  if (!value.inValue) return i + 1;
  if (c === '#') {
    let end = i + 1;
    while (end < length && isHexDigit(line[end])) end++;
    const digits = end - i - 1;
    const isColor = (digits === 3 || digits === 4 || digits === 6 || digits === 8) && (end >= length || !isCssIdentifierChar(line[end]));
    if (isColor) {
      add(spans, i, end - i, 'number');
      return end;
    }
    return cssIdentifierEnd(line, i + 1);
  }
  const signedNumber = (c === '-' || c === '+' || c === '.') && i + 1 < length && isDigit(line[i + 1]);
  if ((isDigit(c) || signedNumber) && (i === 0 || !isCssIdentifierChar(line[i - 1]))) {
    let end = numberEnd(line, isDigit(c) ? i : i + 1);
    if (end < length && line[end] === '%') end++;
    add(spans, i, end - i, 'number');
    return end;
  }
  if (isCssIdentifierStart(c) || c === '-') {
    const end = cssIdentifierEnd(line, i);
    if (end > i && end < length && line[end] === '(') {
      // url() · resource() · var() · rgb() 같은 함수 이름. url · resource 의 따옴표 없는 인자는 문자열 색.
      add(spans, i, end - i, 'keyword');
      const name = line.slice(i, end);
      const argument = skipWhitespace(line, end + 1);
      const isPath = equalsIgnoreCase(name, 'url') || equalsIgnoreCase(name, 'resource');
      if (isPath && argument < length && line[argument] !== '"' && line[argument] !== '\'' && line[argument] !== ')') {
        const close = line.indexOf(')', argument);
        const stop = close < 0 ? length : close;
        add(spans, argument, stop - argument, 'string');
        return stop;
      }
      return end + 1;
    }
    return Math.max(end, i + 1);
  }
  return i + 1;
}

const isCssIdentifierStart = (c) => isLetter(c) || c === '_';
const isCssIdentifierChar = (c) => isLetterOrDigit(c) || c === '_' || c === '-';

/** start 부터 CSS 이름(-unity-font · --git-text · unity-scroller__slider)이 끝난 자리. */
function cssIdentifierEnd(line, start) {
  let i = start;
  while (i < line.length && isCssIdentifierChar(line[i])) i++;
  return i;
}

// ── JSON · YAML ──

function tokenizeJson(line, spans) {
  let i = 0;
  const length = line.length;
  while (i < length) {
    const c = line[i];
    if (c === '/' && i + 1 < length && line[i + 1] === '/') {
      add(spans, i, length - i, 'comment');
      return;
    }
    if (c === '"') {
      const end = stringEnd(line, i, '"', true);
      const next = skipWhitespace(line, end);
      add(spans, i, end - i, next < length && line[next] === ':' ? 'key' : 'string');
      i = end;
      continue;
    }
    if (isDigit(c) || (c === '-' && i + 1 < length && isDigit(line[i + 1]))) {
      const end = numberEnd(line, c === '-' ? i + 1 : i);
      add(spans, i, end - i, 'number');
      i = end;
      continue;
    }
    if (isWordStart(c)) {
      let end = i + 1;
      while (end < length && isWordChar(line[end])) end++;
      if (LITERAL_KEYWORDS.has(line.slice(i, end))) add(spans, i, end - i, 'keyword');
      i = end;
      continue;
    }
    i++;
  }
}

function tokenizeYaml(line, spans) {
  const length = line.length;
  let i = skipWhitespace(line, 0);
  if (i >= length) return;
  if (line[i] === '#') {
    add(spans, i, length - i, 'comment');
    return;
  }
  // 문서 머리(--- !u!1 &123) · 지시문(%YAML)은 키워드 색으로.
  if (line[i] === '%' || line.startsWith('---')) {
    add(spans, i, length - i, 'keyword');
    return;
  }
  if (line[i] === '-' && i + 1 < length && line[i + 1] === ' ') i = skipWhitespace(line, i + 1);
  // 키: "이름:" 뒤가 공백 · 줄 끝.
  const colon = keyColon(line, i);
  if (colon > i) {
    add(spans, i, colon - i, 'key');
    i = colon + 1;
  }
  tokenizeYamlValue(line, i, spans);
}

function tokenizeYamlValue(line, i, spans) {
  const length = line.length;
  while (i < length) {
    const c = line[i];
    if (c === '#' && (i === 0 || line[i - 1] === ' ')) {
      add(spans, i, length - i, 'comment');
      return;
    }
    if (c === '"' || c === '\'') {
      const end = stringEnd(line, i, c, c === '"');
      add(spans, i, end - i, 'string');
      i = end;
      continue;
    }
    if ((isDigit(c) || (c === '-' && i + 1 < length && isDigit(line[i + 1]))) && (i === 0 || !isWordChar(line[i - 1]))) {
      let end = numberEnd(line, c === '-' ? i + 1 : i);
      // 숫자로 시작해도 낱말이 이어지면(guid 등) 숫자가 아니다.
      if (end >= length || !isWordChar(line[end])) add(spans, i, end - i, 'number');
      else while (end < length && isWordChar(line[end])) end++;
      i = end;
      continue;
    }
    if (isWordStart(c)) {
      let end = i + 1;
      while (end < length && isWordChar(line[end])) end++;
      if (LITERAL_KEYWORDS.has(line.slice(i, end))) add(spans, i, end - i, 'keyword');
      i = end;
      continue;
    }
    i++;
  }
}

/** start 부터 YAML 키의 ':' 자리. 키가 아니면 -1. 따옴표 키("a b": 1)도 받는다. */
function keyColon(line, start) {
  const length = line.length;
  let i = start;
  if (i < length && (line[i] === '"' || line[i] === '\'')) i = stringEnd(line, i, line[i], line[i] === '"');
  for (; i < length; i++) {
    const c = line[i];
    if (c === ':' && (i + 1 === length || line[i + 1] === ' ')) return i;
    if (c === '#' || c === '{' || c === '[' || c === '"' || c === '\'') return -1;
  }
  return -1;
}

// ── XML · HTML ──

function tokenizeXml(line, state, spans) {
  let i = 0;
  const length = line.length;
  if (state === STATE_BLOCK_COMMENT) {
    const close = line.indexOf('-->');
    if (close < 0) {
      add(spans, 0, length, 'comment');
      return STATE_BLOCK_COMMENT;
    }
    add(spans, 0, close + 3, 'comment');
    i = close + 3;
  }
  let inTag = false;
  while (i < length) {
    const c = line[i];
    if (c === '<' && line.startsWith('<!--', i)) {
      const close = line.indexOf('-->', i + 4);
      if (close < 0) {
        add(spans, i, length - i, 'comment');
        return STATE_BLOCK_COMMENT;
      }
      add(spans, i, close + 3 - i, 'comment');
      i = close + 3;
      continue;
    }
    if (c === '<') {
      let start = i + 1;
      if (start < length && (line[start] === '/' || line[start] === '?' || line[start] === '!')) start++;
      let end = start;
      while (end < length && (isWordChar(line[end]) || line[end] === ':' || line[end] === '.' || line[end] === '-')) end++;
      add(spans, start, end - start, 'key');
      inTag = true;
      i = end;
      continue;
    }
    if (c === '>') {
      inTag = false;
    } else if (inTag && (c === '"' || c === '\'')) {
      const end = stringEnd(line, i, c, false);
      add(spans, i, end - i, 'string');
      i = end;
      continue;
    }
    i++;
  }
  return STATE_NORMAL;
}

/**
 * HTML 한 줄. GitKraken 처럼 꺾쇠(< >) · 태그 이름 · 속성 이름 · 속성 값을 따로 칠한다.
 * <script> · <style> 의 내용은 닫는 태그까지 JS(tokenizeCLike) · CSS 로 칠한다.
 */
function tokenizeHtml(line, state, spans) {
  let i = 0;
  const length = line.length;
  const tag = { state };
  while (i < length) {
    switch (tag.state) {
      case STATE_BLOCK_COMMENT: {
        const close = line.indexOf('-->', i);
        if (close < 0) {
          add(spans, i, length - i, 'comment');
          return STATE_BLOCK_COMMENT;
        }
        add(spans, i, close + 3 - i, 'comment');
        i = close + 3;
        tag.state = STATE_NORMAL;
        continue;
      }
      case STATE_HTML_SCRIPT:
      case STATE_HTML_SCRIPT_COMMENT:
      case STATE_HTML_STYLE:
      case STATE_HTML_STYLE_COMMENT: {
        const isScript = tag.state === STATE_HTML_SCRIPT || tag.state === STATE_HTML_SCRIPT_COMMENT;
        const inComment = tag.state === STATE_HTML_SCRIPT_COMMENT || tag.state === STATE_HTML_STYLE_COMMENT;
        const close = indexOfIgnoreCase(line, isScript ? '</script' : '</style', i);
        const end = close < 0 ? length : close;
        const inner = tokenizeEmbedded(line, i, end, !isScript, inComment ? STATE_BLOCK_COMMENT : STATE_NORMAL, spans);
        if (close < 0) {
          const endsInComment = inner === STATE_BLOCK_COMMENT;
          if (isScript) return endsInComment ? STATE_HTML_SCRIPT_COMMENT : STATE_HTML_SCRIPT;
          return endsInComment ? STATE_HTML_STYLE_COMMENT : STATE_HTML_STYLE;
        }
        i = close;
        tag.state = STATE_NORMAL;
        continue;
      }
      case STATE_HTML_TAG:
      case STATE_HTML_SCRIPT_TAG:
      case STATE_HTML_STYLE_TAG:
        i = tokenizeHtmlTagBody(line, i, tag, spans);
        continue;
      default:
        break;
    }
    // 보통 글: 다음 < 까지는 칠하지 않는다.
    const open = line.indexOf('<', i);
    if (open < 0) return STATE_NORMAL;
    i = open;
    if (line.startsWith('<!--', i)) {
      tag.state = STATE_BLOCK_COMMENT;
      continue;
    }
    const after = i + 1 < length ? line[i + 1] : '\0';
    const closing = after === '/';
    const bang = after === '!';
    // </ 는 꺾쇠 색, <!DOCTYPE 의 ! 는 태그 이름 쪽에 붙여 칠한다(GitKraken 과 같다).
    const punctuationEnd = closing ? i + 2 : i + 1;
    const nameStart = closing || bang ? i + 2 : i + 1;
    let nameEnd = nameStart;
    while (nameEnd < length && isHtmlNameChar(line[nameEnd])) nameEnd++;
    if (nameEnd === nameStart) {
      // "a < b" 처럼 태그가 아닌 < 는 그냥 글.
      i++;
      continue;
    }
    add(spans, i, punctuationEnd - i, 'punctuation');
    add(spans, punctuationEnd, nameEnd - punctuationEnd, 'tag');
    const name = line.slice(nameStart, nameEnd);
    tag.state = closing ? STATE_HTML_TAG
      : equalsIgnoreCase(name, 'script') ? STATE_HTML_SCRIPT_TAG
        : equalsIgnoreCase(name, 'style') ? STATE_HTML_STYLE_TAG
          : STATE_HTML_TAG;
    i = nameEnd;
  }
  return tag.state;
}

/**
 * 여는 · 닫는 태그의 이름 뒤(속성들). > 를 만나면 태그가 끝나고, <script> · <style> 이면 그 내용 상태로 넘어간다(tag.state).
 * 다음에 볼 자리를 돌려준다.
 */
function tokenizeHtmlTagBody(line, i, tag, spans) {
  const length = line.length;
  while (i < length) {
    const c = line[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '>' || (c === '/' && i + 1 < length && line[i + 1] === '>')) {
      const selfClosing = c === '/';
      const end = selfClosing ? i + 2 : i + 1;
      add(spans, i, end - i, 'punctuation');
      tag.state = selfClosing ? STATE_NORMAL
        : tag.state === STATE_HTML_SCRIPT_TAG ? STATE_HTML_SCRIPT
          : tag.state === STATE_HTML_STYLE_TAG ? STATE_HTML_STYLE
            : STATE_NORMAL;
      return end;
    }
    if (c === '=') {
      add(spans, i, 1, 'punctuation');
      i++;
      continue;
    }
    if (c === '"' || c === '\'') {
      const end = stringEnd(line, i, c, false);
      add(spans, i, end - i, 'string');
      i = end;
      continue;
    }
    const start = i;
    const isValue = start > 0 && previousNonWhitespace(line, start) === '=';
    while (i < length && line[i] !== ' ' && line[i] !== '\t' && line[i] !== '>' && line[i] !== '=' && line[i] !== '"' && line[i] !== '\''
      && (line[i] !== '/' || i + 1 >= length || line[i + 1] !== '>')) i++;
    if (i === start) {
      i++;
      continue;
    }
    // 따옴표 없는 값(width=10)은 값 색, 나머지는 속성 이름(<!DOCTYPE html> 의 html 도).
    add(spans, start, i - start, isValue ? 'string' : 'attribute');
  }
  return i;
}

/** 줄의 [from, to)를 JS · CSS 로 칠한다(조각 자리는 줄 기준). 그 구간 끝 상태(STATE_NORMAL · STATE_BLOCK_COMMENT)를 돌려준다. */
function tokenizeEmbedded(line, from, to, isCss, state, spans) {
  if (to <= from) return state;
  const inner = [];
  const part = line.slice(from, to);
  const end = isCss ? tokenizeCss(part, state, inner) : tokenizeCLike(part, state, inner);
  for (const span of inner) spans.push({ start: span.start + from, length: span.length, kind: span.kind });
  return end;
}

function previousNonWhitespace(line, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (line[i] !== ' ' && line[i] !== '\t') return line[i];
  }
  return '\0';
}

const isHtmlNameChar = (c) => isLetterOrDigit(c) || c === '-' || c === '_' || c === ':' || c === '.';

// ── 공용 ──

/** start 의 따옴표로 시작한 문자열이 끝난 바로 뒤 자리(닫지 않았으면 줄 끝). */
function stringEnd(line, start, quote, backslashEscapes) {
  let i = start + 1;
  while (i < line.length) {
    const c = line[i];
    if (backslashEscapes && c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) {
      // @"..." 와 YAML '...' 는 따옴표 두 개가 따옴표 하나다.
      if (!backslashEscapes && i + 1 < line.length && line[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return line.length;
}

function numberEnd(line, start) {
  let i = start;
  if (i + 1 < line.length && line[i] === '0' && (line[i + 1] === 'x' || line[i + 1] === 'X')) {
    i += 2;
    while (i < line.length && isHexDigit(line[i])) i++;
    return i;
  }
  while (i < line.length && (isDigit(line[i]) || line[i] === '.' || line[i] === '_')) {
    if (line[i] === '.' && (i + 1 >= line.length || !isDigit(line[i + 1]))) break;
    i++;
  }
  if (i < line.length && (line[i] === 'e' || line[i] === 'E')) {
    let exponent = i + 1;
    if (exponent < line.length && (line[exponent] === '+' || line[exponent] === '-')) exponent++;
    if (exponent < line.length && isDigit(line[exponent])) {
      i = exponent;
      while (i < line.length && isDigit(line[i])) i++;
    }
  }
  // 접미사(1f, 10UL, 2px).
  while (i < line.length && isLetter(line[i]) && i - start < 32) i++;
  return i;
}

function skipWhitespace(line, start) {
  let i = start;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

// .NET char.IsLetter · IsDigit · IsUpper 처럼 유니코드 갈래(L · Nd · Lu)로 본다. ASCII 는 빨리 고른다.
const LETTER = /\p{L}/u;
const DECIMAL_DIGIT = /\p{Nd}/u;
const UPPERCASE = /\p{Lu}/u;

function isLetter(c) {
  const n = c.charCodeAt(0);
  if (n < 128) return (n >= 65 && n <= 90) || (n >= 97 && n <= 122);
  return LETTER.test(c);
}

function isDigit(c) {
  const n = c.charCodeAt(0);
  if (n < 128) return n >= 48 && n <= 57;
  return DECIMAL_DIGIT.test(c);
}

function isUpper(c) {
  const n = c.charCodeAt(0);
  if (n < 128) return n >= 65 && n <= 90;
  return UPPERCASE.test(c);
}

const isLetterOrDigit = (c) => isLetter(c) || isDigit(c);
const isWordStart = (c) => isLetter(c) || c === '_';
const isWordChar = (c) => isLetterOrDigit(c) || c === '_';
const isHexDigit = (c) => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');

// .NET OrdinalIgnoreCase 처럼 글자마다 대문자로 맞춰 비교한다.
function equalsIgnoreCase(a, b) {
  return a.length === b.length && a.toUpperCase() === b.toUpperCase();
}

function indexOfIgnoreCase(line, needle, from) {
  const upper = needle.toUpperCase();
  for (let i = from; i + upper.length <= line.length; i++) {
    let k = 0;
    while (k < upper.length && line[i + k].toUpperCase() === upper[k]) k++;
    if (k === upper.length) return i;
  }
  return -1;
}

function add(spans, start, length, kind) {
  if (length > 0) spans.push({ start, length, kind });
}

// ── Unity API 이름 표(원본 GitUnityApi) ──
// - 타입: 에디터에 올라온 UnityEngine* · UnityEditor* 어셈블리의 공개 최상위 타입과 자주 쓰는 C# 기본 타입.
// - 흔한 이름은 뺀다: .NET 의 속성 · 메서드 이름과 같은 이름(Length · Position · State 등)과 COMMON_NAMES.
//   사용자 코드의 속성 · 변수 이름을 Unity 타입으로 잘못 칠하지 않으려는 것이다. 단 CORE_NAMES(Debug · Time 등)는 남긴다.
// - 어트리뷰트: [ ] 안에서만 쓰는 이름 표. 그 자리는 어트리뷰트만 올 수 있어 흔한 이름(Range 등)도 남긴다.
// - 메시지: Awake · Update 같은 Unity 메시지 메서드 이름(선언 자리에서만 칠한다).
// 원본은 처음 쓸 때 리플렉션으로 표를 만들지만 웹뷰에는 Unity 가 없으므로, 리플렉션으로 얻는 몫(UNITY_TYPES · UNITY_MEMBER_NAMES ·
// UNITY_ATTRIBUTES · UNITY_NAMESPACES)은 원본 Build 와 같은 규칙으로 Unity 6000.3.25f1 에디터 어셈블리(+ UI · TestRunner 패키지)에서 뽑아
// 아래에 실었다. 손으로 고른 목록과 거르는 순서는 원본 그대로다.

/** Unity · C# 타입 이름인지(흔한 이름은 뺀 표). */
export function isUnityType(name) {
  return !!name && unityTables().types.has(name);
}

/** [ ] 안에 올 수 있는 어트리뷰트 이름인지(SerializeField · Header · HeaderAttribute · Range). */
export function isUnityAttribute(name) {
  return !!name && unityTables().attributes.has(name);
}

/** Unity 메시지 메서드 이름인지(Awake · Update · OnTriggerEnter). */
export function isUnityMessage(name) {
  return !!name && MESSAGES.has(name);
}

/** UnityEngine · SceneManagement · Generic 처럼 네임스페이스 조각인지. UnityEngine.Debug 의 Debug 를 칠할지 고를 때 쓴다. */
export function isUnityNamespaceSegment(name) {
  return !!name && unityTables().namespaces.has(name);
}

let tables = null;

/** 처음 쓸 때 한 번 표를 만든다(원본 Lazy<Tables>). */
function unityTables() {
  if (tables) return tables;
  const types = new Set(words(UNITY_TYPES));
  // .NET 멤버 이름과 겹치는지는 Unity 이름에만 본다. C# 기본 타입은 손으로 고른 목록이라(Exception · Comparer 도 멤버 이름이다) 그대로 둔다.
  const common = new Set(COMMON_NAMES);
  for (const name of words(UNITY_MEMBER_NAMES)) common.add(name);
  for (const name of CORE_NAMES) common.delete(name);
  for (const name of common) types.delete(name);
  for (const name of CSHARP_TYPES) types.add(name);
  tables = {
    types,
    attributes: new Set([...words(UNITY_ATTRIBUTES), ...CSHARP_ATTRIBUTES]),
    namespaces: new Set([...words(UNITY_NAMESPACES), ...CSHARP_NAMESPACES]),
  };
  return tables;
}

function words(text) {
  return text.split(/\s+/).filter(Boolean);
}

// 자주 쓰는 C# 기본 라이브러리 타입. 리플렉션으로 고르면 흔한 이름이 너무 많이 섞여 손으로 고른다.
const CSHARP_TYPES = [
  'List', 'Dictionary', 'HashSet', 'Queue', 'Stack', 'LinkedList', 'SortedDictionary', 'SortedList', 'SortedSet', 'KeyValuePair',
  'IEnumerable', 'IEnumerator', 'ICollection', 'IList', 'IDictionary', 'ISet', 'IReadOnlyList', 'IReadOnlyCollection', 'IReadOnlyDictionary',
  'IComparer', 'IEqualityComparer', 'IComparable', 'IEquatable', 'IDisposable', 'IAsyncDisposable', 'IAsyncEnumerable',
  'Action', 'Func', 'Predicate', 'Comparison', 'EventHandler', 'EventArgs',
  'Task', 'ValueTask', 'CancellationToken', 'CancellationTokenSource',
  'Exception', 'ArgumentException', 'ArgumentNullException', 'ArgumentOutOfRangeException', 'InvalidOperationException',
  'NotImplementedException', 'NotSupportedException', 'NullReferenceException', 'IndexOutOfRangeException', 'KeyNotFoundException',
  'ObjectDisposedException', 'OperationCanceledException', 'FormatException', 'TimeoutException',
  'StringBuilder', 'Math', 'MathF', 'Span', 'ReadOnlySpan', 'Memory', 'ReadOnlyMemory',
  'DateTime', 'DateTimeOffset', 'TimeSpan', 'Guid', 'Tuple', 'ValueTuple', 'Nullable', 'Enum', 'Convert', 'BitConverter',
  'Stopwatch', 'Regex', 'Encoding', 'StringComparer', 'StringComparison', 'EqualityComparer', 'Comparer',
  'Lazy', 'WeakReference', 'Interlocked', 'Enumerable', 'Array', 'Activator', 'IntPtr', 'UIntPtr', 'Console', 'Environment',
];

// C# · .NET 쪽 어트리뷰트 가운데 Unity 코드에 흔한 것.
const CSHARP_ATTRIBUTES = [
  'Serializable', 'NonSerialized', 'Obsolete', 'Flags', 'Conditional', 'MethodImpl', 'StructLayout', 'FieldOffset',
  'SerializableAttribute', 'NonSerializedAttribute', 'ObsoleteAttribute', 'FlagsAttribute',
];

// 리플렉션으로 넣지 않는 네임스페이스 조각(System.Collections.Generic.List 의 List 를 칠하려고).
const CSHARP_NAMESPACES = [
  'System', 'Collections', 'Generic', 'Concurrent', 'Threading', 'Tasks', 'Text', 'RegularExpressions', 'Linq', 'IO', 'Diagnostics',
];

// 흔해서 빼는 이름. .NET 멤버 이름과 겹치는 것은 UNITY_MEMBER_NAMES 로 따로 고르고, 여기에는 그 검사로 안 걸리지만
// 사용자 코드에서 속성 · 변수 이름으로 흔한 것을 둔다(Unity 6000.7 XML 문서 기준으로 고른 목록 포함).
const COMMON_NAMES = [
  'Appearance', 'Arguments', 'Arm', 'Assembly', 'AssemblyFlags', 'Background', 'Block', 'Box', 'ChannelInfo', 'Client', 'Column', 'Columns',
  'Comment', 'Condition', 'Config', 'Configuration', 'Connection', 'Constant', 'Constants', 'Content', 'Context', 'Count', 'Data', 'DataType',
  'Device', 'Direction', 'Directory', 'Element', 'Error', 'ErrorCode', 'Event', 'EventID', 'Events', 'EventType', 'Extensions', 'Feature',
  'File', 'FileStatus', 'Filter', 'FilterAttribute', 'FilterType', 'Flags', 'Format', 'Formatting', 'Hand', 'Help', 'Id', 'Image', 'Index',
  'Info', 'Item', 'Items', 'Key', 'Kind', 'Label', 'Layout', 'Length', 'Level', 'Locale', 'Locality', 'Location', 'LogType', 'Loop',
  'MainModule', 'Manual', 'Mask', 'Menu', 'Message', 'MessageType', 'Mode', 'Name', 'Node', 'Notification', 'ObjectFlags', 'Offset',
  'Operation', 'Options', 'OSArchitecture', 'Particle', 'Path', 'Ping', 'Pipe', 'Position', 'Priority', 'Properties', 'Property',
  'PropertyName', 'Provider', 'Query', 'Range', 'Reader', 'ReadOnly', 'ReadWrite', 'Repeat', 'Report', 'Request', 'ResolveMethod',
  'Response', 'Result', 'Rotation', 'Sample', 'Scale', 'Security', 'Selector', 'Serializable', 'Server', 'Settings', 'Severity', 'Size',
  'Snapshot', 'SortDirection', 'SortOrder', 'Source', 'Space', 'State', 'Status', 'StatusCode', 'Style', 'System', 'Tab', 'Target', 'Text',
  'TicksPerSecond', 'Tool', 'Translate', 'Type', 'Types', 'Unicode', 'Update', 'UploadData', 'UserState', 'Value', 'ValueType', 'Variable',
  'Variant', 'Version', 'Visibility', 'WarningLevel', 'Window', 'Windows', 'Writer', 'X86',
];

// 흔한 이름이어도 Unity 코드에서 거의 늘 Unity · C# 타입으로 쓰는 것.
const CORE_NAMES = [
  'Application', 'Color', 'Component', 'Debug', 'Input', 'Object', 'Random', 'Resources', 'Selection', 'Task', 'Time', 'Transform', 'Undo',
];

// Unity 가 이름으로 부르는 메시지 메서드(MonoBehaviour · ScriptableObject · Editor · EditorWindow · 직렬화 콜백).
const MESSAGES = new Set([
  'Awake', 'Start', 'Update', 'FixedUpdate', 'LateUpdate', 'OnEnable', 'OnDisable', 'OnDestroy', 'OnValidate', 'Reset', 'OnGUI',
  'OnDrawGizmos', 'OnDrawGizmosSelected', 'OnApplicationFocus', 'OnApplicationPause', 'OnApplicationQuit',
  'OnBecameVisible', 'OnBecameInvisible', 'OnWillRenderObject', 'OnRenderObject', 'OnPreCull', 'OnPreRender', 'OnPostRender', 'OnRenderImage',
  'OnCollisionEnter', 'OnCollisionStay', 'OnCollisionExit', 'OnCollisionEnter2D', 'OnCollisionStay2D', 'OnCollisionExit2D',
  'OnTriggerEnter', 'OnTriggerStay', 'OnTriggerExit', 'OnTriggerEnter2D', 'OnTriggerStay2D', 'OnTriggerExit2D',
  'OnControllerColliderHit', 'OnJointBreak', 'OnJointBreak2D', 'OnParticleCollision', 'OnParticleTrigger', 'OnParticleSystemStopped',
  'OnMouseDown', 'OnMouseUp', 'OnMouseUpAsButton', 'OnMouseDrag', 'OnMouseEnter', 'OnMouseExit', 'OnMouseOver',
  'OnAnimatorIK', 'OnAnimatorMove', 'OnAudioFilterRead', 'OnTransformChildrenChanged', 'OnTransformParentChanged',
  'OnBeforeTransformParentChanged', 'OnRectTransformDimensionsChange', 'OnCanvasGroupChanged', 'OnDidApplyAnimationProperties',
  'OnInspectorGUI', 'OnSceneGUI', 'OnPreviewGUI', 'OnInteractivePreviewGUI', 'OnPreviewSettings', 'OnHeaderGUI', 'CreateInspectorGUI',
  'HasPreviewGUI', 'RenderStaticPreview', 'CreateGUI', 'OnFocus', 'OnLostFocus', 'OnHierarchyChange', 'OnProjectChange',
  'OnSelectionChange', 'OnInspectorUpdate', 'ShowButton', 'OnBeforeSerialize', 'OnAfterDeserialize',
]);

// Unity 어셈블리의 공개 최상위 타입 이름(제네릭 `1 은 뗀 것, 세 글자 이상). 흔한 이름을 거르기 전.
const UNITY_TYPES = `
AIDropdownConfig AIDropdownConfigArgs AMDUnityPlugin AbstractEventData AbstractGenericMenu AbstractProgressBar AccelerationEvent
AccessibilityHierarchy AccessibilityNode AccessibilityRole AccessibilityScrollDirection AccessibilitySettings AccessibilityState Achievement
AchievementDescription ActionOnDotNetUnhandledException ActiveEditorTracker ActiveProfileChangedEventArgs ActivityIndicatorStyle AdaptiveBatching
AdaptiveDecals AdaptiveFramerate AdaptiveLOD AdaptiveLayerCulling AdaptiveLut AdaptiveMSAA AdaptivePerformanceBuildHelper
AdaptivePerformanceBuildUtils AdaptivePerformanceConfigurationDataAttribute AdaptivePerformanceGeneralSettings
AdaptivePerformanceGeneralSettingsPerBuildTarget AdaptivePerformanceIndexer AdaptivePerformanceIndexerSettings AdaptivePerformanceLoader
AdaptivePerformanceLoaderHelper AdaptivePerformanceManagerSettings AdaptivePerformancePackageInitializationBase
AdaptivePerformancePackageMetadataStore AdaptivePerformanceProfilerStats AdaptivePerformanceRenderSettings AdaptivePerformanceScaler
AdaptivePerformanceScalerProfile AdaptivePerformanceScalerSettings AdaptivePerformanceScalerSettingsBase AdaptivePerformanceSubsystem
AdaptivePerformanceSubsystemBase AdaptivePerformanceSubsystemDescriptor AdaptivePerformanceSupportedBuildTargetAttribute AdaptivePhysics
AdaptiveResolution AdaptiveShadowCascade AdaptiveShadowDistance AdaptiveShadowQuality AdaptiveShadowmapResolution AdaptiveSorting AdaptiveTransparency
AdaptiveViewDistance AddAndRemoveRequest AddComponentMenu AddRequest AddedComponent AddedGameObject AdditionalCanvasShaderChannels AddressMode
AdvancedDropdown AdvancedDropdownItem AdvancedDropdownState AdvancedObjectSelectorAttribute AdvancedObjectSelectorEventType
AdvancedObjectSelectorParameters AdvancedObjectSelectorValidatorAttribute AdvertisementSettings AimConstraint AlbedoSwatchInfo Align AlignmentUtils
AllocatingGCMemoryConstraint AlternatingRowBackground AlwaysLinkAssemblyAttribute AmbientMode Analytic AnalyticInfoAttribute Analytics AnalyticsCommon
AnalyticsEventBase AnalyticsEventPriority AnalyticsResult AnalyticsSessionInfo AnalyticsSessionState AnalyticsSettings AnchoredJoint2D
AndroidActivityIndicatorStyle AndroidApplication AndroidApplicationEntry AndroidArchitecture AndroidAssetPackError AndroidAssetPackImporter
AndroidAssetPackInfo AndroidAssetPackState AndroidAssetPackStatus AndroidAssetPackUseMobileDataRequestResult AndroidAssetPacks
AndroidAutoRotationBehavior AndroidBlitType AndroidBuildSystem AndroidBuildType AndroidColorModeHdr AndroidColorModeWideColorGamut
AndroidConfiguration AndroidCreateSymbols AndroidDevice AndroidDeviceFilterData AndroidDisplayOptions AndroidETC2Fallback AndroidETC2FallbackOverride
AndroidGame AndroidGameMode AndroidGameState AndroidGamepadSupportLevel AndroidHardwareKeyboardHidden AndroidHardwareType AndroidInput AndroidJNI
AndroidJNIHelper AndroidJavaClass AndroidJavaException AndroidJavaObject AndroidJavaProxy AndroidJavaRunnable AndroidKeyboard AndroidKeyboardHidden
AndroidLocale AndroidMinification AndroidNavigation AndroidNavigationHidden AndroidOrientation AndroidPreferredDataLocation
AndroidPreferredInstallLocation AndroidScreenLayoutDirection AndroidScreenLayoutLong AndroidScreenLayoutRound AndroidScreenLayoutSize
AndroidSdkVersions AndroidShowActivityIndicatorOnLoading AndroidSplashScreenScale AndroidTargetDevice AndroidTargetDevices AndroidTouchScreen
AndroidUIModeNight AndroidUIModeType Angle AngleRangeInfo AngleUnit AnimBool AnimFloat AnimQuaternion AnimVector3 Animation AnimationBlendMode
AnimationClip AnimationClipCurveData AnimationClipPair AnimationClipPlayable AnimationClipSettings AnimationCullingType AnimationCurve
AnimationCurveTypeConverter AnimationEvent AnimationHumanStream AnimationLayerMixerPlayable AnimationMixerPlayable AnimationMode AnimationModeDriver
AnimationPlayMode AnimationPlayableBinding AnimationPlayableExtensions AnimationPlayableOutput AnimationPlayableUtilities AnimationSceneHandleUtility
AnimationScriptPlayable AnimationState AnimationStream AnimationStreamHandleUtility AnimationTriggers AnimationTriggersDrawer AnimationUpdateMode
AnimationUtility AnimationWindow Animator AnimatorClipInfo AnimatorCondition AnimatorConditionMode AnimatorController AnimatorControllerLayer
AnimatorControllerParameter AnimatorControllerParameterType AnimatorControllerPlayable AnimatorCullingMode AnimatorJobExtensions
AnimatorLayerBlendingMode AnimatorOverrideController AnimatorRecorderMode AnimatorState AnimatorStateInfo AnimatorStateMachine AnimatorStateTransition
AnimatorTransition AnimatorTransitionBase AnimatorTransitionInfo AnimatorUpdateMode AnimatorUtility AnisotropicFiltering ApiCompatibilityLevel
AppCallbackItem AppleMobileArchitecture AppleMobileArchitectureSimulator Application ApplicationExitInfoProvider ApplicationInstallMode
ApplicationMemoryUsage ApplicationMemoryUsageChange ApplicationSandboxType ApplicationTitleDescriptor ApplyRulesIfGraphicsAPIAttribute
ApplyRulesIfNotGraphicsAPIAttribute ApplyRulesIfTagsEqualAttribute ApplyRulesIfTagsNotEqualAttribute ArcDirection ArcHandle AreaEffector2D Arguments
ArmDof ArrayUtility ArticulationBody ArticulationDofLock ArticulationDrive ArticulationDriveAxis ArticulationDriveType ArticulationJacobian
ArticulationJointType ArticulationReducedSpace AscentCalculationMode AspectRatioFitter AspectRatioFitterEditor AssembliesType Assembly AssemblyBuilder
AssemblyBuilderFlags AssemblyBuilderStatus AssemblyDefinitionException AssemblyDefinitionPlatform AssemblyDefinitionReferenceType AssemblyFlags
AssemblyIsEditorAssembly AssemblyReloadEvents Assert AssertionException Asset AssetBundle AssetBundleBuild AssetBundleCreateRequest AssetBundleInfo
AssetBundleLoadResult AssetBundleManifest AssetBundleRecompressOperation AssetBundleRequest AssetBundleUnloadOperation AssetDatabase
AssetDatabaseLoadOperation AssetDatabaseRefreshAnalytic AssetDeleteResult AssetImportContext AssetImporter AssetImporterEditor AssetIndexChangeSet
AssetList AssetLoadInfo AssetModificationProcessor AssetMonitoringUtilities AssetMoveResult AssetPathToGUIDOptions AssetPipelineMode
AssetPostprocessor AssetPostprocessorStaticVariableIgnoreAttribute AssetPreview AssetSettingsProvider AssetStatus AssetStoreAsset AssetsItem
AssistiveSupport AsyncGPUReadback AsyncGPUReadbackRequest AsyncInstantiateOperation AsyncOperation AsyncOperationAwaitableExtensions
AtlasPopulationMode AtlasSettings AttachToPanelEvent AttachmentDescriptor AttachmentIndexArray AudioBehaviour AudioChorusFilter AudioClip
AudioClipLoadType AudioClipPlayable AudioCompressionFormat AudioConfiguration AudioCurveRendering AudioDataLoadState AudioDistortionFilter
AudioEchoFilter AudioExtensions AudioFormat AudioHighPassFilter AudioImporter AudioImporterChannels AudioImporterSampleSettings AudioListener
AudioLowPassFilter AudioMixer AudioMixerEffectPlugin AudioMixerGroup AudioMixerPlayable AudioMixerSnapshot AudioMixerUpdateMode AudioPlayableBinding
AudioPlayableOutput AudioRenderer AudioResource AudioReverbFilter AudioReverbPreset AudioReverbZone AudioRolloffMode AudioSampleRateSetting
AudioSettings AudioSource AudioSourceCurveType AudioSpatialExperience AudioSpeakerMode AudioTrackAttributes AudioType AudioVelocityUpdateMode
AuthorInfo Avatar AvatarBuilder AvatarIKGoal AvatarIKHint AvatarMask AvatarMaskBodyPart AvatarTarget Awaitable AwaitableCompletionSource Axis
AxisEventData Background BackgroundModesOptions BackgroundPosition BackgroundPositionKeyword BackgroundPropertyHelper BackgroundRepeat BackgroundSize
BackgroundSizeType BackgroundThreadAwaitable BakeProgressState BaseAnimValue BaseAnimValueNonAlloc BaseBoolField BaseCompositeField BaseEventData
BaseField BaseFieldMouseDragger BaseFieldTraits BaseInput BaseInputModule BaseListView BaseListViewController BaseMask64Field BaseMaskField
BaseMeshEffect BasePopupField BaseRaycaster BaseSlider BaseTreeView BaseTreeViewController BaseUxmlFactory BaseUxmlTraits BaseVertexEffect
BaseVerticalCollectionView BasicProviderConstants BasicProviderSettings BatchBufferTarget BatchCullingContext BatchCullingFlags BatchCullingOutput
BatchCullingOutputDrawCommands BatchCullingProjectionType BatchCullingViewType BatchDrawCommand BatchDrawCommandFlags BatchDrawCommandIndirect
BatchDrawCommandProcedural BatchDrawCommandProceduralIndirect BatchDrawCommandType BatchDrawRange BatchFilterSettings BatchID BatchMaterialID
BatchMeshID BatchPackedCullingViewID BatchRendererGroup BatchRendererGroupCreateInfo BatchRendererGroupStrippingMode BatteryStatus
BeforeRenderOrderAttribute Behaviour BillboardAsset BillboardRenderer BindableElement BindablePropertyChangedEventArgs Binding
BindingActivationContext BindingContext BindingExtensions BindingId BindingInfo BindingLogLevel BindingMode BindingResult BindingSourceSelectionMode
BindingStatus BindingUpdateTrigger BlendMode BlendOp BlendShapeBufferLayout BlendShapeBufferRange BlendState BlendTree BlendTreeType BlendWeights
BlurEvent BodyDof BodyPart Bone BoneState BoneWeight BoneWeight1 BootOptions BoundProperty BoundingSphere Bounds BoundsField BoundsInt BoundsIntField
Box BoxBoundsHandle BoxCollider BoxCollider2D BoxGeometry BoxcastCommand BrokenPrefabAsset BrushGUIEditFlags BrushTransform BrushesOverlay BufferID
BufferSlice BuildAssetBundleAnalytic BuildAssetBundleOptions BuildAssetBundlesParameters BuildAutomationSettings BuildCallbackContext
BuildCallbackVersionAttribute BuildCompression BuildFailedException BuildFile BuildOptions BuildPipeline BuildPipelineContext BuildPlayerContext
BuildPlayerOptions BuildPlayerProcessor BuildPlayerWindow BuildPlayerWithProfileOptions BuildProfile BuildProfileProviderContainer BuildReferenceMap
BuildReport BuildResult BuildSettings BuildStep BuildStepMessage BuildSummary BuildTarget BuildTargetGroup BuildType BuildUsageCache
BuildUsageTagGlobal BuildUsageTagSet BuildUtilities BuiltinRenderTextureType BuiltinShaderDefine BuiltinShaderMode BuiltinShaderType
BuoyancyEffector2D Button ButtonEditor Cache CacheIndex CacheServer CacheServerConnectionChangedParameters CacheServerMode CacheServerValidationMode
CachedAssetBundle Caching CallbackEventHandler CallbackOptions CallbackOrderAttribute Camera CameraClearFlags CameraDescription CameraEditor
CameraEditorUtils CameraEvent CameraHDRMode CameraLateLatchMatrixType CameraParameters CameraProjectionCache CameraProperties CameraType
CanAppendBuild CanEditMultipleObjects CanStartDragArgs Canvas CanvasGroup CanvasRenderer CanvasScaler CanvasScalerEditor CanvasUpdate
CanvasUpdateRegistry CapsuleBoundsHandle CapsuleCollider CapsuleCollider2D CapsuleDirection2D CapsuleGeometry CapsulecastCommand CapturePixelFormat
CategoryInfoAttribute CertificateHandler ChainGeometry ChainSegmentGeometry ChangeAssetObjectPropertiesEventArgs ChangeChildrenOrderEventArgs
ChangeEvent ChangeGameObjectOrComponentPropertiesEventArgs ChangeGameObjectParentEventArgs ChangeGameObjectStructureEventArgs
ChangeGameObjectStructureHierarchyEventArgs ChangeRootOrderEventArgs ChangeSceneEventArgs ChangeSet ChangeSets ChannelBuffer ChannelClient
ChannelClientInfo ChannelClientScope ChannelInfo ChannelScope ChannelService Character CharacterController CharacterInfo CharacterJoint CheckoutMode
ChildAnimatorState ChildAnimatorStateMachine ChildMotion CircleCollider2D CircleGeometry ClearCacheRequest ClickEvent Clickable Client
ClipAnimationInfoCurve ClipAnimationMaskType ClipboardUtility ClipperRegistry Clipping ClosestPointCommand Cloth ClothSkinningCoefficient
ClothSphereColliderPair CloudProjectSettings CloudProjectSettingsEventManager ClusterInfo ClusterInput ClusterInputType ClusterNetwork
ClusterSerialization ClutchShortcutAttribute CodeOptimization CollabOperationAnalytic CollectImportedDependenciesAttribute CollectionPool
CollectionViewController CollectionVirtualizationMethod Collider Collider2D ColliderDistance2D ColliderErrorState2D ColliderHit Collision Collision2D
CollisionDetectionMode CollisionDetectionMode2D CollisionFlags Color Color32 ColorBlock ColorBlockDrawer ColorEqualityComparer ColorField ColorGamut
ColorGamutUtility ColorGradientMode ColorPickerHDRConfig ColorPrimaries ColorSpace ColorUsageAttribute ColorUtility ColorWriteMask Column
ColumnSortingMode Columns CombineInstance CommandBuffer CommandBufferExecutionFlags CommandBufferExtensions CommandEventBase CommandExecuteContext
CommandHandler CommandHandlerAttribute CommandHint CommandService CommonRoles CommonUsages CompareFunction Compass CompilationPipeline CompilerMessage
CompilerMessageType CompletionAction Component CompositeCollider2D CompressionLevel CompressionType ComputeBuffer ComputeBufferMode ComputeBufferType
ComputeQueueType ComputeShader ComputeShaderImporter ConditionalIgnoreAttribute ConfidenceLevel ConfigField ConfigurableJoint ConfigurableJointMotion
ConnectedPlayer Connection ConnectionTarget ConsentState ConsentStatus ConsoleWindowUtility ConstantForce ConstantForce2D Constants
ConstraintExtensions ConstraintSource ContactFilter2D ContactPair ContactPairHeader ContactPairPoint ContactPoint ContactPoint2D ContentBuildFlags
ContentBuildInterface ContentBuildProfileEvent ContentSizeFitter ContentSizeFitterEditor ContextClickEvent ContextMenu ContextMenuItemAttribute
ContextMenuUtility ContextType ContextualMenuManager ContextualMenuManipulator ContextualMenuPopulateEvent ContinuousEvent ControlContext
ControllerColliderHit ConvertToPrefabInstanceSettings ConverterGroup ConverterGroups ConvexMeshGeometry CoppaCompliance CoppaDrawer CopyTextureSupport
Coroutine Coverage CoveredMethodStats CoveredSequencePoint CrashReport CrashReportHandler CrashReporting CrashReportingSettings
CreateAssetMenuAttribute CreateAssetObjectEventArgs CreateGameObjectHierarchyEventArgs CreateSceneParameters CreationContext CreationToolsGroup Crypto
Cubemap CubemapArray CubemapFace CullMode CullingGroup CullingGroupEvent CullingOptions CullingResults CullingSplit Cursor CursorLockMode CursorMode
CurveField CurveFilterOptions CustomBinding CustomCollider2D CustomEditor CustomEditorForRenderPipelineAttribute CustomGridBrushAttribute
CustomMarkerCallbackFlags CustomObjectIndexerAttribute CustomObjectIndexerTarget CustomPivotAttribute CustomPivotMode CustomPivotRotation
CustomPreviewAttribute CustomPropertyDrawer CustomRenderTexture CustomRenderTextureInitializationSource CustomRenderTextureManager
CustomRenderTextureUpdateMode CustomRenderTextureUpdateZone CustomRenderTextureUpdateZoneSpace CustomSampler CustomStreamPropertyType
CustomStyleProperty CustomStyleResolvedEvent CustomYieldInstruction D3D11FullscreenMode D3D12Comparator D3D12DeviceFilterData D3D12DeviceFilterLists
D3D12GraphicsDeviceType D3D12GraphicsJobsDeviceFilterData D3D9FullscreenMode D3DHDRDisplayBitDepth DLSSCommandExecutionData
DLSSCommandInitializationData DLSSContext DLSSDebugFeatureInfos DLSSFeatureFlags DLSSPreset DLSSQuality DLSSTextureTable DSPConfiguration DataBinding
DataMode DataModeChangeEventArgs DataSourceContext DataSourceContextChanged DataStreamType DataUtility Debug DebuggerEventListHandler Debugging
DecoratorDrawer DeeplinkHandlerAttribute DefaultAsset DefaultControls DefaultExecutionOrder DefaultLaunchReport DefaultLightingExplorerExtension
DefaultMultiColumnTreeViewController DefaultPreset DefaultPresetSelectorReceiver DefaultReflectionMode DefaultTreeViewController DelayedAttribute
DeltaSpeed DependencyInfo DependencyType DepthState DepthTextureMode DestroyAssetObjectEventArgs DestroyGameObjectHierarchyEventArgs
DetachFromPanelEvent DetailBrushBounds DetailBrushRepresentation DetailInstanceTransform DetailPrototype DetailRenderMode DetailScatterMode DevDevice
DevDeviceFeatures DevDeviceList DevDeviceState Device DeviceGeneration DeviceOrientation DeviceSimulator DeviceSimulatorPlugin DeviceType
DiagnosticsReporting DialogIconType DialogOptOutDecisionType DialogResult DictationCompletionCause DictationRecognizer DictationTopicConstraint
DictionaryPool DidReloadScripts DiffuseProfileCallbackAttribute DirectorUpdateMode DirectorWrapMode Directory DisallowMultipleComponent
DiscreteEvaluationAttribute Dispatcher Display DisplayInfo DisplayMode DisplayStyle DistanceJoint2D DistanceMetric DockPosition DockZone DoubleField
DownloadAssetPackAsyncOperation DownloadHandler DownloadHandlerAssetBundle DownloadHandlerAudioClip DownloadHandlerBuffer DownloadHandlerFile
DownloadHandlerMovieTexture DownloadHandlerScript DownloadHandlerTexture DownloadedTextureFlags DownloadedTextureParams DragAndDrop DragAndDropData
DragAndDropEventBase DragAndDropPosition DragAndDropVisualMode DragAndDropWindowTarget DragEnterEvent DragExitedEvent DragLeaveEvent DragPerformEvent
DragUpdatedEvent DragVisualMode DrawCameraMode DrawGizmo DrawingSettings DrivenRectTransformTracker DrivenTransformProperties Dropdown DropdownEditor
DropdownField DropdownMenu DropdownMenuAction DropdownMenuEventInfo DropdownMenuItem DropdownMenuSeparator DropdownMenuSizeMode DummyCachedNullType
DummyNullType DurationUnit DynamicAtlasCustomFilter DynamicAtlasFilters DynamicAtlasSettings DynamicGI EasingFunction EasingMode Edge EdgeCollider2D
EdgeGUI Editor EditorAction EditorActionResult EditorAnalytics EditorAnalyticsSessionInfo EditorApplication EditorAssembliesCompatibilityLevel
EditorBehaviorMode EditorBuildSettings EditorBuildSettingsScene EditorCameraUtils EditorConnection EditorCurveBinding EditorDialog EditorGUI
EditorGUILayout EditorGUIUtility EditorGraphicsSettings EditorHelpers EditorJsonUtility EditorMaterialUtility EditorPrefs EditorSceneManager
EditorSelectedRenderState EditorSettings EditorSkin EditorSnapSettings EditorStyles EditorTextRenderingMode EditorTool EditorToolAttribute
EditorToolContext EditorToolContextAttribute EditorToolbarButton EditorToolbarDropdown EditorToolbarDropdownToggle EditorToolbarElementAttribute
EditorToolbarFloatField EditorToolbarSlider EditorToolbarToggle EditorToolbarUtility EditorUserBuildSettings EditorUserSettings EditorUtility
EditorWindow EditorWindowTitleAttribute Effector2D EffectorForceMode2D EffectorSelection2D ElementInfoAttribute EmbedRequest EmbeddedArchitecture
EmbeddedLinuxArchitecture EndNameEditAction EndUserConsent EngineDiagnosticsSettings EnterPlayMode EnterPlayModeOptions EntityId EnumButtonsAttribute
EnumField EnumFlagsField EnumTypeConverter Error ErrorCode Event EventBase EventCallback EventDataSerialization EventDispatcher EventDispatcherGate
EventHandle EventID EventInterestAttribute EventInterestOptions EventModifiers EventProvider EventService EventSystem EventSystemEditor EventTrigger
EventTriggerEditor EventTriggerType EventType Events ExampleSubsystem ExampleSubsystemDescriptor ExcludeFromCoverageAttribute
ExcludeFromObjectFactoryAttribute ExcludeFromPresetAttribute ExecuteAlways ExecuteCommandEvent ExecuteEvents ExecuteInEditMode ExecutionSettings
ExitGUIException ExitPlayMode ExitReason Explore ExportPackageOptions ExposedPropertyResolver ExposedReference ExpressionEvaluator
ExternalFileReference ExternalVersionControl Eyes FBXMaterialDescriptionPreprocessor FFTWindow FSR2CommandExecutionData FSR2CommandInitializationData
FSR2Context FSR2Quality FSR2TextureTable FaceInfo FastAction FastMemoryFlags Feature FetchPreviewOptions FfxFsr2InitializationFlags FieldDescription
FieldMouseDragger File FileMode FilePathAttribute FileType FileUtil FillGradient FillRule Filter FilterAction FilterAttribute FilterFunction
FilterFunctionDefinition FilterFunctionType FilterMode FilterParameter FilterParameterDeclaration FilterParameterType FilterPassContext
FilteringSettings FindObjectsInactive FindObjectsSortMode FingerDof FixedJoint FixedJoint2D Flare FlareLayer FlexDirection FloatComparer
FloatEqualityComparer FloatField FocusChangeDirection FocusController FocusEvent FocusEventBase FocusInEvent FocusOutEvent FocusType Focusable FogMode
Folder Foldout FoliageIndex Font FontAsset FontAssetCreationEditorSettings FontAssetCreatorWindow FontData FontDataDrawer FontDefinition FontEngine
FontEngineError FontFeatureLookupFlags FontFeatureTable FontRenderingMode FontStyle FontStyles FontTextureCase FontUpdateTracker FontWeightPair
ForceMode ForceMode2D ForceReserializeAssetsOptions ForcedCrashCategory FormatSwizzle FormerlySerializedAsAttribute FoveatedRenderingCaps
FoveatedRenderingMode FrameCapture FrameCaptureDestination FrameData FrameDataView FrameDebugger FrameTiming FrameTimingManager FrictionJoint2D
FrustumPlanes FullScreenMode FullScreenMovieControlMode FullScreenMovieScalingMode FuzzySearch GPUCacheSetting GPUFence GUI GUIContent GUID GUIDrawer
GUILayout GUILayoutOption GUILayoutUtility GUISettings GUISkin GUIStyle GUIStyleState GUITargetAttribute GUIUtility GameCenterPlatform
GameManagerDependencyInfo GameObject GameObjectRecorder GameObjectToolContext GameObjectUtility GameViewRenderMode GameViewSizeGroupType
GamepadSpeakerOutputType GarbageCollector Gender Generator GeneratorInstance GenericBinding GenericBindingUtility GenericDropdownMenu
GenericFloatVarsTypeConverter GenericMenu GenericPool GeometryChangedEvent GeometryHolder GeometryType GeometryUtility GetAssetPackStateAsyncOperation
GfxThreadingMode GitInfo GizmoInfo GizmoSubset GizmoType GizmoUtility Gizmos GlobalKeyword GlobalObjectId Glyph GlyphAdjustmentRecord
GlyphClassDefinitionType GlyphLoadFlags GlyphMetrics GlyphPackingMode GlyphPairAdjustmentRecord GlyphRect GlyphRenderMode GlyphValueRecord GpuBvh
GpuBvhBuildOptions GpuBvhBuildQuality GpuBvhPrimitiveDescriptor Gradient GradientAlphaKey GradientColorKey GradientField GradientMode GradientType
GradientUsageAttribute GrammarRecognizer Graph GraphGUI Graphic GraphicEditor GraphicRaycaster GraphicRebuildTracker GraphicRegistry Graphics
GraphicsAPIConstraintAttribute GraphicsBuffer GraphicsBufferHandle GraphicsDevice GraphicsDeviceDebugView GraphicsDeviceFeature GraphicsDeviceType
GraphicsFence GraphicsFenceType GraphicsJobMode GraphicsJobsFilterMode GraphicsSettings GraphicsSettingsInspectorUtility GraphicsTexture
GraphicsTextureDescriptor GraphicsTextureDescriptorFlags GraphicsTextureState GraphicsTier GraphicsToolLifetimeAnalytic GraphicsToolUsageAnalytic
GraphsTypeConverter Grid GridBrushBase GridLayout GridLayoutGroup GridLayoutGroupEditor GridPalette GroupBox GroupNode Gyroscope H264EncoderAttributes
HDRDisplayBitDepth HDRDisplaySupportFlags HDROutputSettings Hand HandFinger Handheld HandleDragAndDropArgs HandleUtility Handles HapticCapabilities
Hash128 Hash128Field HashSetPool HashUnsafeUtilities HashUtilities HeadDof HeaderAttribute Help HelpBox HelpBoxMessageType HelpURLAttribute HideFlags
HideInCallstackAttribute HideInInspector HierarchyDropFlags HierarchyFrameDataView HierarchyIterator HierarchyProperty HierarchyType
HighlightSearchMode Highlighter HingeJoint HingeJoint2D HmiPlatform Holder HorizontalLayoutGroup HorizontalOrVerticalLayoutGroup
HorizontalOrVerticalLayoutGroupEditor HorizontalWrapMode HttpForcedVersion HumanBodyBones HumanBone HumanDescription HumanLimit HumanPartDof HumanPose
HumanPoseHandler HumanTemplate HumanTrait HyperLinkClickedEventArgs IAccessContainerWindow IAccessibilityNotificationDispatcher IAchievement
IAchievementDescription IActiveBuildTargetChanged IAdaptivePerformance IAdaptivePerformanceLoaderMetadata IAdaptivePerformancePackage
IAdaptivePerformancePackageMetadata IAdaptivePerformanceSettings IAnalytic IAnimationClipSource IAnimationJob IAnimationJobPlayable
IAnimationWindowPreview IApplicationExitInfo IApplicationLifecycle IApplyRevertPropertyContextMenuItemProvider IAudioEffectPlugin
IAudioEffectPluginGUI IAudioGenerator IAudioScriptingContext IBaseUxmlFactory IBeginDragHandler IBindable IBinding IBindingExtensions ICallbacks
ICameraLensData ICancelHandler ICanvasElement ICanvasRaycastFilter IChangeEvent IClippable IClipper ICommandEvent IConnectionState IConstraint
ICreateHorizontalToolbar ICreateToolbar ICreateVerticalToolbar ICustomStyle IDataModeController IDataSourceProvider IDataSourceViewHashProvider
IDebugPanelChangeReceiver IDeselectHandler IDevelopmentSettings IDeviceContext IDevicePerformanceControl IDevicePerformanceLevelControl
IDragAndDropEvent IDragHandler IDrawSelectedHandles IDropHandler IEdgeGUI IEditModeTestYieldInstruction IEditorPlayerConnection IEndDragHandler
IErrorCallbacks IEventHandler IEventSystemHandler IExperimentalFeatures IExposedPropertyTable IFilterBuildAssemblies IFilterEngine IFilterNode
IFocusEvent IFocusRing IGeneratorDefinition IGeometry IHVImageFormatImporter IHasCustomMenu IIconOverlayExtension IIl2CppProcessor
IInitializePotentialDragHandler IInspectorWindowExtension IJobParallelForTransform IJobParallelForTransformExtensions IJobParticleSystem
IJobParticleSystemExtensions IJobParticleSystemParallelFor IJobParticleSystemParallelForBatch IJobParticleSystemParallelForBatchExtensions
IJobParticleSystemParallelForExtensions IKeyboardEvent ILaunchReport ILayoutController ILayoutElement ILayoutGroup ILayoutIgnorer
ILayoutSelfController ILeaderboard ILightingExplorerExtension ILocalUser ILogHandler ILogger IMECompositionMode IMGUIContainer IMGUIEvent IMGUIOverlay
IManipulator IMaskable IMaterialModifier IMeshModifier IMixedValueSupport IMonoBehaviourTest IMouseCaptureEvent IMouseEvent IMoveHandler
IMultipartFormSection INavigationEvent INestedQueryNode INotification INotificationReceiver INotifyBindablePropertyChanged INotifyValueChanged
INotifyValueChangedExtensions IObjectPool IObjectSelectorEngine IOnInspectorGUI IOnPaint IOnSceneGUI IOrderedCallback IOuterUnityTestAction
IOverrideToolbar IPackageManagerExtension IPanel IPanelChangedEvent IParticleSystemJobExtensions IPerformanceModeStatus IPerformanceStatus IPlayable
IPlayableAsset IPlayableBehaviour IPlayableOutput IPointerCaptureEvent IPointerClickHandler IPointerDownHandler IPointerEnterHandler IPointerEvent
IPointerExitHandler IPointerMoveHandler IPointerUpHandler IPopupMenuExtension IPostBuildCleanup IPostBuildPlayerScriptDLLs
IPostGenerateGradleAndroidProject IPostbuildCleanupWithTestData IPostprocessBuild IPostprocessBuildWithContext IPostprocessBuildWithReport
IPostprocessLaunch IPrebuildSetup IPrebuildSetupWithTestData IPreprocessBuild IPreprocessBuildWithContext IPreprocessBuildWithReport
IPreprocessComputeShaders IPreprocessShaders IProbeIntegrator IProbePostProcessor IProcessScene IProcessSceneWithReport
IProfilerFrameTimeViewSampleSelectionController IProjectEditorDrawer IProjectSearchEngine IPropertyDatabaseRecord IPropertyDatabaseRecordValue
IPropertyDatabaseView IQueryEngineFilter IQueryHandler IQueryHandlerFactory IQueryNode IQuerySource IRenderPipelineGraphicsSettings
IRenderPipelineGraphicsSettingsContextMenu IRenderPipelineGraphicsSettingsContextMenu2 IRenderPipelineResources IResolvedStyle IRuntimePanel
ISceneSearchEngine ISceneSearchEngineV2 ISceneTemplatePipeline IScore IScrollHandler ISearchContext ISearchDatabase ISearchEngine ISearchEngineBase
ISearchList ISearchNode ISearchQuery ISearchView ISelectHandler ISelectorEngine ISerializationCallbackReceiver ISettingsInspectorExtension
IShortcutContext IShortcutManager IShouldIncludeInBuildCallback ISocialPlatform IStyle IStyleValue ISubmitHandler ISubsystem ISubsystemDescriptor
ISupportsOverlays ISupportsOverlaysWithFilter ITableView ITerrainLayerCustomUI ITestAdaptor ITestPlayerBuildModifier ITestResultAdaptor
ITestRunCallback ITestRunDataHolder ITestRunSettings ITextEdition ITextElementExperimentalFeatures ITextSelection IThermalStatus ITilemap
IToolbarMenuElement ITransform ITransientOverlay ITransitionEvent IUnityLinkerProcessor IUpdateSelectedHandler IUserProfile IUxmlAttributes
IUxmlFactory IUxmlUpgrader IValueField IVisualElementScheduledItem IVisualElementScheduler IWorld IconAttribute IconDrawStyle IconKind IconOverlayType
Identifiers Il2CppCodeGeneration Il2CppCompilerConfiguration Il2CppStacktraceInformation Image ImageConversion ImageEditor ImageEffectAfterScale
ImageEffectAllowedInSceneView ImageEffectOpaque ImageEffectTransformsToLDR ImageEffectUsesCommandBuffer ImagePosition ImmediateContact
ImmediateModeElement ImmediatePhysics ImmediateTransform ImportAssetOptions ImportLog ImportLogFlags InSceneAssetInformation InSceneAssetUtility
IndexFormat IndexingOptions InitializeOnEnterPlayModeAttribute InitializeOnLoadAttribute InitializeOnLoadMethodAttribute Input InputDevice
InputDeviceCharacteristics InputDeviceRole InputDevices InputEvent InputExtraction InputFeatureUsage InputField InputFieldEditor
InputModuleComponentFactory InputSystemEventSystem InputTracking InputTrackingState InputWrapper InsecureHttpOption InspectorElement InspectorMode
InspectorNameAttribute InspectorOrderAttribute InspectorSort InspectorSortDirection InstanceID InstantiateParameters InstantiationResult IntegerField
IntegratedSubsystem IntegratedSubsystemDescriptor IntegrationContext IntegrationInfo IntegrityCheckLevel InteractionMode InvalidImportException
ItemSelectors JNINativeMethod Joint Joint2D JointAngleLimits2D JointAngularLimitHandle JointBreakAction2D JointDrive JointLimitState2D JointLimits
JointMotor JointMotor2D JointProjectionMode JointSpring JointSuspension2D JointTranslationLimits2D JsonUtility Justify KeyCode KeyCombination
KeyDownEvent KeyUpEvent KeyboardEventBase KeyboardNavigationManipulator KeyboardNavigationOperation Keyframe KeywordRecognizer L10n LOD LODFadeMode
LODGroup LODParameters LODUtility Label LanguageDirection LaunchResult Launcher LayerField LayerMask LayerMaskField Layout LayoutElement
LayoutElementEditor LayoutGroup LayoutRebuilder LayoutUtility LazyLoadReference Leaderboard LegDof Length LengthUnit LensFlare LibraryVisibility
LicenseInformation LicensingErrorAnalytic LicensingInitAnalytic LifecycleChangeType LifecycleEventHandler Light Light2DBase LightBakingOutput
LightDescription LightEditor LightEvent LightProbeGroup LightProbeOutsideHullStrategy LightProbeProxyVolume LightProbeUsage LightProbes
LightProbesQuery LightRenderMode LightShadowCasterCullingInfo LightShadowCasterMode LightShadowResolution LightShadows LightShape LightType LightUnit
LightingDataAsset LightingExplorerExtensionAttribute LightingExplorerTab LightingExplorerTableColumn LightingSettings LightingWindowEnvironmentSection
LightingWindowTab LightmapBakeQuality LightmapBakeType LightmapCompression LightmapData LightmapEditorSettings LightmapParameters LightmapSettings
LightmapSnapshot Lightmapping LightmappingMode LightmapsMode LightmapsModeLegacy LineAlignment LineCap LineEndingsMode LineJoin LineRenderer
LineTextureMode LineUtility LinkedPool ListPool ListRequest ListView ListViewController ListViewReorderMode LoadSceneMode LoadSceneParameters
LoadStoreActionDebugModeSettings Local LocalKeyword LocalKeywordSpace LocalPhysicsMode LocalUser Localization LocalizationAsset LocalizationAttribute
LocalizationGroup LocationInfo LocationService LocationServiceStatus LogAssert LogLevel LogOption LogType Logger LongField LookAtConstraint
MacFullscreenMode MacOSArchitecture MacOSCodeSigning MachineLearningContext MachineLearningDataType MachineLearningOperator
MachineLearningOperatorDispatcher MachineLearningOperatorFactory MachineLearningOperatorType MachineLearningTensorDescriptor
MachineLearningTensorShape MacroEvaluator MainStage MainThreadAwaitable MainToolbar MainToolbarButton MainToolbarContent MainToolbarDockPosition
MainToolbarDropdown MainToolbarElement MainToolbarElementAttribute MainToolbarLabel MainToolbarSlider MainToolbarToggle MakeSerializableAttribute
ManagedDebugger ManagedReferenceMissingType ManagedReferenceUtility ManagedStrippingLevel Manipulator ManipulatorActivationFilter MapsOptions Mask
Mask64Field MaskEditor MaskField MaskUtilities MaskableGraphic MatchTargetWeightMask Material MaterialDefinition MaterialDescription MaterialEditor
MaterialEditorExtensions MaterialGlobalIlluminationFlags MaterialIndex MaterialProperty MaterialPropertyBlock MaterialPropertyDrawer
MaterialPropertyType MaterialSettingsCallbackAttribute MathUtils Mathf Matrix4x4 MediaEncoder MediaRational MediaTime MemorySection MemorySnapshot
Menu MenuCommand MenuItem MergeMethod Mesh MeshChangeState MeshCollider MeshColliderCookingOptions MeshDeformation MeshFilter MeshGenerationContext
MeshGenerationNode MeshGenerationOptions MeshGenerationResult MeshGenerationStatus MeshId MeshInfo MeshLodRange MeshLodUtility MeshOptimizationFlags
MeshPreview MeshRenderer MeshTopology MeshTransform MeshUpdateFlags MeshUtility MeshVertexAttributes MeshWriteData Message MessageEventArgs
MessageExtensions MessageType MetadataValue MetalPatchShaderComputeBufferAnalytic MethodEvaluator Microphone MinAttribute MinMaxSlider
MipmapLimitDescriptor MissingComponentException MissingReferenceException MixedLightingMode MobileTextureSubtarget ModeService ModelImporter
ModelImporterAnimationCompression ModelImporterAnimationType ModelImporterAvatarSetup ModelImporterClipAnimation ModelImporterGenerateAnimations
ModelImporterGenerateMaterials ModelImporterHumanoidOversampling ModelImporterIndexFormat ModelImporterMaterialImportMode
ModelImporterMaterialLocation ModelImporterMaterialName ModelImporterMaterialSearch ModelImporterMeshCompression ModelImporterNormalCalculationMode
ModelImporterNormalSmoothingSource ModelImporterNormals ModelImporterSecondaryUVMarginMethod ModelImporterSkinWeights ModelImporterTangentSpaceMode
ModelImporterTangents ModifiableContactPair ModifiableMassProperties MonoBehaviour MonoBehaviourTest MonoImporter MonoScript Motion
MotionVectorGenerationMode MouseButton MouseCaptureController MouseCaptureEvent MouseCaptureEventBase MouseCaptureOutEvent MouseCursor MouseDownEvent
MouseEnterEvent MouseEnterWindowEvent MouseEventBase MouseLeaveEvent MouseLeaveWindowEvent MouseManipulator MouseMoveEvent MouseOutEvent
MouseOverEvent MouseUpEvent MoveDirection MovedFromAttribute MultiColumnController MultiColumnHeader MultiColumnHeaderState MultiColumnListView
MultiColumnListViewController MultiColumnTreeView MultiColumnTreeViewController MultilineAttribute MultipartFormDataSection MultipartFormFileSection
MuscleHandle MustExtensions NPOTSupport NVUnityPlugin NamedBuildTarget NavMesh NavMeshAgent NavMeshBuildDebugFlags NavMeshBuildDebugSettings
NavMeshBuildMarkup NavMeshBuildSettings NavMeshBuildSource NavMeshBuildSourceShape NavMeshBuilder NavMeshCollectGeometry NavMeshData
NavMeshDataInstance NavMeshEditorHelpers NavMeshHit NavMeshLinkData NavMeshLinkInstance NavMeshObstacle NavMeshObstacleShape NavMeshPath
NavMeshPathStatus NavMeshQueryFilter NavMeshTriangulation NavMeshVisualizationSettings Navigation NavigationCancelEvent NavigationDeviceType
NavigationDrawer NavigationEventBase NavigationMoveEvent NavigationSubmitEvent NavmeshBakingAnalytic NeighborTerrainsIndex NetworkReachability
NewSceneMode NewSceneSetup Node NonReorderableAttribute NormalMapEncoding NotKeyableAttribute Notification OSArchitecture OTL_FeatureTag Object
ObjectChangeEventStream ObjectChangeEvents ObjectChangeKind ObjectFactory ObjectField ObjectIdRequest ObjectIdResult ObjectIdentifier ObjectIndexer
ObjectMatchMode ObjectNames ObjectOverride ObjectPool ObjectPreview ObjectReferenceKeyframe ObjectSelector ObjectSelectorEngineAttribute
ObjectSelectorHandlerAttribute ObjectSelectorHandlerWithLabelsAttribute ObjectSelectorHandlerWithTagsAttribute ObjectSelectorSearch
ObjectSelectorSearchContext ObjectSelectorSearchEndSessionModes ObjectSelectorTargetInfo ObjectSerializedInfo ObstacleAvoidanceType OcclusionArea
OcclusionPortal OffMeshLink OffMeshLinkData OffMeshLinkType OnDemandRendering OnDemandResources OnDemandResourcesRequest OnInspectorGUIContext
OnOpenAssetAttribute OnOpenAssetAttributeMode OnlineState OpaqueSortMode OpenGLESVersion OpenSceneMode OperatingSystemFamily OptimalDLSSSettingsData
Outline Overflow OverflowClipBox OverlapBoxCommand OverlapCapsuleCommand OverlapSphereCommand Overlay OverlayAttribute OverlayCanvas OverlayToolbar
OverridableToolbar OverrideTextureCompression PBXCapabilityType PBXProject PBXProjectExtensions PBXSourceTree PIX PS4BuildSubtarget PS4HardwareTarget
PackOperationResult PackRequest PackageCollection PackageInfo PackageManagerAddPackageAnalytic PackageManagerBaseAnalytic
PackageManagerEmbedPackageAnalytic PackageManagerExtensions PackageManagerRemovePackageAnalytic PackageManagerResetPackageAnalytic
PackageManagerResolveErrorPackageAnalytic PackageManagerResolvePackageAnalytic PackageManagerStartServerPackageAnalytic PackageManagerTestAnalytic
PackageRegistrationEventArgs PackageSource PackedAssetInfo PackedAssets PackedGCHandle PackedMemorySnapshot PackedNativeType
PackedNativeUnityEngineObject Packer PackerJob PaintContext PaintDetailsToolUtility PaintTreesDetailsContext Painter2D PanelChangedEventBase
PanelEventHandler PanelExtensions PanelInputConfiguration PanelRaycaster PanelRenderMode PanelScaleMode PanelScreenMatchMode PanelSettings
PanelTextSettings ParameterBinding ParametrizedIgnoreAttribute ParentConstraint ParseResult ParsedQuery ParticleCollisionEvent
ParticlePhysicsExtensions ParticleSystem ParticleSystemAnimationMode ParticleSystemAnimationRowMode ParticleSystemAnimationTimeMode
ParticleSystemAnimationType ParticleSystemBakeMeshOptions ParticleSystemBakeTextureOptions ParticleSystemColliderQueryMode ParticleSystemCollisionMode
ParticleSystemCollisionQuality ParticleSystemCollisionType ParticleSystemCullingMode ParticleSystemCurveMode ParticleSystemCustomData
ParticleSystemCustomDataMode ParticleSystemEmissionType ParticleSystemEmitterVelocityMode ParticleSystemForceField ParticleSystemForceFieldShape
ParticleSystemGameObjectFilter ParticleSystemGradientMode ParticleSystemGravitySource ParticleSystemInheritVelocityMode ParticleSystemJobData
ParticleSystemMeshDistribution ParticleSystemMeshShapeType ParticleSystemNativeArray3 ParticleSystemNativeArray4 ParticleSystemNoiseQuality
ParticleSystemOverlapAction ParticleSystemRenderMode ParticleSystemRenderSpace ParticleSystemRenderer ParticleSystemRingBufferMode
ParticleSystemScalingMode ParticleSystemShapeMultiModeValue ParticleSystemShapeTextureChannel ParticleSystemShapeType ParticleSystemSimulationSpace
ParticleSystemSortMode ParticleSystemStopAction ParticleSystemStopBehavior ParticleSystemSubEmitterProperties ParticleSystemSubEmitterType
ParticleSystemTrailMode ParticleSystemTrailTextureMode ParticleSystemTriggerEventType ParticleSystemVertexStream ParticleSystemVertexStreams
PassIdentifier PassType PatchExtents PauseState PenButton PenData PenEventType PenStatus PerObjectData PerformanceBoostChangeEventArgs
PerformanceBoostChangeHandler PerformanceBottleneck PerformanceBottleneckChangeEventArgs PerformanceBottleneckChangeHandler PerformanceControlMode
PerformanceDataRecord PerformanceLevelChangeEventArgs PerformanceLevelChangeHandler PerformanceMetrics PerformanceMode PerformanceModeEventHandler
PerformanceReporting PerformanceReportingSettings Permission PermissionCallbacks PersistentListenerMode PhotoCapture PhotoCaptureFileOutputFormat
PhotoCaptureFrame PhraseRecognitionSystem PhraseRecognizedEventArgs PhraseRecognizer PhysicMaterial PhysicMaterialCombine Physics Physics2D
Physics2DRaycaster Physics2DRaycasterEditor PhysicsAABB PhysicsBody PhysicsBodyDefinition PhysicsCallbacks PhysicsChain PhysicsChainDefinition
PhysicsComposer PhysicsConstants PhysicsDebugWindow PhysicsDestructor PhysicsDistanceJoint PhysicsDistanceJointDefinition PhysicsEvents
PhysicsFixedJoint PhysicsFixedJointDefinition PhysicsHingeJoint PhysicsHingeJointDefinition PhysicsIgnoreJoint PhysicsIgnoreJointDefinition
PhysicsJobOptions2D PhysicsJoint PhysicsLayers PhysicsLowLevelSettings2D PhysicsMask PhysicsMaterial PhysicsMaterial2D PhysicsMaterialCombine
PhysicsMaterialCombine2D PhysicsMath PhysicsPlane PhysicsQuery PhysicsRaycaster PhysicsRaycasterEditor PhysicsRelativeJoint
PhysicsRelativeJointDefinition PhysicsRotate PhysicsScene PhysicsScene2D PhysicsSceneExtensions PhysicsSceneExtensions2D PhysicsShape PhysicsShape2D
PhysicsShapeDefinition PhysicsShapeGroup2D PhysicsShapeType2D PhysicsSliderJoint PhysicsSliderJointDefinition PhysicsTransform
PhysicsUpdateBehaviour2D PhysicsUserData PhysicsVisualizationSettings PhysicsWheelJoint PhysicsWheelJointDefinition PhysicsWorld
PhysicsWorldDefinition PickingIncludeExcludeEntityIdList PickingIncludeExcludeList PickingMode Ping Pivot PivotManager PivotMode PivotReferenceSize
PivotRotation PixelPerfectRendering Plane PlatformEffector2D PlatformIcon PlatformIconKind PlatformKeywordSet PlatformShaderSettings PlayMode
PlayModeStateChange PlayModeWindow PlayState Playable PlayableAsset PlayableBehaviour PlayableBinding PlayableDirector PlayableExtensions
PlayableGraph PlayableHandle PlayableOutput PlayableOutputEditorExtensions PlayableOutputExtensions PlayableOutputHandle PlayableTraversalMode
PlayerBuildInterface PlayerConnection PlayerConnectionGUI PlayerConnectionGUILayout PlayerConnectionGUIUtility PlayerConnectionInitiateMode PlayerLoop
PlayerLoopSystem PlayerPrefs PlayerPrefsException PlayerSettings PlistDocument PlistElement PlistElementArray PlistElementBoolean PlistElementDate
PlistElementDict PlistElementInteger PlistElementReal PlistElementString Plugin PluginImporter PointEffector2D PointerCancelEvent PointerCaptureEvent
PointerCaptureEventBase PointerCaptureHelper PointerCaptureOutEvent PointerDownEvent PointerEnterEvent PointerEventBase PointerEventData PointerId
PointerInputModule PointerLeaveEvent PointerManipulator PointerMoveEvent PointerOutEvent PointerOverEvent PointerStationaryEvent PointerType
PointerUpEvent PolygonCollider2D PolygonGeometry PooledObject PopupField PopupWindow PopupWindowContent Pose Position PositionAsUV1 PositionConstraint
PostBuildCleanupAttribute PostBuildCleanupWithTestDataAttribute PostProcessAttribute PostProcessBuildAttribute PostProcessSceneAttribute
PostProcessingMargins PostProcessingPass PrebuildSetupAttribute PrebuildSetupWithTestDataAttribute PrecompiledAssemblyException PrefabAssetType
PrefabInstanceStatus PrefabOverride PrefabOverridesOptions PrefabReplacingSettings PrefabStage PrefabStageUtility PrefabType PrefabUnpackMode
PrefabUtility PreferBinarySerialization PreferenceItem PreloadInfo PreprocessorOverride PreserveAttribute PreservedValuesAttribute Preset
PresetSelector PresetSelectorReceiver PresetType PreviewRenderUtility PreviewSceneStage PrimitiveBoundsHandle PrimitiveType ProbeBakeRequest
ProbeBakeRequestOutput Procedural ProceduralTexture ProcessEvent ProcessImportance ProcessLevel ProcessService ProcessState ProcessingContext
Processor ProcessorInstance ProfileCaptureOptions ProfileEventType Profiler ProfilerArea ProfilerCategoryInfo ProfilerEditorUtility
ProfilerTimeSampleSelection ProfilerWindow Progress ProgressBar Project ProjectBindDrawer ProjectCapabilityManager ProjectSearch ProjectSearchContext
ProjectSearchEngineAttribute ProjectSettingsInformationAnalytic ProjectWindowUtil Projector PropagationPhase Property PropertyAttribute
PropertyCollectionAttribute PropertyDatabase PropertyDatabaseRecordKey PropertyDatabaseType PropertyDrawer PropertyField PropertyModification
PropertyName PropertySceneHandle PropertyStreamHandle PropertyTable Provider ProviderSettingsEditor ProvisioningProfileType PurchasingSettings
QNXArchitecture QNXOsVersion QualityLevel QualitySettings Quaternion QuaternionEqualityComparer Query QueryBlock QueryEngine
QueryEngineFilterAttribute QueryEngineParameterTransformerAttribute QueryError QueryFilterOperator QueryGraph QueryGraphOptimizationOptions
QueryListBlock QueryListBlockAttribute QueryNodeType QueryParameters QueryToken QueryTriggerInteraction QueryValidationOptions QueueMode RTClearFlags
RadeonRaysContext RadeonRaysProbeIntegrator RadeonRaysProbePostProcessor RadeonRaysWorld RadioButton RadioButtonGroup Random Range RangeAttribute
RangeInt RasterState Ratio RawFrameDataView RawImage RawImageEditor Ray Ray2D RayTracingAABBsInstanceConfig RayTracingAccelerationStructure
RayTracingAccelerationStructureBuildFlags RayTracingGeometryInstanceConfig RayTracingInstanceCullingConfig RayTracingInstanceCullingFlags
RayTracingInstanceCullingMaterialTest RayTracingInstanceCullingResults RayTracingInstanceCullingShaderTagConfig RayTracingInstanceCullingTest
RayTracingInstanceMaterialCRC RayTracingInstanceMaterialConfig RayTracingInstanceTriangleCullingConfig RayTracingMeshInstanceConfig
RayTracingMultiGeometryInstanceConfig RayTracingShader RayTracingSubGeometryDesc RayTracingSubMeshFlags RayTracingSubMeshFlagsConfig RaycastCommand
RaycastHit RaycastHit2D RaycastResult RaycasterManager RealtimeContext RealtimeGICPUUsage ReceiveGI RecompileScripts Recorder
RecreatePipelineOnChangeAttribute Rect RectField RectInt RectIntField RectMask2D RectMask2DEditor RectOffset RectTransform RectTransformUtility
ReferenceContext ReferenceProbePostProcessor ReferencesOptions ReflectionCubemapCompression ReflectionProbe ReflectionProbeBlendInfo
ReflectionProbeClearFlags ReflectionProbeMode ReflectionProbeRefreshMode ReflectionProbeSortingCriteria ReflectionProbeTimeSlicingMode
ReflectionProbeType ReflectionProbeUsage RefreshFlags RefreshRate RegisterUxmlCacheAttribute RegistryInfo RelativeJoint2D Remote RemoteConfigSettings
RemoteDeviceVersion RemoteSettings RemoveAssetOptions RemoveIfAttribute RemoveIfNotAttribute RemoveOrSelectAttribute RemoveRequest RemovedComponent
RemovedGameObject RenderBuffer RenderBufferLoadAction RenderBufferStoreAction RenderMode RenderParams RenderPickingArgs RenderPickingResult
RenderPickingType RenderPipeline RenderPipelineAsset RenderPipelineEditorUtility RenderPipelineGlobalSettings RenderPipelineGlobalSettingsEditor
RenderPipelineGraphicsSettingsCollection RenderPipelineGraphicsSettingsEditorUtility RenderPipelineGraphicsSettingsExtensions RenderPipelineManager
RenderQueue RenderQueueRange RenderSettings RenderStateBlock RenderStateMask RenderTargetBinding RenderTargetBlendState RenderTargetFlags
RenderTargetIdentifier RenderTargetSetup RenderTexture RenderTextureCreationFlags RenderTextureDescriptor RenderTextureFormat RenderTextureMemoryless
RenderTextureReadWrite RenderTextureSubElement Renderer RendererExtensions RendererList RendererListDesc RendererListParams RendererListStatus
RenderingLayerMask RenderingLayerMaskField RenderingLayersLimitSettings RenderingPath RenderingThreadingMode RepaintFlags Repeat RepeatButton
ReplacePrefabOptions ReplayKit RepositoryInfo Request RequestScriptCompilationOptions RequestToUseMobileDataAsyncOperation
RequireAttributeUsagesAttribute RequireComponent RequireDerivedAttribute RequireImplementorsAttribute RequirePlatformSupportAttribute
RequiredInterfaceAttribute RequiredMemberAttribute ReserveModifiersAttribute ResetToEditorDefaultsRequest Resolution ResolutionDialogSetting
ResolveMethod Resolver ResourceFile ResourceFormattedPathsAttribute ResourcePathAttribute ResourcePathsAttribute ResourcePathsBaseAttribute
ResourceRequest Resources ResourcesAPI ResponseFileData RevertMode Rigidbody Rigidbody2D RigidbodyConstraints RigidbodyConstraints2D
RigidbodyInterpolation RigidbodyInterpolation2D RigidbodySleepMode2D RigidbodyType2D RoleProviderAttribute RootEditorAttribute RootOutputInstance
Rotate RotationConstraint RotationDriveMode RunAfterAssemblyAttribute RunAfterClassAttribute RunAfterPackageAttribute RunBeforeAssemblyAttribute
RunBeforeClassAttribute RunBeforePackageAttribute RunState RuntimeAnimatorController RuntimeInitializeLoadType RuntimeInitializeOnLoadMethodAttribute
RuntimePanelUtils RuntimePlatform Sample Sampler SaveAssetsProcessor SaveData SaveType ScalableBufferManager Scale ScaleConstraint ScaleMode
ScalerTarget ScalerVisualImpact Scene SceneAsset SceneBundleInfo SceneCullingMasks SceneDependencyInfo SceneHandle SceneHierarchyHooks SceneLoadInfo
SceneManager SceneManagerAPI SceneModeUtility SceneQueryEngineFilterAttribute SceneQueryEngineParameterTransformerAttribute SceneSearch
SceneSearchContext SceneSearchEngineAttribute SceneSetup SceneTemplateAsset SceneTemplatePipelineAdapter SceneTemplateService SceneUtility SceneView
SceneViewCameraWindow SceneVisibilityManager ScenesUsingAsset ScenesUsingAssets ScopedRenderPass ScopedSubPass Score Screen ScreenCapture
ScreenOrientation ScriptCallOptimizationLevel ScriptCompilationOptions ScriptCompilationResult ScriptCompilationSettings ScriptCompiler
ScriptCompilerOptions ScriptPlayable ScriptPlayableBinding ScriptPlayableOutput ScriptableCullingParameters ScriptableObject ScriptablePacker
ScriptableRenderContext ScriptableRenderPipelineExtensionAttribute ScriptableSingleton ScriptableWizard ScriptedImporter ScriptedImporterAttribute
ScriptedImporterEditor ScriptingImplementation ScriptingRuntimeVersion ScrollRect ScrollRectEditor ScrollView ScrollViewMode Scrollbar ScrollbarEditor
Scroller ScrollerVisibility SculptIndex SearchAction SearchActionsProviderAttribute SearchColumn SearchColumnCompareArgs SearchColumnEventArgs
SearchColumnFlags SearchColumnProviderAttribute SearchContext SearchContextAttribute SearchDocument SearchDocumentFlags SearchEngineScope
SearchExpression SearchExpressionContext SearchExpressionEvaluationHints SearchExpressionEvaluatorAttribute
SearchExpressionEvaluatorSignatureOverloadAttribute SearchExpressionKeyword SearchExpressionRuntime SearchExpressionType SearchField SearchFieldBase
SearchFlags SearchIndexer SearchItem SearchItemOptions SearchItemProviderAttribute SearchMonitor SearchMonitorView SearchProposition
SearchPropositionFlags SearchPropositionFlagsExtensions SearchPropositionOptions SearchProvider SearchQueryError SearchQueryErrorType SearchRequest
SearchResult SearchSelection SearchSelectorArgs SearchSelectorAttribute SearchService SearchSettings SearchTable SearchType SearchUtils SearchValue
SearchViewFlags SearchViewState SearchableEditorWindow SecondarySpriteTexture SecondaryTileData Security SegmentGeometry SelectIfAttribute
SelectIfNotAttribute SelectOrRemoveAttribute Selectable SelectableEditor Selection SelectionBaseAttribute SelectionMode SelectionType
SelfControllerEditor SemanticMeaning SemanticMergeMode SendEventOptions SendGameBuildAnalytic SendMessageOptions SerializationInfo SerializationMode
SerializationUtility SerializeField SerializeReference SerializedLocation SerializedObject SerializedObjectChangeEvent SerializedProperty
SerializedPropertyChangeEvent SerializedPropertyNumericType SerializedPropertyType SerializedType SessionState SettingsProvider
SettingsProviderAttribute SettingsProviderGroupAttribute SettingsScope SettingsService SetupDragAndDropArgs Shader ShaderBuildSettings
ShaderCompilerData ShaderCompilerMessageSeverity ShaderCompilerPlatform ShaderConstantType ShaderData ShaderGUI ShaderHardwareTier ShaderImporter
ShaderInclude ShaderIncludePathAttribute ShaderInfo ShaderKeyword ShaderKeywordSet ShaderKeywordType ShaderMessage ShaderParamType
ShaderPrecisionModel ShaderPropertyFlags ShaderPropertyType ShaderQuality ShaderRequirements ShaderSnippetData ShaderStage ShaderStageFlags
ShaderTagId ShaderType ShaderTypeFlags ShaderUtil ShaderVariantCollection ShadingRateCombiner ShadingRateCombinerStage ShadingRateFragmentSize
ShadingRateImage ShadingRateInfo Shadow ShadowCastersCullingInfos ShadowCastingMode ShadowDrawingSettings ShadowMapPass ShadowObjectsFilter
ShadowProjection ShadowQuality ShadowResolution ShadowSamplingMode ShadowSplitData ShadowmaskMode ShapeControlPoint SharedBetweenAnimatorsAttribute
ShortcutArguments ShortcutAttribute ShortcutBaseAttribute ShortcutBinding ShortcutBindingChangedEventArgs ShortcutManager ShortcutModifiers
ShortcutStage ShowDetailsOptions SimulationMode SimulationMode2D SimulationOption SimulationStage SimulatorAdaptivePerformanceSubsystem
SimulatorProviderConstants SimulatorProviderLoader SimulatorProviderSettings SimulatorProviderSettingsEditor SinglePassStereoMode SkeletonBone
SketchUpImportCamera SketchUpImportScene SketchUpImporter SketchupMaterialDescriptionPreprocessor SkinQuality SkinWeights SkinnedMeshRenderer Skybox
SleepTimeout SliceType Slider SliderDirection SliderEditor SliderInt SliderJoint2D Slot SlotType SnapAxis Snapping Social SoftJointLimit
SoftJointLimitSpring SortColumnDescription SortColumnDescriptions SortDirection SortingCriteria SortingGroup SortingLayer SortingLayerRange
SortingSettings SourceTextureInformation Space SpaceAttribute SparseTexture SpecialNames SpeechError SpeechSystemStatus SpeedTree9Importer
SpeedTreeImporter SpeedTreeWindAsset SphereBoundsHandle SphereCollider SphereGeometry SpherecastCommand SphericalHarmonicsL2 SplashScreen
SplashScreenStyle SplatPrototype SpringJoint SpringJoint2D Sprite SpriteAlignment SpriteAsset SpriteAtlas SpriteAtlasAsset SpriteAtlasExtensions
SpriteAtlasImporter SpriteAtlasManager SpriteAtlasPackingSettings SpriteAtlasTextureSettings SpriteAtlasUtility SpriteBone SpriteCharacter
SpriteDataAccessExtensions SpriteDrawMode SpriteEditorExtension SpriteGlyph SpriteImportData SpriteImportMode SpriteMask SpriteMaskInteraction
SpriteMeshType SpriteMetaData SpritePackerMode SpritePackingMode SpritePackingRotation SpriteRenderer SpriteRendererDataAccessExtensions
SpriteShapeMetaData SpriteShapeParameters SpriteShapeRenderer SpriteShapeSegment SpriteShapeUtility SpriteSortPoint SpriteState SpriteStateDrawer
SpriteTileMode SpriteUtility StackTraceLogType StackTraceUtility Stage StageHandle StageUtility StallSummaryAnalytic StandaloneBuildSubtarget
StandaloneInputModule StandaloneRenderResize StartDragArgs StateAction StateMachineBehaviour StateMachineBehaviourContext StaticBatchingUtility
StaticEditorFlags StaticOcclusionCulling StaticOcclusionCullingVisualization StatusCode StatusQueryOptions StencilMaterial StencilOp StencilState
StereoRenderingPath StereoTargetEyeMask Streaming StreamingController StringView StrippingInfo StrippingLevel StyleBackground StyleBackgroundPosition
StyleBackgroundRepeat StyleBackgroundSize StyleColor StyleCursor StyleEnum StyleFloat StyleFont StyleFontDefinition StyleInt StyleKeyword StyleLength
StyleList StyleMaterialDefinition StylePropertyName StylePropertyNameCollection StyleRatio StyleRotate StyleScale StyleSheet StyleTextAutoSize
StyleTextShadow StyleTransformOrigin StyleTranslate Styles SubMeshDescriptor SubPassDescriptor SubPassFlags SubmitResult Subsystem SubsystemDescriptor
SubsystemDescriptorExtensions SubsystemDescriptorStore SubsystemDescriptorWithProvider SubsystemExtensions SubsystemManager SubsystemProvider
SubsystemProxy SubsystemWithProvider SubsystemsAnalyticBase SubsystemsAnalyticInfo SubsystemsAnalyticStart SubsystemsAnalyticStop
SupportedOnRenderPipelineAttribute SupportedRenderingFeatures SurfaceEffector2D SwitchRomCompressionType SynchronisationStage
SynchronisationStageFlags Sysroot System SystemGestureDeferMode SystemInfo SystemLanguage Tab TabView TagConstraintAttribute TagField TagHandle
TakeInfo TargetGlesGraphics TargetIOSGraphics TargetJoint2D Task TempMeshAllocator TemplateContainer TemplateInstantiationMode Terrain
TerrainBrushPreviewMode TerrainBuiltinPaintMaterialPasses TerrainCallbacks TerrainCategory TerrainChangedFlags TerrainCollider TerrainData
TerrainDetailMeshRenderMode TerrainDetailMeshWizard TerrainDetailTextureWizard TerrainExtensions TerrainGeometry TerrainHeightmapSyncControl
TerrainInspectorUtility TerrainLayer TerrainLayerInspector TerrainLayerSmoothnessSource TerrainLayerUtility TerrainMap TerrainPaintTool
TerrainPaintToolWithOverlays TerrainPaintToolWithOverlaysBase TerrainPaintUtility TerrainPaintUtilityEditor TerrainQualityOverrides TerrainRenderFlags
TerrainTileCoord TerrainToolShortcutContext TerrainUtility TerrainWizard TestData TestMode TestMustExpectAllLogsAttribute TestPlatform
TestPlayerBuildModifierAttribute TestRunCallbackAttribute TestRunData TestRunDataHolder TestRunnerApi TestRunnerWindow TestStatus TexGenMode Text
TextAlignment TextAnchor TextAreaAttribute TextAsset TextAutoSize TextAutoSizeMode TextClipping TextColorGradient TextCoreShaderGUI
TextCoreShaderGUIBitmap TextCoreShaderGUISDF TextCursorPlacement TextEditor TextElement TextElementType TextEventManager TextField TextFontWeight
TextGenerationSettings TextGenerator TextGeneratorType TextInputBaseField TextMesh TextOverflow TextOverflowPosition TextSettings TextSettingsEditor
TextShaderUtilities TextShadow TextStyle TextStyleSheet TextValueField TextValueFieldTraits Texture Texture2D Texture2DArray Texture3D
TextureCompressionFormat TextureCompressionQuality TextureDimension TextureFormat TextureGenerationOutput TextureGenerationSettings TextureGenerator
TextureImporter TextureImporterAlphaSource TextureImporterCompression TextureImporterCubemapConvolution TextureImporterFormat
TextureImporterGenerateCubemap TextureImporterMipFilter TextureImporterNPOTScale TextureImporterNormalFilter TextureImporterPlatformSettings
TextureImporterRGBMMode TextureImporterSettings TextureImporterShape TextureImporterSingleChannelComponent TextureImporterSwizzle TextureImporterType
TextureMipmapLimitBiasMode TextureMipmapLimitGroups TextureMipmapLimitSettings TextureOptions TexturePropertyDescription TextureResizeAlgorithm
TextureSlotCount TextureWrapMode ThemeStyleSheet ThermalEventHandler ThermalMetrics ThreadPriority ThreadedBatchContext
ThreeDSMaterialDescriptionPreprocessor TierSettings Tile TileAnimationData TileAnimationFlags TileBase TileBaseEditor TileChangeData TileData
TileEditor TileFlags TileForegroundText TileTemplate Tilemap TilemapCollider2D TilemapRenderer Time TimeScope TimeUnit TimeValue TimerState Toast
ToastTemplate Toggle ToggleButtonGroup ToggleButtonGroupState ToggleButtonGroupStatePropertiesAttribute ToggleEditor ToggleGroup Tool ToolAttribute
ToolManager Toolbar ToolbarBreadcrumbs ToolbarButton ToolbarMenu ToolbarMenuElementExtensions ToolbarOverlay ToolbarPopupSearchField
ToolbarSearchField ToolbarSpacer ToolbarToggle Tools TooltipAttribute TooltipEvent TopologicalSort Touch TouchEvent TouchInputModule TouchPhase
TouchScreenKeyboard TouchScreenKeyboardType TouchType TrackedReference TrackingOriginModeFlags TrackingSpaceType TrailRenderer TransferFunction
Transform TransformAccess TransformAccessArray TransformHandle TransformOrigin TransformOriginOffset TransformSceneHandle TransformStreamHandle
TransformUtils TransitionCancelEvent TransitionEndEvent TransitionEventBase TransitionInterruptionSource TransitionRunEvent TransitionStartEvent
Translate TransparencySortMode Tree TreeInstance TreeMotionVectorModeOverride TreePrototype TreeView TreeViewController TreeViewExpansionChangedArgs
TreeViewInternal TreeViewItem TreeViewItemData TreeViewSelectionOptions TreeViewState TriangleMeshGeometry TrickleDown TrueTypeFontImporter
TwoPaneSplitView TwoPaneSplitViewOrientation TypeCache TypeDB TypeDbHelper TypeDescription TypeSelector TypedUxmlAttributeDescription Types
UGSAnalyticsInternalTools UIBehaviour UICharInfo UIDocument UIElementsEntryPoint UILineInfo UIOrientation UIRenderer UISubset UISystemProfilerApi
UIToolkitInputBackendOption UIToolkitInputConfiguration UIVertex UQuery UQueryBuilder UQueryExtensions UQueryState UVChannelFlags
UnassignedReferenceException Undo UndoPropertyModification UndoRedoInfo UndoSnapshot UnicodeLineBreakingRules UnityAPICompatibilityVersionAttribute
UnityAction UnityEvent UnityEventAwaitableExtensions UnityEventBase UnityEventCallState UnityEventQueueSystem UnityEventTools UnityException
UnityLinkerBuildPipelineData UnityOAuth UnityOneTimeSetUpAttribute UnityOneTimeTearDownAttribute UnityPlatformAttribute UnitySetUpAttribute UnityStats
UnitySurrogateSelector UnityTearDownAttribute UnityTestAttribute UnityWebRequest UnityWebRequestAssetBundle UnityWebRequestAsyncOperation
UnityWebRequestMultimedia UnityWebRequestTexture UnloadSceneOptions UnsafeGenericPool UnsignedIntegerField UnsignedLongField Unsupported UnwrapParam
Unwrapping UpdatePrefabInstancesEventArgs UploadHandler UploadHandlerFile UploadHandlerRaw UsageDial UsageHints Usb UsbDevice UserAuthorization
UserBuildSettings UserProfile UserScope UserState UsesLuminPlatformLevelAttribute UsesLuminPrivilegeAttribute Utility Utils
UxmlAssetAttributeDescription UxmlAttributeAttribute UxmlAttributeConverter UxmlAttributeDescription UxmlAttributeNames UxmlAttributeOverridesFactory
UxmlAttributeOverridesTraits UxmlBoolAttributeDescription UxmlChildElementDescription UxmlColorAttributeDescription UxmlCreateInstanceMethodAttribute
UxmlDescriptionCache UxmlDoubleAttributeDescription UxmlElementAttribute UxmlEnumAttributeDescription UxmlEnumeration UxmlFactory
UxmlFloatAttributeDescription UxmlHash128AttributeDescription UxmlIgnoreAttribute UxmlIntAttributeDescription UxmlLongAttributeDescription
UxmlNamespacePrefixAttribute UxmlObjectAttribute UxmlObjectReferenceAttribute UxmlRootElementFactory UxmlRootElementTraits UxmlSerializedData
UxmlSerializedDataCreator UxmlSerializedDataUtility UxmlStringAttributeDescription UxmlStyleFactory UxmlStyleTraits UxmlTemplateFactory
UxmlTemplateTraits UxmlTraits UxmlTypeAttributeDescription UxmlTypeReferenceAttribute UxmlTypeRestriction UxmlUnsignedIntAttributeDescription
UxmlUnsignedLongAttributeDescription UxmlUpgradeService UxmlValueBounds UxmlValueMatches VCProviderAnalytics VFXBatchedEffectInfo VFXCameraBufferTypes
VFXCameraXRSettings VFXEventAttribute VFXExposedProperty VFXExpressionValues VFXManager VFXOutputEventArgs VFXParticleSystemInfo VFXRenderer VFXSpace
VFXSpawnerCallbacks VFXSpawnerLoopState VFXSpawnerState VP8EncoderAttributes VRDeviceActiveControllersAnalytic VRDeviceAnalyticAspect
VRDeviceAnalyticBase VRDeviceMirrorAnalytic VRDeviceUserAnalytic VRTextureUsage ValidateCommandEvent ValidationLevel Vector2
Vector2ComparerWithEqualsOperator Vector2EqualityComparer Vector2Field Vector2Int Vector2IntField Vector3 Vector3ComparerWithEqualsOperator
Vector3EqualityComparer Vector3Field Vector3Int Vector3IntField Vector4 Vector4ComparerWithEqualsOperator Vector4EqualityComparer Vector4Field
VectorImage VersionChangeType VersionControlAttribute VersionControlDescriptor VersionControlManager VersionControlObject VersionControlSettings
VersionControlUtils VersionsInfo Vertex VertexAttribute VertexAttributeDescriptor VertexAttributeFormat VertexChannelCompressionFlags VertexHelper
VerticalLayoutGroup VerticalWrapMode Video3DLayout VideoAspectRatio VideoAudioOutputMode VideoBitrateMode VideoCapture VideoClip VideoClipImporter
VideoCodec VideoDeinterlaceMode VideoEncodeAspectRatio VideoEncodingProfile VideoImporterTargetSettings VideoPlayer VideoRenderMode VideoResizeMode
VideoShadersIncludeMode VideoSource VideoSpatialQuality VideoTimeReference VideoTimeSource VideoTimeUpdateMode VideoTrackAttributes
VideoTrackEncoderAttributes ViewTool Viewpoint VirtualMachineInformation Visibility VisibleLight VisibleObjects VisibleReflectionProbe
VisionOSSdkVersion VisionUtility VisualEffect VisualEffectAsset VisualEffectObject VisualElement VisualElementDebugExtensions VisualElementExtensions
VisualElementFocusChangeDirection VisualElementFocusRing VisualElementStyleSheetSet VisualTreeAsset VulkanDeviceFilterData VulkanDeviceFilterLists
VulkanGraphicsJobsDeviceFilterData WSABuildAndRunDeployTarget WSABuildType WSASDK WSASubtarget WSAUWPBuildType WWW WWWAudioExtensions WWWForm
WaitForDomainReload WaitForEndOfFrame WaitForFixedUpdate WaitForSeconds WaitForSecondsRealtime WaitTimeoutMode WaitUntil WaitWhile WarningLevel
Watermark WebCam WebCamDevice WebCamFlags WebCamKind WebCamMode WebCamTexture WebGLClientBrowserType WebGLCompressionFormat WebGLDebugSymbolMode
WebGLExceptionSupport WebGLLinkerTarget WebGLMemoryGrowthMode WebGLPowerPreference WebGLTextureSubtarget WebGLWasmArithmeticExceptions WeightedMode
WheelCollider WheelEvent WheelFrictionCurve WheelHit WheelJoint2D WhitePoint WhiteSpace WindZone WindZoneMode Window WindowActivated
WindowActivationState WindowSizeChanged WindowsBuildAndRunDeployTarget WindowsGamepadBackendHint WorldDocumentRaycaster Wrap WrapMode WriteCommand
WriteManagerParameters WriteParameters WriteResult WriteSceneParameters XRDevice XRDisplaySubsystem XRDisplaySubsystemDescriptor XRInputSubsystem
XRInputSubsystemDescriptor XRMeshSubsystem XRMeshSubsystemDescriptor XRMirrorViewBlitMode XRMirrorViewBlitModeDesc XRNode XRNodeState XRSettings
XRStats XboxBuildSubtarget XboxOneDeployDrive XboxOneDeployMethod XboxOneEncryptionLevel XboxOneLoggingLevel XboxOnePackageUpdateGranularity XcScheme
XcodeBuildConfig YieldInstruction iOSAppInBackgroundBehavior iOSBackgroundMode iOSBuildType iOSDeviceRequirement iOSLaunchScreenImageType
iOSLaunchScreenType iOSSdkVersion iOSShowActivityIndicatorOnLoading iOSStatusBarStyle iOSSystemGestureDeferMode iOSTargetDevice iOSTargetOSVersion
jvalue tvOSSdkVersion tvOSTargetOSVersion
`;

// UNITY_TYPES 가운데 .NET 기본 어셈블리(mscorlib · System · System.Core)의 공개 멤버 이름과 같은 것.
const UNITY_MEMBER_NAMES = `
Analytic Application Arguments Assembly AssemblyFlags Assert Background Box ChannelInfo Client Color Column Component Connection Constants Debug
Device Directory Error ErrorCode Event EventHandle EventID EventProvider EventType Events Feature File Filter FilterAttribute GUID Gender Hand Help
Image Input Label Layout Length Local LogType Mask Menu Message MessageType OSArchitecture Object Ping Position Property PropertyName Provider Query
Random Range Repeat Request ResolveMethod Resources Sample Security Selection SortDirection Space StatusCode System Tab Task Text Time Toggle Tool
Translate Types Undo UserProfile UserState Visibility WarningLevel Window
`;

// Unity 어셈블리의 어트리뷰트 타입 이름과 끝의 Attribute 를 뗀 이름.
const UNITY_ATTRIBUTES = `
AdaptivePerformanceConfigurationData AdaptivePerformanceConfigurationDataAttribute AdaptivePerformanceSupportedBuildTarget
AdaptivePerformanceSupportedBuildTargetAttribute AddComponentMenu AdvancedObjectSelector AdvancedObjectSelectorAttribute
AdvancedObjectSelectorValidator AdvancedObjectSelectorValidatorAttribute AlwaysLinkAssembly AlwaysLinkAssemblyAttribute AnalyticInfo
AnalyticInfoAttribute ApplyRulesIfGraphicsAPI ApplyRulesIfGraphicsAPIAttribute ApplyRulesIfNotGraphicsAPI ApplyRulesIfNotGraphicsAPIAttribute
ApplyRulesIfTagsEqual ApplyRulesIfTagsEqualAttribute ApplyRulesIfTagsNotEqual ApplyRulesIfTagsNotEqualAttribute AssemblyIsEditorAssembly
AssetPostprocessorStaticVariableIgnore AssetPostprocessorStaticVariableIgnoreAttribute BeforeRenderOrder BeforeRenderOrderAttribute
BuildCallbackVersion BuildCallbackVersionAttribute CallbackOrder CallbackOrderAttribute CanEditMultipleObjects CategoryInfo CategoryInfoAttribute
ClutchShortcut ClutchShortcutAttribute CollectImportedDependencies CollectImportedDependenciesAttribute ColorUsage ColorUsageAttribute CommandHandler
CommandHandlerAttribute ConditionalIgnore ConditionalIgnoreAttribute ContextMenu ContextMenuItem ContextMenuItemAttribute CreateAssetMenu
CreateAssetMenuAttribute CustomEditor CustomEditorForRenderPipeline CustomEditorForRenderPipelineAttribute CustomGridBrush CustomGridBrushAttribute
CustomObjectIndexer CustomObjectIndexerAttribute CustomPivot CustomPivotAttribute CustomPreview CustomPreviewAttribute CustomPropertyDrawer
DeeplinkHandler DeeplinkHandlerAttribute DefaultExecutionOrder Delayed DelayedAttribute DidReloadScripts DiffuseProfileCallback
DiffuseProfileCallbackAttribute DisallowMultipleComponent DiscreteEvaluation DiscreteEvaluationAttribute DrawGizmo EditorTool EditorToolAttribute
EditorToolContext EditorToolContextAttribute EditorToolbarElement EditorToolbarElementAttribute EditorWindowTitle EditorWindowTitleAttribute
ElementInfo ElementInfoAttribute EnumButtons EnumButtonsAttribute EventInterest EventInterestAttribute ExcludeFromCoverage
ExcludeFromCoverageAttribute ExcludeFromObjectFactory ExcludeFromObjectFactoryAttribute ExcludeFromPreset ExcludeFromPresetAttribute ExecuteAlways
ExecuteInEditMode FilePath FilePathAttribute Filter FilterAttribute FormerlySerializedAs FormerlySerializedAsAttribute GUITarget GUITargetAttribute
GradientUsage GradientUsageAttribute GraphicsAPIConstraint GraphicsAPIConstraintAttribute Header HeaderAttribute HelpURL HelpURLAttribute
HideInCallstack HideInCallstackAttribute HideInInspector Icon IconAttribute ImageEffectAfterScale ImageEffectAllowedInSceneView ImageEffectOpaque
ImageEffectTransformsToLDR ImageEffectUsesCommandBuffer InitializeOnEnterPlayMode InitializeOnEnterPlayModeAttribute InitializeOnLoad
InitializeOnLoadAttribute InitializeOnLoadMethod InitializeOnLoadMethodAttribute InspectorName InspectorNameAttribute InspectorOrder
InspectorOrderAttribute LightingExplorerExtension LightingExplorerExtensionAttribute Localization LocalizationAttribute MainToolbarElement
MainToolbarElementAttribute MakeSerializable MakeSerializableAttribute MaterialSettingsCallback MaterialSettingsCallbackAttribute MenuItem Min
MinAttribute MovedFrom MovedFromAttribute Multiline MultilineAttribute NonReorderable NonReorderableAttribute NotKeyable NotKeyableAttribute
ObjectSelectorEngine ObjectSelectorEngineAttribute ObjectSelectorHandler ObjectSelectorHandlerAttribute ObjectSelectorHandlerWithLabels
ObjectSelectorHandlerWithLabelsAttribute ObjectSelectorHandlerWithTags ObjectSelectorHandlerWithTagsAttribute OnOpenAsset OnOpenAssetAttribute Overlay
OverlayAttribute ParametrizedIgnore ParametrizedIgnoreAttribute PostBuildCleanup PostBuildCleanupAttribute PostBuildCleanupWithTestData
PostBuildCleanupWithTestDataAttribute PostProcess PostProcessAttribute PostProcessBuild PostProcessBuildAttribute PostProcessScene
PostProcessSceneAttribute PrebuildSetup PrebuildSetupAttribute PrebuildSetupWithTestData PrebuildSetupWithTestDataAttribute PreferBinarySerialization
PreferenceItem Preserve PreserveAttribute PreservedValues PreservedValuesAttribute ProjectSearchEngine ProjectSearchEngineAttribute Property
PropertyAttribute PropertyCollection PropertyCollectionAttribute QueryEngineFilter QueryEngineFilterAttribute QueryEngineParameterTransformer
QueryEngineParameterTransformerAttribute QueryListBlock QueryListBlockAttribute Range RangeAttribute RecreatePipelineOnChange
RecreatePipelineOnChangeAttribute RegisterUxmlCache RegisterUxmlCacheAttribute RemoveIf RemoveIfAttribute RemoveIfNot RemoveIfNotAttribute
RemoveOrSelect RemoveOrSelectAttribute RequireAttributeUsages RequireAttributeUsagesAttribute RequireComponent RequireDerived RequireDerivedAttribute
RequireImplementors RequireImplementorsAttribute RequirePlatformSupport RequirePlatformSupportAttribute RequiredInterface RequiredInterfaceAttribute
RequiredMember RequiredMemberAttribute ReserveModifiers ReserveModifiersAttribute ResourceFormattedPaths ResourceFormattedPathsAttribute ResourcePath
ResourcePathAttribute ResourcePaths ResourcePathsAttribute ResourcePathsBase ResourcePathsBaseAttribute RoleProvider RoleProviderAttribute RootEditor
RootEditorAttribute RunAfterAssembly RunAfterAssemblyAttribute RunAfterClass RunAfterClassAttribute RunAfterPackage RunAfterPackageAttribute
RunBeforeAssembly RunBeforeAssemblyAttribute RunBeforeClass RunBeforeClassAttribute RunBeforePackage RunBeforePackageAttribute
RuntimeInitializeOnLoadMethod RuntimeInitializeOnLoadMethodAttribute SceneQueryEngineFilter SceneQueryEngineFilterAttribute
SceneQueryEngineParameterTransformer SceneQueryEngineParameterTransformerAttribute SceneSearchEngine SceneSearchEngineAttribute
ScriptableRenderPipelineExtension ScriptableRenderPipelineExtensionAttribute ScriptedImporter ScriptedImporterAttribute SearchActionsProvider
SearchActionsProviderAttribute SearchColumnProvider SearchColumnProviderAttribute SearchContext SearchContextAttribute SearchExpressionEvaluator
SearchExpressionEvaluatorAttribute SearchExpressionEvaluatorSignatureOverload SearchExpressionEvaluatorSignatureOverloadAttribute SearchItemProvider
SearchItemProviderAttribute SearchSelector SearchSelectorAttribute SelectIf SelectIfAttribute SelectIfNot SelectIfNotAttribute SelectOrRemove
SelectOrRemoveAttribute SelectionBase SelectionBaseAttribute SerializeField SerializeReference SettingsProvider SettingsProviderAttribute
SettingsProviderGroup SettingsProviderGroupAttribute ShaderIncludePath ShaderIncludePathAttribute SharedBetweenAnimators
SharedBetweenAnimatorsAttribute Shortcut ShortcutAttribute ShortcutBase ShortcutBaseAttribute Space SpaceAttribute SupportedOnRenderPipeline
SupportedOnRenderPipelineAttribute TagConstraint TagConstraintAttribute TestMustExpectAllLogs TestMustExpectAllLogsAttribute TestPlayerBuildModifier
TestPlayerBuildModifierAttribute TestRunCallback TestRunCallbackAttribute TextArea TextAreaAttribute ToggleButtonGroupStateProperties
ToggleButtonGroupStatePropertiesAttribute Tool ToolAttribute Tooltip TooltipAttribute UnityAPICompatibilityVersion
UnityAPICompatibilityVersionAttribute UnityOneTimeSetUp UnityOneTimeSetUpAttribute UnityOneTimeTearDown UnityOneTimeTearDownAttribute UnityPlatform
UnityPlatformAttribute UnitySetUp UnitySetUpAttribute UnityTearDown UnityTearDownAttribute UnityTest UnityTestAttribute UsesLuminPlatformLevel
UsesLuminPlatformLevelAttribute UsesLuminPrivilege UsesLuminPrivilegeAttribute UxmlAttribute UxmlAttributeAttribute UxmlCreateInstanceMethod
UxmlCreateInstanceMethodAttribute UxmlElement UxmlElementAttribute UxmlIgnore UxmlIgnoreAttribute UxmlNamespacePrefix UxmlNamespacePrefixAttribute
UxmlObject UxmlObjectAttribute UxmlObjectReference UxmlObjectReferenceAttribute UxmlTypeReference UxmlTypeReferenceAttribute VersionControl
VersionControlAttribute
`;

// Unity 타입 네임스페이스의 조각(UnityEngine.SceneManagement → UnityEngine · SceneManagement).
const UNITY_NAMESPACES = `
AI AMD APIUpdating Accessibility Actions AdaptivePerformance Advertisements Analytics Android AnimatedValues AnimationBlendTree Animations Api Apple
Assertions AssetImporters Audio Basic Build Callbacks Categorization Comparers Compilation Connect Constraints Content Controls CrashReportHandler
CrashReporting DedicatedServer Device DeviceSimulation Diagnostics Editor EditorTools Embree EngineDiagnostics EventSystems Events Extensions
GameCenter GraphicsSettingsInspectors Graphs Hardware IMGUI Identifiers Impl Importer InputSystem Inspector Jobs LightTransport Localization LowLevel
LowLevelPhysics LowLevelPhysics2D Lumin MPE Macros Media MemoryProfiler Metadata Must NVIDIA Networking OSXStandalone Overlays PackageManager
ParticleSystemJobs Playables Player PlayerConnection Pool PostProcessing Presets Profile Profiling ProjectWindowCallback Provider Providers Purchasing
RendererUtils Rendering ReplayKit Reporting Requests SceneManagement SceneTemplate Scripting Search SearchService Serialization ShaderKeywordFilter
Shaders ShortcutManagement Simulator SocialPlatforms Speech SpeedTree Sprites Subsystems SubsystemsImplementation TerrainTools TerrainUtils TestRunner
TestTools Text TextCore Tilemaps Toolbars U2D UI UIElements UnityConsent UnityEditor UnityEngine UnityLinker UnityTestProtocol Utils VFX
VersionControl Video VirtualTexturing WSA WebCam Windows XR Xcode iOS tvOS
`;
