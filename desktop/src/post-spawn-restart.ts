interface PluginConfig {
  plugins?: {
    entries?: Record<string, { enabled?: boolean }>;
  };
}

export function requiresPostSpawnChannelRestart(config: PluginConfig | null): boolean {
  return config?.plugins?.entries?.["openclaw-weixin"]?.enabled === true;
}
