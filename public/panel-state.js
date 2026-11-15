function panels(root) {
  return [...root.querySelectorAll('[data-pane][data-scroll-key]')];
}

function disclosures(panel) {
  const counts = new Map();
  return [...panel.querySelectorAll('details')].map(el => {
    const label = el.dataset.stateKey || el.getAttribute('class') || el.querySelector('summary')?.textContent || '';
    const n = counts.get(label) || 0;
    counts.set(label, n + 1);
    return [JSON.stringify([label, n]), el];
  });
}

function focusKeys(panel) {
  const counts = new Map();
  for (const el of panel.querySelectorAll('button,input,select,textarea,summary,a[href]')) {
    const label = JSON.stringify([el.tagName, el.getAttribute('name'), el.getAttribute('class'), el.tagName.toLowerCase() === 'input' ? '' : el.textContent]);
    const n = counts.get(label) || 0;
    counts.set(label, n + 1);
    if (!el.dataset.focusKey) el.dataset.focusKey = `${panel.dataset.scrollKey}:${label}:${n}`;
  }
}

function endpoint(panel, node, offset) {
  if (!panel.contains(node)) return null;
  const path = [];
  for (let el = node; el !== panel; el = el.parentNode) {
    if (!el.parentNode) return null;
    path.unshift([...el.parentNode.childNodes].indexOf(el));
  }
  return { node, path, text: node.textContent, type: node.nodeType, offset };
}

export function capturePanelState(root, memory) {
  const selection = globalThis.getSelection?.();
  let range = null;
  for (const panel of panels(root)) {
    focusKeys(panel);
    memory.set(panel.dataset.scrollKey, new Map(disclosures(panel).map(([key, el]) => [key, el.open])));
    if (selection && !selection.isCollapsed) {
      const anchor = endpoint(panel, selection.anchorNode, selection.anchorOffset);
      const focus = endpoint(panel, selection.focusNode, selection.focusOffset);
      if (anchor && focus) range = { key: panel.dataset.scrollKey, anchor, focus };
    }
  }
  return range;
}

export function restorePanelState(root, memory, range) {
  for (const panel of panels(root)) {
    focusKeys(panel);
    const saved = memory.get(panel.dataset.scrollKey);
    for (const [key, el] of disclosures(panel)) if (saved?.has(key)) el.open = saved.get(key);
    if (range?.key !== panel.dataset.scrollKey) continue;
    if (panel.contains(range.anchor.node) && panel.contains(range.focus.node)) continue;
    const resolve = point => {
      let node = panel;
      for (const index of point.path) node = node?.childNodes[index];
      if (node?.textContent === point.text && node.nodeType === point.type) return node;
      const matches = [];
      const walk = el => {
        if (el.textContent === point.text && el.nodeType === point.type) matches.push(el);
        for (const child of el.childNodes || []) walk(child);
      };
      walk(panel);
      return matches.length === 1 ? matches[0] : null;
    };
    const anchor = resolve(range.anchor), focus = resolve(range.focus);
    if (anchor && focus) {
      const selection = globalThis.getSelection?.();
      if (selection?.anchorNode !== anchor || selection?.focusNode !== focus) {
        try { selection?.setBaseAndExtent(anchor, range.anchor.offset, focus, range.focus.offset); } catch { }
      }
    }
  }
}
