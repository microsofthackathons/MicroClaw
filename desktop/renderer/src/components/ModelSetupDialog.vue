<template>
  <div v-if="modelValue" class="model-setup-overlay" :class="{ 'model-setup-inline': inline }">
    <LocalModelSetupDialog
      v-if="localVisible"
      :streaming="streaming"
      :target-model-ref="localTarget"
      :default-agent-override="defaultAgentOverride"
      @close="close"
      @configured="handleLocalConfigured"
    />
    <div
      v-else
      class="model-setup-panel"
      :role="inline ? 'region' : 'dialog'"
      :aria-modal="inline ? undefined : true"
      :aria-label="inline ? getFamilyLabel(selectedFamily) : undefined"
    >
      <button
        v-if="!inline"
        class="model-setup-close"
        type="button"
        :disabled="configMutationInProgress"
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
      <p v-if="defaultAgentOverride" role="status" data-testid="default-agent-override">
        {{
          t("localModel.defaultAgentOverride", {
            agent: defaultAgentOverride.agentId,
            model: defaultAgentOverride.modelRef,
          })
        }}
      </p>

      <template v-if="!isKeyStep">
        <h2>{{ inline ? getFamilyLabel(selectedFamily) : t("modelSetup.title") }}</h2>
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
          {{
            isLocalProvider
              ? t("localModel.configure")
              : isGitHubCopilot
                ? t("modelSetup.copilotSignIn")
                : t("modelSetup.getApiKey")
          }}
        </button>
        <button
          v-if="!isGitHubCopilot && !isLocalProvider"
          class="text-action"
          type="button"
          @click.stop="goToKeyForm()"
        >
          {{ t("modelSetup.haveApiKey") }}
        </button>
      </template>

      <template v-else>
        <template v-if="!inline">
          <h2>{{ t("modelSetup.title") }}</h2>
          <p class="model-setup-desc">
            {{
              manageOnly
                ? t("modelManager.saveOnlyHint")
                : t(
                    isGitHubCopilot
                      ? "modelSetup.copilotDesc"
                      : isCustomProvider
                        ? "modelSetup.customDesc"
                        : "modelSetup.keyDesc",
                  )
            }}
          </p>
        </template>

        <el-form label-position="top" class="model-key-form">
          <template v-if="isGitHubCopilot">
            <div class="copilot-auth-panel">
              <template v-if="githubAuthState === 'code'">
                <span class="copilot-auth-label">{{ t("modelSetup.copilotEnterCode") }}</span>
                <strong class="copilot-device-code">{{ githubUserCode }}</strong>
                <span class="copilot-auth-hint">
                  {{
                    t("modelSetup.copilotCodeExpires", {
                      minutes: githubCodeExpiryMinutes,
                    })
                  }}
                </span>
                <button
                  class="text-action copilot-open-action"
                  type="button"
                  @click.stop="openGitHubVerificationPage"
                >
                  {{ t("modelSetup.copilotOpenGitHub") }}
                </button>
              </template>
              <p v-if="streaming || localBlocked" role="status">
                {{ t(streaming ? "localModel.streaming" : "localModel.switchBeforeSave") }}
              </p>
              <template
                v-else-if="githubAuthState === 'checking' || githubAuthState === 'signing-in'"
              >
                <span class="copilot-auth-label">
                  {{
                    t(
                      githubAuthState === "checking"
                        ? "modelSetup.copilotChecking"
                        : "modelSetup.copilotStarting",
                    )
                  }}
                </span>
                <span class="copilot-auth-hint">{{ t("modelSetup.copilotTokenPrivacy") }}</span>
              </template>
              <template v-else-if="githubAuthState === 'authenticated'">
                <span class="copilot-auth-success">{{ t("modelSetup.copilotConnected") }}</span>
                <button
                  class="text-action copilot-open-action"
                  type="button"
                  @click.stop="startGitHubCopilotLogin"
                >
                  {{ t("modelSetup.copilotUseAnotherAccount") }}
                </button>
              </template>
              <template v-else>
                <span class="copilot-auth-label">{{ t("modelSetup.copilotSignInHint") }}</span>
                <span class="copilot-auth-hint">{{ t("modelSetup.copilotTokenPrivacy") }}</span>
              </template>
            </div>

            <el-form-item
              v-if="githubAuthState === 'authenticated' && !manageOnly"
              :label="t('modelSetup.modelSelect')"
            >
              <el-select
                v-model="selectedGitHubModel"
                style="width: 100%"
                filterable
                :placeholder="t('modelSetup.copilotModelPlaceholder')"
              >
                <el-option
                  v-for="model in githubModels"
                  :key="model.id"
                  :label="model.name"
                  :value="model.id"
                />
              </el-select>
            </el-form-item>
          </template>

          <template v-else>
            <el-form-item v-if="isCustomProvider" :label="t('modelSetup.providerId')">
              <el-input
                v-model="providerKey"
                :disabled="Boolean(inline && currentProvider)"
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
            <el-form-item v-if="isCustomProvider" :label="t('modelSetup.modelSelect')">
              <el-input
                v-model="selectedModelName"
                :placeholder="t('modelSetup.modelPlaceholder')"
                @keydown.enter.prevent="saveAndStart"
              />
            </el-form-item>
            <el-form-item :label="t('modelSetup.baseUrl')" data-testid="provider-base-field">
              <el-input
                v-model="baseUrl"
                :disabled="!isCustomProvider"
                placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                @keydown.enter.prevent="saveAndStart"
              />
            </el-form-item>
            <el-form-item
              :label="t(isCustomProvider ? 'modelSetup.apiKeyOptional' : 'modelSetup.apiKey')"
              data-testid="provider-key-field"
            >
              <div class="model-field-row">
                <el-input
                  v-model="apiKey"
                  class="model-field-input"
                  :disabled="saving"
                  type="password"
                  show-password
                  :placeholder="selectedFamily.apiKeyPlaceholder"
                  @keydown.enter.prevent="saveAndStart"
                />
                <button
                  v-if="selectedManagedProvider"
                  class="model-field-action provider-api-key-link"
                  type="button"
                  :disabled="configMutationInProgress"
                  @click.stop="openProviderSignup"
                >
                  {{ t("modelSetup.getApiKey") }}
                </button>
              </div>
              <div v-if="isCustomProvider" class="field-hint">
                {{ t("modelSetup.credentialHint") }}
              </div>
            </el-form-item>
            <el-form-item
              v-if="selectedManagedProvider"
              :label="t('modelSetup.modelSelect')"
              data-testid="provider-model-field"
            >
              <div class="model-field-row">
                <el-select
                  class="model-field-input"
                  :model-value="catalogReady ? selectedModelName : ''"
                  :disabled="!catalogReady || saving"
                  :loading="catalogLoading"
                  filterable
                  :filter-method="filterCatalogModels"
                  :placeholder="t('modelSetup.modelPlaceholder')"
                  @update:model-value="selectedModelName = $event"
                  @visible-change="resetCatalogPicker"
                >
                  <el-option
                    v-for="model in visibleCatalogModels"
                    :key="model"
                    :label="catalogModelLabel(model)"
                    :title="catalogModelLabel(model)"
                    :value="model"
                    :disabled="Boolean(catalogModelRestriction(model))"
                  >
                    <span class="catalog-option-name">{{ catalogModelLabel(model) }}</span>
                    <span
                      v-if="isRecommendedProviderModel(providerKey, model)"
                      class="catalog-recommended"
                    >
                      {{ t("modelManager.recommended") }}
                    </span>
                  </el-option>
                  <template
                    v-if="
                      !visibleCatalogModels.length && catalogSections.more.length && !catalogQuery
                    "
                    #empty
                  >
                    <p class="catalog-empty-hint">{{ t("modelManager.noFeaturedModels") }}</p>
                  </template>
                  <template v-if="!catalogQuery && catalogSections.more.length" #footer>
                    <button
                      class="catalog-more-toggle"
                      type="button"
                      data-testid="more-provider-models"
                      :aria-expanded="catalogMoreExpanded"
                      @mousedown.prevent
                      @click.stop="catalogMoreExpanded = !catalogMoreExpanded"
                    >
                      {{
                        t(
                          catalogMoreExpanded
                            ? "modelManager.fewerModels"
                            : "modelManager.moreModels",
                          { count: catalogSections.more.length },
                        )
                      }}
                      <span aria-hidden="true">{{ catalogMoreExpanded ? "−" : "+" }}</span>
                    </button>
                  </template>
                </el-select>
                <button
                  class="model-field-action model-refresh-action"
                  type="button"
                  data-testid="refresh-provider-models"
                  :aria-label="t('modelSetup.catalogRefresh')"
                  :title="t('modelSetup.catalogRefresh')"
                  :aria-busy="catalogLoading"
                  :disabled="!apiKey.trim() || catalogLoading || saving"
                  @click="loadProviderModels"
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                    :class="{ 'refresh-spinning': catalogLoading }"
                  >
                    <path d="M20 7v5h-5M4 17v-5h5" />
                    <path d="M6.1 7A7 7 0 0 1 18 5l2 2M4 17l2 2a7 7 0 0 0 11.9-2" />
                  </svg>
                </button>
              </div>
              <p class="field-hint" role="status">
                {{
                  t(
                    catalogLoading
                      ? "modelSetup.catalogLoading"
                      : catalogReady
                        ? "modelSetup.catalogLoaded"
                        : "modelSetup.catalogNeedsKey",
                  )
                }}
              </p>
              <p v-if="catalogError" class="error-msg" role="alert">{{ catalogError }}</p>
              <p v-if="selectedModelRestriction" class="error-msg" role="alert">
                {{ t(`modelSetup.incompatible.${selectedModelRestriction}`) }}
              </p>
            </el-form-item>
          </template>
          <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>
        </el-form>

        <div class="key-actions">
          <button
            v-if="!inline"
            class="text-action text-action--back"
            type="button"
            :disabled="configMutationInProgress"
            @click.prevent.stop="goToSelectStep"
          >
            {{ t("modelSetup.back") }}
          </button>
          <button
            v-if="isGitHubCopilot && githubLoginInProgress"
            class="text-action"
            type="button"
            @mousedown.prevent.stop="cancelGitHubCopilotLogin"
          >
            {{ t("modelSetup.copilotCancel") }}
          </button>
          <button
            class="primary-action"
            type="button"
            :disabled="formPrimaryDisabled"
            @click.prevent.stop="handleFormPrimaryAction"
            @keydown.enter.prevent.stop="handleFormPrimaryAction"
            @keydown.space.prevent.stop="handleFormPrimaryAction"
          >
            {{ formPrimaryLabel }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useProviderModelCatalog } from "@/composables/use-provider-model-catalog";
import { getChatModelRestriction } from "../../../src/provider-model-capabilities";
import {
  getProviderCatalogOptions,
  getProviderModelSections,
  isRecommendedProviderModel,
} from "@/utils/provider-model-options";
import { computed, onUnmounted, ref, watch } from "vue";
import { t } from "@/i18n";
import {
  mergeModelProviderConfig,
  matchesProviderConnection,
  getDefaultAgentModelOverride,
  selectPrimaryModelConfig,
  validateModelProviderInput,
  type ModelApiFormat,
  type ModelProviderInput,
  type ModelProviderValidationError,
  type ModelInputCapability,
  type ModelReasoningEffort,
} from "@/utils/model-provider";
import {
  MANAGED_MODEL_PROVIDERS,
  getManagedModelProvider,
  type ManagedModelProviderId,
  type ManagedModelPreset,
} from "@/utils/managed-model-providers";
import { useGitHubCopilotAuth } from "@/composables/use-github-copilot-auth";
import { isModelProviderEnabled } from "@/utils/model-features";
import githubCopilotBlack from "@/assets/github-copilot-black.svg";
import LocalModelSetupDialog from "./LocalModelSetupDialog.vue";
import { useLocalModelOperation } from "@/composables/use-local-model-operation";
import { confirmLocalModelSwitch, releaseLocalModelSetup } from "@/utils/local-model-transition";

type ModelFamilyId = ManagedModelProviderId | "github-copilot" | "custom" | "local";

interface ModelFamilyPreset {
  id: ModelFamilyId;
  label?: string;
  labelKey?: string;
  providerKey: string;
  baseUrl: string;
  apiFormat: ModelApiFormat;
  models: ManagedModelPreset[];
  defaultModel: string;
  apiKeyPlaceholder: string;
  logo?: string;
  signupUrl?: string;
}

// The provider that is currently configured, so the wizard can reopen pre-filled for quick
// adjustment. Null when nothing is configured yet.
interface ModelProviderPrefill {
  familyId: string;
  providerKey: string;
  modelName: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: ModelApiFormat;
  displayName?: string;
  reasoningEffort?: ModelReasoningEffort;
  input?: ModelInputCapability[];
}

const props = defineProps<{
  modelValue: boolean;
  singleProvider?: boolean;
  currentProvider?: ModelProviderPrefill | null;
  initialFamily?: ModelFamilyId;
  streaming?: boolean;
  inline?: boolean;
  manageOnly?: boolean;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  configured: [];
  busy: [value: boolean];
}>();

const allModelFamilies: ModelFamilyPreset[] = [
  ...MANAGED_MODEL_PROVIDERS.map((provider) => ({
    ...provider,
    providerKey: provider.id,
  })),
  {
    id: "github-copilot",
    labelKey: "modelSetup.githubCopilot",
    providerKey: "",
    baseUrl: "",
    apiFormat: "openai-chat",
    models: [],
    defaultModel: "",
    apiKeyPlaceholder: "sk-...",
    logo: githubCopilotBlack,
  },
  {
    id: "local",
    labelKey: "localModel.title",
    providerKey: "llama-cpp",
    baseUrl: "",
    apiFormat: "openai-chat",
    models: [],
    defaultModel: "",
    apiKeyPlaceholder: "",
  },
];
const modelFamilies = allModelFamilies.filter((family) => isModelProviderEnabled(family.id));

const customModelFamily: ModelFamilyPreset = {
  id: "custom",
  labelKey: "modelSetup.customProvider",
  providerKey: "custom",
  baseUrl: "",
  apiFormat: "openai-chat",
  models: [],
  defaultModel: "",
  apiKeyPlaceholder: "sk-... or ${MODEL_API_KEY}",
};

function getDefaultModel(family: ModelFamilyPreset): string {
  return family.defaultModel;
}

function getFamilyById(familyId: ModelFamilyId): ModelFamilyPreset {
  if (familyId === "custom") return customModelFamily;
  return modelFamilies.find((family) => family.id === familyId) ?? modelFamilies[0];
}

const isKeyStep = ref(false);
const selectedFamilyId = ref<ModelFamilyId>("qwen");
const selectedModelName = ref("");
const baseUrl = ref(modelFamilies[0].baseUrl);
const providerKey = ref(modelFamilies[0].providerKey);
const selectedApiFormat = ref<ModelApiFormat>(modelFamilies[0].apiFormat);
const apiKey = ref("");
const errorMsg = ref("");
const saving = ref(false);
watch(saving, (value) => emit("busy", value), { flush: "sync" });
onUnmounted(() => {
  catalogGeneration++;
  clearTimeout(catalogTimer);
  cancelPendingSubmission();
  emit("busy", false);
});
const configMutationInProgress = ref(false);
const localVisible = ref(false);
const localTarget = ref<string>();
const defaultAgentOverride = ref<ReturnType<typeof getDefaultAgentModelOverride>>(null);
const { blocked: localBlocked, refresh: refreshLocalOperation } = useLocalModelOperation();
let submissionGeneration = 0;

const selectedFamily = computed(() => getFamilyById(selectedFamilyId.value));
const selectedManagedProvider = computed(() => getManagedModelProvider(selectedFamilyId.value));
const catalogModels = ref<string[]>([]);
const catalogQuery = ref("");
const catalogMoreExpanded = ref(false);
const catalogSections = computed(() =>
  getProviderModelSections(
    providerKey.value,
    catalogModels.value.map((id) => ({ id })),
    selectedModelName.value,
  ),
);
const visibleCatalogModels = computed(() => {
  if (catalogQuery.value)
    return catalogModels.value.filter((id) =>
      catalogModelLabel(id).toLocaleLowerCase().includes(catalogQuery.value),
    );
  return [
    ...catalogSections.value.primary,
    ...(catalogMoreExpanded.value ? catalogSections.value.more : []),
  ].map(({ id }) => id);
});
const catalogReady = ref(false);
const catalogLoading = ref(false);
const catalogError = ref("");
const providerCatalog = useProviderModelCatalog();
const selectedModelRestriction = computed(() => catalogModelRestriction(selectedModelName.value));
function catalogModelRestriction(model: string) {
  return getChatModelRestriction(`${providerKey.value}/${model}`);
}
function catalogModelLabel(model: string): string {
  const restriction = catalogModelRestriction(model);
  return restriction ? `${model} — ${t(`modelSetup.incompatible.${restriction}`)}` : model;
}
function filterCatalogModels(query: string): void {
  catalogQuery.value = query.trim().toLocaleLowerCase();
}
function resetCatalogPicker(): void {
  catalogQuery.value = "";
  catalogMoreExpanded.value = false;
}
let catalogGeneration = 0;
let catalogTimer: ReturnType<typeof setTimeout> | undefined;

async function loadProviderModels() {
  if (!props.modelValue || !selectedManagedProvider.value || !apiKey.value.trim() || saving.value)
    return;
  clearTimeout(catalogTimer);
  const generation = ++catalogGeneration;
  catalogModels.value = [];
  catalogReady.value = false;
  catalogLoading.value = true;
  catalogError.value = "";
  try {
    const result = await providerCatalog.load({
      baseUrl: baseUrl.value,
      apiKey: apiKey.value,
    });
    if (generation !== catalogGeneration) return;
    if (!result.ok) {
      catalogError.value = t(`modelSetup.catalogError.${result.error}`);
      return;
    }
    catalogModels.value = getProviderCatalogOptions(providerKey.value, result.models);
    catalogReady.value = true;
    if (!catalogModels.value.includes(selectedModelName.value)) selectedModelName.value = "";
  } catch {
    if (generation === catalogGeneration) catalogError.value = t("modelSetup.catalogError.network");
  } finally {
    if (generation === catalogGeneration) catalogLoading.value = false;
  }
}
const isCustomProvider = computed(() => selectedFamilyId.value === "custom");
const isGitHubCopilot = computed(() => selectedFamilyId.value === "github-copilot");
const isLocalProvider = computed(() => selectedFamilyId.value === "local");
const {
  state: githubAuthState,
  models: githubModels,
  selectedModel: selectedGitHubModel,
  userCode: githubUserCode,
  loginInProgress: githubLoginInProgress,
  codeExpiryMinutes: githubCodeExpiryMinutes,
  loadStatus: loadGitHubCopilotStatus,
  startLogin: startGitHubCopilotLogin,
  cancelLogin: cancelGitHubCopilotLogin,
  reset: resetGitHubCopilotState,
  openVerificationPage: openGitHubVerificationPage,
} = useGitHubCopilotAuth({
  isActive: () => props.modelValue && isKeyStep.value && isGitHubCopilot.value,
  clearError: () => {
    errorMsg.value = "";
  },
  setError: (message) => {
    errorMsg.value = message;
  },
});
const formPrimaryDisabled = computed(
  () =>
    saving.value ||
    props.streaming ||
    Boolean(selectedModelRestriction.value) ||
    (Boolean(selectedManagedProvider.value) &&
      (!catalogReady.value || !catalogModels.value.includes(selectedModelName.value))) ||
    (isGitHubCopilot.value &&
      (githubAuthState.value === "checking" ||
        githubAuthState.value === "signing-in" ||
        githubAuthState.value === "code" ||
        (githubAuthState.value === "authenticated" &&
          !props.manageOnly &&
          !selectedGitHubModel.value))),
);
const formPrimaryLabel = computed(() => {
  if (props.manageOnly && (!isGitHubCopilot.value || githubAuthState.value === "authenticated"))
    return t(saving.value ? "modelManager.saving" : "settings.save");
  if (isGitHubCopilot.value) {
    if (saving.value) return t("modelSetup.starting");
    if (githubAuthState.value === "authenticated") return t("modelSetup.copilotUseModel");
    if (
      githubAuthState.value === "checking" ||
      githubAuthState.value === "signing-in" ||
      githubAuthState.value === "code"
    ) {
      return t("modelSetup.copilotWaiting");
    }
    return t("modelSetup.copilotSignIn");
  }
  return saving.value ? t("modelSetup.validating") : t("modelSetup.start");
});

watch(
  () => props.modelValue,
  (visible) => {
    cancelPendingSubmission();
    void resetGitHubCopilotState();
    if (!visible) return;
    localVisible.value = false;
    localTarget.value = undefined;
    defaultAgentOverride.value = null;
    const generation = submissionGeneration;
    void window.openclaw.config
      .read()
      .then((config) => {
        if (props.modelValue && generation === submissionGeneration) {
          defaultAgentOverride.value = getDefaultAgentModelOverride(config);
        }
      })
      .catch(() => {});
    void refreshLocalOperation();
    const prefill = props.currentProvider;
    if (prefill?.providerKey === "llama-cpp" || props.initialFamily === "local") {
      selectFamily("local");
      if (prefill) localTarget.value = `llama-cpp/${prefill.modelName}`;
      localVisible.value = true;
      return;
    }
    if (
      prefill &&
      isModelProviderEnabled(prefill.familyId) &&
      isModelProviderEnabled(prefill.providerKey)
    ) {
      // Reopen on the configured provider, pre-filled and jumped to the key form so the user
      // can adjust the model, base URL or key without re-selecting the family.
      selectFamily(prefill.familyId as ModelFamilyId);
      providerKey.value = prefill.providerKey;
      selectedModelName.value = prefill.modelName || getDefaultModel(selectedFamily.value);
      baseUrl.value = prefill.baseUrl || selectedFamily.value.baseUrl;
      selectedApiFormat.value = prefill.apiFormat;
      apiKey.value = prefill.apiKey;
      isKeyStep.value = props.inline || selectedFamilyId.value !== "github-copilot";
      if (isGitHubCopilot.value) void loadGitHubCopilotStatus();
      errorMsg.value = "";
      return;
    }
    if (props.initialFamily && isModelProviderEnabled(props.initialFamily)) {
      selectFamily(props.initialFamily);
      isKeyStep.value = true;
      apiKey.value = "";
      errorMsg.value = "";
      if (isGitHubCopilot.value) void loadGitHubCopilotStatus();
      return;
    }
    selectFamily("qwen");
    isKeyStep.value = false;
    apiKey.value = "";
    errorMsg.value = "";
  },
  { immediate: true },
);

watch(
  [() => props.modelValue, isKeyStep, selectedFamilyId, baseUrl, apiKey],
  () => {
    ++catalogGeneration;
    clearTimeout(catalogTimer);
    catalogReady.value = false;
    catalogLoading.value = false;
    catalogModels.value = [];
    catalogError.value = "";
    resetCatalogPicker();
    if (props.modelValue && isKeyStep.value && selectedManagedProvider.value && apiKey.value.trim())
      catalogTimer = setTimeout(() => void loadProviderModels(), 600);
  },
  { immediate: true, flush: "sync" },
);

function getFamilyLabel(family: ModelFamilyPreset): string {
  return family.labelKey ? t(family.labelKey) : (family.label ?? family.id);
}

function cancelPendingSubmission() {
  submissionGeneration += 1;
  saving.value = false;
}

function close() {
  if (configMutationInProgress.value) return;
  cancelPendingSubmission();
  void resetGitHubCopilotState();
  emit("update:modelValue", false);
}

function selectFamily(familyId: ModelFamilyId) {
  const family = getFamilyById(familyId);
  if (family.id !== selectedFamilyId.value) apiKey.value = "";
  selectedFamilyId.value = family.id;
  selectedModelName.value = getManagedModelProvider(familyId) ? "" : getDefaultModel(family);
  baseUrl.value = family.baseUrl;
  providerKey.value = family.providerKey;
  selectedApiFormat.value = family.apiFormat;
  errorMsg.value = "";
}

function goToKeyForm() {
  selectedModelName.value = selectedManagedProvider.value
    ? ""
    : getDefaultModel(selectedFamily.value);
  baseUrl.value = selectedFamily.value.baseUrl;
  providerKey.value = selectedFamily.value.providerKey;
  selectedApiFormat.value = selectedFamily.value.apiFormat;
  isKeyStep.value = true;
  errorMsg.value = "";
  if (isGitHubCopilot.value) void loadGitHubCopilotStatus();
}

function handlePrimaryAction() {
  if (isLocalProvider.value) {
    localVisible.value = true;
    return;
  }
  if (isGitHubCopilot.value) {
    goToKeyForm();
    return;
  }
  handleGetApiKey();
}

function handleGetApiKey() {
  void openProviderSignup();
  goToKeyForm();
}

async function openProviderSignup() {
  const signupUrl = selectedManagedProvider.value?.signupUrl;
  if (!signupUrl) return;
  const family = selectedFamilyId.value;
  const generation = submissionGeneration;
  try {
    if (window.openclaw?.shell?.openExternal) {
      await window.openclaw.shell.openExternal(signupUrl);
    } else {
      window.open(signupUrl, "_blank", "noopener,noreferrer");
    }
  } catch (error) {
    if (
      props.modelValue &&
      selectedFamilyId.value === family &&
      submissionGeneration === generation
    ) {
      errorMsg.value = t("modelSetup.openProviderFailed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function goToSelectStep() {
  if (configMutationInProgress.value) return;
  cancelPendingSubmission();
  if (isCustomProvider.value) selectFamily("qwen");
  void resetGitHubCopilotState();
  isKeyStep.value = false;
  errorMsg.value = "";
}

async function saveGitHubCopilotModel(): Promise<void> {
  if (saving.value || props.streaming) return;
  if (
    !props.manageOnly &&
    (!selectedGitHubModel.value.startsWith("github-copilot/") ||
      !githubModels.value.some((model) => model.id === selectedGitHubModel.value))
  ) {
    errorMsg.value = t("modelSetup.copilotSelectModel");
    return;
  }

  const generation = ++submissionGeneration;
  saving.value = true;
  errorMsg.value = "";
  try {
    if (!(await releaseLocalBeforeSave(generation))) return;
    configMutationInProgress.value = true;
    const preparation = await window.openclaw.model.prepareGitHubCopilot();
    if (generation !== submissionGeneration || !props.modelValue) return;
    if (preparation.restartRequired) {
      await window.openclaw.gateway.restart({ reason: "copilot-plugin-activation" });
      if (generation !== submissionGeneration || !props.modelValue) return;
    }
    if (props.manageOnly) {
      configMutationInProgress.value = false;
      emit("update:modelValue", false);
      emit("configured");
      return;
    }
    const existing = await window.openclaw.config.read();
    if (generation !== submissionGeneration || !props.modelValue) return;
    if (props.streaming) return;
    const nextConfig = selectPrimaryModelConfig(existing || {}, selectedGitHubModel.value, {
      ensureAllowed: true,
    });
    configMutationInProgress.value = true;
    await window.openclaw.model.applyConfig({
      config: nextConfig,
      expectedConfig: existing,
      action: "copilot-save",
      providerKey: "github-copilot",
    });
    if (generation !== submissionGeneration || !props.modelValue) return;
    configMutationInProgress.value = false;
    emit("update:modelValue", false);
    emit("configured");
  } catch (error) {
    errorMsg.value = t("modelSetup.saveFailed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (generation === submissionGeneration) {
      saving.value = false;
      configMutationInProgress.value = false;
    }
  }
}

async function releaseLocalBeforeSave(generation: number): Promise<boolean> {
  const isCurrent = () => generation === submissionGeneration && props.modelValue;
  const outcome = await releaseLocalModelSetup(
    window.openclaw.model.local,
    confirmLocalModelSwitch,
    isCurrent,
  );
  if (!isCurrent()) return false;
  await refreshLocalOperation();
  if (outcome === "pending") {
    errorMsg.value = t("localModel.setupFinishing");
    return false;
  }
  return outcome === "ready" && isCurrent();
}

function handleFormPrimaryAction(): void {
  if (isGitHubCopilot.value) {
    if (githubAuthState.value === "authenticated") {
      void saveGitHubCopilotModel();
    } else {
      void startGitHubCopilotLogin();
    }
  } else {
    void saveAndStart();
  }
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
  if (saving.value || props.streaming) return;
  if (selectedModelRestriction.value) {
    errorMsg.value = t(`modelSetup.incompatible.${selectedModelRestriction.value}`);
    return;
  }
  if (
    selectedManagedProvider.value &&
    (!catalogReady.value || !catalogModels.value.includes(selectedModelName.value))
  ) {
    errorMsg.value = catalogError.value || t("modelSetup.catalogChoose");
    return;
  }
  if (providerKey.value.trim().toLowerCase() === "llama-cpp") {
    if (props.inline) {
      errorMsg.value = t("modelManager.localEntryHint");
      return;
    }
    localVisible.value = true;
    return;
  }

  const managedModel = selectedManagedProvider.value?.models.find(
    (model) => model.id === selectedModelName.value,
  );
  const input: ModelProviderInput = {
    providerKey: providerKey.value,
    baseUrl: baseUrl.value,
    apiKey: apiKey.value,
    apiFormat: selectedApiFormat.value,
    modelName: selectedModelName.value,
    input:
      props.currentProvider?.modelName === selectedModelName.value
        ? props.currentProvider.input
        : isCustomProvider.value
          ? ["text"]
          : managedModel?.input,
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
    const connection = props.manageOnly
      ? null
      : await window.openclaw.model.testConnection({
          baseUrl: input.baseUrl.trim(),
          apiKey: input.apiKey.trim(),
          apiFormat: input.apiFormat,
          modelName: input.modelName.trim(),
        });
    if (generation !== submissionGeneration || !props.modelValue) return;
    if (connection && !connection.ok) {
      errorMsg.value = t("modelSetup.connectionFailed", { error: connection.message });
      return;
    }
    if (!(await releaseLocalBeforeSave(generation))) return;

    const verifiedInput = {
      ...input,
      baseUrl: connection?.baseUrl ?? input.baseUrl,
    };
    const existing = await window.openclaw.config.read();
    if (generation !== submissionGeneration || !props.modelValue) return;
    if (props.streaming) return;
    if (
      props.manageOnly &&
      !input.apiKey.trim() &&
      typeof existing?.models?.providers?.[input.providerKey.trim()]?.apiKey === "object"
    ) {
      errorMsg.value = t("modelManager.structuredSecret");
      return;
    }
    configMutationInProgress.value = true;
    if (
      props.manageOnly &&
      selectedManagedProvider.value &&
      matchesProviderConnection(existing, verifiedInput)
    ) {
      await window.openclaw.model.registerCatalogModel({
        modelRef: `${verifiedInput.providerKey.trim()}/${verifiedInput.modelName.trim()}`,
        expectedConfig: existing,
      });
    } else {
      const nextConfig = props.manageOnly
        ? mergeModelProviderConfig(existing || {}, verifiedInput, {
            select: false,
            displayName:
              props.currentProvider?.modelName === verifiedInput.modelName
                ? (props.currentProvider.displayName ?? verifiedInput.modelName)
                : verifiedInput.modelName,
          })
        : mergeModelProviderConfig(existing || {}, verifiedInput);
      await window.openclaw.model.applyConfig({
        config: nextConfig,
        expectedConfig: existing,
        action: "provider-save",
        providerKey: verifiedInput.providerKey.trim(),
      });
      if (generation !== submissionGeneration || !props.modelValue) return;
      if (selectedManagedProvider.value) {
        await window.openclaw.model.registerCatalogModel({
          modelRef: `${verifiedInput.providerKey.trim()}/${verifiedInput.modelName.trim()}`,
          expectedConfig: await window.openclaw.config.read(),
        });
      }
    }
    if (generation !== submissionGeneration || !props.modelValue) return;
    configMutationInProgress.value = false;
    emit("update:modelValue", false);
    emit("configured");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    errorMsg.value = t("modelSetup.saveFailed", { error: message });
  } finally {
    if (generation === submissionGeneration) {
      saving.value = false;
      configMutationInProgress.value = false;
    }
  }
}

function handleLocalConfigured() {
  emit("configured");
}
</script>

<style scoped>
.model-setup-overlay.model-setup-inline {
  position: relative;
  inset: auto;
  z-index: auto;
  display: block;
  background: transparent;
}
.model-setup-inline .model-setup-panel {
  width: 100%;
  min-height: 0;
  max-height: none;
  box-sizing: border-box;
  padding: 24px;
  box-shadow: none;
  border-radius: 0;
  text-align: left;
  background: transparent;
}
.model-setup-inline .model-setup-panel h2 {
  font-size: 18px;
}
.model-setup-overlay,
.model-setup-panel,
.model-setup-close,
.model-family-card,
.primary-action,
.text-action,
.model-key-form,
.copilot-auth-panel,
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
  grid-template-columns: repeat(auto-fit, minmax(105px, 1fr));
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
  border: 2px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: var(--ux-panel-text);
  cursor: pointer;
  transition:
    border-color 70ms ease-out,
    background 70ms ease-out,
    transform 70ms ease-out;
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
  display: flex;
  gap: 12px;
}

.key-actions .text-action,
.key-actions .primary-action {
  flex: 1 1 0;
  width: auto;
  margin-top: 0;
  height: 46px;
}

.model-key-form {
  text-align: left;
}

.model-field-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-width: 0;
}

.model-field-input {
  flex: 1 1 0;
  min-width: 0;
  width: auto;
}

.catalog-empty-hint {
  margin: 0;
  padding: 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  text-align: center;
}

.catalog-option-name {
  margin-right: 12px;
}

.catalog-recommended {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  font-size: 11px;
}

.catalog-more-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--el-text-color-secondary);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.catalog-more-toggle:hover {
  color: var(--el-text-color-primary);
}

.catalog-more-toggle:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.model-field-action {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 48px;
  padding: 0 12px;
  border: 1px solid var(--ux-border);
  border-radius: 10px;
  background: var(--ux-panel-bg);
  color: var(--ux-text-secondary);
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
}

.model-field-action:hover:not(:disabled) {
  background: var(--ux-surface-hover);
  color: var(--ux-panel-text);
}

.model-field-action:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.model-field-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.model-refresh-action {
  width: 48px;
  padding: 0;
}

.refresh-spinning {
  animation: model-refresh-spin 1s linear infinite;
}

@keyframes model-refresh-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .refresh-spinning {
    animation: none;
  }
}

@media (max-width: 480px) {
  .model-field-row {
    gap: 8px;
  }
  .provider-api-key-link {
    padding: 0 8px;
    font-size: 12px;
  }
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

.copilot-auth-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-bottom: 18px;
  padding: 18px;
  border: 1px solid var(--ux-border);
  border-radius: 14px;
  background: var(--ux-card-active);
  text-align: center;
}

.copilot-auth-label,
.copilot-auth-success {
  color: var(--ux-panel-text);
  font-size: 14px;
  font-weight: 700;
}

.copilot-auth-success {
  color: #238636;
}

.copilot-auth-hint {
  color: var(--ux-text-muted);
  font-size: 12px;
  line-height: 1.5;
}

.copilot-device-code {
  padding: 8px 14px;
  border: 1px solid var(--ux-border);
  border-radius: 10px;
  background: var(--ux-panel-bg);
  color: var(--ux-panel-text);
  font-family: "Cascadia Code", Consolas, monospace;
  font-size: 24px;
  letter-spacing: 2px;
  user-select: all;
}

.copilot-open-action {
  width: auto;
  height: auto;
  margin-top: 2px;
  padding: 6px 12px;
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
