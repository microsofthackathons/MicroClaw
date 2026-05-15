/**
 * Main-process i18n.
 * The renderer has its own i18n under renderer/src/i18n/.
 * This module covers strings sent from the main process (e.g. WeChat notifications).
 */

import zhCN from "./zh-CN";
import enUS from "./en-US";

const messages: Record<string, Record<string, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

export function t(lang: string, key: string): string {
  return messages[lang]?.[key] ?? messages["en-US"]?.[key] ?? key;
}
