export type CommandConsentMode = "ask-when-needed" | "allow-always";

export function parseCommandConsentMode(value: unknown): CommandConsentMode {
  if (value === "ask-when-needed" || value === "allow-always") return value;
  throw new Error("Unknown command consent mode");
}

export interface CommandConsentPreview {
  required: boolean;
  allowAlwaysAvailable: boolean;
}

export function parseCommandConsentPreview(value: unknown): CommandConsentPreview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const preview = value as Record<string, unknown>;
  if (
    typeof preview.required !== "boolean" ||
    typeof preview.allowAlwaysAvailable !== "boolean" ||
    (!preview.required && preview.allowAlwaysAvailable)
  ) {
    return null;
  }
  return {
    required: preview.required,
    allowAlwaysAvailable: preview.allowAlwaysAvailable,
  };
}

export async function applyCommandConsentChange(
  previous: CommandConsentMode,
  next: CommandConsentMode,
  hooks: {
    lock: () => Promise<void>;
    save: (mode: CommandConsentMode) => void;
    publish: (mode: CommandConsentMode) => Promise<void>;
    verify: (mode: CommandConsentMode) => Promise<void>;
    release: () => Promise<void>;
    failClosed: (error: unknown) => Promise<void>;
  },
): Promise<void> {
  try {
    await hooks.lock();
    hooks.save(next);
    await hooks.publish(next);
    await hooks.verify(next);
    await hooks.release();
  } catch (error) {
    try {
      await hooks.lock();
      hooks.save(previous);
      await hooks.publish(previous);
      await hooks.verify(previous);
      await hooks.release();
    } catch (rollbackError) {
      const failures = [error, rollbackError];
      try {
        await hooks.failClosed(rollbackError);
      } catch (lockingError) {
        failures.push(lockingError);
      }
      throw new AggregateError(
        failures,
        "Command consent could not be applied or restored; execution is unavailable",
        { cause: rollbackError },
      );
    }
    throw error;
  }
}
