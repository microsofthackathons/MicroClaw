export interface SessionModelState {
  /** Canonical Gateway session key. */
  sessionKey: string;
  /** Effective selected model, not the model used by a transient fallback. */
  modelRef: string | null;
  overridden: boolean;
}

export interface SessionModelAPI {
  get(sessionKey: string): Promise<SessionModelState>;
  /** null clears only the session override and restores agent/default inheritance. */
  select(params: { sessionKey: string; modelRef: string | null }): Promise<SessionModelState>;
}
