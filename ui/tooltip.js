// 말풍선 툴팁. 원본 Elements/HoverCallout.cs 처럼 브라우저 기본 title 대신 꼭지 달린 검은 말풍선(테마와 상관없이 흰 글자)을
// 대상 아래(넘치면 위)에 지연 없이 띄운다. 나타나고 사라질 때는 알파로 짧게 페이드한다. data-tip-side="right" 면 오른쪽. 어디서든 title 이나 data-tip 을 달면 된다(title 은 처음 올릴 때 data-tip 으로 옮긴다).

const bubble = document.createElement('div');
bubble.className = 'callout';
const arrow = document.createElement('span');
arrow.className = 'callout-arrow';
const text = document.createElement('div');
bubble.append(arrow, text);

let target = null;
/** 마우스 단추를 누르고 있는 동안(끌기·폭 바꾸기)은 띄우지 않는다. */
let pressed = false;
/**
 * 누른 대상의 말풍선 글. 끄는 동안 대상이 다시 그려져도(새 요소) 같은 글이면, 놓은 뒤 다른 곳으로 옮길 때까지 다시 띄우지 않는다
 * — 폭을 바꿀 때마다 "끌어서 폭 바꾸기" 가 따라 뜨지 않게.
 */
let quietTip = null;

function tipOf(element) {
  if (element.hasAttribute('title')) {
    element.dataset.tip = element.getAttribute('title');
    element.removeAttribute('title');
  }
  return element.dataset.tip;
}

const side0 = (element) => element.dataset.tipSide ?? 'below';

function show(element) {
  const tip = tipOf(element);
  if (!tip) return hide();
  target = element;
  text.textContent = tip;
  bubble.classList.remove('side-right', 'side-below', 'side-above');
  // 재기 전에 왼쪽 위로 옮긴다 — 지난 자리(화면 오른쪽 끝 등)에 둔 채 재면 남은 폭만큼만 펴져서 글이 한 글자씩 꺾인다.
  bubble.style.left = '0px';
  bubble.style.top = '0px';
  const r = element.getBoundingClientRect();
  const b = bubble.getBoundingClientRect();
  const gap = side0(element) === 'right' ? 6 : 4;
  // 원본 HoverCallout.ReplaceTooltips 처럼 툴팁은 늘 대상 아래(넘치면 위)에 뜬다. 오른쪽은 data-tip-side="right" 를 단 것만(구역 머리 "+" 등).
  let side = side0(element) === 'right' && r.right + gap + b.width < window.innerWidth - 4 ? 'right' : 'below';
  let left;
  let top;
  if (side === 'right') {
    left = r.right + gap;
    top = r.top + r.height / 2 - b.height / 2;
  } else {
    left = Math.min(Math.max(4, r.left + r.width / 2 - b.width / 2), window.innerWidth - b.width - 4);
    top = r.bottom + gap;
    if (top + b.height > window.innerHeight - 4) {
      top = r.top - gap - b.height;
      side = 'above';
    }
  }
  top = Math.max(4, Math.min(top, window.innerHeight - b.height - 4));
  bubble.classList.add(`side-${side}`, 'shown');
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
  if (side === 'right') arrow.style.cssText = `top:${Math.min(Math.max(8, r.top + r.height / 2 - top), b.height - 8)}px`;
  else arrow.style.cssText = `left:${Math.min(Math.max(10, r.left + r.width / 2 - left), b.width - 10)}px`;
}

function hide() {
  target = null;
  // 글과 자리는 그대로 두고 알파만 내려 사라지게 한다(app.css 의 .callout 전환).
  bubble.classList.remove('shown');
}

export function installTooltips() {
  document.body.append(bubble);
  document.addEventListener('mouseover', (event) => {
    const element = event.target.closest?.('[title], [data-tip]');
    if (element === target) return;
    if (!element) {
      quietTip = null;
      return hide();
    }
    if (pressed || event.buttons) return hide();
    if (quietTip != null) {
      if (tipOf(element) === quietTip) return;
      quietTip = null;
    }
    show(element);
  });
  document.addEventListener('mouseout', (event) => {
    if (target && !target.contains(event.relatedTarget)) hide();
  });
  document.addEventListener('pointerdown', (event) => {
    pressed = true;
    const element = event.target.closest?.('[title], [data-tip]');
    quietTip = element ? tipOf(element) : null;
    hide();
  }, true);
  const release = () => { pressed = false; };
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', release);
  document.addEventListener('wheel', hide, { passive: true, capture: true });
  document.addEventListener('keydown', hide, true);
}

/** 지금 보이는 툴팁의 글을 바꾼다(검사 결과처럼 바로 바뀌는 것). */
export function refreshTooltip(element) {
  if (element === target) show(element);
}
