export function includeInRestrictedPluginAllowlist(
  plugins: { allow?: unknown },
  pluginId: string,
): boolean {
  const allow = plugins.allow;
  if (!Array.isArray(allow) || allow.length === 0 || allow.includes(pluginId)) return false;
  allow.push(pluginId);
  return true;
}
