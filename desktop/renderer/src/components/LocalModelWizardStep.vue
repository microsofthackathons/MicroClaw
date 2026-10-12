<template>
  <section class="wizard-step" :aria-label="t('localModel.gatewayStep')">
    <template v-if="downloadSummary">
      <div class="model-heading" data-testid="download-summary">
        <span class="model-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <rect x="4" y="4" width="16" height="12" rx="2" />
            <path d="M2 20h20M8 16l-1 4m9-4 1 4" />
          </svg>
        </span>
        <div>
          <span class="eyebrow">{{ t("localModel.recommended") }}</span>
          <h3>{{ downloadSummary.modelName }}</h3>
        </div>
      </div>
      <div class="download-facts">
        <div>
          <span>{{ t("localModel.downloadSize") }}</span>
          <strong>{{
            t("localModel.downloadAmount", { size: downloadSummary.downloadGB })
          }}</strong>
        </div>
        <div>
          <span>{{ t("localModel.runMode") }}</span>
          <strong>{{
            t(downloadSummary.backend === "cpu" ? "localModel.cpuMode" : "localModel.gpuMode")
          }}</strong>
        </div>
      </div>
      <p class="summary-hint">
        {{
          t(
            downloadSummary.backend === "cpu"
              ? "localModel.cpuDownloadHint"
              : "localModel.gpuDownloadHint",
          )
        }}
      </p>
      <details class="download-details" data-testid="download-details">
        <summary>{{ t("localModel.details") }}</summary>
        <p v-if="step.title">{{ step.title }}</p>
        <p class="upstream-text">{{ step.message }}</p>
        <p v-for="note in notes" :key="note">{{ note }}</p>
      </details>
    </template>
    <template v-else>
      <h3 v-if="step.title">{{ step.title }}</h3>
      <p v-if="step.message" class="upstream-text">{{ step.message }}</p>
    </template>
    <template v-if="gatewayOwned">
      <progress :aria-label="t('localModel.waiting')" />
      <p v-if="!step.message">{{ t("localModel.waiting") }}</p>
    </template>
    <form v-else @submit.prevent="submit">
      <label v-if="step.type === 'text'">
        <span>{{ t("localModel.answer") }}</span>
        <input
          v-model="text"
          :type="step.sensitive ? 'password' : 'text'"
          :placeholder="step.placeholder"
          :disabled="disabled"
          autocomplete="off"
          @input="submitted = false"
        />
      </label>
      <label v-else-if="step.type === 'select'">
        <span>{{ t("localModel.chooseOption") }}</span>
        <select v-model="selection" :disabled="disabled">
          <option :value="null" disabled>{{ t("localModel.chooseOption") }}</option>
          <option v-for="(option, index) in step.options" :key="index" :value="index">
            {{ option.label }}{{ option.hint ? ` — ${option.hint}` : "" }}
          </option>
        </select>
      </label>
      <fieldset v-else-if="step.type === 'multiselect'" :disabled="disabled">
        <legend>{{ t("localModel.chooseOptions") }}</legend>
        <label v-for="(option, index) in step.options" :key="index" class="choice">
          <input v-model="selections" type="checkbox" :value="index" />
          {{ option.label }}{{ option.hint ? ` — ${option.hint}` : "" }}
        </label>
      </fieldset>
      <div v-if="step.type === 'confirm'" class="actions">
        <button type="button" :disabled="disabled || submitted" @click="send(false)">
          {{ t(downloadSummary ? "localModel.notNow" : "localModel.decline") }}
        </button>
        <button
          class="primary-action"
          type="button"
          :disabled="disabled || submitted"
          @click="send(true)"
        >
          {{ t(downloadSummary ? "localModel.startDownload" : "localModel.confirm") }}
        </button>
      </div>
      <button
        v-else
        class="primary-action"
        type="submit"
        :disabled="disabled || submitted || (step.type === 'select' && selection === null)"
      >
        {{ t("localModel.continue") }}
      </button>
    </form>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { t } from "@/i18n";
import type { LocalModelStep } from "../../../src/local-model-types";
import type { ManagedDownloadSummary } from "@/utils/local-model-presentation";

const props = defineProps<{
  step: LocalModelStep;
  disabled: boolean;
  downloadSummary?: ManagedDownloadSummary | null;
  notes?: string[];
}>();
const emit = defineEmits<{ answer: [value: unknown] }>();
const text = ref("");
const selection = ref<number | null>(null);
const selections = ref<number[]>([]);
const submitted = ref(false);
const gatewayOwned = computed(
  () =>
    props.step.type === "progress" ||
    props.step.executor === "gateway" ||
    (props.step.type === "action" && props.step.executor !== "client"),
);

watch(
  () => props.step.id,
  () => {
    text.value =
      !props.step.sensitive && typeof props.step.initialValue === "string"
        ? props.step.initialValue
        : "";
    selection.value = null;
    selections.value = [];
    submitted.value = false;
  },
  { immediate: true },
);
watch(
  () => props.disabled,
  (disabled) => {
    if (!disabled) submitted.value = false;
  },
);

function send(value?: unknown) {
  if (props.disabled || submitted.value || gatewayOwned.value) return;
  submitted.value = true;
  emit("answer", value);
  text.value = "";
  selection.value = null;
  selections.value = [];
}

function submit() {
  if (props.step.type === "confirm") return;
  if (props.step.type === "select") {
    if (selection.value !== null) send(props.step.options?.[selection.value]?.value);
  } else if (props.step.type === "multiselect") {
    send(selections.value.map((index) => props.step.options?.[index]?.value));
  } else {
    send(props.step.type === "text" ? text.value : undefined);
  }
}
</script>

<style scoped>
.upstream-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.wizard-step,
form,
label {
  display: grid;
  gap: 12px;
}
.choice,
.actions {
  display: flex;
  gap: 12px;
  align-items: center;
}
.actions {
  justify-content: flex-end;
  margin-top: 8px;
}
.model-heading {
  display: flex;
  align-items: center;
  gap: 14px;
}
.model-heading h3 {
  margin: 4px 0 0;
  font-size: 22px;
  line-height: 1.3;
}
.model-icon {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  border-radius: 12px;
  background: var(--smtc-background-ctrl-subtle-hover, #f3f4f6);
}
.model-icon svg {
  width: 28px;
  height: 28px;
}
.eyebrow,
.download-facts span,
.summary-hint {
  color: var(--smtc-foreground-ctrl-neutral-secondary-rest, #60646c);
  font-size: 13px;
}
.download-facts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 8px;
}
.download-facts > div {
  display: grid;
  gap: 4px;
}
.download-facts strong {
  font-size: 18px;
  font-weight: 600;
}
.summary-hint {
  margin: 0;
  line-height: 1.6;
}
.download-details {
  font-size: 13px;
  line-height: 1.6;
}
.download-details summary {
  cursor: pointer;
  color: var(--smtc-foreground-ctrl-neutral-secondary-rest, #60646c);
}
.download-details p {
  margin: 10px 0 0;
}
input,
select,
button,
fieldset {
  font: inherit;
  color: inherit;
  background: var(--smtc-background-card-on-primary-default-rest, #fff);
  border: 1px solid var(--smtc-stroke-divider-subtle, #ccc);
  border-radius: 8px;
  padding: 8px;
}
button {
  cursor: pointer;
  min-height: 38px;
  padding: 8px 16px;
}
.primary-action {
  background: var(--ux-brand-bg, #18181b);
  color: var(--ux-brand-fg, #fff);
  border-color: transparent;
}
:global(html.dark) .primary-action {
  background: #f2f2f2;
  color: #18181b;
}
:global(html.dark) .model-icon {
  background: rgba(255, 255, 255, 0.08);
}
button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
