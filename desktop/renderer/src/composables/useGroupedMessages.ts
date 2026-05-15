import { computed, type Ref } from "vue";
import type { ChatMessage } from "@/stores/chat";

export interface MessageGroup {
  key: string;
  normalizedRole: string;
  messages: ChatMessage[];
  timestamp: number;
}

function normalizeRole(role: string): string {
  const lower = role.toLowerCase();
  if (lower === "user") return "user";
  return "assistant"; // assistant / system / tool results shown as assistant
}

/**
 * Groups consecutive messages by normalized role.
 * Accepts a reactive ref to the messages array so it works in any component.
 */
export function useGroupedMessages(messages: Ref<ChatMessage[]>) {
  return computed<MessageGroup[]>(() => {
    const msgs = messages.value;
    if (!msgs || msgs.length === 0) return [];

    const groups: MessageGroup[] = [];
    let current: MessageGroup | null = null;

    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      const role = normalizeRole(msg.role);
      const ts = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();

      if (!current || current.normalizedRole !== role) {
        current = {
          key: `group-${i}`,
          normalizedRole: role,
          messages: [msg],
          timestamp: ts,
        };
        groups.push(current);
      } else {
        current.messages.push(msg);
      }
    }
    return groups;
  });
}
