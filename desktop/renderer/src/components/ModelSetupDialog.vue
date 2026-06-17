<template>
  <div v-if="modelValue" class="model-setup-overlay">
    <div class="model-setup-panel" role="dialog" aria-modal="true">
      <button class="model-setup-close" type="button" :aria-label="t('common.close')" @click="close">
        <span></span>
        <span></span>
      </button>

      <template v-if="step === 'select'">
        <h2>{{ t("modelSetup.title") }}</h2>
        <p class="model-setup-desc">{{ t("modelSetup.selectDesc") }}</p>

        <div class="model-family-grid">
          <button
            v-for="family in modelFamilies"
            :key="family.id"
            type="button"
            class="model-family-card"
            :class="{ active: selectedFamilyId === family.id }"
            @click="selectedFamilyId = family.id"
          >
            <span class="family-icon" aria-hidden="true">
              <img :src="family.logo" :alt="family.label" />
            </span>
            <span class="family-name">{{ family.label }}</span>
          </button>
        </div>

        <button class="primary-action" type="button" @click="handleGetApiKey">
          {{ t("modelSetup.getApiKey") }}
        </button>
        <button class="text-action" type="button" @click="goToKeyForm">
          {{ t("modelSetup.haveApiKey") }}
        </button>
      </template>

      <template v-else>
        <h2>{{ t("modelSetup.title") }}</h2>
        <p class="model-setup-desc">{{ t("modelSetup.keyDesc") }}</p>

        <el-form label-position="top" class="model-key-form">
          <el-form-item :label="t('modelSetup.modelSelect')">
            <el-select v-model="selectedModelName" style="width: 100%">
              <el-option
                v-for="model in selectedFamily.models"
                :key="model"
                :label="model"
                :value="model"
              />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('modelSetup.apiKey')">
            <el-input
              v-model="apiKey"
              type="password"
              show-password
              :placeholder="selectedFamily.apiKeyPlaceholder"
              @keydown.enter.prevent="saveAndStart"
            />
          </el-form-item>
          <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>
        </el-form>

        <button
          class="primary-action primary-action--spaced"
          type="button"
          :disabled="saving"
          @click="saveAndStart"
        >
          {{ saving ? t("modelSetup.saving") : t("modelSetup.start") }}
        </button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { t } from "@/i18n";
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

const modelFamilies: ModelFamilyPreset[] = [
  {
    id: "qwen",
    label: "千问",
    providerKey: "qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
    apiFormat: "openai-chat",
    models: ["Qwen3.6-Plus"],
    apiKeyPlaceholder: "sk-...",
    logo: qwenLogo,
  },
  {
    id: "minimax",
    label: "MiniMax",
    providerKey: "minimax",
    baseUrl: "https://api.minimaxi.com/anthropic",
    apiFormat: "anthropic",
    models: ["MiniMax-M1"],
    apiKeyPlaceholder: "sk-cp-...",
    logo: minimaxLogo,
  },
];

const step = ref<"select" | "key">("select");
const selectedFamilyId = ref<ModelFamilyId>("qwen");
const selectedModelName = ref(modelFamilies[0].models[0]);
const apiKey = ref("");
const errorMsg = ref("");
const saving = ref(false);

const selectedFamily = computed(
  () => modelFamilies.find((family) => family.id === selectedFamilyId.value) ?? modelFamilies[0],
);

watch(selectedFamilyId, () => {
  selectedModelName.value = selectedFamily.value.models[0];
  errorMsg.value = "";
});

watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) return;
    step.value = "select";
    errorMsg.value = "";
  },
);

function resolveApiValue(apiFormat: ApiFormat): string {
  return apiFormat === "anthropic" ? "anthropic-messages" : "openai-completions";
}

function close() {
  emit("update:modelValue", false);
}

function handleGetApiKey() {
  // Reserved for the future BYOK/register-url flow.
}

function goToKeyForm() {
  selectedModelName.value = selectedFamily.value.models[0];
  step.value = "key";
  errorMsg.value = "";
}

async function saveAndStart() {
  const trimmedKey = apiKey.value.trim();
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
    const modelName = selectedModelName.value || family.models[0];
    const modelRef = `${family.providerKey}/${modelName}`;
    const existing = (await window.openclaw.config.read()) || {};
    const providerEntry: Record<string, unknown> = {
      baseUrl: family.baseUrl,
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
.model-setup-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: grid;
  place-items: center;
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(10px);
}

.model-setup-panel {
  width: min(470px, calc(100vw - 32px));
  min-height: 430px;
  position: relative;
  padding: 42px 34px 34px;
  border-radius: 16px;
  background: #fff;
  color: #1f2228;
  box-shadow: 0 24px 70px rgba(25, 25, 30, 0.18);
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
  cursor: pointer;
}

.model-setup-close span {
  position: absolute;
  top: 13px;
  left: 7px;
  width: 14px;
  height: 2px;
  background: #8d8f98;
  border-radius: 2px;
}

.model-setup-close span:first-child {
  transform: rotate(45deg);
}

.model-setup-close span:last-child {
  transform: rotate(-45deg);
}

.model-setup-close:hover {
  background: #f4f4f5;
}

h2 {
  margin: 0;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 0;
}

.model-setup-desc {
  margin: 12px 0 34px;
  color: #555967;
  font-size: 14px;
  line-height: 1.6;
}

.model-family-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 26px;
  margin-bottom: 28px;
}

.model-family-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 8px 6px 12px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: #1f2228;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s,
    transform 0.15s;
}

.model-family-card:hover,
.model-family-card.active {
  background: #fafafa;
  border-color: #ededf0;
}

.model-family-card:hover {
  transform: translateY(-1px);
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
  font-size: 18px;
  font-weight: 500;
  color: #6b6e78;
}

.primary-action {
  width: 100%;
  height: 48px;
  border: 0;
  border-radius: 8px;
  background: #211d1a;
  color: #fff;
  font-family: inherit;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}

.primary-action:hover:not(:disabled) {
  background: #302b27;
}

.primary-action:disabled {
  opacity: 0.72;
  cursor: wait;
}

.primary-action--spaced {
  margin-top: 16px;
}

.text-action {
  margin-top: 20px;
  border: 0;
  background: transparent;
  color: #6b6e78;
  font-family: inherit;
  font-size: 14px;
  cursor: pointer;
}

.text-action:hover {
  color: #1f2228;
}

.model-key-form {
  text-align: left;
}

.model-key-form :deep(.el-form-item__label) {
  color: #555967;
  font-weight: 600;
}

.model-key-form :deep(.el-input__wrapper),
.model-key-form :deep(.el-select__wrapper) {
  min-height: 48px;
  border-radius: 12px;
  box-shadow: 0 0 0 1px #dedfe5 inset;
}

.error-msg {
  margin-top: -4px;
  color: #d93025;
  font-size: 13px;
  line-height: 1.5;
}

html.dark .model-setup-overlay {
  background: rgba(18, 19, 20, 0.7);
}

html.dark .model-setup-panel {
  background: #1b1c20;
  color: #f5f5f5;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
}

html.dark .model-setup-desc,
html.dark .family-name,
html.dark .text-action {
  color: #a6a8b0;
}

html.dark .model-family-card:hover,
html.dark .model-family-card.active,
html.dark .model-setup-close:hover {
  background: #24262b;
  border-color: #30323a;
}
</style>
