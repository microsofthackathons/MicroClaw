<template>
  <div v-if="modelValue" class="model-setup-overlay">
    <div class="model-setup-panel" role="dialog" aria-modal="true">
      <button
        class="model-setup-close"
        type="button"
        :aria-label="t('common.close')"
        @click="close"
      >
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
            @click="selectFamily(family.id)"
          >
            <span class="family-icon" aria-hidden="true">
              <img v-if="family.logo" :src="family.logo" :alt="getFamilyLabel(family)" />
              <svg
                v-else
                class="custom-provider-icon"
                viewBox="0 0 64 64"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <rect
                  x="10"
                  y="10"
                  width="44"
                  height="44"
                  rx="14"
                  fill="currentColor"
                  opacity=".08"
                />
                <circle cx="24" cy="26" r="5" stroke="currentColor" stroke-width="3" />
                <circle cx="42" cy="22" r="4" stroke="currentColor" stroke-width="3" />
                <circle cx="39" cy="42" r="5" stroke="currentColor" stroke-width="3" />
                <path
                  d="M28.5 24.5 38 22.8M27.5 30 36 39M41.5 26 40 37"
                  stroke="currentColor"
                  stroke-width="3"
                  stroke-linecap="round"
                />
              </svg>
            </span>
            <span class="family-name">{{ getFamilyLabel(family) }}</span>
            <span
              v-if="selectedFamilyId === family.id"
              class="family-selected-badge"
              aria-hidden="true"
            >
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

        <button class="primary-action" type="button" @click.stop="handlePrimaryAction">
          {{ isCustomProvider ? t("modelSetup.configureCustom") : t("modelSetup.getApiKey") }}
        </button>
        <button
          v-if="!isCustomProvider"
          class="text-action"
          type="button"
          @click.stop="goToKeyForm"
        >
          {{ t("modelSetup.haveApiKey") }}
        </button>
      </template>

      <template v-else>
        <h2>{{ t("modelSetup.title") }}</h2>
        <p class="model-setup-desc">
          {{ t(isCustomProvider ? "modelSetup.customDesc" : "modelSetup.keyDesc") }}
        </p>

        <el-form label-position="top" class="model-key-form">
          <el-form-item v-if="isCustomProvider" :label="t('modelSetup.providerId')">
            <el-input
              v-model="providerKey"
              :placeholder="t('modelSetup.providerIdPlaceholder')"
              @keydown.enter.prevent="saveAndStart"
            />
            <div class="field-hint">{{ t("modelSetup.providerIdHint") }}</div>
          </el-form-item>
          <el-form-item v-if="isCustomProvider" :label="t('modelSetup.apiFormat')">
            <el-select v-model="selectedApiFormat" style="width: 100%">
              <el-option :label="t('modelSetup.apiFormatOpenAIChat')" value="openai-chat" />
              <el-option
                :label="t('modelSetup.apiFormatOpenAIResponses')"
                value="openai-responses"
              />
              <el-option :label="t('modelSetup.apiFormatAnthropic')" value="anthropic" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('modelSetup.modelSelect')">
            <el-input
              v-if="isCustomProvider"
              v-model="selectedModelName"
              :placeholder="t('modelSetup.modelPlaceholder')"
              @keydown.enter.prevent="saveAndStart"
            />
            <el-select
              v-else
              v-model="selectedModelName"
              style="width: 100%"
              filterable
              allow-create
              default-first-option
              :reserve-keyword="false"
              :placeholder="t('modelSetup.modelPlaceholder')"
              @change="handleModelChange"
            >
              <el-option-group
                v-for="family in presetModelFamilies"
                :key="family.id"
                :label="family.label"
              >
                <el-option
                  v-for="model in family.models"
                  :key="`${family.id}:${model}`"
                  :label="model"
                  :value="model"
                />
              </el-option-group>
            </el-select>
          </el-form-item>
          <el-form-item :label="t('modelSetup.baseUrl')">
            <el-input
              v-model="baseUrl"
              placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
              @keydown.enter.prevent="saveAndStart"
            />
          </el-form-item>
          <el-form-item
            :label="t(isCustomProvider ? 'modelSetup.apiKeyOptional' : 'modelSetup.apiKey')"
          >
            <el-input
              v-model="apiKey"
              type="password"
              show-password
              :placeholder="selectedFamily.apiKeyPlaceholder"
              @keydown.enter.prevent="saveAndStart"
            />
            <div v-if="isCustomProvider" class="field-hint">
              {{ t("modelSetup.credentialHint") }}
            </div>
          </el-form-item>
          <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>
        </el-form>

        <div class="key-actions">
          <button
            class="text-action text-action--back"
            type="button"
            @mousedown.prevent.stop="goToSelectStep"
          >
            {{ t("modelSetup.back") }}
          </button>
          <button
            class="primary-action"
            type="button"
            :disabled="saving"
            @mousedown.prevent.stop="saveAndStart"
          >
            {{ saving ? t("modelSetup.validating") : t("modelSetup.start") }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { t } from "@/i18n";
import qwenLogo from "@/assets/modelprovider/Qwen.png";
import minimaxLogo from "@/assets/modelprovider/minimax.png";
import {
  mergeModelProviderConfig,
  validateModelProviderInput,
  type ModelApiFormat,
  type ModelProviderInput,
  type ModelProviderValidationError,
} from "@/utils/model-provider";

type ModelFamilyId = "qwen" | "minimax" | "custom";

interface ModelFamilyPreset {
  id: ModelFamilyId;
  label?: string;
  labelKey?: string;
  providerKey: string;
  baseUrl: string;
  apiFormat: ModelApiFormat;
  models: string[];
  defaultModel: string;
  apiKeyPlaceholder: string;
  logo?: string;
}

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  configured: [];
}>();

const ALIYUN_OPENAI_COMPATIBLE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const MINIMAX_OPENAI_COMPATIBLE_BASE_URL = "https://api.minimaxi.com/v1";
const MINIMAX_SIGNUP_URL_CODES = [
  104, 116, 116, 112, 115, 58, 47, 47, 112, 108, 97, 116, 102, 111, 114, 109, 46, 109, 105, 110,
  105, 109, 97, 120, 105, 46, 99, 111, 109, 47, 98, 121, 111, 107, 45, 116, 114, 105, 97, 108, 63,
  115, 111, 117, 114, 99, 101, 61, 109, 105, 99, 114, 111, 99, 108, 97, 119,
];

const modelFamilies: ModelFamilyPreset[] = [
  {
    id: "qwen",
    label: "千问",
    providerKey: "qwen",
    baseUrl: ALIYUN_OPENAI_COMPATIBLE_BASE_URL,
    apiFormat: "openai-chat",
    models: ["qwen", "qwen3.7-plus", "qwen3.6-plus", "qwen3-32b", "qwen3.6-flash", "qwen3.5-plus"],
    defaultModel: "qwen3.7-plus",
    apiKeyPlaceholder: "sk-...",
    logo: qwenLogo,
  },
  {
    id: "minimax",
    label: "MiniMax",
    providerKey: "minimax",
    baseUrl: MINIMAX_OPENAI_COMPATIBLE_BASE_URL,
    apiFormat: "openai-chat",
    models: ["MiniMax-M3", "MiniMax-M1"],
    defaultModel: "MiniMax-M3",
    apiKeyPlaceholder: "sk-...",
    logo: minimaxLogo,
  },
  {
    id: "custom",
    labelKey: "modelSetup.otherModel",
    providerKey: "custom",
    baseUrl: "",
    apiFormat: "openai-chat",
    models: [],
    defaultModel: "",
    apiKeyPlaceholder: "sk-... or ${MODEL_API_KEY}",
  },
];

const presetModelFamilies = modelFamilies.filter((family) => family.id !== "custom");

function getDefaultModel(family: ModelFamilyPreset): string {
  return family.defaultModel;
}

function getFamilyById(familyId: ModelFamilyId): ModelFamilyPreset {
  return modelFamilies.find((family) => family.id === familyId) ?? modelFamilies[0];
}

function getFamilyByModel(modelName: string): ModelFamilyPreset | undefined {
  return modelFamilies.find((family) => family.models.includes(modelName));
}

const isKeyStep = ref(false);
const selectedFamilyId = ref<ModelFamilyId>("qwen");
const selectedModelName = ref(getDefaultModel(modelFamilies[0]));
const baseUrl = ref(modelFamilies[0].baseUrl);
const providerKey = ref(modelFamilies[0].providerKey);
const selectedApiFormat = ref<ModelApiFormat>(modelFamilies[0].apiFormat);
const apiKey = ref("");
const errorMsg = ref("");
const saving = ref(false);
let submissionGeneration = 0;

const selectedFamily = computed(() => getFamilyById(selectedFamilyId.value));
const isCustomProvider = computed(() => selectedFamilyId.value === "custom");

watch(
  () => props.modelValue,
  (visible) => {
    cancelPendingSubmission();
    if (!visible) return;
    selectFamily("qwen");
    isKeyStep.value = false;
    apiKey.value = "";
    errorMsg.value = "";
  },
);

function getFamilyLabel(family: ModelFamilyPreset): string {
  return family.labelKey ? t(family.labelKey) : (family.label ?? family.id);
}

function decodeAsciiCodes(codes: number[]): string {
  return String.fromCharCode(...codes);
}

async function reloadGatewayAfterModelSetup() {
  await window.openclaw.gateway.restart();
}

function cancelPendingSubmission() {
  submissionGeneration += 1;
  saving.value = false;
}

function close() {
  cancelPendingSubmission();
  emit("update:modelValue", false);
}

function selectFamily(familyId: ModelFamilyId) {
  const family = getFamilyById(familyId);
  selectedFamilyId.value = family.id;
  selectedModelName.value = getDefaultModel(family);
  baseUrl.value = family.baseUrl;
  providerKey.value = family.providerKey;
  selectedApiFormat.value = family.apiFormat;
  errorMsg.value = "";
}

function handleModelChange(modelName: string) {
  const family = getFamilyByModel(modelName);
  if (!family || family.id === selectedFamilyId.value) return;

  selectedFamilyId.value = family.id;
  baseUrl.value = family.baseUrl;
  providerKey.value = family.providerKey;
  selectedApiFormat.value = family.apiFormat;
  errorMsg.value = "";
}

function goToKeyForm() {
  selectedModelName.value = getDefaultModel(selectedFamily.value);
  baseUrl.value = selectedFamily.value.baseUrl;
  providerKey.value = selectedFamily.value.providerKey;
  selectedApiFormat.value = selectedFamily.value.apiFormat;
  isKeyStep.value = true;
  errorMsg.value = "";
}

function handlePrimaryAction() {
  if (isCustomProvider.value) {
    goToKeyForm();
    return;
  }
  handleGetApiKey();
}

function handleGetApiKey() {
  const signupUrl =
    selectedFamily.value.id === "qwen"
      ? "https://click.qianwenai.com/m/20000000741/"
      : decodeAsciiCodes(MINIMAX_SIGNUP_URL_CODES);
  try {
    window.openclaw?.shell?.openExternal?.(signupUrl);
  } catch {
    window.open(signupUrl, "_blank", "noopener,noreferrer");
  }
  goToKeyForm();
}

function goToSelectStep() {
  cancelPendingSubmission();
  isKeyStep.value = false;
  errorMsg.value = "";
}

function validationMessage(error: ModelProviderValidationError): string {
  const keys: Record<ModelProviderValidationError, string> = {
    providerKeyRequired: "modelSetup.enterProviderId",
    invalidProviderKey: "modelSetup.invalidProviderId",
    modelNameRequired: "modelSetup.enterModelName",
    baseUrlRequired: "modelSetup.enterBaseUrl",
    invalidBaseUrl: "modelSetup.invalidBaseUrl",
    apiKeyRequired: "modelSetup.enterApiKey",
    invalidCredentialReference: "modelSetup.invalidCredentialReference",
  };
  return t(keys[error]);
}

async function saveAndStart() {
  if (saving.value) return;

  const input: ModelProviderInput = {
    providerKey: providerKey.value,
    baseUrl: baseUrl.value,
    apiKey: apiKey.value,
    apiFormat: selectedApiFormat.value,
    modelName: selectedModelName.value,
    input: isCustomProvider.value ? ["text"] : ["text", "image"],
  };
  const validationError = validateModelProviderInput(input, {
    requireApiKey: !isCustomProvider.value,
  });
  if (validationError) {
    errorMsg.value = validationMessage(validationError);
    return;
  }

  const generation = ++submissionGeneration;
  saving.value = true;
  errorMsg.value = "";
  try {
    const connection = await window.openclaw.model.testConnection({
      baseUrl: input.baseUrl.trim(),
      apiKey: input.apiKey.trim(),
      apiFormat: input.apiFormat,
      modelName: input.modelName.trim(),
    });
    if (generation !== submissionGeneration || !props.modelValue) return;
    if (!connection.ok) {
      errorMsg.value = t("modelSetup.connectionFailed", { error: connection.message });
      return;
    }

    const verifiedInput = {
      ...input,
      baseUrl: connection.baseUrl ?? input.baseUrl,
    };
    const existing = (await window.openclaw.config.read()) || {};
    if (generation !== submissionGeneration || !props.modelValue) return;
    await window.openclaw.config.write(mergeModelProviderConfig(existing, verifiedInput));
    await reloadGatewayAfterModelSetup();
    if (generation !== submissionGeneration || !props.modelValue) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (generation !== submissionGeneration || !props.modelValue) return;
    emit("update:modelValue", false);
    emit("configured");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    errorMsg.value = t("modelSetup.saveFailed", { error: message });
  } finally {
    if (generation === submissionGeneration) {
      saving.value = false;
    }
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
.field-hint,
.error-msg {
  --ux-overlay: rgba(255, 255, 255, 0.72);
  --ux-panel-bg: #fff;
  --ux-panel-text: #1f2228;
  --ux-text-secondary: var(--smtc-foreground-ctrl-neutral-secondary-rest, #555967);
  --ux-text-muted: var(--smtc-foreground-ctrl-hint-default, #6b6e78);
  --ux-border: var(--smtc-stroke-divider-subtle, #ededf0);
  --ux-surface-hover: var(--smtc-background-ctrl-subtle-hover, #f4f4f5);
  --ux-card-active: var(--smtc-background-card-on-primary-default-rest, #fafafa);
  --ux-card-selected-border: var(--ux-brand-bg);
  --ux-card-selected-bg: var(--ux-card-active);
  --ux-card-check-bg: var(--ux-brand-bg);
  --ux-card-check-fg: var(--ux-brand-fg);
  --ux-brand-bg: #18181b;
  --ux-brand-bg-hover: #27272a;
  --ux-brand-bg-active: #09090b;
  --ux-brand-fg: #fff;
  --ux-panel-radius: 20px;
  --ux-cta-radius: 999px;
  --ux-danger: var(--smtc-status-danger-foreground);
  --ux-shadow: 0 24px 70px rgba(25, 25, 30, 0.18);
  --ux-flyout-border: #e7e8ec;
  --ux-flyout-bg: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.94) 0%,
    rgba(250, 250, 252, 0.9) 100%
  );
  --ux-flyout-shadow: 0 24px 44px rgba(21, 24, 31, 0.16), 0 8px 18px rgba(21, 24, 31, 0.1);
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
  width: min(560px, calc(100vw - 32px));
  min-height: 430px;
  max-height: calc(100vh - 32px);
  position: relative;
  padding: 42px 34px 34px;
  border-radius: var(--ux-panel-radius);
  background: var(--ux-panel-bg);
  color: var(--ux-panel-text);
  font-family: var(--ux-font-family);
  box-shadow: var(--ux-shadow);
  text-align: center;
  overflow-y: auto;
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
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

.custom-provider-icon {
  width: 76px;
  height: 76px;
  color: var(--ux-panel-text);
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
  height: 52px;
  border: 0;
  border-radius: var(--ux-cta-radius);
  background: var(--ux-brand-bg);
  color: var(--ux-brand-fg);
  font-family: var(--ux-font-family);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.2px;
  cursor: pointer;
  transition:
    background 0.18s ease,
    transform 0.12s ease,
    box-shadow 0.18s ease;
  box-shadow: 0 10px 26px rgba(24, 24, 27, 0.18);
}

.primary-action:hover:not(:disabled) {
  background: var(--ux-brand-bg-hover);
  transform: translateY(-1px);
  box-shadow: 0 14px 30px rgba(24, 24, 27, 0.22);
}

.primary-action:active:not(:disabled) {
  background: var(--ux-brand-bg-active);
  transform: translateY(0);
  box-shadow: 0 6px 14px rgba(24, 24, 27, 0.2);
}

.primary-action:disabled {
  opacity: 0.72;
  cursor: wait;
}

.primary-action--spaced {
  margin-top: 16px;
}

.text-action {
  margin-top: 14px;
  border: 1px solid var(--ux-border);
  border-radius: var(--ux-cta-radius);
  box-sizing: border-box;
  background: #fff;
  color: var(--ux-text-muted);
  font-family: var(--ux-font-family);
  font-size: 14px;
  font-weight: 600;
  height: 52px;
  width: 100%;
  cursor: pointer;
  transition:
    color 0.15s,
    background 0.15s,
    border-color 0.15s;
}

.text-action:hover {
  color: var(--ux-panel-text);
  background: var(--ux-surface-hover);
  border-color: var(--ux-border);
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
  height: 46px;
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

.field-hint {
  width: 100%;
  margin-top: 6px;
  color: var(--ux-text-muted);
  font-size: 12px;
  font-weight: 500;
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
  background: #fff;
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
  background: #fcfcfd;
}

.model-dropdown-trigger:disabled {
  cursor: default;
  background: #fff;
}

.model-dropdown-trigger:disabled .model-dropdown-caret {
  opacity: 0.55;
}

.model-dropdown-trigger:focus-visible {
  outline: none;
  border-color: #c9cbd3;
  box-shadow: 0 0 0 3px rgba(120, 126, 146, 0.12);
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
  border-right: 2px solid #989ba7;
  border-bottom: 2px solid #989ba7;
  transform: translateY(-62%) rotate(45deg);
  transition: transform 0.16s ease;
}

.model-dropdown-menu {
  display: none;
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
  backdrop-filter: blur(14px) saturate(1.08);
  box-shadow: var(--ux-flyout-shadow);
}

.model-dropdown:focus-within .model-dropdown-menu {
  display: block;
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
  background: transparent;
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
