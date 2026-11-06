<template>
  <ElPopover
    :visible="open"
    placement="top-start"
    :width="320"
    trigger="click"
    role="dialog"
    :aria-labelledby="titleId"
    :show-arrow="false"
    :persistent="true"
    :popper-style="{ maxWidth: 'calc(100vw - 24px)', padding: '16px', borderRadius: '12px' }"
  >
    <template #reference>
      <button
        ref="trigger"
        type="button"
        class="weixin-shortcut"
        :class="{ active: open }"
        data-testid="weixin-shortcut"
        :title="t('sidebar.phone')"
        :aria-label="t('sidebar.phone')"
        aria-haspopup="dialog"
        :aria-expanded="open"
        @click="open = !open"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M10 16H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3M6 20h4M8 16v4" />
          <rect x="13" y="8" width="9" height="14" rx="2" />
          <path d="M17 18h1" />
        </svg>
      </button>
    </template>
    <div ref="content">
      <WeixinConnectionCard
        v-if="activated"
        inline
        show-messages
        :active="open"
        :heading-id="titleId"
        @close="open = false"
        @confirmation-change="confirming = $event"
      />
      <p v-else>{{ t("plugins.weixinPreparingQr") }}</p>
    </div>
  </ElPopover>
</template>

<script setup lang="ts">
import { defineAsyncComponent, onMounted, onUnmounted, ref, useId, watch } from "vue";
import { useRoute } from "vue-router";
import { ElPopover } from "element-plus";
import { t } from "@/i18n";

const WeixinConnectionCard = defineAsyncComponent(() => import("./WeixinConnectionCard.vue"));
const route = useRoute();
const titleId = useId();
const open = ref(false);
const activated = ref(false);
const confirming = ref(false);
const trigger = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);

watch(open, (value) => {
  if (value) activated.value = true;
});
watch(
  () => route.fullPath,
  () => (open.value = false),
);

function closeOnEscape(event: KeyboardEvent): void {
  if (event.key === "Escape" && !confirming.value) open.value = false;
}
function closeOnOutside(event: PointerEvent): void {
  if (
    !open.value ||
    confirming.value ||
    !(event.target instanceof Node) ||
    trigger.value?.contains(event.target) ||
    content.value?.contains(event.target)
  )
    return;
  open.value = false;
}
onMounted(() => {
  document.addEventListener("keydown", closeOnEscape);
  document.addEventListener("pointerdown", closeOnOutside, true);
});
onUnmounted(() => {
  document.removeEventListener("keydown", closeOnEscape);
  document.removeEventListener("pointerdown", closeOnOutside, true);
});
</script>

<style scoped>
.weixin-shortcut {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s;
}
.weixin-shortcut:hover,
.weixin-shortcut.active {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}
.weixin-shortcut:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
</style>
