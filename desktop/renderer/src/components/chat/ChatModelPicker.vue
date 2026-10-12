<template>
  <el-popover
    :visible="open"
    trigger="click"
    placement="top-end"
    :width="360"
    :popper-style="{ maxWidth: 'calc(100vw - 32px)' }"
    @update:visible="setOpen"
  >
    <template #reference>
      <button
        class="model-pill"
        data-testid="chat-model-picker"
        :aria-label="t('modelManager.sessionModel')"
        :aria-expanded="open"
        :aria-busy="switching || opening"
        :disabled="switching"
        :title="state?.modelRef ?? t('modelManager.sessionModel')"
        @blur="cancelOpening"
        @keydown.esc.stop.prevent="closePicker"
      >
        <span v-if="switching || opening" class="model-pill-label" role="status">
          {{
            t(
              recovering
                ? "modelManager.recovering"
                : switching
                  ? "modelManager.switching"
                  : "modelManager.loading",
            )
          }}
        </span>
        <span v-else class="model-pill-label">{{ currentName }}</span>
        <span v-if="currentFileStatus === 'missing'" class="missing-indicator" aria-hidden="true"
          >!</span
        >
        <span aria-hidden="true">&#9662;</span>
      </button>
    </template>
    <section class="model-menu" :aria-label="t('modelManager.sessionModel')">
      <div class="menu-heading">
        <strong>{{ t("modelManager.sessionModel") }}</strong>
        <button class="text-button" :disabled="loading || switching" @click="loadCatalog">
          {{ t("modelManager.refresh") }}
        </button>
      </div>
      <p class="menu-hint">{{ t("modelManager.sessionHint") }}</p>
      <input
        v-model="query"
        type="search"
        class="model-search"
        :placeholder="t('modelManager.search')"
        :aria-label="t('modelManager.search')"
      />
      <p v-if="error || catalogError" class="menu-error" role="alert">
        {{ error || catalogError }}
      </p>
      <SessionModelRecoveryNotice
        :disabled="disabled || !connected || changing || localSelecting || Boolean(operation?.busy)"
        @state="recovery = $event"
        @busy="handleRecoveryBusy"
        @recovered="handleRecovered"
      />
      <p v-if="!connected" class="menu-hint" role="status">{{ t("modelManager.offline") }}</p>
      <p v-else-if="disabled" class="menu-hint" role="status">{{ t("localModel.streaming") }}</p>
      <p v-if="operation?.busy" class="menu-hint" role="status">
        {{ t("localModel.setupPending") }}
      </p>
      <p v-if="loading && !models.length" role="status">{{ t("localModel.readingConfig") }}</p>
      <ModelProviderGroups
        v-show="!loading || models.length > 0"
        :models="models"
        :selected-model="state?.modelRef"
        :query="query"
        :context-key="sessionKey"
        :disabled="selectionBlocked"
        :is-model-disabled="(model) => !canSelect(model)"
        :model-status="modelStatus"
        @select="select"
        @clear-search="query = ''"
      >
        <template #model-action="{ model }">
          <button
            v-if="
              files.get(getModelRef(model)) === 'missing' &&
              !isManagedLocalModel(getModelRef(model))
            "
            class="text-button"
            :disabled="switching"
            @click="manage('llama-cpp')"
          >
            {{ t("localModel.downloadAgain") }}
          </button>
        </template>
      </ModelProviderGroups>
      <div class="menu-footer">
        <button
          v-if="state?.overridden"
          class="text-button"
          :disabled="selectionBlocked"
          @click="select(null)"
        >
          {{ t("modelManager.useInherited") }}
        </button>
        <button class="text-button" :disabled="switching" @click="manage()">
          {{ t("modelManager.manage") }}
        </button>
      </div>
    </section>
  </el-popover>
  <LocalModelDownloadDialog
    v-if="localSelection"
    :key="localSelection"
    :model-ref="localSelection"
    :session-key="localSelectionSession"
    :streaming="disabled"
    @busy="handleLocalBusy"
    @close="closeLocalSelection"
    @selected="loadCurrent"
  />
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { t } from "@/i18n";
import { useLocalModelOperation } from "@/composables/use-local-model-operation";
import { mergeGitHubCopilotModelEntries } from "@/utils/auth-managed-models";
import { getModelRef, readConfiguredModels, type ConfiguredModel } from "@/utils/configured-models";
import type { LocalModelFileStatus } from "../../../../src/local-model-types";
import type { SessionModelRecovery, SessionModelState } from "../../../../src/session-model-types";
import {
  isManagedLocalModel,
  type LocalModelCatalogEntry,
} from "../../../../src/local-model-catalog";
import { mergeLocalModelCatalog } from "@/utils/local-model-catalog";
import LocalModelDownloadDialog from "@/components/LocalModelDownloadDialog.vue";
import ModelProviderGroups from "@/components/ModelProviderGroups.vue";
import SessionModelRecoveryNotice from "@/components/SessionModelRecoveryNotice.vue";

const props = defineProps<{ sessionKey: string; disabled: boolean; connected: boolean }>();
const emit = defineEmits<{ manage: [provider?: string]; busy: [value: boolean] }>();
const { operation } = useLocalModelOperation();
const open = ref(false);
const opening = ref(false);
const catalogLoaded = ref(false);
const catalogValid = ref(false);
const query = ref("");
const models = ref<ConfiguredModel[]>([]);
const state = ref<SessionModelState | null>(null);
const files = ref(new Map<string, LocalModelFileStatus | "not-downloaded">());
const localCatalog = ref<LocalModelCatalogEntry[]>([]);
const localProviderReady = ref(false);
const localSelection = ref("");
const localSelectionSession = ref("");
const localSelecting = ref(false);
const recovering = ref(false);
const recovery = ref<SessionModelRecovery | null>(null);
const localFilesKnown = ref(false);
const loading = ref(false);
const changing = ref(false);
const error = ref("");
const catalogError = ref("");
let disposed = false;
let stateRevision = 0;
let catalogRevision = 0;
let openRevision = 0;
let catalogTask: Promise<void> | undefined;
const switching = computed(() => changing.value || localSelecting.value || recovering.value);
const selectionBlocked = computed(
  () =>
    switching.value ||
    Boolean(recovery.value) ||
    !catalogValid.value ||
    props.disabled ||
    !props.connected ||
    Boolean(operation.value?.busy),
);
const currentFileStatus = computed(() => files.value.get(state.value?.modelRef ?? ""));
const currentName = computed(
  () =>
    models.value.find((model) => getModelRef(model) === state.value?.modelRef)?.name ??
    state.value?.modelRef?.split("/").slice(1).join("/") ??
    t("localModel.selectModel"),
);
watch(
  () => props.sessionKey,
  () => {
    query.value = "";
  },
);

function canSelect(model: ConfiguredModel): boolean {
  const ref = getModelRef(model);
  if (isManagedLocalModel(ref)) return localFilesKnown.value && localProviderReady.value;
  return (
    model.providerKey !== "llama-cpp" ||
    (localFilesKnown.value && files.value.has(ref) && files.value.get(ref) !== "missing")
  );
}

function modelStatus(model: ConfiguredModel): string {
  if (model.providerKey !== "llama-cpp") return "";
  if (!localFilesKnown.value) return t("localModel.filesUnknown");
  const status = files.value.get(getModelRef(model));
  const preset = localCatalog.value.find((entry) => entry.modelRef === getModelRef(model));
  if (preset) {
    if (status === "external") return t("modelManager.external");
    if (!localProviderReady.value) return t("fixedLocal.enableFirst");
    if (operation.value?.busy && operation.value.modelRef === preset.modelRef)
      return t(
        operation.value.download && operation.value.step?.type !== "confirm"
          ? "fixedLocal.downloading"
          : "fixedLocal.preparing",
      );
    const state = t(
      status === "present"
        ? "modelManager.downloaded"
        : status === "unknown"
          ? "localModel.filesUnknown"
          : "fixedLocal.notDownloaded",
    );
    return `${state} · ${(preset.downloadBytes / 1e9).toFixed(1)} GB${preset.preferred ? ` · ${t("fixedLocal.lightweight")}` : ""}`;
  }
  return t(
    status === "missing"
      ? "localModel.filesMissing"
      : status === "present"
        ? "modelManager.downloaded"
        : status === "external"
          ? "modelManager.external"
          : "localModel.filesUnknown",
  );
}

async function loadCurrent() {
  const revision = ++stateRevision;
  const key = props.sessionKey;
  if (!props.connected) return;
  try {
    const result = await window.openclaw.model.session.get(key);
    if (!disposed && revision === stateRevision && key === props.sessionKey) {
      state.value = result;
      error.value = "";
    }
  } catch (cause) {
    if (!disposed && revision === stateRevision)
      error.value = String(cause instanceof Error ? cause.message : cause);
  }
}

function closePicker() {
  openRevision += 1;
  opening.value = false;
  open.value = false;
}

function cancelOpening() {
  if (opening.value) closePicker();
}

async function setOpen(visible: boolean) {
  if (!visible || opening.value) {
    closePicker();
    return;
  }
  if (switching.value) return;
  if (catalogLoaded.value && (state.value || error.value || !props.connected)) {
    open.value = true;
    void loadCatalog();
    return;
  }
  const revision = ++openRevision;
  opening.value = true;
  await loadCatalog();
  if (disposed || revision !== openRevision) return;
  if (props.connected && !state.value && !error.value) await loadCurrent();
  if (disposed || revision !== openRevision) return;
  opening.value = false;
  open.value = true;
}

function loadCatalog(): Promise<void> {
  if (changing.value || localSelecting.value) return Promise.resolve();
  catalogTask ??= refreshCatalog().finally(() => {
    catalogTask = undefined;
  });
  return catalogTask;
}

async function refreshCatalog() {
  const revision = ++catalogRevision;
  loading.value = true;
  const current = () => !disposed && revision === catalogRevision;
  const currentSelection = loadCurrent();
  try {
    const config = readConfiguredModels(await window.openclaw.config.read());
    if (!current()) return;
    const loadCopilot = async () => {
      const status = await window.openclaw.model.getGitHubCopilotStatus();
      return current() && status.authenticated
        ? window.openclaw.model.listGitHubCopilotModels()
        : [];
    };
    const [local, copilot] = await Promise.allSettled([
      Promise.all([
        window.openclaw.model.local.getSnapshot(),
        window.openclaw.model.local.getCapabilities(),
      ]),
      loadCopilot(),
    ]);
    await currentSelection;
    if (!current()) return;
    const errors: string[] = [];
    const report = (cause: unknown) =>
      errors.push(cause instanceof Error ? cause.message : String(cause));
    let nextModels = config.models;
    let nextCatalog: LocalModelCatalogEntry[] = [];
    const nextFiles = new Map<string, LocalModelFileStatus | "not-downloaded">();
    let filesKnown = false;
    let providerReady = false;
    if (local.status === "fulfilled") {
      const [snapshot, capabilities] = local.value;
      if (snapshot.ok) {
        nextCatalog = snapshot.value.catalog ?? [];
        nextModels = mergeLocalModelCatalog(nextModels, nextCatalog);
        for (const model of snapshot.value.models)
          nextFiles.set(model.modelRef, model.fileStatus ?? "unknown");
        for (const model of nextCatalog) nextFiles.set(model.modelRef, model.fileStatus);
        filesKnown = true;
      } else report(snapshot.error);
      if (capabilities.ok) {
        providerReady =
          capabilities.value.supported &&
          capabilities.value.mutable &&
          capabilities.value.plugin.installed &&
          capabilities.value.plugin.enabled;
      } else {
        report(capabilities.error);
      }
    } else report(local.reason);
    if (copilot.status === "fulfilled") {
      nextModels = mergeGitHubCopilotModelEntries(nextModels, copilot.value);
    } else report(copilot.reason);

    // Publish one complete snapshot; replacing providers as each request finishes
    // makes Popper repeatedly resize and re-anchor an already-visible menu.
    models.value = nextModels;
    localCatalog.value = nextCatalog;
    files.value = nextFiles;
    localFilesKnown.value = filesKnown;
    localProviderReady.value = providerReady;
    catalogValid.value = true;
    catalogError.value = errors.join("; ");
  } catch (cause) {
    if (current()) {
      catalogValid.value = false;
      catalogError.value = String(cause instanceof Error ? cause.message : cause);
    }
  } finally {
    await currentSelection;
    if (current()) {
      loading.value = false;
      catalogLoaded.value = true;
    }
  }
}

async function select(modelRef: string | null) {
  if (selectionBlocked.value) return;
  if (modelRef && isManagedLocalModel(modelRef)) {
    if (!localProviderReady.value) return;
    localSelectionSession.value = props.sessionKey;
    localSelection.value = modelRef;
    closePicker();
    return;
  }
  const key = props.sessionKey;
  const revision = ++stateRevision;
  changing.value = true;
  emit("busy", true);
  error.value = "";
  try {
    const selected = await window.openclaw.model.session.select({ sessionKey: key, modelRef });
    if (!disposed && revision === stateRevision && key === props.sessionKey) {
      state.value = selected;
      closePicker();
      localSelection.value = "";
      query.value = "";
    }
  } catch (cause) {
    if (!disposed && key === props.sessionKey)
      error.value = String(cause instanceof Error ? cause.message : cause);
  } finally {
    changing.value = false;
    emit("busy", false);
  }
}

function handleLocalBusy(busy: boolean) {
  localSelecting.value = busy;
  emit("busy", busy);
}

function handleRecoveryBusy(busy: boolean) {
  recovering.value = busy;
  emit("busy", busy);
}

async function handleRecovered() {
  await catalogTask;
  if (!disposed) await loadCatalog();
}

function closeLocalSelection() {
  localSelection.value = "";
  if (recovery.value) {
    open.value = true;
    void loadCurrent();
  }
}

function manage(provider?: string) {
  if (switching.value) return;
  closePicker();
  emit("manage", provider);
}

watch(
  () => [props.sessionKey, props.connected],
  () => {
    state.value = null;
    error.value = "";
    closePicker();
    localSelection.value = "";
    void loadCurrent();
  },
  { immediate: true },
);
onUnmounted(() => {
  disposed = true;
  stateRevision += 1;
  catalogRevision += 1;
});
</script>

<style scoped>
.model-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 240px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 20px;
  padding: 5px 10px;
  color: var(--el-text-color-regular);
  background: transparent;
  cursor: pointer;
  font-size: 12px;
}
.model-pill-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.missing-indicator,
.menu-error {
  color: var(--el-color-warning-dark-2);
}
.model-menu {
  text-align: left;
  color: var(--el-text-color-primary);
  max-height: calc(100vh - 100px);
  overflow-y: auto;
}
.menu-heading,
.menu-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.menu-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  margin: 8px 0;
}
.model-search {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  background: var(--el-fill-color-blank);
  color: inherit;
}
.text-button {
  border: 0;
  padding: 4px 0;
  background: transparent;
  color: var(--el-color-primary);
  cursor: pointer;
  font-size: 12px;
}
.text-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.menu-footer {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.menu-error {
  font-size: 12px;
  overflow-wrap: anywhere;
}
@media (max-width: 600px) {
  .model-pill {
    max-width: 170px;
  }
}
</style>
