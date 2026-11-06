// 앱을 켜는 동안 보이는 스켈레톤. 모듈이 아니라 <body> 첫머리에서 바로 돈다 — 첫 그림부터 실제 화면 모양(배치·칸 폭·테마)으로.
// 힌트는 Rust 가 웹뷰를 만들 때 window.__boot 로 넘긴다: {theme, platform, layout, sidebar, detail, repo, tabs}.
// app.js 가 첫 화면(레포지토리·시작·GitHub 연결)을 다 그리면 window.__bootDone() 으로 걷어 낸다.
(function () {
  var hint = window.__boot || {};
  var root = document.documentElement;
  var theme = hint.theme === 'light' ? 'light'
    : hint.theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : 'dark';
  root.dataset.theme = theme;
  if (hint.platform) root.dataset.platform = hint.platform;

  function div(cls, style) {
    var node = document.createElement('div');
    if (cls) node.className = cls;
    if (style) node.setAttribute('style', style);
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) node.appendChild(arguments[i]);
    return node;
  }
  // 회색 막대 하나. w: 폭(px 또는 %), h: 높이.
  function bar(w, h, extra) {
    return div('bk', 'width:' + (typeof w === 'number' ? w + 'px' : w) + ';height:' + (h || 10) + 'px;' + (extra || ''));
  }
  function repeat(n, make) {
    var host = document.createDocumentFragment();
    for (var i = 0; i < n; i++) host.appendChild(make(i));
    return host;
  }

  var boot = div('boot');
  boot.id = 'boot';
  boot.setAttribute('aria-busy', 'true');
  boot.setAttribute('aria-label', '불러오는 중');

  // 탭 막대: 폴더 버튼 자리 + 탭(열려 있던 수만큼, 첫 탭이 지금 탭).
  var tabs = div('boot-tabs', '', bar(16, 14, 'border-radius:4px;margin:0 10px 0 6px;align-self:center'));
  var tabCount = Math.max(1, Math.min(4, hint.tabs || (hint.repo ? 1 : 0) || 1));
  for (var t = 0; t < tabCount; t++) {
    tabs.appendChild(div('boot-tab' + (t === 0 && hint.repo ? ' on' : ''), '', bar(14, 14, 'border-radius:7px'), bar([96, 72, 110, 84][t], 10)));
  }

  if (!hint.repo) {
    // 다시 열 레포지토리가 없으면 시작 화면 모양.
    boot.classList.add('boot-start');
    boot.appendChild(tabs);
    boot.appendChild(div('boot-start-card', '',
      bar(140, 26, 'margin-bottom:14px'), bar(260, 10, 'margin-bottom:28px'),
      div('boot-row', 'gap:10px;margin-bottom:28px', bar(150, 32, 'border-radius:6px'), bar(110, 32, 'border-radius:6px'), bar(110, 32, 'border-radius:6px')),
      bar(120, 12, 'margin-bottom:14px'),
      repeat(5, function (i) { return div('boot-row', 'gap:12px;height:36px', bar(18, 18, 'border-radius:4px'), bar([180, 230, 150, 210, 170][i], 10), div('boot-grow'), bar(70, 8)); })));
    document.body.prepend(boot);
    install(boot);
    return;
  }

  // 도구 막대: 왼쪽 레포지토리·브랜치, 가운데 동작 버튼들, 오른쪽 터미널·새로고침.
  function action() { return div('boot-action', '', bar(20, 20, 'border-radius:5px'), bar(26, 7)); }
  var toolbar = div('boot-toolbar', '',
    div('boot-picker', '', bar(44, 7), bar(96, 12)),
    div('boot-picker', '', bar(30, 7), bar(64, 12)),
    div('boot-grow'),
    repeat(2, action), div('boot-sep'), repeat(3, action), div('boot-sep'), action(), div('boot-sep'), repeat(2, action),
    div('boot-grow'),
    repeat(2, action));

  // 사이드바: 위 항목 4줄, 찾기 칸, 묶음 머리 + 줄.
  var sidebar = div('boot-side', 'width:' + (hint.sidebar || 240) + 'px',
    repeat(4, function (i) { return div('boot-row', 'height:22px;padding:0 10px', bar([62, 70, 58, 52][i], 9), div('boot-grow'), i === 0 ? bar(26, 9) : null); }),
    div('boot-row', 'height:36px;padding:0 8px', bar('100%', 24, 'border-radius:5px')),
    repeat(3, function (g) {
      return div('', '',
        div('boot-row', 'height:28px;padding:0 10px;gap:8px', bar(10, 10), bar(14, 12), bar([36, 40, 44][g], 10), div('boot-grow'), bar(10, 9)),
        repeat([3, 6, 2][g], function (i) { return div('boot-row', 'height:26px;padding:0 10px 0 ' + (g === 1 && i > 0 ? 44 : 30) + 'px;gap:8px', bar(12, 12), bar([96, 120, 84, 140, 104, 90][i], 9)); }));
    }));

  // 그래프: 열 이름 줄 + 커밋 줄(가지 선·점, 메시지, 작성자, 해시, 날짜).
  var lanes = [0, 0, 1, 0, 2, 1, 0, 0, 1, 0, 0, 2, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  var graph = div('boot-graph', '',
    div('boot-row boot-graph-head', '', bar(54, 8), div('', 'width:200px'), bar(40, 8), div('boot-grow'), bar(36, 8, 'margin-right:90px'), bar(28, 8, 'margin-right:70px'), bar(28, 8, 'margin-right:60px')),
    div('boot-graph-rows', '', div('boot-lane', 'left:31px'), div('boot-lane', 'left:55px;top:68px;height:180px'), div('boot-lane', 'left:79px;top:136px;height:112px'),
      repeat(lanes.length, function (i) {
        var lane = lanes[i];
        return div('boot-row boot-commit', '',
          div('boot-dot', 'margin-left:' + (22 + lane * 24) + 'px'),
          div('', 'width:' + (130 - lane * 24) + 'px;flex:none'),
          i % 7 === 0 ? bar([72, 90, 64][i % 3], 16, 'border-radius:4px;margin-right:10px') : null,
          // 메시지는 남은 칸 안에서만 늘어난다(작성자·날짜 칸을 넘지 않게).
          div('boot-grow boot-row', 'padding-right:24px', bar(['72%', '88%', '54%', '80%', '62%', '94%', '48%'][i % 7], 10)),
          bar(52, 9, 'margin-right:40px'), bar(58, 9, 'margin-right:30px'), bar(104, 9, 'margin-right:16px'));
      })));

  // 오른쪽(GitKraken) 또는 아래(Fork) 작업 패널: 머리, 파일 줄, 커밋 상자.
  var fork = hint.layout === 'fork';
  var detail = div('boot-detail' + (fork ? ' fork' : ''), fork ? '' : 'width:' + (hint.detail || 380) + 'px',
    div('boot-row', 'height:34px;padding:0 12px;gap:8px', bar(84, 11), div('boot-grow'), bar(64, 22, 'border-radius:5px')),
    repeat(fork ? 4 : 7, function (i) { return div('boot-row', 'height:24px;padding:0 12px;gap:8px', bar(12, 12), bar(14, 14, 'border-radius:3px'), bar([140, 110, 170, 96, 150, 124, 88][i], 9)); }),
    div('boot-grow'),
    div('boot-row', 'height:34px;padding:0 12px;gap:8px', bar(70, 11), div('boot-grow'), bar(64, 22, 'border-radius:5px')),
    div('boot-commitbox', '', bar('100%', 28, 'border-radius:5px'), bar('100%', 64, 'border-radius:5px'), bar('100%', 30, 'border-radius:6px')));

  var workspace = fork
    ? div('boot-body', '', sidebar, div('boot-column', '', graph, detail))
    : div('boot-body', '', sidebar, graph, detail);
  var footer = div('boot-footer', '', bar(90, 8), div('boot-grow'), bar(40, 8), bar(64, 8), bar(30, 10, 'border-radius:3px'));

  boot.appendChild(tabs);
  boot.appendChild(toolbar);
  boot.appendChild(workspace);
  boot.appendChild(footer);
  document.body.prepend(boot);
  install(boot);

  // 걷어 내기: 짧게 흐려지며 사라진다. 너무 빨리 끝나도 0.25초는 보인다(번쩍이지 않게).
  function install(node) {
    var since = performance.now();
    window.__bootDone = function () {
      window.__bootDone = function () {};
      var wait = Math.max(0, 250 - (performance.now() - since));
      setTimeout(function () {
        node.classList.add('out');
        setTimeout(function () { node.remove(); }, 260);
      }, wait);
    };
  }
})();
