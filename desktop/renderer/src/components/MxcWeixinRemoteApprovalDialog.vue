<template>
  <el-dialog
    :model-value="modelValue"
    :title="t('settings.weixinRemoteApprovalActivationTitle')"
    width="600"
    :close-on-click-modal="!submitting"
    :close-on-press-escape="!submitting"
    :show-close="!submitting"
    :before-close="beforeClose"
  >
    <div v-if="options" class="mxc-weixin-approval-dialog">
      <p>{{ t("settings.weixinRemoteApprovalActivationIntro") }}</p>
      <div class="mxc-weixin-approval-risk">
        <strong>{{ t("settings.weixinRemoteApprovalRiskTitle") }}</strong>
        <p>{{ t("settings.weixinRemoteApprovalRisk") }}</p>
        <p>{{ t("settings.weixinRemoteApprovalOnceOnly") }}</p>
      </div>

      <label class="mxc-weixin-approval-choice">
        <input
          v-model="choice"
          type="radio"
          value="disabled"
          :disabled="submitting"
          data-testid="mxc-weixin-approval-disabled"
        />
        <span>
          <strong>{{ t("settings.weixinRemoteApprovalActivationDisabled") }}</strong>
          <small>{{ t("settings.weixinRemoteApprovalActivationDisabledDesc") }}</small>
        </span>
      </label>
      <label v-if="options.enableAvailable && options.account" class="mxc-weixin-approval-choice">
        <input
          v-model="choice"
          type="radio"
          value="enabled"
          :disabled="submitting"
          data-testid="mxc-weixin-approval-enabled"
        />
        <span>
          <strong>{{ t("settings.weixinRemoteApprovalActivationEnabled") }}</strong>
          <small>{{ t("settings.weixinRemoteApprovalActivationEnabledDesc") }}</small>
        </span>
      </label>

      <div
        v-if="options.account"
        class="mxc-weixin-approval-owner"
        data-testid="mxc-weixin-approval-owner"
      >
        <strong>{{ t("settings.weixinRemoteApprovalActivationIdentity") }}</strong>
        <span
          >{{ t("plugins.accountId") }}: <code>{{ options.account.accountId }}</code></span
        >
        <span
          >{{ t("plugins.weixinUserId") }}: <code>{{ options.account.userId }}</code></span
        >
      </div>

      <div
        v-if="!options.enableAvailable"
        class="mxc-weixin-approval-ineligible-summary"
        data-testid="mxc-weixin-approval-no-eligible"
      >
        {{ t("settings.weixinRemoteApprovalActivationNoEligible") }}
        <span v-if="options.unavailableReason">
          {{ ineligibleReason(options.unavailableReason) }}
        </span>
      </div>
    </div>
    <template #footer>
      <el-button data-testid="mxc-weixin-approval-cancel" :disabled="submitting" @click="cancel">
        {{ t("common.cancel") }}
      </el-button>
      <el-button
        type="warning"
        data-testid="mxc-weixin-approval-confirm"
        :loading="submitting"
        :disabled="confirmDisabled"
        @click="confirm"
      >
        {{
          choice === "enabled"
            ? t("settings.weixinRemoteApprovalActivationEnableAndContinue")
            : t("settings.weixinRemoteApprovalActivationContinueDisabled")
        }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { t } from "@/i18n";

type ActivationOptions = Awaited<
  ReturnType<typeof window.openclaw.windowsNodeMxc.getWeixinRemoteApprovalActivationOptions>
>;
type ActivationOwner = NonNullable<ActivationOptions["account"]>;
type ActivationSelection =
  | { enabled: false }
  | {
      enabled: true;
      owner: ActivationOwner;
    };

const props = defineProps<{
  modelValue: boolean;
  options: ActivationOptions | null;
  submitting?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  confirm: [selection: ActivationSelection];
  cancel: [];
}>();

const choice = ref<"disabled" | "enabled">("disabled");
let submitted = false;

watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) return;
    choice.value = "disabled";
    submitted = false;
  },
);

const confirmDisabled = computed(
  () =>
    props.submitting === true ||
    (choice.value === "enabled" && (!props.options?.enableAvailable || !props.options.account)),
);

function ineligibleReason(reason: NonNullable<ActivationOptions["unavailableReason"]>) {
  return t(`settings.weixinRemoteApprovalActivationIneligible.${reason}`);
}

function cancel() {
  if (props.submitting || submitted) return;
  emit("update:modelValue", false);
  emit("cancel");
}

function beforeClose(done: () => void) {
  if (props.submitting || submitted) return;
  cancel();
  done();
}

function confirm() {
  if (confirmDisabled.value || submitted) return;
  submitted = true;
  if (choice.value === "enabled" && props.options?.account) {
    emit("confirm", { enabled: true, owner: props.options.account });
    return;
  }
  emit("confirm", { enabled: false });
}
</script>

<style scoped>
.mxc-weixin-approval-dialog > p {
  margin-top: 0;
}

.mxc-weixin-approval-risk {
  margin: 12px 0;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--warning-color, #e6a23c) 40%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--warning-color, #e6a23c) 7%, transparent);
}

.mxc-weixin-approval-risk p {
  margin: 6px 0 0;
}

.mxc-weixin-approval-choice {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin: 10px 0;
  cursor: pointer;
}

.mxc-weixin-approval-choice input {
  margin-top: 4px;
}

.mxc-weixin-approval-choice span {
  display: grid;
  gap: 3px;
}

.mxc-weixin-approval-choice small {
  color: var(--text-secondary);
}

.mxc-weixin-approval-owner {
  display: grid;
  gap: 6px;
  margin: 10px 0 12px 26px;
}

.mxc-weixin-approval-owner span {
  overflow-wrap: anywhere;
}

.mxc-weixin-approval-ineligible-summary {
  margin-top: 10px;
  color: var(--warning-color, #e6a23c);
}
</style>
