import { ref, computed } from "vue";
import zhCN from "./zh-CN";
import enUS from "./en-US";

export type Locale = "zh-CN" | "en-US";

const messages: Record<Locale, Record<string, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

const currentLocale = ref<Locale>("en-US");

export function setLocale(locale: Locale) {
  currentLocale.value = locale;
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

export function getLocale(): Locale {
  return currentLocale.value;
}

export const locale = computed(() => currentLocale.value);

/**
 * Translate a key, with optional interpolation.
 * Usage: t('key')  or  t('key', { error: msg })
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = messages[currentLocale.value] ?? messages["en-US"];
  let text = dict[key] ?? messages["en-US"][key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, String(v));
    }
  }
  return text;
}
