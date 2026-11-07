// 앱을 켜는 동안 보이는 시작 화면. 모듈이 아니라 <body> 첫머리에서 바로 돈다 — 첫 그림부터 실제 테마 바탕색으로.
// 힌트는 Rust 가 웹뷰를 만들 때 window.__boot 로 넘긴다: {theme, platform}.
// macOS 가 켜질 때처럼: 가운데에 단색의 큼직한 가지 표식이 조용히 떠오르고 그 아래 이름이 뒤따른다. 금방 열려도 적어도 MIN_MS 는 보이고, 그보다 오래 걸리면 아이콘 아래 가는 막대가 흐른다(시간은 app.css).
// app.js 가 첫 화면(레포지토리·시작·GitHub 연결)을 다 그리면 window.__bootDone() 으로 걷어 낸다.
(function () {
  var hint = window.__boot || {};
  var root = document.documentElement;
  var theme = hint.theme === 'light' ? 'light'
    : hint.theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : 'dark';
  root.dataset.theme = theme;
  if (hint.platform) root.dataset.platform = hint.platform;

  var boot = document.createElement('div');
  boot.className = 'boot';
  boot.id = 'boot';
  boot.setAttribute('role', 'progressbar');
  boot.setAttribute('aria-busy', 'true');
  boot.setAttribute('aria-label', '불러오는 중');

  // macOS 가 켜질 때의 사과처럼: 바탕 위에 단색의 큼직한 가지 표식만(Ramus 는 라틴어로 '가지' — 본줄기에서 곁가지가 하나 갈라진다),
  // 그 아래 이름, 오래 걸리면 가는 막대.
  boot.innerHTML =
    '<div class="boot-mark">' +
      '<svg class="boot-glyph" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true">' +
        '<path d="M17 14.5V33.5"/><path d="M17 30c0-8 14-6 14-13.5"/>' +
        '<circle cx="17" cy="10" r="4.5"/><circle cx="17" cy="38" r="4.5"/><circle cx="31" cy="12" r="4.5"/>' +
      '</svg>' +
      '<div class="boot-name">Ramus</div>' +
    '</div>' +
    '<div class="boot-bar" aria-hidden="true"><i></i></div>';
  document.body.prepend(boot);

  // 걷어 내기: 켠 뒤 적어도 MIN_MS 는 보이고(등장 애니메이션이 끝날 만큼), 조용히 흐려져 사라진다.
  var MIN_MS = 1100;
  var since = performance.now();
  window.__bootDone = function () {
    window.__bootDone = function () {};
    setTimeout(function () {
      boot.classList.add('out');
      setTimeout(function () { boot.remove(); }, 420);
    }, Math.max(0, MIN_MS - (performance.now() - since)));
  };
})();
