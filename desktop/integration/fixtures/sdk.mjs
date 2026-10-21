import os from "node:os";

export const normalizeAccountId = (id) => id.trim();
export const resolvePreferredOpenClawTmpDir = () => os.tmpdir();
export const withFileLock = async (_path, _options, operation) => operation();
export const shouldComputeCommandAuthorized = (body) => body.startsWith("/");
export const resolveCommandAuthorizedFromAuthorizers = () => true;
export const createTypingCallbacks = () => ({});
export const getGlobalHookRunner = () => undefined;
export const fireAndForgetHook = () => {};
export const buildCanonicalSentMessageHookContext = (value) => value;
export const toPluginMessageContext = (value) => value;
export const toPluginMessageSentEvent = (value) => value;
