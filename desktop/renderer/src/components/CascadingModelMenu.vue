<template>
  <div
    class="provider-menu"
    role="menu"
    :aria-label="t('modelManager.providers')"
    @keydown="navigate"
  >
    <el-popover
      v-for="group in groups"
      :key="group.key"
      :visible="activeProvider === group.key"
      trigger="hover"
      placement="right-start"
      :width="240"
      :show-arrow="false"
      :offset="4"
      :show-after="80"
      :hide-after="180"
      :teleported="false"
      :disabled="disabled"
      popper-class="model-cascade-popup"
      :popper-style="{ maxWidth: 'calc(100vw - 32px)', padding: '4px' }"
      @update:visible="setProvider(group.key, $event)"
    >
      <template #reference>
        <button
          :id="`${menuId}-${group.key}-trigger`"
          type="button"
          role="menuitem"
          class="provider-menu-trigger"
          :class="{ 'submenu-open': activeProvider === group.key }"
          :data-provider-group="group.key"
          aria-haspopup="menu"
          :aria-expanded="activeProvider === group.key"
          :aria-controls="`${menuId}-${group.key}`"
          :disabled="disabled"
          @click="setProvider(group.key, activeProvider !== group.key)"
          @keydown.right.prevent.stop="enterProvider(group.key)"
        >
          <span class="model-group-name">{{ label(group.key) }}</span>
          <IconChevronDown
            class="provider-chevron"
            :size="12"
            :stroke-width="2"
            aria-hidden="true"
          />
        </button>
      </template>
      <section
        :id="`${menuId}-${group.key}`"
        role="menu"
        :aria-label="label(group.key)"
        @keydown="navigate"
        @keydown.left.prevent.stop="leaveProvider(group.key)"
        @keydown.esc.prevent.stop="leaveProvider(group.key)"
      >
        <ModelMenuChoices
          :models="group.frequent"
          :selected-model="selectedModel"
          :disabled="disabled"
          :model-status="modelStatus"
          @select="emit('select', $event)"
        />
        <el-popover
          v-if="group.remaining.length"
          :visible="activeProvider === group.key && moreOpen"
          trigger="hover"
          :placement="morePlacement"
          :width="240"
          :show-arrow="false"
          :offset="4"
          :show-after="80"
          :hide-after="180"
          :teleported="false"
          :disabled="disabled"
          popper-class="model-cascade-popup"
          :popper-style="{ maxWidth: 'calc(100vw - 32px)', padding: '4px' }"
          @update:visible="setMore(group.key, $event)"
        >
          <template #reference>
            <button
              :id="`${menuId}-${group.key}-more-trigger`"
              type="button"
              role="menuitem"
              class="provider-menu-trigger more-models-trigger"
              :class="{ 'submenu-open': activeProvider === group.key && moreOpen }"
              :data-more-models="group.key"
              aria-haspopup="menu"
              :aria-expanded="moreOpen"
              :aria-controls="`${menuId}-${group.key}-more`"
              :disabled="disabled"
              @click="setMore(group.key, !moreOpen)"
              @keydown.right.prevent.stop="enterMore(group.key)"
            >
              <span>{{ t("modelManager.moreModels") }}</span>
              <IconChevronDown
                class="provider-chevron"
                :size="12"
                :stroke-width="2"
                aria-hidden="true"
              />
            </button>
          </template>
          <section
            :id="`${menuId}-${group.key}-more`"
            class="remaining-models"
            role="menu"
            :aria-label="`${label(group.key)} · ${t('modelManager.moreModels')}`"
            @keydown="navigate"
            @keydown.left.prevent.stop="leaveMore(group.key)"
            @keydown.esc.prevent.stop="leaveMore(group.key)"
          >
            <ModelMenuChoices
              :models="group.remaining"
              :selected-model="selectedModel"
              :disabled="disabled"
              :model-status="modelStatus"
              @select="emit('select', $event)"
            />
          </section>
        </el-popover>
      </section>
    </el-popover>
    <p v-if="!groups.length" class="empty-models" role="status">
      {{ t("settings.noProviderConfigured") }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId } from "vue";
import { t } from "@/i18n";
import { providerName, type ConfiguredModel } from "@/utils/configured-models";
import { sortModelsByFamily } from "@/utils/model-family-sort";
import ModelMenuChoices from "./ModelMenuChoices.vue";
import IconChevronDown from "./icons/IconChevronDown.vue";

const props = defineProps<{
  models: ConfiguredModel[];
  selectedModel: string;
  disabled?: boolean;
  modelStatus?: (model: ConfiguredModel) => string;
}>();
const emit = defineEmits<{ select: [modelRef: string] }>();
const menuId = useId();
const activeProvider = ref("");
const moreOpen = ref(false);
const morePlacement = ref<"right-start" | "left-start">("right-start");
const curated: Record<string, string[]> = {
  openai: ["gpt-5.4", "gpt-5-mini", "gpt-5", "gpt-4.1", "gpt-4o"],
  anthropic: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-sonnet-4", "claude-haiku-4-5"],
  qwen: ["qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash", "qwen3.5-plus", "qwen3-32b"],
  minimax: ["MiniMax-M3", "MiniMax-M1"],
};
function label(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "qwen") return t("modelManager.qianwen");
  return providerName(provider);
}
const groups = computed(() => {
  const grouped = new Map<string, ConfiguredModel[]>();
  for (const model of props.models) {
    const models = grouped.get(model.providerKey) ?? [];
    models.push(model);
    grouped.set(model.providerKey, models);
  }
  return [...grouped].map(([key, models]) => {
    const preferred = curated[key] ?? [];
    const ranked = sortModelsByFamily(models).sort((a, b) => {
      const rank = (id: string) => {
        const index = preferred.indexOf(id);
        return index < 0 ? preferred.length : index;
      };
      return rank(a.id) - rank(b.id);
    });
    return { key, frequent: ranked.slice(0, 5), remaining: ranked.slice(5) };
  });
});
function setProvider(key: string, visible: boolean): void {
  if (visible && !props.disabled) {
    if (activeProvider.value !== key) moreOpen.value = false;
    activeProvider.value = key;
  } else if (activeProvider.value === key) {
    activeProvider.value = "";
    moreOpen.value = false;
  }
}
async function enterProvider(key: string): Promise<void> {
  setProvider(key, true);
  await nextTick();
  document
    .getElementById(`${menuId}-${key}`)
    ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
    ?.focus();
}
function leaveProvider(key: string): void {
  setProvider(key, false);
  document.getElementById(`${menuId}-${key}-trigger`)?.focus();
}
async function enterMore(key: string): Promise<void> {
  setMore(key, true);
  await nextTick();
  document
    .getElementById(`${menuId}-${key}-more`)
    ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
    ?.focus();
}
function setMore(key: string, visible: boolean): void {
  if (visible && props.disabled) return;
  if (visible) {
    const placement = document
      .getElementById(`${menuId}-${key}-more-trigger`)
      ?.closest(".el-popper")
      ?.getAttribute("data-popper-placement");
    morePlacement.value = placement?.startsWith("left") ? "left-start" : "right-start";
  }
  moreOpen.value = visible;
}
function leaveMore(key: string): void {
  moreOpen.value = false;
  document.getElementById(`${menuId}-${key}-more-trigger`)?.focus();
}
function navigate(event: KeyboardEvent): void {
  if (!(event.currentTarget instanceof HTMLElement) || !(event.target instanceof HTMLElement))
    return;
  const menu = event.currentTarget;
  if (event.target.closest('[role="menu"]') !== menu) return;
  const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")].filter(
    (button) => button.closest('[role="menu"]') === menu,
  );
  const index = buttons.findIndex((button) => button === event.target);
  let next: number;
  if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
  else if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = buttons.length - 1;
  else return;
  event.preventDefault();
  event.stopPropagation();
  buttons[next]?.focus();
}
</script>

<style scoped>
.provider-menu-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 10px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--el-text-color-primary);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.provider-menu-trigger:not(:disabled).submenu-open,
.provider-menu-trigger:not(:disabled):hover,
.provider-menu-trigger:not(:disabled):focus-visible {
  background: var(--accent-light);
}
.provider-menu-trigger:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: -2px;
}
.provider-menu-trigger:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.model-group-name {
  overflow-wrap: anywhere;
}
.provider-chevron {
  margin-left: auto;
  flex-shrink: 0;
  transform: rotate(-90deg);
}
.empty-models {
  margin: 4px 8px 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.more-models-trigger {
  margin-top: 4px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.remaining-models {
  max-height: min(360px, calc(100vh - 64px));
  overflow-y: auto;
}
</style>
