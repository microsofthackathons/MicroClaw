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
        :aria-label="t('plugins.weixinName')"
        aria-haspopup="dialog"
        :aria-expanded="open"
        @click="open = !open"
      >
        <img :src="weixinIcon" alt="" />
        <span>{{ t("plugins.weixinName") }}</span>
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
import weixinIcon from "@/assets/wechat.png";

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
  gap: 10px;
  width: 100%;
  min-height: 40px;
  padding: 8px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.weixin-shortcut img {
  width: 22px;
  height: 22px;
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
