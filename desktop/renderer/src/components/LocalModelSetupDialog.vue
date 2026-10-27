<template>
  <div
    class="local-model-overlay"
    :class="{ 'local-model-inline': inline, 'download-active': fixedDialogVisible }"
  >
    <section
      v-show="!fixedDialogVisible"
      class="local-model-panel"
      :class="{ 'catalog-panel': providerReady && snapshot?.catalog }"
      :role="inline ? 'region' : 'dialog'"
      :aria-modal="inline ? undefined : true"
      aria-labelledby="local-model-title"
      @keydown.esc.stop.prevent="close"
    >
      <div class="heading">
        <h2 id="local-model-title">{{ t("localModel.title") }}</h2>
        <button
          class="close-button"
          data-testid="local-close"
          :aria-label="t('common.close')"
          :disabled="
            fixedSelecting ||
            pending ||
            loading ||
            metadataPending ||
            operation?.cancellationPending
          "
          @click="close"
        >
          <span aria-hidden="true">&times;</span>
        </button>
      </div>
      <p class="subtitle">{{ t("localModel.subtitle") }}</p>
      <p
        v-if="defaultAgentOverride"
        class="notice"
        role="status"
        data-testid="default-agent-override"
      >
        {{
          t("localModel.defaultAgentOverride", {
            agent: defaultAgentOverride.agentId,
            model: defaultAgentOverride.modelRef,
          })
        }}
      </p>
      <p v-if="streaming" role="status">{{ t("localModel.streaming") }}</p>
      <p v-if="snapshotLoading || loading" role="status">{{ t("localModel.readingConfig") }}</p>
      <p v-else-if="refreshing" class="status-hint" role="status">
        {{ t("localModel.refreshingStatus") }}
      </p>
      <p v-if="metadataPending && providerReady" role="status">{{ t("localModel.checking") }}</p>
      <p v-if="error || metadataError || snapshotError || statusError" class="error" role="alert">
        {{ error || metadataError || snapshotError || statusError }}
      </p>

      <section
        v-if="snapshot?.models.length && !snapshot.catalog && !operation?.busy"
        class="saved-models"
        data-testid="configured-local-models"
      >
        <div v-for="model in snapshot.models" :key="model.modelRef" class="saved-model-row">
          <strong>{{ model.name }}</strong>
          <span :class="{ 'missing-file-label': model.fileStatus === 'missing' }">{{
            t(
              model.fileStatus === "missing"
                ? "localModel.filesMissing"
                : model.fileStatus === "unknown"
                  ? "localModel.filesUnknown"
                  : model.modelRef === snapshot.configuredModel
                    ? "localModel.currentDefault"
                    : "localModel.configured",
            )
          }}</span>
        </div>
      </section>

      <section
        v-if="missingModels.length && !snapshot?.catalog && !operation?.busy"
        class="missing-model-recovery"
        data-testid="local-files-missing"
        role="status"
      >
        <p>{{ t("localModel.filesMissingHint") }}</p>
        <button
          class="primary-action"
          data-testid="local-download-again"
          :disabled="blocked || metadataPending || !canMutate || !providerReady || streaming"
          @click="prepare('llama-cpp')"
        >
          {{ t("localModel.downloadAgain") }}
        </button>
      </section>

      <template v-if="capabilities">
        <ul v-if="capabilityReasons.length" class="notice" data-testid="local-blockers">
          <li v-for="reason in capabilityReasons" :key="reason">{{ reason }}</li>
        </ul>
        <section v-if="!providerReady" class="provider-setup" data-testid="provider-setup">
          <div class="provider-heading">
            <span class="provider-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3" y="4" width="18" height="13" rx="2" />
                <path d="M8 21h8m-4-4v4m-4-9 2 2 4-4" />
              </svg>
            </span>
            <div>
              <h3>{{ t("localModel.runtimeTitle") }}</h3>
              <p>{{ t("localModel.providerRequired") }}</p>
            </div>
          </div>
          <section v-if="review" class="provider-permissions" data-testid="provider-permissions">
            <h4>{{ t("localModel.permissionTitle") }}</h4>
            <p>{{ t("localModel.permissionHint") }}</p>
            <template v-for="(items, name) in review.capabilities" :key="name">
              <template v-if="items.length">
                <strong>{{ name }}</strong>
                <ul>
                  <li v-for="item in items" :key="item">{{ item }}</li>
                </ul>
              </template>
            </template>
            <details class="provider-details" data-testid="provider-details">
              <summary>{{ t("localModel.providerDetails") }}</summary>
              <dl>
                <dt>{{ t("localModel.provider") }}</dt>
                <dd>{{ review.pluginId }}</dd>
                <dt>{{ t("localModel.version") }}</dt>
                <dd>{{ review.version || t("localModel.unknown") }}</dd>
                <dt>{{ t("localModel.source") }}</dt>
                <dd>{{ review.source || t("localModel.unknown") }}</dd>
              </dl>
            </details>
          </section>
          <button
            class="primary-action"
            data-testid="provider-install"
            :disabled="blocked || metadataPending || !canInstall || streaming"
            :aria-busy="metadataPending"
            @click="installProvider"
          >
            {{
              t(
                metadataPending
                  ? "localModel.installingProvider"
                  : review
                    ? "localModel.confirmProviderInstall"
                    : capabilities.plugin.installed
                      ? "localModel.enableProvider"
                      : "localModel.installProvider",
              )
            }}
          </button>
        </section>
      </template>

      <LocalModelCatalog
        v-if="providerReady && snapshot?.catalog"
        data-testid="fixed-local-models"
        :catalog="snapshot.catalog"
        :hardware="hardware"
        :loading="hardwareLoading"
        :disabled="streaming || fixedSelecting || !canMutate"
        :busy-model-ref="operation?.busy ? operation.modelRef : undefined"
        :selecting-model-ref="fixedSelecting ? fixedSelection : undefined"
        :current-model-ref="snapshot.configuredModel"
        @select="fixedSelection = $event"
      />
      <section
        v-if="operation && !operationFilesMissing && !snapshot?.catalog"
        class="operation"
        :class="{ 'operation-download': downloadSummary }"
        aria-live="polite"
        data-testid="local-operation"
      >
        <h3 v-if="!downloadSummary">{{ t(`localModel.phase.${operation.phase}`) }}</h3>
        <p
          v-if="!downloadSummary && (operation.modelRef || operation.preparedModelRef)"
          class="model-reference"
        >
          {{ operation.modelRef || operation.preparedModelRef }}
        </p>
        <p v-if="operation.error" class="error" role="alert">{{ operation.error }}</p>
        <p v-if="operation.phase === 'error'">
          {{
            t(
              operation.rejectedBeforePromotion
                ? "localModel.notSwitched"
                : "localModel.checkAfterError",
            )
          }}
        </p>
        <p v-if="operation.cancellationPending" data-testid="local-cancel-pending">
          {{ t("localModel.cancelProtected") }}
        </p>
        <LocalModelWizardStep
          v-if="operation.phase === 'step' && operation.step"
          :key="`${operation.id}:${operation.step.id}`"
          :step="operation.step"
          :download-summary="downloadSummary"
          :notes="technicalNotes"
          :disabled="pending || metadataPending || !canMutate || Boolean(streaming)"
          @answer="answer"
        />
        <progress
          v-else-if="operation.busy && operation.phase !== 'interrupted'"
          :aria-label="t(`localModel.phase.${operation.phase}`)"
        />
        <button
          v-if="operation.phase === 'interrupted'"
          data-testid="local-resume"
          :disabled="pending || loading || metadataPending"
          @click="run(() => api.resume())"
        >
          {{ t("localModel.resume") }}
        </button>
        <button
          v-if="!downloadSummary && (operation.busy || operation.phase === 'interrupted')"
          data-testid="local-cancel"
          :disabled="pending || metadataPending || operation.cancellationPending"
          @click="run(() => api.cancel(operation!.id))"
        >
          {{ t("localModel.cancelSetup") }}
        </button>
        <p v-if="operation.phase === 'ready'">{{ t("localModel.readyNotice") }}</p>
        <button v-if="operation.phase === 'ready'" class="primary-action" @click="close">
          {{ t("localModel.finish") }}
        </button>
      </section>

      <template v-if="(!operation || !operation.busy) && !snapshot?.catalog">
        <section
          v-if="providerReady && operation?.phase !== 'prepared' && !snapshot?.models.length"
          class="setup-choice"
        >
          <p>{{ t("localModel.prepareIntro") }}</p>
          <button
            class="primary-action"
            data-testid="prepare-llama-cpp"
            :disabled="blocked || metadataPending || !canMutate || !providerReady || streaming"
            @click="prepare('llama-cpp')"
          >
            {{ t("localModel.managed") }}
          </button>
        </section>
        <section v-if="showActivation && (!capabilities || providerReady)">
          <h3>{{ t("localModel.activationTitle") }}</h3>
          <p>
            {{
              t(
                operation?.phase === "prepared"
                  ? "localModel.preparedHint"
                  : "localModel.configuredHint",
              )
            }}
          </p>
          <label for="local-candidate">{{ t("localModel.exactModel") }}</label>
          <select
            id="local-candidate"
            v-model="selectedCandidate"
            :disabled="blocked || metadataPending"
          >
            <option value="" disabled>{{ t("localModel.chooseCandidate") }}</option>
            <option
              v-for="option in candidates"
              :key="candidateKey(option)"
              :value="candidateKey(option)"
            >
              {{ option.label }} — {{ option.modelRef }}
            </option>
          </select>
          <p v-if="!candidate">{{ t("localModel.noExactCandidate") }}</p>
          <button
            data-testid="local-activate"
            class="primary-action"
            :disabled="
              !candidate || blocked || metadataPending || !canMutate || !providerReady || streaming
            "
            @click="activate"
          >
            {{ t("localModel.useModel") }}
          </button>
        </section>
        <button
          v-else-if="
            snapshot?.models.length && !missingModels.length && operation?.phase !== 'ready'
          "
          data-testid="local-current-done"
          class="primary-action"
          @click="close"
        >
          {{ t("localModel.finish") }}
        </button>
      </template>
    </section>
    <LocalModelDownloadDialog
      v-if="fixedSelection"
      :key="fixedSelection"
      :model-ref="fixedSelection"
      :streaming="streaming"
      @busy="fixedSelecting = $event"
      @visible="fixedDialogVisible = $event"
      @close="fixedSelection = ''"
      @selected="handleFixedSelected"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { t } from "@/i18n";
import { useLocalModelOperation } from "@/composables/use-local-model-operation";
import LocalModelWizardStep from "./LocalModelWizardStep.vue";
import LocalModelDownloadDialog from "./LocalModelDownloadDialog.vue";
import LocalModelCatalog from "./LocalModelCatalog.vue";
import { summarizeManagedDownload } from "@/utils/local-model-presentation";
import type {
  LocalModelCandidate,
  LocalModelCapabilities,
  LocalModelChoice,
  LocalModelInstallReview,
  LocalModelHardware,
  LocalModelSnapshot,
} from "../../../src/local-model-types";

const props = defineProps<{
  targetModelRef?: string;
  streaming?: boolean;
  defaultAgentOverride?: { agentId: string; modelRef: string } | null;
  removableConnections?: Array<{ modelRef: string; name: string }>;
  connectionMutationBusy?: boolean;
  inline?: boolean;
}>();
const emit = defineEmits<{ close: []; configured: []; "remove-connection": [modelRef: string] }>();
const api = window.openclaw.model.local;
const {
  operation,
  pending,
  loading,
  error,
  blocked: operationBlocked,
  run,
} = useLocalModelOperation();
const capabilities = ref<LocalModelCapabilities | null>(null);
const snapshot = ref<LocalModelSnapshot | null>(null);
const hardware = ref<LocalModelHardware | null>(null);
const hardwareLoading = ref(false);
let hardwareRequested = false;
const snapshotLoading = ref(true);
const snapshotError = ref("");
const refreshing = ref(false);
const statusError = ref("");
const metadataPending = ref(false);
const metadataError = ref("");
const review = ref<LocalModelInstallReview | null>(null);
const selectedCandidate = ref("");
const fixedSelection = ref("");
const fixedSelecting = ref(false);
const fixedDialogVisible = ref(false);
const blocked = computed(() => operationBlocked.value || fixedSelecting.value);
function handleFixedSelected() {
  emit("configured");
  emit("close");
}
let disposed = false;
let emittedReadyId = "";
let activationObserved = false;
let snapshotRevision = 0;
let capabilitiesRevision = 0;
const providerReady = computed(
  () => capabilities.value?.plugin.installed && capabilities.value.plugin.enabled,
);
const canMutate = computed(() =>
  Boolean(capabilities.value?.supported && capabilities.value.mutable),
);
const downloadSummary = computed(() =>
  summarizeManagedDownload(
    operation.value?.step,
    operation.value?.kind === "prepare" && operation.value.authChoice === "llama-cpp",
  ),
);
const technicalNotes = computed(() => [
  t("localModel.configuredHint"),
  t("localModel.defaultNotice"),
  t("localModel.experimental"),
  t("localModel.privacy"),
  `${t("localModel.gatewayVersion")}: ${capabilities.value?.gatewayVersion || t("localModel.unknown")}`,
]);
const canInstall = computed(
  () =>
    canMutate.value &&
    Boolean(
      capabilities.value?.plugin.canInstall ||
      (capabilities.value?.plugin.installed && !capabilities.value.plugin.enabled),
    ),
);
const capabilityReasons = computed(() => {
  const value = capabilities.value;
  if (!value) return [];
  return [
    ...value.blockers,
    ...(!value.supported ? [t("localModel.unsupported")] : []),
    ...(!value.mutable ? [t("localModel.readOnly")] : []),
    ...(!providerReady.value && !canInstall.value ? [t("localModel.installUnavailable")] : []),
  ];
});
const missingModels = computed(
  () => snapshot.value?.models.filter((model) => model.fileStatus === "missing") ?? [],
);
const missingModelRefs = computed(
  () => new Set(missingModels.value.map((model) => model.modelRef)),
);
const operationFilesMissing = computed(() => {
  const active = operation.value;
  return (
    active &&
    !active.busy &&
    (active.phase === "ready" || active.phase === "prepared") &&
    missingModelRefs.value.has(active.modelRef ?? active.preparedModelRef ?? "")
  );
});
const candidates = computed(() => {
  const found: LocalModelCandidate[] = [];
  for (const configured of snapshot.value?.models ?? []) {
    if (
      !configured.modelRef.startsWith("llama-cpp/") ||
      configured.fileStatus === "missing" ||
      found.some((item) => item.modelRef === configured.modelRef)
    )
      continue;
    found.push({
      kind: "existing-model",
      modelRef: configured.modelRef,
      label: configured.name,
      detail: "",
      recommended: false,
    });
  }
  return found;
});
function candidateKey(value: LocalModelCandidate) {
  return JSON.stringify([value.kind, value.modelRef]);
}
const candidate = computed(() =>
  candidates.value.find((item) => candidateKey(item) === selectedCandidate.value),
);
const showActivation = computed(
  () =>
    !(props.targetModelRef && missingModelRefs.value.has(props.targetModelRef)) &&
    !(missingModels.value.length > 0 && candidates.value.length === 0) &&
    (Boolean(props.targetModelRef) ||
      operation.value?.phase === "prepared" ||
      candidates.value.some((item) => item.modelRef !== snapshot.value?.configuredModel)),
);

function selectExactCandidate(preferTarget = false) {
  const prepared = operation.value?.phase === "prepared";
  const exactRef =
    preferTarget && props.targetModelRef
      ? props.targetModelRef
      : prepared
        ? operation.value?.preparedModelRef
        : (props.targetModelRef ?? snapshot.value?.configuredModel);
  const matches = exactRef
    ? candidates.value.filter((item) => item.modelRef === exactRef)
    : prepared
      ? []
      : candidates.value;
  selectedCandidate.value = matches.length === 1 ? candidateKey(matches[0]) : "";
}

async function metadata(action: () => Promise<void>) {
  if (metadataPending.value) return;
  metadataPending.value = true;
  metadataError.value = "";
  try {
    await action();
  } catch (cause) {
    if (!disposed) metadataError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (!disposed) {
      metadataPending.value = false;
    }
  }
}
async function loadSnapshot() {
  const revision = ++snapshotRevision;
  snapshotLoading.value = true;
  snapshotError.value = "";
  try {
    const result = await api.getSnapshot();
    if (disposed || revision !== snapshotRevision) return;
    if (!result.ok) throw new Error(result.error);
    snapshot.value = result.value;
    if (snapshot.value.catalog) void loadHardware();
    selectExactCandidate();
  } catch (cause) {
    if (!disposed && revision === snapshotRevision) {
      snapshotError.value = cause instanceof Error ? cause.message : String(cause);
    }
  } finally {
    if (!disposed && revision === snapshotRevision) snapshotLoading.value = false;
  }
}
async function loadHardware() {
  if (hardwareRequested) return;
  hardwareRequested = true;
  hardwareLoading.value = true;
  try {
    const result = await api.getHardware();
    if (!disposed && result.ok) hardware.value = result.value;
  } catch {
    if (!disposed) hardware.value = null;
  } finally {
    if (!disposed) hardwareLoading.value = false;
  }
}
async function loadCapabilities() {
  const revision = ++capabilitiesRevision;
  refreshing.value = true;
  statusError.value = "";
  try {
    const result = await api.getCapabilities();
    if (disposed || revision !== capabilitiesRevision) return;
    if (!result.ok) throw new Error(result.error);
    capabilities.value = result.value;
  } catch (cause) {
    if (!disposed && revision === capabilitiesRevision) {
      capabilities.value = null;
      statusError.value = cause instanceof Error ? cause.message : String(cause);
    }
  } finally {
    if (!disposed && revision === capabilitiesRevision) refreshing.value = false;
  }
}
async function installProvider() {
  if (metadataPending.value || !canInstall.value || blocked.value || props.streaming) return;
  const reviewToken = review.value?.reviewToken;
  review.value = null;
  await metadata(async () => {
    const result = await api.installProvider({
      confirmed: true,
      ...(reviewToken ? { reviewToken } : {}),
    });
    if (disposed) return;
    if (!result.ok && result.code === "PLUGIN_CAPABILITY_CONSENT_REQUIRED") {
      const inspected = await api.inspectProvider();
      if (disposed) return;
      if (!inspected.ok) throw new Error(inspected.error);
      if (!inspected.value.reviewToken) throw new Error(result.error);
      review.value = inspected.value;
      return;
    }
    if (!result.ok) throw new Error(result.error);
    capabilities.value = result.value;
    await Promise.all([loadSnapshot(), loadCapabilities()]);
  });
}
function prepare(authChoice: LocalModelChoice) {
  if (
    blocked.value ||
    metadataPending.value ||
    !canMutate.value ||
    !providerReady.value ||
    props.streaming
  )
    return;
  selectedCandidate.value = "";
  void run(() => api.prepare({ authChoice }));
}
function activate() {
  const exact = candidate.value;
  if (
    !exact ||
    blocked.value ||
    metadataPending.value ||
    !canMutate.value ||
    !providerReady.value ||
    props.streaming
  )
    return;
  activationObserved = true;
  void run(() => api.activate({ kind: exact.kind, modelRef: exact.modelRef }));
}
function answer(value: unknown) {
  const active = operation.value;
  if (
    !active?.step ||
    active.phase !== "step" ||
    pending.value ||
    !canMutate.value ||
    props.streaming
  )
    return;
  void run(() => api.answer({ operationId: active.id, stepId: active.step!.id, value }));
}
async function close() {
  if (
    fixedSelecting.value ||
    pending.value ||
    loading.value ||
    metadataPending.value ||
    operation.value?.cancellationPending
  )
    return;
  if (operation.value?.busy) {
    await run(() => api.cancel(operation.value!.id));
    if (operation.value?.busy || error.value) return;
  }
  emit("close");
}
watch(
  () => props.targetModelRef,
  () => selectExactCandidate(true),
);
watch(
  () => [operation.value?.id, operation.value?.phase],
  () => {
    if (fixedSelection.value) return;
    if (operation.value?.phase === "prepared") {
      void loadSnapshot();
    }
    if (operation.value?.kind === "activate" && operation.value.phase !== "ready") {
      activationObserved = true;
    }
    if (
      operation.value?.phase === "ready" &&
      operation.value.kind === "activate" &&
      activationObserved &&
      emittedReadyId !== operation.value.id
    ) {
      emittedReadyId = operation.value.id;
      activationObserved = false;
      emit("configured");
      void loadSnapshot();
    }
  },
);
onMounted(() => {
  void loadSnapshot();
  void loadCapabilities();
});
onUnmounted(() => {
  disposed = true;
});
</script>

<style scoped>
.local-model-overlay.local-model-inline {
  position: relative;
  inset: auto;
  z-index: auto;
  display: block;
  background: transparent;
}
.local-model-inline .local-model-panel {
  width: 100%;
  box-sizing: border-box;
  max-height: none;
  border-radius: 0;
  background: transparent;
}
.local-model-inline .heading h2 {
  font-size: 18px;
}
.local-model-overlay {
  position: fixed;
  inset: 0;
  z-index: 2100;
  background: rgba(0, 0, 0, 0.4);
  display: grid;
  place-items: center;
}
.local-model-overlay.download-active {
  background: transparent;
}
.local-model-panel {
  box-sizing: border-box;
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  padding: 24px 28px;
  border-radius: 16px;
  background: var(--smtc-background-card-on-primary-default-rest, #fff);
  color: var(--smtc-foreground-ctrl-neutral-primary-rest, #242424);
}
.local-model-overlay:not(.local-model-inline) .catalog-panel {
  width: min(560px, calc(100vw - 32px));
  padding: 24px;
  box-shadow: 0 16px 64px rgba(0, 0, 0, 0.12);
}
.catalog-panel .heading h2 {
  font-size: 20px;
}
.catalog-panel .subtitle {
  margin: 6px 0 18px;
  font-size: 13px;
}
.heading {
  display: flex;
  gap: 12px;
  justify-content: space-between;
  align-items: center;
}
.heading h2 {
  margin: 0;
  font-size: 22px;
}
.subtitle {
  margin: 8px 0 24px;
  color: var(--smtc-foreground-ctrl-neutral-secondary-rest, #60646c);
  font-size: 14px;
}
.notice {
  border: 1px solid var(--smtc-stroke-divider-subtle, #ccc);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.operation {
  margin: 20px 0;
}
.operation h3 {
  margin: 0 0 12px;
}
.operation-download {
  margin: 0;
}
.setup-choice {
  margin: 20px 0;
}
.status-hint {
  color: var(--smtc-foreground-ctrl-neutral-secondary-rest, #60646c);
  font-size: 13px;
}
.saved-models {
  margin: 16px 0;
}
.saved-model-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 0;
}
.saved-model-row span {
  color: var(--smtc-foreground-ctrl-neutral-secondary-rest, #60646c);
  font-size: 12px;
}
.saved-model-row .missing-file-label {
  color: var(--smtc-status-danger-foreground, #b42318);
}
.missing-model-recovery {
  margin: 16px 0;
}
.setup-choice .primary-action {
  width: 100%;
}
.provider-setup {
  margin: 20px 0;
  padding: 20px;
  border: 1px solid var(--smtc-stroke-divider-subtle, #e5e7eb);
  border-radius: 12px;
  background: var(--smtc-background-ctrl-subtle-hover, #f8f9fa);
}
.provider-heading {
  display: flex;
  align-items: center;
  gap: 12px;
}
.provider-heading h3 {
  margin: 0;
  font-size: 16px;
}
.provider-heading p {
  margin: 6px 0 0;
  color: var(--smtc-foreground-ctrl-neutral-secondary-rest, #60646c);
  font-size: 13px;
  line-height: 1.6;
}
.provider-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--smtc-background-card-on-primary-default-rest, #fff);
}
.provider-icon svg {
  width: 24px;
  height: 24px;
}
.provider-setup .primary-action {
  width: 100%;
  margin: 20px 0 0;
}
.provider-permissions {
  margin-top: 16px;
  font-size: 13px;
  line-height: 1.6;
}
.provider-permissions h4 {
  margin: 0;
  font-size: 14px;
}
.provider-permissions p {
  margin: 6px 0 12px;
}
.provider-permissions ul {
  margin: 4px 0 12px;
  padding-left: 20px;
}
.provider-details {
  color: var(--smtc-foreground-ctrl-neutral-secondary-rest, #60646c);
}
.provider-details summary {
  cursor: pointer;
}
.provider-details dl {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 6px 12px;
}
.provider-details dd {
  margin: 0;
}
.model-reference {
  font-size: 13px;
  color: var(--smtc-foreground-ctrl-neutral-secondary-rest, #60646c);
}
button,
select {
  background: var(--smtc-background-card-on-primary-default-rest, #fff);
  color: inherit;
  border: 1px solid var(--smtc-stroke-divider-subtle, #ccc);
  border-radius: 8px;
  padding: 8px 12px;
  margin: 4px 0;
  font: inherit;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.primary-action {
  background: var(--ux-brand-bg, #18181b);
  color: var(--ux-brand-fg, #fff);
  border-color: transparent;
  min-height: 38px;
}
:global(html.dark) .primary-action {
  background: #f2f2f2;
  color: #18181b;
}
.close-button {
  margin: 0;
  padding: 0;
  width: 32px;
  height: 32px;
  border: 0;
  background: transparent;
  font-size: 24px;
  font-weight: 300;
  line-height: 1;
}
.close-button:hover:not(:disabled) {
  background: var(--smtc-background-ctrl-subtle-hover, #f3f4f6);
}
small {
  display: block;
  margin-top: 6px;
  white-space: pre-wrap;
}
p,
dd {
  overflow-wrap: anywhere;
}
.error {
  color: var(--smtc-status-danger-foreground, #b42318);
}
</style>
