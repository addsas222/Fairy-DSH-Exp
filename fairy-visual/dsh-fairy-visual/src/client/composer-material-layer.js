const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
let materialLayerSeed = 0;

function createMaterialLayer(card) {
  if (!card) return null;
  const materialLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const instanceId = `dsh-fairy-composer-${++materialLayerSeed}`;
  const patternId = `${instanceId}-polymer-pattern`;
  const sheenId = `${instanceId}-polymer-sheen`;
  const ambientId = `${instanceId}-polymer-ambient`;
  materialLayer.setAttribute('data-dsh-fairy-composer-material', 'true');
  materialLayer.setAttribute('data-dsh-fairy-composer-material-instance', instanceId);
  materialLayer.setAttribute('preserveAspectRatio', 'none');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const mask = document.createElementNS('http://www.w3.org/2000/svg', 'mask');
  mask.setAttribute('data-dsh-fairy-composer-material-mask', 'true');
  mask.setAttribute('maskUnits', 'userSpaceOnUse');
  const outer = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  outer.setAttribute('fill', 'white');
  const hole = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  hole.setAttribute('fill', 'black');
  mask.append(outer, hole);
  defs.appendChild(mask);
  const pattern = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
  pattern.setAttribute('id', patternId);
  pattern.setAttribute('patternUnits', 'userSpaceOnUse');
  pattern.setAttribute('width', '12');
  pattern.setAttribute('height', '12');
  const patternBase = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  patternBase.setAttribute('width', '12');
  patternBase.setAttribute('height', '12');
  patternBase.setAttribute('fill', 'var(--dsh-composer-polymer)');
  const patternGrainLight = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  patternGrainLight.setAttribute('cx', '1.4');
  patternGrainLight.setAttribute('cy', '1.4');
  patternGrainLight.setAttribute('r', '.72');
  patternGrainLight.setAttribute('fill', 'var(--dsh-composer-polymer-light)');
  const patternGrainDark = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  patternGrainDark.setAttribute('cx', '6.5');
  patternGrainDark.setAttribute('cy', '8.5');
  patternGrainDark.setAttribute('r', '.78');
  patternGrainDark.setAttribute('fill', 'var(--dsh-composer-polymer-dark)');
  const patternLight = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  patternLight.setAttribute('d', 'M 0 3.5 H 12 M 0 9.5 H 12');
  patternLight.setAttribute('stroke', 'var(--dsh-composer-polymer-stripe)');
  patternLight.setAttribute('stroke-width', '.82');
  patternLight.setAttribute('opacity', '.9');
  pattern.append(patternBase, patternGrainLight, patternGrainDark, patternLight);
  defs.appendChild(pattern);
  const sheen = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
  sheen.setAttribute('id', sheenId);
  sheen.setAttribute('gradientUnits', 'userSpaceOnUse');
  const sheenLight = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  sheenLight.setAttribute('offset', '0%');
  const sheenMid = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  sheenMid.setAttribute('offset', '46%');
  const sheenDark = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  sheenDark.setAttribute('offset', '100%');
  sheen.append(sheenLight, sheenMid, sheenDark);
  defs.appendChild(sheen);
  const ambient = document.createElementNS('http://www.w3.org/2000/svg', 'radialGradient');
  ambient.setAttribute('id', ambientId);
  ambient.setAttribute('gradientUnits', 'userSpaceOnUse');
  const ambientLight = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  ambientLight.setAttribute('offset', '0%');
  const ambientFade = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  ambientFade.setAttribute('offset', '68%');
  const ambientEnd = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  ambientEnd.setAttribute('offset', '100%');
  ambient.append(ambientLight, ambientFade, ambientEnd);
  defs.appendChild(ambient);
  const face = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  face.setAttribute('data-dsh-fairy-composer-material-face', 'continuous');
  face.setAttribute('fill', `url(#${patternId})`);
  face.setAttribute('fill-rule', 'evenodd');
  face.setAttribute('clip-rule', 'evenodd');
  const sheenFace = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  sheenFace.setAttribute('data-dsh-fairy-composer-material-sheen', 'true');
  sheenFace.setAttribute('fill', `url(#${sheenId})`);
  sheenFace.setAttribute('fill-rule', 'evenodd');
  sheenFace.setAttribute('clip-rule', 'evenodd');
  const ambientFace = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  ambientFace.setAttribute('data-dsh-fairy-composer-material-ambient', 'true');
  ambientFace.setAttribute('fill', `url(#${ambientId})`);
  ambientFace.setAttribute('fill-rule', 'evenodd');
  ambientFace.setAttribute('clip-rule', 'evenodd');
  materialLayer.append(defs, face, sheenFace, ambientFace);
  materialLayer._dshMaterial = { outer, hole, face, sheenFace, ambientFace, patternBase, patternGrainLight, patternGrainDark, patternLight, sheen, sheenLight, sheenMid, sheenDark, ambient, ambientLight, ambientFade, ambientEnd };
  card.appendChild(materialLayer);
  return materialLayer;
}

function unionRect(nodes) {
  const rects = nodes
    .map((node) => node?.getBoundingClientRect?.())
    .filter((rect) => rect && Number.isFinite(rect.left) && Number.isFinite(rect.top)
      && Number.isFinite(rect.right) && Number.isFinite(rect.bottom));
  if (!rects.length) return null;
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  };
}

function syncHoleContactGeometry(card, inputRect, clampValue = clamp) {
  if (!card?.style || !inputRect) return null;
  const cardRect = card.getBoundingClientRect?.();
  if (!cardRect || !Number.isFinite(cardRect.left) || !Number.isFinite(cardRect.top)
    || !Number.isFinite(cardRect.width) || !Number.isFinite(cardRect.height)) return null;
  const borderLeft = Number(card.clientLeft) || 0;
  const borderTop = Number(card.clientTop) || 0;
  const width = Number(card.clientWidth) || cardRect.width - borderLeft * 2;
  const height = Number(card.clientHeight) || cardRect.height - borderTop * 2;
  const originLeft = cardRect.left + borderLeft;
  const originTop = cardRect.top + borderTop;
  const left = clampValue(inputRect.left - originLeft, 0, width);
  const top = clampValue(inputRect.top - originTop, 0, height);
  const right = clampValue(inputRect.right - originLeft, left, width);
  const bottom = clampValue(inputRect.bottom - originTop, top, height);
  const geometry = { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  card.style.setProperty('--dsh-fairy-composer-hole-contact-left', geometry.left + 'px');
  card.style.setProperty('--dsh-fairy-composer-hole-contact-top', geometry.top + 'px');
  card.style.setProperty('--dsh-fairy-composer-hole-contact-width', geometry.width + 'px');
  card.style.setProperty('--dsh-fairy-composer-hole-contact-height', geometry.height + 'px');
  return geometry;
}

function clearHoleContactGeometry(card) {
  [
    '--dsh-fairy-composer-hole-contact-left',
    '--dsh-fairy-composer-hole-contact-top',
    '--dsh-fairy-composer-hole-contact-width',
    '--dsh-fairy-composer-hole-contact-height',
  ].forEach((name) => card?.style?.removeProperty(name));
}

function syncMaterialLayer(layer, input, relatedInputs = [], clampValue = clamp, options = {}) {
  if (typeof relatedInputs === 'function') {
    clampValue = relatedInputs;
    relatedInputs = [];
  }
  if (!layer || !input) return;
  const layerRect = layer.getBoundingClientRect();
  const inputRect = unionRect([input, ...relatedInputs]);
  if (!inputRect) return;
  // 任务条在卡片上方时：只把洞的**顶**推到卡片顶沿（去掉卡片顶那条框材亮带），
  // 洞的左右仍按输入区——否则全宽的条会把洞扩到整张卡片、把玻璃面整块挖空（卡片变薄变透）。
  if (options.extendTop && Number.isFinite(inputRect.top)) {
    const card = options.extendTop === true ? layer.closest?.('[data-composer-card="true"]') : options.extendTop;
    const cardRect = card?.getBoundingClientRect?.();
    if (cardRect && Number.isFinite(cardRect.top) && cardRect.top < inputRect.top) inputRect.top = cardRect.top;
  }
  const left = clampValue(inputRect.left - layerRect.left, 0, layerRect.width);
  const top = clampValue(inputRect.top - layerRect.top, 0, layerRect.height);
  const right = clampValue(inputRect.right - layerRect.left, left, layerRect.width);
  const bottom = clampValue(inputRect.bottom - layerRect.top, top, layerRect.height);
  const geometry = layer._dshMaterial;
  if (!geometry) return;
  const styles = getComputedStyle(layer);
  const color = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  geometry.patternBase.setAttribute('fill', color('--dsh-composer-polymer', '#3b4148'));
  geometry.patternGrainLight.setAttribute('fill', color('--dsh-composer-polymer-light', 'rgba(255,255,255,.06)'));
  geometry.patternGrainDark.setAttribute('fill', color('--dsh-composer-polymer-dark', 'rgba(0,0,0,.06)'));
  geometry.patternLight.setAttribute('stroke', color('--dsh-composer-polymer-stripe', 'rgba(255,255,255,.12)'));
  const panelWidth = Math.max(1, layerRect.width);
  const panelHeight = Math.max(1, layerRect.height);
  geometry.sheen.setAttribute('x1', '0');
  geometry.sheen.setAttribute('y1', '0');
  geometry.sheen.setAttribute('x2', String(panelWidth));
  geometry.sheen.setAttribute('y2', String(panelHeight));
  geometry.sheenLight.setAttribute('stop-color', color('--dsh-composer-sheen-light', 'rgba(255,255,255,.06)'));
  geometry.sheenMid.setAttribute('stop-color', 'rgba(255,255,255,0)');
  geometry.sheenDark.setAttribute('stop-color', color('--dsh-composer-sheen-dark', 'rgba(0,0,0,.07)'));
  geometry.ambient.setAttribute('cx', String(panelWidth * .16));
  geometry.ambient.setAttribute('cy', String(panelHeight * .04));
  geometry.ambient.setAttribute('r', String(Math.max(panelWidth, panelHeight) * .72));
  geometry.ambientLight.setAttribute('stop-color', color('--dsh-composer-ambient-light', 'rgba(255,255,255,.045)'));
  geometry.ambientFade.setAttribute('stop-color', 'rgba(255,255,255,0)');
  geometry.ambientEnd.setAttribute('stop-color', color('--dsh-composer-ambient-dark', 'rgba(0,0,0,.035)'));
  layer.setAttribute('viewBox', '0 0 ' + layerRect.width + ' ' + layerRect.height);
  geometry.outer.setAttribute('width', String(layerRect.width));
  geometry.outer.setAttribute('height', String(layerRect.height));
  geometry.hole.setAttribute('x', String(left));
  geometry.hole.setAttribute('y', String(top));
  geometry.hole.setAttribute('width', String(Math.max(0, right - left)));
  geometry.hole.setAttribute('height', String(Math.max(0, bottom - top)));
  geometry.hole.setAttribute('rx', '10');
  geometry.hole.setAttribute('ry', '10');
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const radius = Math.min(10, width / 2, height / 2);
  const roundedHole = [
    'M ' + (left + radius) + ' ' + top,
    'H ' + (right - radius),
    'A ' + radius + ' ' + radius + ' 0 0 1 ' + right + ' ' + (top + radius),
    'V ' + (bottom - radius),
    'A ' + radius + ' ' + radius + ' 0 0 1 ' + (right - radius) + ' ' + bottom,
    'H ' + (left + radius),
    'A ' + radius + ' ' + radius + ' 0 0 1 ' + left + ' ' + (bottom - radius),
    'V ' + (top + radius),
    'A ' + radius + ' ' + radius + ' 0 0 1 ' + (left + radius) + ' ' + top,
    'Z',
  ].join(' ');
  const facePath = 'M 0 0 H ' + layerRect.width + ' V ' + layerRect.height + ' H 0 Z ' + roundedHole;
  geometry.face.setAttribute('d', facePath);
  geometry.sheenFace.setAttribute('d', facePath);
  geometry.ambientFace.setAttribute('d', facePath);
  syncHoleContactGeometry(layer.parentElement, inputRect, clampValue);
  layer.style.setProperty('--dsh-fairy-composer-hole-left', left + 'px');
  layer.style.setProperty('--dsh-fairy-composer-hole-top', top + 'px');
  layer.style.setProperty('--dsh-fairy-composer-hole-right', right + 'px');
  layer.style.setProperty('--dsh-fairy-composer-hole-bottom', bottom + 'px');
}

module.exports = {
  createMaterialLayer,
  syncMaterialLayer,
  unionRect,
  syncHoleContactGeometry,
  clearHoleContactGeometry,
};
