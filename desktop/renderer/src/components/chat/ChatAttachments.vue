<template>
  <div v-if="attachments.length" class="chat-attachments">
    <div
      v-for="(attachment, index) in attachments"
      :key="`${attachment.fileName}-${attachment.size}-${index}`"
      class="chat-attachment"
      :class="{ 'chat-attachment--openable': isOpenable(attachment) }"
      :role="isOpenable(attachment) ? 'button' : undefined"
      :tabindex="isOpenable(attachment) ? 0 : undefined"
      @click.stop="openAttachment(attachment)"
      @keydown.enter.self.stop.prevent="openAttachment(attachment)"
      @keydown.space.self.stop.prevent="openAttachment(attachment)"
    >
      <img
        v-if="attachment.type === 'image' && attachment.content"
        class="chat-attachment__thumbnail"
        :src="imageSource(attachment)"
        alt=""
      />
      <span v-else class="chat-attachment__icon" aria-hidden="true">&#x1F4CE;</span>
      <span class="chat-attachment__details">
        <span class="chat-attachment__name">
          {{
            attachment.fileName || t(attachment.type === "image" ? "chat.image" : "chat.attachment")
          }}
        </span>
        <span v-if="attachment.size" class="chat-attachment__size">
          {{ formatFileSize(attachment.size) }}
        </span>
      </span>
      <button
        v-if="removable"
        class="chat-attachment__remove"
        type="button"
        :title="t('chat.removeAttachment', { file: attachment.fileName })"
        :aria-label="t('chat.removeAttachment', { file: attachment.fileName })"
        @click.stop="$emit('remove', index)"
        @keydown.enter.stop
        @keydown.space.stop
      >
        &times;
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from "@/i18n";
import { ElMessage } from "element-plus";

defineProps<{
  attachments: ChatAttachment[];
  removable?: boolean;
}>();

defineEmits<{
  remove: [index: number];
}>();

function imageSource(attachment: ChatAttachment): string {
  return attachment.content.startsWith("data:")
    ? attachment.content
    : `data:${attachment.mimeType};base64,${attachment.content}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isOpenable(attachment: ChatAttachment): boolean {
  return (
    attachment.content.length > 0 ||
    (typeof attachment.mediaPath === "string" &&
      (/^media:\/\/inbound\/[^/?#]+$/i.test(attachment.mediaPath) ||
        /^[a-z]:\\.*\\media\\inbound\\[^\\]+$/i.test(attachment.mediaPath)))
  );
}

async function openAttachment(attachment: ChatAttachment) {
  if (!isOpenable(attachment)) return;
  try {
    const result = await window.openclaw.attachment.open(attachment);
    if (!result.ok) {
      ElMessage.error(t("chat.attachment.openFailed", { error: result.error || "" }));
    }
  } catch (error) {
    ElMessage.error(t("chat.attachment.openFailed", { error: String(error) }));
  }
}
</script>

<style scoped>
.chat-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chat-attachment {
  display: flex;
  min-width: 0;
  max-width: 240px;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--ux-border);
  border-radius: 10px;
  background: var(--ux-surface-secondary);
}

.chat-attachment--openable {
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s;
}

.chat-attachment--openable:hover,
.chat-attachment--openable:focus-visible {
  border-color: var(--ux-focus);
  background: var(--ux-surface-hover);
  outline: none;
}

.chat-attachment__thumbnail {
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  border-radius: 6px;
  object-fit: cover;
}

.chat-attachment__icon {
  flex: 0 0 auto;
  font-size: 18px;
}

.chat-attachment__details {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}

.chat-attachment__name {
  overflow: hidden;
  color: var(--ux-text-primary);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-attachment__size {
  color: var(--ux-text-muted);
  font-size: 10px;
}

.chat-attachment__remove {
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ux-text-secondary);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
}

.chat-attachment__remove:hover {
  background: var(--ux-surface-hover);
}
</style>
