export const FAIRY_IDENTITY_SETTINGS_NAMESPACE: 'fairy-identity';

export type FairyIdentityMode = 'ling' | 'zhe' | 'custom';
export interface FairyIdentitySettings {
  mode: FairyIdentityMode;
  customName: string;
  secondAssistant: string;
  household: string[];
}

/**
 * Shared activity vocabulary. The current dsh-fairy-visual state machine emits
 * 'comforting' is entered from a committed user utterance and has precedence
 * over the Session running expression.
 */
export type FairyVisualActivity = 'normal' | 'thinking' | 'comforting';

/**
 * Shared lifecycle vocabulary, not a guarantee that every literal is emitted
 * by the current Visual controller. Its current public snapshots use only
 * 'idle', 'running', and 'completed'; the remaining literals are reserved.
 */
export type FairyVisualLifecycle = 'idle' | 'preparing' | 'running' | 'interrupted' | 'completed' | 'failed' | 'disposed';
export interface FairyVisualSettings {
  version: 2;
  enabled: boolean;
  theme: 'dark' | 'light';
  mascotVisible: boolean;
  mascotScale: number;
  mascotAnimationSpeed: number;
  powerMode: 'normal' | 'low-power';
  composerDockHeight: number;
}
/**
 * Snapshot shape shared for typing. Activity is session-derived unless the
 * local comfort latch is active for the current session.
 */
export interface FairyVisualSnapshot {
  settings: FairyVisualSettings;
  activity: FairyVisualActivity;
  lifecycle: FairyVisualLifecycle;
  sessionId?: string;
}
