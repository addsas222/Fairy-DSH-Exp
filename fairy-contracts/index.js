// Runtime-free by design. Client plugins must not share mutable browser
// singletons; this package is a place for schemas and test fixtures only.
export const FAIRY_VISUAL_SETTINGS_NAMESPACE = 'fairy-visual';
export const FAIRY_IDENTITY_SETTINGS_NAMESPACE = 'fairy-identity';
export const FAIRY_VISUAL_SETTINGS_VERSION = 2;
export const FAIRY_VISUAL_THEMES = Object.freeze(['dark', 'light']);
export const FAIRY_VISUAL_POWER_MODES = Object.freeze(['normal', 'low-power']);
export const FAIRY_VISUAL_ACTIVITY = Object.freeze(['normal', 'thinking', 'comforting']);
export const FAIRY_VISUAL_LIFECYCLE = Object.freeze(['idle', 'preparing', 'running', 'interrupted', 'completed', 'failed', 'disposed']);
