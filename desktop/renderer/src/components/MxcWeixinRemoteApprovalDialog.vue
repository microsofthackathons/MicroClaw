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
      <label
        v-if="options.eligibleOwners.length > 0"
        class="mxc-weixin-approval-choice"
      >
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

      <label
        v-if="choice === 'enabled' && options.eligibleOwners.length > 0"
        class="mxc-weixin-approval-owner"
      >
        <span>{{ t("settings.weixinRemoteApprovalActivationAccount") }}</span>
        <select
          v-model="selectedOwnerKey"
          :disabled="submitting"
          data-testid="mxc-weixin-approval-owner"
        >
          <option value="" disabled>
            {{ t("settings.weixinRemoteApprovalActivationSelectAccount") }}
          </option>
          <option
            v-for="owner in options.eligibleOwners"
            :key="ownerKey(owner)"
            :value="ownerKey(owner)"
          >
            {{ owner.userId }} ({{ owner.accountId }})
          </option>
        </select>
      </label>

      <div
        v-if="options.eligibleOwners.length === 0"
        class="mxc-weixin-approval-ineligible-summary"
        data-testid="mxc-weixin-approval-no-eligible"
      >
        {{ t("settings.weixinRemoteApprovalActivationNoEligible") }}
      </div>
      <ul
        v-if="options.ineligibleAccounts.length > 0"
        class="mxc-weixin-approval-ineligible-list"
      >
        <li
          v-for="account in options.ineligibleAccounts"
          :key="`${account.accountId}:${account.userId ?? ''}`"
        >
          <code>{{ account.userId ?? account.accountId }}</code>
          <span>{{ ineligibleReason(account.reason) }}</span>
        </li>
      </ul>
    </div>
    <template #footer>
      <el-button
        data-testid="mxc-weixin-approval-cancel"
        :disabled="submitting"
        @click="cancel"
      >
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
type ActivationOwner = ActivationOptions["eligibleOwners"][number];
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
const selectedOwnerKey = ref("");
let submitted = false;

const ownerKey = (owner: ActivationOwner) => JSON.stringify([owner.accountId, owner.userId]);

watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) return;
    choice.value = "disabled";
    selectedOwnerKey.value = "";
    submitted = false;
  },
);

const selectedOwner = computed(
  () =>
    props.options?.eligibleOwners.find(
      (owner) => ownerKey(owner) === selectedOwnerKey.value,
    ) ?? null,
);

const confirmDisabled = computed(
  () => props.submitting === true || (choice.value === "enabled" && !selectedOwner.value),
);

function ineligibleReason(reason: ActivationOptions["ineligibleAccounts"][number]["reason"]) {
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
  if (choice.value === "enabled" && selectedOwner.value) {
    emit("confirm", { enabled: true, owner: selectedOwner.value });
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

.mxc-weixin-approval-owner select {
  width: 100%;
  min-height: 36px;
  padding: 6px 8px;
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-card);
}

.mxc-weixin-approval-ineligible-summary {
  margin-top: 10px;
  color: var(--warning-color, #e6a23c);
}

.mxc-weixin-approval-ineligible-list {
  display: grid;
  gap: 6px;
  margin: 8px 0 0;
  padding-left: 20px;
}

.mxc-weixin-approval-ineligible-list li {
  display: grid;
  gap: 2px;
}

.mxc-weixin-approval-ineligible-list code {
  overflow-wrap: anywhere;
}
</style>
