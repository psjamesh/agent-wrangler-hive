export const PANEL_WIDTH_KEY = 'hive:panel-width';

export function panelBounds(width) {
  return { min: 320, max: Math.max(320, width - 384) };
}

export function installPanelSplit(root, divider, storage) {
  let preferred;
  try {
    storage ??= globalThis.localStorage;
    const value = Number(storage?.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(value) && value > 0) preferred = value;
  } catch {}
  let current;
  let drag = null;
  const update = () => {
    const { min, max } = panelBounds(root.clientWidth);
    current = Math.round(Math.max(min, Math.min(max, preferred ?? root.clientWidth * 0.38)));
    root.style.setProperty('--hive-panel-width', `${current}px`);
    root.dataset.layout = root.clientWidth < 700 ? 'small' : 'split';
    divider.setAttribute('aria-valuemin', min);
    divider.setAttribute('aria-valuemax', max);
    divider.setAttribute('aria-valuenow', current);
  };
  const resize = width => {
    const { min, max } = panelBounds(root.clientWidth);
    preferred = Math.round(Math.max(min, Math.min(max, width)));
    update();
    try { storage?.setItem(PANEL_WIDTH_KEY, String(preferred)); } catch {}
  };
  divider.addEventListener('keydown', event => {
    const { min, max } = panelBounds(root.clientWidth);
    const width = { ArrowLeft: current + 20, ArrowRight: current - 20, Home: min, End: max }[event.key];
    if (width === undefined) return;
    event.preventDefault();
    resize(width);
  });
  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    divider.focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, width: current };
    divider.setPointerCapture(event.pointerId);
  });
  divider.addEventListener('pointermove', event => {
    if (drag?.id === event.pointerId) resize(drag.width + drag.x - event.clientX);
  });
  const finish = event => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    if (event.type !== 'lostpointercapture') divider.releasePointerCapture(event.pointerId);
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) divider.addEventListener(type, finish);
  update();
  return update;
}
