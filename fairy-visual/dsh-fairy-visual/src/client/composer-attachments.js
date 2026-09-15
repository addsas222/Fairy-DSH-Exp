const { OFFICIAL_SELECTORS, composerAttachmentsSlot } = require('./dom-adapter.js');

const ATTACHMENTS_SLOT = OFFICIAL_SELECTORS.composerAttachmentsSlot;

function attachmentSlot(card) {
  return composerAttachmentsSlot(card);
}

function attachmentRail(slot) {
  return slot?.firstElementChild || null;
}

function attachmentRailHeight(slot) {
  const height = Number(attachmentRail(slot)?.getBoundingClientRect?.().height);
  return Number.isFinite(height) ? Math.max(0, Math.ceil(height)) : 0;
}

function attachmentDockHeight(baseHeight, railHeight, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, baseHeight + railHeight));
}

// The input dock slot is a display:contents wrapper; its own box has no height,
// so the strip height comes from the union of the rendered entries (todo/queue).
function inputDockRailHeight(slot) {
  const children = slot?.children ? [...slot.children] : [];
  if (!children.length) return 0;
  const rects = children.map((node) => node.getBoundingClientRect?.()).filter((rect) => rect && rect.height > 0);
  if (!rects.length) return 0;
  const top = Math.min(...rects.map((rect) => rect.top));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return Math.max(0, Math.ceil(bottom - top));
}

module.exports = {
  ATTACHMENTS_SLOT,
  attachmentSlot,
  attachmentRail,
  attachmentRailHeight,
  attachmentDockHeight,
  inputDockRailHeight,
};
