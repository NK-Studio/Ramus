// 말풍선 툴팁. 원본 Elements/HoverCallout.cs 처럼 브라우저 기본 title 대신 꼭지 달린 검은 말풍선(테마와 상관없이 흰 글자)을
// 대상 아래(넘치면 위)에 지연 없이 띄운다. data-tip-side="right" 면 오른쪽. 어디서든 title 이나 data-tip 을 달면 된다(title 은 처음 올릴 때 data-tip 으로 옮긴다).

const bubble = document.createElement('div');
bubble.className = 'callout';
bubble.hidden = true;
const arrow = document.createElement('span');
arrow.className = 'callout-arrow';
const text = document.createElement('div');
bubble.append(arrow, text);

let target = null;

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
  bubble.hidden = false;
  bubble.className = 'callout';
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
  bubble.classList.add(`side-${side}`);
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
  if (side === 'right') arrow.style.cssText = `top:${Math.min(Math.max(8, r.top + r.height / 2 - top), b.height - 8)}px`;
  else arrow.style.cssText = `left:${Math.min(Math.max(10, r.left + r.width / 2 - left), b.width - 10)}px`;
}

function hide() {
  target = null;
  bubble.hidden = true;
}

export function installTooltips() {
  document.body.append(bubble);
  document.addEventListener('mouseover', (event) => {
    const element = event.target.closest?.('[title], [data-tip]');
    if (element === target) return;
    if (!element) return hide();
    show(element);
  });
  document.addEventListener('mouseout', (event) => {
    if (target && !target.contains(event.relatedTarget)) hide();
  });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('wheel', hide, { passive: true, capture: true });
  document.addEventListener('keydown', hide, true);
}

/** 지금 보이는 툴팁의 글을 바꾼다(검사 결과처럼 바로 바뀌는 것). */
export function refreshTooltip(element) {
  if (element === target) show(element);
}
