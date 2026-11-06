<template>
  <div
    v-if="attachments.length"
    class="chat-attachments"
    :class="{ 'chat-attachments--composer': removable }"
  >
    <div
      v-for="(attachment, index) in attachments"
      :key="`${attachment.fileName}-${attachment.size}-${index}`"
      class="chat-attachment"
      :class="{
        'chat-attachment--openable': isOpenable(attachment),
        'chat-attachment--image': !!imageSource(attachment) || isLoadingImage(attachment),
      }"
      :role="isOpenable(attachment) ? 'button' : undefined"
      :tabindex="isOpenable(attachment) ? 0 : undefined"
      :aria-label="imageSource(attachment) ? t('chat.previewImage') : undefined"
      @click.stop="openAttachment(attachment)"
      @dblclick.stop
      @keydown.enter.self.stop.prevent="openAttachment(attachment)"
      @keydown.space.self.stop.prevent="openAttachment(attachment)"
    >
      <template v-if="imageSource(attachment)">
        <img
          class="chat-attachment__image"
          :src="imageSource(attachment)"
          :alt="attachment.fileName || t('chat.image')"
          @error="failedImages.add(imageKey(attachment))"
        />
        <span class="chat-attachment__preview-hint" aria-hidden="true">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
          >
            <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />
          </svg>
        </span>
      </template>
      <span v-else-if="isLoadingImage(attachment)" class="chat-attachment__loading" role="status">
        {{ t("chat.imageLoading") }}
      </span>
      <span v-else class="chat-attachment__icon" aria-hidden="true">&#x1F4CE;</span>
      <span
        v-if="!imageSource(attachment) && !isLoadingImage(attachment)"
        class="chat-attachment__details"
      >
        <span class="chat-attachment__name">
          {{
            attachment.fileName || t(attachment.type === "image" ? "chat.image" : "chat.attachment")
          }}
        </span>
        <span v-if="attachment.size" class="chat-attachment__size">
          {{ formatFileSize(attachment.size) }}
        </span>
        <span v-if="attachment.type === 'image'" class="chat-attachment__size">
          {{ t("chat.imageUnavailable") }}
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
    <ElImageViewer
      v-if="previewUrl"
      :url-list="[previewUrl]"
      teleported
      hide-on-click-modal
      @close="previewUrl = null"
    />
  </div>
</template>

<script setup lang="ts">
import { t } from "@/i18n";
import { computed, reactive, ref, watch } from "vue";
import { ElImageViewer, ElMessage } from "element-plus";

const props = defineProps<{
  attachments: ChatAttachment[];
  removable?: boolean;
}>();

defineEmits<{
  remove: [index: number];
}>();

const previewUrl = ref<string | null>(null);
const imageSources = reactive(new Map<string, string>());
const failedImages = reactive(new Set<string>());
const historyImagePaths = computed(() => [
  ...new Set(
    props.attachments
      .filter(
        (attachment) =>
          attachment.type === "image" && !attachment.content && isOpenable(attachment),
      )
      .map((attachment) => attachment.mediaPath!),
  ),
]);

watch(
  () => JSON.stringify(historyImagePaths.value),
  async (_paths, _previousPaths, onCleanup) => {
    let active = true;
    onCleanup(() => {
      active = false;
    });
    imageSources.clear();
    failedImages.clear();
    await Promise.all(
      historyImagePaths.value.map(async (mediaPath) => {
        try {
          const result = await window.openclaw.attachment.readImage(mediaPath);
          if (!active) return;
          if (result.ok && result.dataUrl) imageSources.set(mediaPath, result.dataUrl);
          else failedImages.add(mediaPath);
        } catch {
          if (active) failedImages.add(mediaPath);
        }
      }),
    );
  },
  { immediate: true },
);

function imageKey(attachment: ChatAttachment): string {
  return attachment.content || attachment.mediaPath || "";
}

function imageSource(attachment: ChatAttachment): string {
  if (attachment.type !== "image" || failedImages.has(imageKey(attachment))) return "";
  if (!attachment.content) return imageSources.get(attachment.mediaPath || "") || "";
  return attachment.content.startsWith("data:")
    ? attachment.content
    : `data:${attachment.mimeType};base64,${attachment.content}`;
}

function isLoadingImage(attachment: ChatAttachment): boolean {
  return (
    attachment.type === "image" &&
    !attachment.content &&
    isOpenable(attachment) &&
    !imageSources.has(attachment.mediaPath!) &&
    !failedImages.has(imageKey(attachment))
  );
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
  const source = imageSource(attachment);
  if (source) {
    previewUrl.value = source;
    return;
  }
  if (isLoadingImage(attachment)) return;
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

.chat-attachment--image {
  position: relative;
  display: block;
  max-width: min(320px, 100%);
  padding: 0;
  overflow: hidden;
  border: none;
  border-radius: 14px;
}

.chat-attachment--image:focus-visible {
  outline: 2px solid var(--ux-focus);
  outline-offset: 3px;
}

.chat-attachment__image {
  display: block;
  max-width: 100%;
  max-height: 320px;
  border-radius: inherit;
  object-fit: contain;
}

.chat-attachment__preview-hint {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgb(0 0 0 / 18%);
  color: #fff;
  opacity: 0;
  transition: opacity 0.15s;
}

.chat-attachment:hover .chat-attachment__preview-hint,
.chat-attachment:focus-visible .chat-attachment__preview-hint {
  opacity: 1;
}

.chat-attachment__loading {
  display: grid;
  width: 220px;
  max-width: 100%;
  height: 160px;
  place-items: center;
  color: var(--ux-text-muted);
  font-size: 13px;
}

.chat-attachments--composer .chat-attachment--image {
  overflow: visible;
  border-radius: 10px;
}

.chat-attachments--composer .chat-attachment__image {
  width: 64px;
  height: 64px;
  object-fit: cover;
}

.chat-attachment--image .chat-attachment__remove {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 1;
  background: var(--ux-surface-secondary);
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
