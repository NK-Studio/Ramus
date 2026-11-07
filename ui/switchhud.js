// 레포지토리 탭을 바꿀 때 화면 가운데에 잠깐 뜨는 로딩 HUD(macOS 의 반투명 HUD 창처럼).
// 반투명 유리판 위에 12살 회전 표시와 레포지토리 이름. 탭 이름에는 "밀어서 잠금 해제" 같은 빛 줄기가 지나간다.
// 전환은 대개 금방 끝나므로 너무 빨리 깜박이지 않게 최소한 잠깐은 보인다. 연달아 바꾸면 마지막 것만 따른다.

const MIN_VISIBLE_MS = 420;
const LEAVE_MS = 240;

export function createSwitchHud() {
  let node = null;
  let scrim = null;
  let nameEl = null;
  let shownAt = 0;
  let token = 0;
  let hideTimer = 0;
  let removeTimer = 0;

  function build() {
    const spinner = document.createElement('div');
    spinner.className = 'hud-spinner';
    for (let i = 0; i < 12; i++) {
      const blade = document.createElement('i');
      blade.style.transform = `rotate(${i * 30}deg) translateY(-13px)`;
      blade.style.animationDelay = `${(i - 12) / 12}s`;
      spinner.append(blade);
    }
    nameEl = document.createElement('div');
    nameEl.className = 'hud-name';
    const sub = document.createElement('div');
    sub.className = 'hud-sub';
    sub.textContent = '불러오는 중…';
    const text = document.createElement('div');
    text.className = 'hud-text';
    text.append(nameEl, sub);
    node = document.createElement('div');
    node.className = 'switch-hud';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    node.append(spinner, text);
    // HUD 뒤 작업 화면을 살짝 흐리고 어둡게 덮는 막. 탭 막대는 덮지 않는다(탭 이름의 빛 줄기가 보이게).
    scrim = document.createElement('div');
    scrim.className = 'switch-scrim';
    document.body.append(scrim, node);
  }

  /** 막의 위쪽을 탭 막대 아래에 맞춘다(전체 화면·배율에 따라 높이가 다르다). */
  function placeScrim() {
    const tabs = document.getElementById('tabs');
    const bottom = tabs && !tabs.hidden ? tabs.getBoundingClientRect().bottom : 0;
    scrim.style.top = `${Math.max(0, Math.round(bottom))}px`;
  }

  return {
    /** 이름을 보이며 띄운다. hide 에 넘길 번호를 돌려준다. */
    show(name) {
      const mine = ++token;
      clearTimeout(hideTimer);
      clearTimeout(removeTimer);
      if (!node) build();
      nameEl.textContent = name ?? '';
      const wasVisible = node.classList.contains('visible') && !node.classList.contains('leaving');
      node.classList.remove('leaving');
      scrim.classList.remove('leaving');
      node.hidden = false;
      scrim.hidden = false;
      placeScrim();
      document.body.classList.add('repo-loading');
      if (!wasVisible) {
        shownAt = performance.now();
        // 다음 그림에서 visible 을 붙여야 들어오는 움직임이 보인다.
        node.classList.remove('visible');
        scrim.classList.remove('visible');
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (mine !== token) return;
          node.classList.add('visible');
          scrim.classList.add('visible');
        }));
      }
      return mine;
    },
    /** 그 show 가 아직 마지막 것이면 걷는다. immediate 면 최소 시간을 기다리지 않는다(실패했을 때). */
    hide(mine, { immediate = false } = {}) {
      if (mine !== token || !node) return;
      const wait = immediate ? 0 : Math.max(0, MIN_VISIBLE_MS - (performance.now() - shownAt));
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (mine !== token) return;
        document.body.classList.remove('repo-loading');
        node.classList.add('leaving');
        scrim.classList.add('leaving');
        removeTimer = setTimeout(() => {
          if (mine !== token) return;
          node.classList.remove('visible', 'leaving');
          scrim.classList.remove('visible', 'leaving');
          node.hidden = true;
          scrim.hidden = true;
        }, LEAVE_MS);
      }, wait);
    },
  };
}
