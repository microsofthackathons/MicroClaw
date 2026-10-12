export interface SessionModelState {
  /** Canonical Gateway session key. */
  sessionKey: string;
  /** Effective selected model, not the model used by a transient fallback. */
  modelRef: string | null;
  overridden: boolean;
}

export interface SessionModelRecovery {
  id: string;
  requiresRestart: boolean;
  recovering: boolean;
  canRecover: boolean;
  blockedReason?: string;
}

export interface SessionModelRecoveryRequest {
  recoveryId: string;
  confirmed: true;
  restart: boolean;
}

export interface SessionModelAPI {
  get(sessionKey: string): Promise<SessionModelState>;
  /** null clears only the session override and restores agent/default inheritance. */
  select(params: { sessionKey: string; modelRef: string | null }): Promise<SessionModelState>;
  getRecovery(): Promise<SessionModelRecovery | null>;
  /** Accept saved state only after the previous write is known to have finished or stopped. */
  recover(params: SessionModelRecoveryRequest): Promise<void>;
  onRecoveryChanged(callback: () => void): () => void;
}
