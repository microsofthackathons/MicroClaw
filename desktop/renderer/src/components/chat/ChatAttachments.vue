<template>
  <div v-if="attachments.length" class="chat-attachments">
    <div
      v-for="(attachment, index) in attachments"
      :key="`${attachment.fileName}-${attachment.size}-${index}`"
      class="chat-attachment"
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
      >
        &times;
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from "@/i18n";

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
