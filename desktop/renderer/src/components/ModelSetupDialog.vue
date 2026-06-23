<template>
  <div v-if="modelValue" class="model-setup-overlay">
    <div class="model-setup-panel">
      <button class="model-setup-close" type="button" :aria-label="t('common.close')" @click="close">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <template v-if="!isKeyStep">
        <h2>{{ t("modelSetup.title") }}</h2>
        <p class="model-setup-desc">{{ t("modelSetup.selectDesc") }}</p>

        <div class="model-family-grid">
          <button
            v-for="family in modelFamilies"
            :key="family.id"
            type="button"
            class="model-family-card"
            :class="{ active: selectedFamilyId === family.id }"
            :aria-pressed="selectedFamilyId === family.id ? 'true' : 'false'"
            @click="selectedFamilyId = family.id"
          >
            <span class="family-icon" aria-hidden="true">
              <img :src="family.logo" :alt="family.label" />
            </span>
            <span class="family-name">{{ family.label }}</span>
            <span v-if="selectedFamilyId === family.id" class="family-selected-badge" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path
                  d="M3.25 8.25L6.5 11.5L12.75 5.25"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
          </button>
        </div>

        <UiButton class="primary-action" variant="default" size="lg" @click.stop="handleGetApiKey">
          {{ t("modelSetup.getApiKey") }}
        </UiButton>
        <UiButton class="text-action" variant="outline" size="lg" @click.stop="goToKeyForm">
          {{ t("modelSetup.haveApiKey") }}
        </UiButton>
      </template>

      <template v-else>
        <h2>{{ t("modelSetup.title") }}</h2>
        <p class="model-setup-desc">{{ t("modelSetup.keyDesc") }}</p>

        <el-form label-position="top" class="model-key-form">
          <el-form-item :label="t('modelSetup.modelSelect')">
            <div ref="dropdownRef" class="model-dropdown" :class="{ 'is-open': isDropdownOpen }">
              <button
                class="model-dropdown-trigger"
                type="button"
                role="combobox"
                :aria-expanded="isDropdownOpen ? 'true' : 'false'"
                :aria-controls="dropdownListId"
                :aria-activedescendant="isDropdownOpen ? activeOptionId : undefined"
                aria-haspopup="listbox"
                @click.stop="toggleDropdown"
                @keydown.down.prevent="handleTriggerArrow(1)"
                @keydown.up.prevent="handleTriggerArrow(-1)"
                @keydown.home.prevent="selectFirstModel"
                @keydown.end.prevent="selectLastModel"
                @keydown.enter.prevent="toggleDropdown"
                @keydown.space.prevent="toggleDropdown"
                @keydown.esc.prevent="closeDropdown"
              >
                <span class="model-dropdown-value">{{ selectedModelName }}</span>
                <span class="model-dropdown-caret" aria-hidden="true"></span>
              </button>

              <ul
                :id="dropdownListId"
                class="model-dropdown-menu"
                role="listbox"
                :aria-hidden="isDropdownOpen ? 'false' : 'true'"
              >
                <li v-for="model in selectedFamily.models" :key="model" role="none">
                  <button
                    :id="getOptionId(model)"
                    class="model-dropdown-option"
                    :class="{ selected: selectedModelName === model, active: selectedModelName === model && isDropdownOpen }"
                    type="button"
                    role="option"
                    :aria-selected="selectedModelName === model ? 'true' : 'false'"
                    @click.stop="selectModel(model)"
                  >
                    {{ model }}
                  </button>
                </li>
              </ul>
            </div>
          </el-form-item>
          <el-form-item :label="t('modelSetup.baseUrl')">
            <UiInput
              v-model="baseUrl"
              class="model-key-input"
              size="lg"
              placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
              @keydown.enter.prevent="saveAndStart"
            />
          </el-form-item>
          <el-form-item :label="t('modelSetup.apiKey')">
            <UiInput
              class="model-key-input"
              v-model="apiKey"
              size="lg"
              show-password
              :placeholder="selectedFamily.apiKeyPlaceholder"
              @keydown.enter.prevent="saveAndStart"
            />
          </el-form-item>
          <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>
        </el-form>

        <div class="key-actions">
          <UiButton
            class="text-action text-action--back"
            variant="outline"
            size="lg"
            @mousedown.prevent.stop="goToSelectStep"
          >
            {{ t("common.back") }}
          </UiButton>
          <UiButton
            class="primary-action"
            variant="default"
            size="lg"
            :disabled="saving"
            @mousedown.prevent.stop="saveAndStart"
          >
            {{ saving ? t("modelSetup.saving") : t("modelSetup.start") }}
          </UiButton>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { t } from "@/i18n";
import { UiButton, UiInput } from "@/components/ui";
import qwenLogo from "@/assets/modelprovider/Qwen.png";
import minimaxLogo from "@/assets/modelprovider/minimax.png";

type ModelFamilyId = "qwen" | "minimax";
type ApiFormat = "openai-chat" | "anthropic";

interface ModelFamilyPreset {
  id: ModelFamilyId;
  label: string;
  providerKey: string;
  baseUrl: string;
  apiFormat: ApiFormat;
  models: string[];
  apiKeyPlaceholder: string;
  logo: string;
}

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  configured: [];
}>();

const ALIYUN_OPENAI_COMPATIBLE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

const modelFamilies: ModelFamilyPreset[] = [
  {
    id: "qwen",
    label: "千问",
    providerKey: "qwen",
    baseUrl: ALIYUN_OPENAI_COMPATIBLE_BASE_URL,
    apiFormat: "openai-chat",
    models: ["qwen", "Qwen3.6-Plus", "Qwen3.5-Plus"],
    apiKeyPlaceholder: "sk-...",
    logo: qwenLogo,
  },
  {
    id: "minimax",
    label: "MiniMax",
    providerKey: "minimax",
    baseUrl: "",
    apiFormat: "anthropic",
    models: ["minimaxm3", "MiniMax-M1"],
    apiKeyPlaceholder: "sk-cp-...",
    logo: minimaxLogo,
  },
];

const isKeyStep = ref(false);
const selectedFamilyId = ref<ModelFamilyId>("qwen");
const selectedModelName = ref(modelFamilies[0].models[0]);
const baseUrl = ref(modelFamilies[0].baseUrl);
const isDropdownOpen = ref(false);
const dropdownRef = ref<HTMLElement | null>(null);
const dropdownListId = "model-setup-model-listbox";
const apiKey = ref("");
const errorMsg = ref("");
const saving = ref(false);

const activeOptionId = computed(() => getOptionId(selectedModelName.value));

const selectedFamily = computed(
  () => modelFamilies.find((family) => family.id === selectedFamilyId.value) ?? modelFamilies[0],
);

watch(selectedFamilyId, () => {
  selectedModelName.value = selectedFamily.value.models[0];
  baseUrl.value = selectedFamily.value.baseUrl;
  errorMsg.value = "";
});

watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) {
      closeDropdown();
      return;
    }
    isKeyStep.value = false;
    errorMsg.value = "";
    closeDropdown();
  },
);

onMounted(() => {
  document.addEventListener("pointerdown", handleDocumentPointerDown);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", handleDocumentPointerDown);
});

function resolveApiValue(apiFormat: ApiFormat): string {
  return apiFormat === "anthropic" ? "anthropic-messages" : "openai-completions";
}

function close() {
  emit("update:modelValue", false);
}

function goToKeyForm() {
  selectedModelName.value = selectedFamily.value.models[0];
  baseUrl.value = selectedFamily.value.baseUrl;
  isKeyStep.value = true;
  errorMsg.value = "";
  closeDropdown();
}

function handleGetApiKey() {
  const signupUrl =
    selectedFamily.value.id === "qwen"
      ? "https://bailian.console.aliyun.com/?tab=model#/api-key"
      : "https://platform.minimaxi.com/user-center/basic-information/interface-key";
  try {
    window.openclaw?.shell?.openExternal?.(signupUrl);
  } catch {
    window.open(signupUrl, "_blank", "noopener,noreferrer");
  }
  goToKeyForm();
}

function goToSelectStep() {
  isKeyStep.value = false;
  errorMsg.value = "";
  closeDropdown();
}

function selectModel(model: string) {
  selectedModelName.value = model;
  closeDropdown();
}

function toggleDropdown() {
  isDropdownOpen.value = !isDropdownOpen.value;
}

function closeDropdown() {
  isDropdownOpen.value = false;
}

function handleTriggerArrow(step: number) {
  if (!isDropdownOpen.value) {
    isDropdownOpen.value = true;
  }
  cycleModel(step);
}

function cycleModel(step: number) {
  const models = selectedFamily.value.models;
  if (!models.length) return;
  const currentIndex = Math.max(0, models.indexOf(selectedModelName.value));
  const nextIndex = (currentIndex + step + models.length) % models.length;
  selectedModelName.value = models[nextIndex];
}

function selectFirstModel() {
  const models = selectedFamily.value.models;
  if (!models.length) return;
  selectedModelName.value = models[0];
  isDropdownOpen.value = true;
}

function selectLastModel() {
  const models = selectedFamily.value.models;
  if (!models.length) return;
  selectedModelName.value = models[models.length - 1];
  isDropdownOpen.value = true;
}

function getOptionId(model: string) {
  return `model-option-${model.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()}`;
}

function handleDocumentPointerDown(event: Event) {
  const target = event.target as Node | null;
  if (!target) return;
  if (!dropdownRef.value?.contains(target)) {
    closeDropdown();
  }
}

async function saveAndStart() {
  const trimmedModelName = selectedModelName.value.trim();
  const trimmedBaseUrl = baseUrl.value.trim();
  const trimmedKey = apiKey.value.trim();
  if (!trimmedModelName) {
    errorMsg.value = t("modelSetup.enterModelName");
    return;
  }
  if (!trimmedKey) {
    errorMsg.value = t("modelSetup.enterApiKey");
    return;
  }
  if (selectedFamily.value.id === "minimax" && !trimmedKey.startsWith("sk-cp-")) {
    errorMsg.value = t("modelSetup.invalidMiniMaxKey");
    return;
  }

  saving.value = true;
  errorMsg.value = "";
  try {
    const family = selectedFamily.value;
    const modelName = trimmedModelName;
    const modelRef = `${family.providerKey}/${modelName}`;
    const existing = (await window.openclaw.config.read()) || {};
    const providerEntry: Record<string, unknown> = {
      ...(trimmedBaseUrl ? { baseUrl: trimmedBaseUrl } : {}),
      apiKey: trimmedKey,
      api: resolveApiValue(family.apiFormat),
      models: [
        {
          id: modelName,
          name: modelName,
          ...(family.apiFormat !== "anthropic" ? { input: ["text", "image"] } : {}),
        },
      ],
    };

    existing.models = {
      ...(existing.models ?? {}),
      mode: existing.models?.mode ?? "merge",
      providers: {
        ...(existing.models?.providers ?? {}),
        [family.providerKey]: providerEntry,
      },
    };
    existing.agents = existing.agents || {};
    existing.agents.defaults = existing.agents.defaults || {};
    existing.agents.defaults.model = {
      ...(typeof existing.agents.defaults.model === "object" && existing.agents.defaults.model
        ? existing.agents.defaults.model
        : {}),
      primary: modelRef,
    };

    await window.openclaw.config.write(existing);
    await new Promise((resolve) => setTimeout(resolve, 500));
    emit("update:modelValue", false);
    emit("configured");
  } catch (err: any) {
    errorMsg.value = t("modelSetup.saveFailed", { error: err.message || err });
  } finally {
    saving.value = false;
  }
}

</script>

<style scoped>
.model-setup-overlay,
.model-setup-panel,
.model-setup-close,
.model-family-card,
.primary-action,
.text-action,
.model-key-form,
.error-msg {
  --ux-overlay: var(--surface-overlay, rgba(255, 255, 255, 0.72));
  --ux-panel-bg: var(--surface-page, var(--bg-primary));
  --ux-panel-text: var(--text-primary, #1f2228);
  --ux-text-secondary: var(--smtc-foreground-ctrl-neutral-secondary-rest, #555967);
  --ux-text-muted: var(--smtc-foreground-ctrl-hint-default, #6b6e78);
  --ux-border: var(--border-default, var(--smtc-stroke-divider-subtle, #ededf0));
  --ux-surface-hover: var(--surface-hover, var(--smtc-background-ctrl-subtle-hover, #f4f4f5));
  --ux-card-active: var(--smtc-background-card-on-primary-default-rest, #fafafa);
  --ux-card-selected-border: var(--ux-brand-bg);
  --ux-card-selected-bg: var(--ux-card-active);
  --ux-card-check-bg: var(--ux-brand-bg);
  --ux-card-check-fg: var(--ux-brand-fg);
  --ux-brand-bg: var(--action-primary, #18181b);
  --ux-brand-bg-hover: #27272a;
  --ux-brand-bg-active: #09090b;
  --ux-brand-fg: var(--action-primary-foreground, #fff);
  --ux-panel-radius: 20px;
  --ux-cta-radius: 999px;
  --ux-danger: var(--smtc-status-danger-foreground);
  --ux-shadow: 0 24px 70px rgba(25, 25, 30, 0.18);
  --ux-flyout-border: var(--ux-border);
  --ux-flyout-bg: var(--ux-panel-bg);
  --ux-flyout-shadow:
    0 24px 44px rgba(21, 24, 31, 0.16),
    0 8px 18px rgba(21, 24, 31, 0.1);
  --ux-font-family: "Segoe UI", "Noto Sans SC", sans-serif;
  --ux-title-size: 28px;
  --ux-title-weight: 700;
  --ux-body-size: 15px;
  --ux-body-line: 1.55;
  --ux-label-size: 14px;
  --ux-label-weight: 600;
  --ux-input-size: 15px;
  --ux-caption-size: 13px;
}

.model-setup-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: grid;
  place-items: center;
  background: var(--ux-overlay);
  backdrop-filter: blur(10px);
}

.model-setup-panel {
  width: min(470px, calc(100vw - 32px));
  min-height: 430px;
  position: relative;
  padding: 42px 34px 34px;
  border-radius: var(--ux-panel-radius);
  background: var(--ux-panel-bg);
  color: var(--ux-panel-text);
  font-family: var(--ux-font-family);
  box-shadow: var(--ux-shadow);
  text-align: center;
}

.model-setup-close {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--ux-text-muted);
  cursor: pointer;
  display: grid;
  place-items: center;
  transition:
    background 0.15s,
    color 0.15s;
}

.model-setup-close:hover {
  background: var(--ux-surface-hover);
  color: var(--ux-panel-text);
}

h2 {
  margin: 0;
  font-size: var(--ux-title-size);
  font-weight: var(--ux-title-weight);
  line-height: 1.1;
  color: var(--ux-panel-text);
  letter-spacing: 0.1px;
}

.model-setup-desc {
  margin: 14px 0 34px;
  color: var(--ux-text-secondary);
  font-size: var(--ux-body-size);
  line-height: var(--ux-body-line);
  font-weight: 500;
}

.model-family-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 26px;
  margin-bottom: 28px;
}

.model-family-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 8px 6px 12px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: var(--ux-panel-text);
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s,
    transform 0.15s;
}

.model-family-card:hover,
.model-family-card.active {
  background: var(--ux-card-active);
  border-color: var(--ux-border);
}

.model-family-card:hover {
  transform: translateY(-1px);
}

.model-family-card.active {
  background: var(--ux-card-selected-bg);
  border-color: var(--ux-card-selected-border);
  border-width: 2px;
}

.family-icon {
  width: 82px;
  height: 82px;
  display: grid;
  place-items: center;
}

.family-icon img {
  width: 76px;
  height: 76px;
  object-fit: contain;
  display: block;
}

.family-name {
  font-size: 17px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--ux-text-muted);
}

.model-family-card.active .family-name {
  color: var(--ux-panel-text);
  font-weight: 700;
}

.family-selected-badge {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  background: var(--ux-card-check-bg);
  color: var(--ux-card-check-fg);
}

.primary-action {
  width: 100%;
  min-height: 52px;
  border-radius: var(--ux-cta-radius);
}

.primary-action--spaced {
  margin-top: 16px;
}

.text-action {
  margin-top: 14px;
  width: 100%;
  min-height: 52px;
  border-radius: var(--ux-cta-radius);
}

.text-action--back {
  margin-top: 0;
}

.key-actions {
  margin-top: 16px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.key-actions .text-action,
.key-actions .primary-action {
  margin-top: 0;
  min-height: 48px;
}

.model-key-input {
  width: 100%;
}

.model-key-input :deep(.ui-input__control) {
  height: 48px;
  border-radius: 12px;
}

.model-key-form {
  text-align: left;
}

.model-key-form :deep(.el-form-item__label) {
  color: var(--ux-text-secondary);
  font-size: var(--ux-label-size);
  font-weight: var(--ux-label-weight);
  line-height: 1.4;
}

.model-key-form :deep(.el-input__wrapper),
.model-key-form :deep(.el-select__wrapper) {
  min-height: 48px;
  border-radius: 12px;
  box-shadow: 0 0 0 1px var(--ux-border) inset;
}

.model-dropdown {
  position: relative;
  width: 100%;
  flex: 1 1 auto;
  min-width: 0;
}

.model-dropdown-trigger {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  width: 100%;
  height: 48px;
  position: relative;
  border: 1px solid var(--ux-border);
  border-radius: 12px;
  background: var(--surface-panel, var(--ux-panel-bg));
  color: var(--ux-panel-text);
  font-family: var(--ux-font-family);
  font-size: var(--ux-input-size);
  font-weight: 500;
  line-height: 1.4;
  padding: 0 30px 0 14px;
  cursor: pointer;
  text-align: left;
  transition:
    border-color 0.15s,
    box-shadow 0.15s,
    background 0.15s;
}

.model-dropdown-trigger:hover {
  background: var(--ux-surface-hover);
}

.model-dropdown-trigger:disabled {
  cursor: default;
  background: var(--surface-panel, var(--ux-panel-bg));
}

.model-dropdown-trigger:disabled .model-dropdown-caret {
  opacity: 0.55;
}

.model-dropdown-trigger:focus-visible {
  outline: none;
  border-color: var(--ux-brand-bg);
  box-shadow: 0 0 0 3px var(--focus-ring);
}

.model-dropdown-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-dropdown-caret {
  position: absolute;
  right: 14px;
  top: 50%;
  width: 9px;
  height: 9px;
  border-right: 2px solid var(--ux-text-muted);
  border-bottom: 2px solid var(--ux-text-muted);
  transform: translateY(-62%) rotate(45deg);
  transition: transform 0.16s ease;
}

.model-dropdown-menu {
  display: block;
  position: absolute;
  z-index: 40;
  left: 0;
  right: 0;
  top: calc(100% + 8px);
  margin: 0;
  padding: 6px;
  list-style: none;
  border: 1px solid var(--ux-flyout-border);
  border-radius: 14px;
  background: var(--ux-flyout-bg);
  backdrop-filter: none;
  box-shadow: var(--ux-flyout-shadow);
  opacity: 0;
  transform: translateY(-4px);
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity 0.15s ease,
    transform 0.15s ease,
    visibility 0.15s ease;
}

.model-dropdown.is-open .model-dropdown-menu {
  opacity: 1;
  transform: translateY(0);
  visibility: visible;
  pointer-events: auto;
}

.model-dropdown-option {
  width: 100%;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--ux-panel-text);
  font-family: var(--ux-font-family);
  font-size: var(--ux-input-size);
  font-weight: 500;
  line-height: 40px;
  min-height: 40px;
  padding: 0 12px;
  text-align: left;
  cursor: pointer;
}

.model-dropdown-option:hover {
  background: var(--ux-surface-hover);
}

.model-dropdown-option.selected {
  background: transparent;
  font-weight: 700;
}

.model-dropdown-option.selected:hover {
  background: var(--ux-surface-hover);
}

.model-key-form :deep(.el-input__inner),
.model-key-form :deep(.el-select__selected-item),
.model-key-form :deep(.el-select__placeholder) {
  font-family: var(--ux-font-family);
  font-size: var(--ux-input-size);
  color: var(--ux-panel-text);
}

.model-key-form :deep(.el-input__inner::placeholder) {
  color: var(--ux-text-muted);
}

.error-msg {
  margin-top: -4px;
  color: var(--ux-danger);
  font-size: var(--ux-caption-size);
  font-weight: 600;
  line-height: 1.5;
}
</style>
