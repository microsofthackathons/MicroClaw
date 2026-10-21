<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { t } from "@/i18n";
import {
  WINDOWS_NODE_MXC_CAPABILITY_DISCLOSURE,
  type WindowsNodeMxcDisclosureTargetMode,
} from "../../../src/windows-node-mxc-disclosure";

const props = defineProps<{
  modelValue: boolean;
  targetMode: WindowsNodeMxcDisclosureTargetMode | null;
  submitting?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [visible: boolean];
  accept: [];
  cancel: [];
}>();

const enableButton = ref<{ $el?: HTMLElement } | null>(null);
const accepting = ref(false);
const busy = computed(() => props.submitting || accepting.value);
const targetModeLabel = computed(() =>
  props.targetMode === "limited-dacl"
    ? t("settings.windowsNodeMxcModeLimited")
    : t("settings.windowsNodeMxcModeFull"),
);
const modeNote = computed(() =>
  props.targetMode === "limited-dacl"
    ? t("settings.windowsNodeMxcConsent.limitedNote")
    : t("settings.windowsNodeMxcConsent.fullNote"),
);

function cancel() {
  if (busy.value) return;
  emit("update:modelValue", false);
  emit("cancel");
}

function accept() {
  if (!props.targetMode || busy.value) return;
  accepting.value = true;
  emit("accept");
}

function handleBeforeClose(done: () => void) {
  if (busy.value) return;
  done();
  emit("cancel");
}

async function focusPrimaryAction() {
  await nextTick();
  enableButton.value?.$el?.focus();
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) accepting.value = false;
  },
);
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    class="mxc-consent-dialog"
    :title="t('settings.windowsNodeMxcConsent.title', { mode: targetModeLabel })"
    width="680"
    :before-close="handleBeforeClose"
    :close-on-click-modal="!busy"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    aria-describedby="windows-node-mxc-consent-summary"
    data-testid="mxc-capability-consent"
    @opened="focusPrimaryAction"
  >
    <p id="windows-node-mxc-consent-summary" class="mxc-consent-summary">
      {{ t("settings.windowsNodeMxcConsent.summary", { mode: targetModeLabel }) }}
    </p>
    <section
      v-for="group in WINDOWS_NODE_MXC_CAPABILITY_DISCLOSURE.groups"
      :key="group.id"
      class="mxc-consent-group"
      :data-testid="`mxc-consent-group-${group.id}`"
    >
      <h3>{{ t(group.titleKey) }}</h3>
      <p>{{ t(group.summaryKey) }}</p>
    </section>
    <p class="mxc-consent-mode-note">{{ modeNote }}</p>
    <p class="mxc-consent-repeat-note">
      {{ t("settings.windowsNodeMxcConsent.repeatNote") }}
    </p>
    <template #footer>
      <el-button data-testid="mxc-consent-cancel" :disabled="busy" @click="cancel">
        {{ t("common.cancel") }}
      </el-button>
      <el-button
        ref="enableButton"
        type="primary"
        data-testid="mxc-consent-accept"
        :loading="busy"
        :disabled="!targetMode || busy"
        @click="accept"
      >
        {{ t("settings.windowsNodeMxcConsent.enable") }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.mxc-consent-summary,
.mxc-consent-mode-note,
.mxc-consent-repeat-note {
  margin: 0 0 14px;
  color: var(--text-secondary);
  line-height: 1.55;
}

.mxc-consent-group {
  margin: 14px 0;
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
}

.mxc-consent-group h3 {
  margin: 0 0 8px;
  color: var(--text-primary);
  font-size: 14px;
}

.mxc-consent-group p {
  margin: 0;
  color: var(--text-secondary);
  line-height: 1.5;
}

.mxc-consent-mode-note {
  color: var(--warning, #b45309);
  font-weight: 600;
}

.mxc-consent-repeat-note {
  margin-bottom: 0;
  font-size: 12px;
}
</style>
