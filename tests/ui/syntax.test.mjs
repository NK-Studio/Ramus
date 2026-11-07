// ui/syntax.js 시험. 원본 Tests/Editor/GitTextEditorTests.cs 의 Test_Tokenize_* · Test_UnityApi_* · Test_LanguageOf_* 를 옮겼다.
// 저장소 뿌리에서 `node tests/ui/syntax.test.mjs` 로 돌린다.
import assert from 'node:assert/strict';
import {
  STATE_NORMAL, STATE_BLOCK_COMMENT, languageOf, tokenize, highlightLines, highlight,
  isUnityType, isUnityAttribute, isUnityMessage,
} from '../../ui/syntax.js';

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push([name, null]);
  } catch (error) {
    results.push([name, error]);
  }
}

/** 원본 Spans(): 조각을 [글, 갈래] 로. 괄호 짝 색(bracket-*)은 원본에 없으므로 빼고 본다(아래 따로 시험한다). */
function spans(line, language, state = STATE_NORMAL) {
  return tokenize(line, language, state).spans
    .filter((span) => !span.kind.startsWith('bracket-'))
    .map((span) => [line.substr(span.start, span.length), span.kind]);
}

// ── GitSyntax ──

test('Test_Tokenize_CLike_ControlKeywordsAreSeparate', () => {
  // VSCode 처럼 흐름을 바꾸는 키워드(control)는 다른 키워드와 따로 칠한다.
  assert.deepEqual(spans('public static string A { get { return x; } }', 'csharp'), [
    ['public', 'keyword'], ['static', 'keyword'], ['string', 'keyword'], ['get', 'keyword'], ['return', 'control'],
  ]);
});

test('Test_Tokenize_CLike_BracketDepthCarriesAcrossLines', () => {
  // 괄호는 깊이마다 세 색을 돌려 쓰고, 깊이는 줄 끝 상태로 다음 줄에 이어진다.
  const brackets = (line, state) => {
    const r = tokenize(line, 'csharp', state);
    return { kinds: r.spans.filter((x) => x.kind.startsWith('bracket-')).map((x) => `${line[x.start]}${x.kind.slice(8)}`), state: r.state };
  };
  const a = brackets('class A {', STATE_NORMAL);
  assert.deepEqual(a.kinds, ['{0']);
  const b = brackets('  void F() { G(x[1]); }', a.state);
  assert.deepEqual(b.kinds, ['(1', ')1', '{1', '(2', '[0', ']0', ')2', '}1']);
  const c = brackets('}', b.state);
  assert.deepEqual(c.kinds, ['}0']);
  assert.equal(c.state, STATE_NORMAL);
});

test('Test_Tokenize_CLike_BlockCommentStateSurvivesBracketDepth', () => {
  // 괄호 깊이가 상태에 실려도 블록 주석은 이어진다.
  const a = tokenize('{ /* open', 'clike', STATE_NORMAL);
  const b = tokenize('still */ }', 'clike', a.state);
  assert.deepEqual(b.spans.map((x) => [ 'still */ }'.substr(x.start, x.length), x.kind]), [['still */', 'comment'], ['}', 'bracket-0']]);
  assert.equal(b.state, STATE_NORMAL);
});

test('Test_Tokenize_CSharp_KeywordsStringsNumbersComments', () => {
  assert.deepEqual(spans('public int x = 42; string s = "a\\"b"; // done', 'clike'), [
    ['public', 'keyword'],
    ['int', 'keyword'],
    ['42', 'number'],
    ['string', 'keyword'],
    ['"a\\"b"', 'string'],
    ['// done', 'comment'],
  ]);
});

test('Test_Tokenize_BlockComment_CarriesStateAcrossLines', () => {
  const { state } = tokenize('int a; /* start', 'clike', STATE_NORMAL);
  assert.equal(state, STATE_BLOCK_COMMENT);

  assert.deepEqual(spans('still */ return 1;', 'clike', state), [
    ['still */', 'comment'],
    ['return', 'control'],
    ['1', 'number'],
  ]);
});

test('Test_Tokenize_CSharp_UnityTypesAndMessages', () => {
  assert.deepEqual(spans('public class Player : MonoBehaviour', 'csharp'), [
    ['public', 'keyword'],
    ['class', 'keyword'],
    ['MonoBehaviour', 'type'],
  ]);
  // 메시지 선언은 함수 색, Debug.Log 의 Log · transform.position 은 멤버라 칠하지 않는다.
  assert.deepEqual(spans('    private void Update() { Debug.Log(transform.position); }', 'csharp'), [
    ['private', 'keyword'],
    ['void', 'keyword'],
    ['Update', 'function'],
    ['Debug', 'type'],
  ]);
  assert.deepEqual(spans('IEnumerator Start()', 'csharp'), [
    ['IEnumerator', 'type'],
    ['Start', 'function'],
  ]);
});

test('Test_Tokenize_CSharp_TypePositions', () => {
  assert.deepEqual(spans('var rb = GetComponent<Rigidbody>(); var v = new Vector3(1, 2);', 'csharp'), [
    ['var', 'keyword'],
    ['Rigidbody', 'type'],
    ['var', 'keyword'],
    ['new', 'keyword'],
    ['Vector3', 'type'],
    ['1', 'number'],
    ['2', 'number'],
  ]);
  // . 앞이 네임스페이스면 타입.
  assert.deepEqual(spans('UnityEngine.Debug.Log("a");', 'csharp'), [
    ['Debug', 'type'],
    ['"a"', 'string'],
  ]);
  assert.deepEqual(spans('List<GameObject> targets;', 'csharp'), [
    ['List', 'type'],
    ['GameObject', 'type'],
  ]);
});

test('Test_Tokenize_CSharp_Attributes', () => {
  // Range 는 흔한 이름이라 타입 표에서 빠지지만, 어트리뷰트 자리에서는 어트리뷰트만 올 수 있어 칠한다.
  assert.deepEqual(spans('[SerializeField, Range(0, 1)] private float speed;', 'csharp'), [
    ['SerializeField', 'type'],
    ['Range', 'type'],
    ['0', 'number'],
    ['1', 'number'],
    ['private', 'keyword'],
    ['float', 'keyword'],
  ]);
  assert.deepEqual(spans('[RequireComponent(typeof(Rigidbody))]', 'csharp'), [
    ['RequireComponent', 'type'],
    ['typeof', 'keyword'],
    ['Rigidbody', 'type'],
  ]);
});

for (const [line, colored] of [
  ['for (int i = 0; i < Length; i++)', ['for', 'int', '0']],
  ['var n = items.Length;', ['var']],
  ['Mode = 1; return Result;', ['1', 'return']],
  ['Settings.Value = State;', []],
  ['Rigidbody = other;', []],
  ['Start(); Position.Set(1);', ['1']],
]) {
  test(`Test_Tokenize_CSharp_CommonNamesStayPlain(${JSON.stringify(line)})`, () => {
    const result = spans(line, 'csharp');
    assert.deepEqual(result.map(([text]) => text), colored);
    assert.ok(!result.some(([, kind]) => kind === 'type' || kind === 'function'));
  });
}

test('Test_Tokenize_CSharp_DeclaredNameIsNotAType', () => {
  assert.deepEqual(spans('public Camera Camera { get; }', 'csharp'), [
    ['public', 'keyword'],
    ['Camera', 'type'],
    ['get', 'keyword'],
  ]);
});

test('Test_Tokenize_UnityTypesOnlyInCSharp', () => {
  assert.deepEqual(spans('var v = Vector3;', 'clike'), [['var', 'keyword']]);
  assert.deepEqual(spans('void Update()', 'clike'), [['void', 'keyword']]);
});

test('Test_UnityApi_DropsCommonNames', () => {
  assert.ok(isUnityType('GameObject'));
  assert.ok(isUnityType('EditorWindow'));
  assert.ok(isUnityType('Debug'), '흔하지만 핵심인 이름은 남긴다');
  assert.ok(!isUnityType('Length'));
  assert.ok(!isUnityType('Position'));
  assert.ok(!isUnityType('State'));
  assert.ok(isUnityAttribute('Header'));
  assert.ok(isUnityAttribute('HeaderAttribute'));
  assert.ok(isUnityMessage('OnTriggerEnter'));
});

test('Test_Tokenize_Json_KeysValuesLiterals', () => {
  assert.deepEqual(spans('"com.unity.burst": "2.0.0", "n": -1.5e3, "b": true', 'json'), [
    ['"com.unity.burst"', 'key'],
    ['"2.0.0"', 'string'],
    ['"n"', 'key'],
    ['-1.5e3', 'number'],
    ['"b"', 'key'],
    ['true', 'keyword'],
  ]);
});

test('Test_Tokenize_Yaml_KeyNumberComment', () => {
  assert.deepEqual(spans('  m_Name: 12 # note', 'yaml'), [
    ['m_Name', 'key'],
    ['12', 'number'],
    ['# note', 'comment'],
  ]);
  // guid 처럼 숫자로 시작하는 낱말은 숫자가 아니다.
  assert.deepEqual(spans('guid: 7a3e9f00b1', 'yaml'), [['guid', 'key']]);
  assert.deepEqual(spans('--- !u!1 &100', 'yaml'), [['--- !u!1 &100', 'keyword']]);
});

test('Test_Tokenize_Xml_TagsAttributesComments', () => {
  assert.deepEqual(spans('<ui:Button name="go" /> <!-- c -->', 'xml'), [
    ['ui:Button', 'key'],
    ['"go"', 'string'],
    ['<!-- c -->', 'comment'],
  ]);
});

test('Test_Tokenize_Html_TagsAttributesValuesPunctuation', () => {
  assert.deepEqual(spans('    <meta charset="UTF-8">text</p>', 'html'), [
    ['<', 'punctuation'],
    ['meta', 'tag'],
    ['charset', 'attribute'],
    ['=', 'punctuation'],
    ['"UTF-8"', 'string'],
    ['>', 'punctuation'],
    ['</', 'punctuation'],
    ['p', 'tag'],
    ['>', 'punctuation'],
  ]);

  assert.deepEqual(spans('<!DOCTYPE html>', 'html'), [
    ['<', 'punctuation'],
    ['!DOCTYPE', 'tag'],
    ['html', 'attribute'],
    ['>', 'punctuation'],
  ]);
});

test('Test_Tokenize_Html_ScriptContentIsJavaScript', () => {
  const { state } = tokenize('<script type="text/javascript">', 'html', STATE_NORMAL);

  assert.deepEqual(spans('    var url = "manual/index.html"; // go', 'html', state), [
    ['var', 'keyword'],
    ['"manual/index.html"', 'string'],
    ['// go', 'comment'],
  ]);

  const closing = tokenize('</script>', 'html', state);
  assert.equal(closing.state, STATE_NORMAL);
  assert.equal(closing.spans[1].kind, 'tag');
});

test('Test_Tokenize_Html_TagSpanningLines', () => {
  const { state } = tokenize('<link rel="stylesheet"', 'html', STATE_NORMAL);

  assert.deepEqual(spans('      href="a.css">', 'html', state), [
    ['href', 'attribute'],
    ['=', 'punctuation'],
    ['"a.css"', 'string'],
    ['>', 'punctuation'],
  ]);
});

test('Test_Tokenize_Uss_UnityPropertiesAreKeys', () => {
  assert.deepEqual(spans('    -unity-font-style: bold;', 'css'), [
    ['-unity-font-style', 'key'],
  ]);

  assert.deepEqual(spans('    -unity-slice-left: 4;', 'css'), [
    ['-unity-slice-left', 'key'],
    ['4', 'number'],
  ]);

  assert.deepEqual(spans('    --accent-color: #ff5c6c;', 'css'), [
    ['--accent-color', 'key'],
    ['#ff5c6c', 'number'],
  ]);
});

test('Test_Tokenize_Uss_FunctionsUnitsAndAtRules', () => {
  assert.deepEqual(spans('    background-image: resource("Icons/d_Trash");', 'css'), [
    ['background-image', 'key'],
    ['resource', 'keyword'],
    ['"Icons/d_Trash"', 'string'],
  ]);

  assert.deepEqual(spans('    -unity-font-definition: url(../Fonts/A.ttf);', 'css'), [
    ['-unity-font-definition', 'key'],
    ['url', 'keyword'],
    ['../Fonts/A.ttf', 'string'],
  ]);

  assert.deepEqual(spans('@import url("unity-theme://default");', 'css'), [
    ['@import', 'keyword'],
    ['url', 'keyword'],
    ['"unity-theme://default"', 'string'],
  ]);

  assert.deepEqual(spans('    max-width: 50% -2px;', 'css'), [
    ['max-width', 'key'],
    ['50%', 'number'],
    ['-2px', 'number'],
  ]);
});

test('Test_Tokenize_Uss_SelectorsAreNotProperties', () => {
  assert.deepEqual(spans('Button:hover,', 'css'), [
    ['Button', 'tag'],
    [':hover', 'keyword'],
    [',', 'punctuation'],
  ]);

  assert.deepEqual(spans('.git-themed .unity-scroller > .unity-scroller__slider:hover:enabled {', 'css'), [
    ['.git-themed', 'attribute'],
    ['.unity-scroller', 'attribute'],
    ['>', 'punctuation'],
    ['.unity-scroller__slider', 'attribute'],
    [':hover', 'keyword'],
    [':enabled', 'keyword'],
  ]);

  // #아이디는 16진 색이 아니다.
  assert.deepEqual(spans('#delete-test-footer {', 'css'), [['#delete-test-footer', 'attribute']]);
  assert.deepEqual(spans(':root {', 'css'), [[':root', 'keyword']]);
});

test('Test_Tokenize_Uss_SingleLineRule', () => {
  assert.deepEqual(spans('.state-badge--added { background-color: var(--git-state-added); }', 'css'), [
    ['.state-badge--added', 'attribute'],
    ['background-color', 'key'],
    ['var', 'keyword'],
  ]);
});

test('Test_LanguageOf_ByExtension', () => {
  assert.equal(languageOf('Assets/A.cs'), 'csharp');
  assert.equal(languageOf('Assets/Shaders/A.shader'), 'clike');
  assert.equal(languageOf('Packages/manifest.json'), 'json');
  assert.equal(languageOf('Assets/Scenes/A.unity'), 'yaml');
  assert.equal(languageOf('Editor/UI/Styles/GitDiff.uss'), 'css');
  assert.equal(languageOf('A.uxml'), 'xml');
  assert.equal(languageOf('Assets/Web/index.html'), 'html');
  assert.equal(languageOf('Assets/Web/style.css'), 'css');
  assert.equal(languageOf('Assets/Web/app.js'), 'clike');
  assert.equal(languageOf('README.md'), null);
  assert.equal(languageOf('tools/build.py'), 'python');
  assert.equal(languageOf('stubs/a.pyi'), 'python');
});

// ── Python(이 포트에서 더한 말, PyCharm 색 갈래 py-*) ──

test('python_KeywordsSelfStringsKwargs', () => {
  assert.deepEqual(spans("        self.assertEqual('', self.tool._classify('Passed', ['Skipped']))", 'python'), [
    ['self', 'py-self'], ["''", 'py-string'], ['self', 'py-self'], ["'Passed'", 'py-string'], ["'Skipped'", 'py-string'],
  ]);
  assert.deepEqual(spans("(self.directory / 'a.json').write_text(json.dumps(x), encoding='utf-8')", 'python'), [
    ['self', 'py-self'], ["'a.json'", 'py-string'], ['encoding', 'py-kwarg'], ["'utf-8'", 'py-string'],
  ]);
  assert.deepEqual(spans('if __name__ == \'__main__\':', 'python'), [['if', 'py-keyword'], ["'__main__'", 'py-string']]);
  assert.deepEqual(spans('def find_font() -> str | None:', 'python'), [
    ['def', 'py-keyword'], ['find_font', 'py-function'], ['None', 'py-keyword'],
  ]);
  // obj.self · obj.None 같은 멤버는 칠하지 않는다.
  assert.deepEqual(spans('x = a.self', 'python'), []);
});

test('python_DefDefaultsAreNotKwargs', () => {
  assert.deepEqual(spans('def f(a, b=1, *, c: int = 2):', 'python'), [
    ['def', 'py-keyword'], ['f', 'py-function'], ['1', 'py-number'], ['2', 'py-number'],
  ]);
  // 여러 줄 def 머리도 괄호가 닫힐 때까지 기본값으로 본다.
  const a = tokenize('def f(', 'python');
  assert.deepEqual(tokenize('    b=1,', 'python', a.state).spans.map((s) => s.kind), ['py-number']);
  // 여러 줄 호출은 이름=값 을 이어서 본다.
  const call = tokenize("path.write_text('x',", 'python');
  const next = '    encoding=\'utf-8\')';
  assert.deepEqual(spans(next, 'python', call.state), [['encoding', 'py-kwarg'], ["'utf-8'", 'py-string']]);
  assert.equal(tokenize(next, 'python', call.state).state, STATE_NORMAL);
});

test('python_EscapesPrefixesNumbersComments', () => {
  assert.deepEqual(spans("t = '# 메모\\n  FAIL\\x41\\d'", 'python'), [
    ["'# 메모", 'py-string'], ['\\n', 'py-escape'], ['  FAIL', 'py-string'], ['\\x41', 'py-escape'], ["\\d'", 'py-string'],
  ]);
  // raw 문자열은 이스케이프를 따로 칠하지 않는다.
  assert.deepEqual(spans("re.sub(r'\\\\1', x)  # 바꾼다", 'python'), [["r'\\\\1'", 'py-string'], ['# 바꾼다', 'py-comment']]);
  assert.deepEqual(spans('f"{a}" + b\'z\' + 0x1F + 1_000 + 2.5e3j', 'python'), [
    ['f"{a}"', 'py-string'], ["b'z'", 'py-string'], ['0x1F', 'py-number'], ['1_000', 'py-number'], ['2.5e3j', 'py-number'],
  ]);
  assert.deepEqual(spans('#!/usr/bin/env python3', 'python'), [['#!/usr/bin/env python3', 'py-comment']]);
  assert.deepEqual(spans('@dataclass.field(x=1)', 'python'), [['@dataclass.field', 'py-decorator'], ['x', 'py-kwarg'], ['1', 'py-number']]);
});

test('python_TripleQuotedStringsCarryAcrossLines', () => {
  // 문장 첫자리의 삼중 따옴표는 문서 문자열.
  const a = tokenize('"""자연 회복 고정 구도', 'python');
  assert.deepEqual(a.spans.map((s) => s.kind), ['py-docstring']);
  const b = tokenize('    python3 a.py \\n', 'python', a.state);
  assert.deepEqual(b.spans.map((s) => s.kind), ['py-docstring']);
  const c = tokenize('끝."""  # x', 'python', b.state);
  assert.deepEqual(spans('끝."""  # x', 'python', b.state), [['끝."""', 'py-docstring'], ['# x', 'py-comment']]);
  assert.equal(c.state, STATE_NORMAL);
  // 대입의 삼중 따옴표는 보통 문자열이고 이스케이프도 칠한다.
  const d = tokenize("X = '''a\\t", 'python');
  assert.deepEqual(d.spans.map((s) => s.kind), ['py-string', 'py-escape']);
  assert.deepEqual(spans("b'''", 'python', d.state), [["b'''", 'py-string']]);
  assert.equal(tokenize("b'''", 'python', d.state).state, STATE_NORMAL);
});

// ── 이 포트의 HTML 출력(원본에 없는 몫: ui/tools.js 의 블레임 · 코드 편집기가 쓰는 모양) ──

test('highlightLines_EscapesAndCarriesState', () => {
  assert.deepEqual(highlightLines(['a < b /* x', 'y */ 1'], 'clike'), [
    'a &lt; b <span class="sx-comment">/* x</span>',
    '<span class="sx-comment">y */</span> <span class="sx-number">1</span>',
  ]);
  assert.deepEqual(highlightLines(['<b>&'], null), ['&lt;b&gt;&amp;']);
});

test('highlight_PerLineArrayJoinsAsText', () => {
  const html = highlight('int a;\n// b', 'clike');
  assert.equal(html[0], '<span class="sx-keyword">int</span> a;');
  assert.equal(html[1], '<span class="sx-comment">// b</span>');
  assert.equal(String(html), `${html[0]}\n${html[1]}`);
});

let failed = 0;
for (const [name, error] of results) {
  if (error) {
    failed++;
    console.log(`FAIL ${name}\n  ${String(error.message).split('\n').join('\n  ')}`);
  } else {
    console.log(`ok   ${name}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} 통과`);
if (failed) process.exitCode = 1;
