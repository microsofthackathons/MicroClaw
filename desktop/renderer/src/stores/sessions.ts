import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { t } from "../i18n";

export interface Session {
  key: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  preview: string; // last message snippet
  agentId?: string;
}

const STORAGE_KEY = "openclaw-sessions";

function loadFromStorage(): Session[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveToStorage(sessions: Session[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

export const useSessionStore = defineStore("sessions", () => {
  const sessions = ref<Session[]>(loadFromStorage());
  const currentKey = ref<string | null>(null);

  const sortedSessions = computed(() =>
    [...sessions.value].sort((a, b) => b.updatedAt - a.updatedAt),
  );

  /** Ensure a session entry exists for the given key. */
  function ensureSession(key: string, agentId?: string) {
    const existing = sessions.value.find((s) => s.key === key);
    if (!existing) {
      sessions.value.push({
        key,
        title: t("store.newChat"),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        preview: "",
        agentId,
      });
      saveToStorage(sessions.value);
    } else if (agentId && !existing.agentId) {
      existing.agentId = agentId;
      saveToStorage(sessions.value);
    }
    currentKey.value = key;
  }

  /** Update session metadata (title / preview). */
  function updateSession(key: string, patch: Partial<Pick<Session, "title" | "preview">>) {
    const s = sessions.value.find((s) => s.key === key);
    if (s) {
      if (patch.title !== undefined) s.title = patch.title;
      if (patch.preview !== undefined) s.preview = patch.preview;
      s.updatedAt = Date.now();
      saveToStorage(sessions.value);
    }
  }

  /** Remove a session. */
  function removeSession(key: string) {
    sessions.value = sessions.value.filter((s) => s.key !== key);
    if (currentKey.value === key) currentKey.value = null;
    saveToStorage(sessions.value);
  }

  /** Replace a local alias with its canonical Gateway key and merge duplicates. */
  function canonicalizeSession(aliasKey: string, canonicalKey: string) {
    if (!aliasKey || aliasKey === canonicalKey) return;

    const alias = sessions.value.find((s) => s.key === aliasKey);
    const canonical = sessions.value.find((s) => s.key === canonicalKey);
    if (alias && canonical) {
      const newer = alias.updatedAt > canonical.updatedAt ? alias : canonical;
      const older = newer === alias ? canonical : alias;
      const defaultTitle = t("store.newChat");
      const merged: Session = {
        ...newer,
        key: canonicalKey,
        title: newer.title !== defaultTitle ? newer.title : older.title,
        preview: newer.preview || older.preview,
        agentId: newer.agentId || older.agentId,
        createdAt: Math.min(alias.createdAt, canonical.createdAt),
        updatedAt: Math.max(alias.updatedAt, canonical.updatedAt),
      };
      sessions.value = sessions.value.filter(
        (session) => session.key !== aliasKey && session.key !== canonicalKey,
      );
      sessions.value.push(merged);
    } else if (alias) {
      alias.key = canonicalKey;
    }

    if (currentKey.value === aliasKey) currentKey.value = canonicalKey;
    if (alias) saveToStorage(sessions.value);
  }

  /** Remove every session from the sidebar list. */
  function clearAll() {
    sessions.value = [];
    currentKey.value = null;
    saveToStorage(sessions.value);
  }

  /** Auto-generate a title from the first user message. */
  function autoTitle(key: string, firstMessage: string) {
    const s = sessions.value.find((s) => s.key === key);
    if (s && s.title === t("store.newChat")) {
      s.title = firstMessage.replace(/\n/g, " ").slice(0, 30) || t("store.newChat");
      s.updatedAt = Date.now();
      saveToStorage(sessions.value);
    }
  }

  return {
    sessions,
    currentKey,
    sortedSessions,
    ensureSession,
    updateSession,
    removeSession,
    canonicalizeSession,
    clearAll,
    autoTitle,
  };
});
