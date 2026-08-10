<template>
  <section class="docker-panel" :class="{ 'docker-panel--compact': compact }">
    <div class="docker-header">
      <div>
        <h3>{{ t("dockerPrep.title") }}</h3>
        <p>{{ t("dockerPrep.description") }}</p>
      </div>
      <el-button size="small" :loading="checking" data-test="docker-refresh" @click="refresh">
        {{ t("dockerPrep.refresh") }}
      </el-button>
    </div>

    <div class="docker-notice">{{ t("dockerPrep.appContainerNotice") }}</div>

    <div v-if="result" class="docker-checks">
      <div v-for="check in checks" :key="check.key" class="docker-check">
        <span class="docker-status" :class="`docker-status--${check.state.status}`"></span>
        <div>
          <strong>{{ t(check.label) }}</strong>
          <p>{{ reasonText(check.state.reason) }}</p>
        </div>
      </div>
    </div>
    <div v-else-if="errorMessage" class="docker-error">{{ errorMessage }}</div>
    <div v-else class="docker-placeholder">{{ t("dockerPrep.notChecked") }}</div>

    <div class="docker-guidance">
      <p>{{ t("dockerPrep.adminReboot") }}</p>
      <p>{{ t("dockerPrep.licensing") }}</p>
      <div class="docker-actions">
        <el-button size="small" plain data-test="wsl-docs" @click="openExternal(WSL_DOCS)">
          {{ t("dockerPrep.openWslDocs") }}
        </el-button>
        <el-button size="small" plain data-test="docker-docs" @click="openExternal(DOCKER_DOCS)">
          {{ t("dockerPrep.openDockerDocs") }}
        </el-button>
      </div>
      <small>{{ t("dockerPrep.linkNotice") }}</small>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { t } from "@/i18n";

defineProps<{ compact?: boolean }>();

const WSL_DOCS = "https://learn.microsoft.com/windows/wsl/install";
const DOCKER_DOCS = "https://docs.docker.com/desktop/setup/install/windows-install/";
const result = ref<DockerPrerequisites | null>(null);
const checking = ref(false);
const errorMessage = ref("");

const checks = computed(() => {
  if (!result.value) return [];
  return [
    { key: "windows", label: "dockerPrep.windows", state: result.value.windows },
    { key: "wslCommand", label: "dockerPrep.wslCommand", state: result.value.wslCommand },
    { key: "wsl2", label: "dockerPrep.wsl2", state: result.value.wsl2 },
    { key: "dockerCli", label: "dockerPrep.dockerCli", state: result.value.dockerCli },
    { key: "dockerDaemon", label: "dockerPrep.dockerDaemon", state: result.value.dockerDaemon },
    {
      key: "linuxContainers",
      label: "dockerPrep.linuxContainers",
      state: result.value.linuxContainers,
    },
  ];
});

function reasonText(reason: DockerPrerequisiteReason): string {
  return t(`dockerPrep.reason.${reason}`);
}

async function refresh(): Promise<void> {
  checking.value = true;
  errorMessage.value = "";
  try {
    result.value = await window.openclaw.dockerPrerequisites.check();
  } catch (error) {
    result.value = null;
    errorMessage.value = t("dockerPrep.checkFailed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    checking.value = false;
  }
}

function openExternal(url: string): void {
  void window.openclaw.shell.openExternal(url);
}

onMounted(() => void refresh());
</script>

<style scoped>
.docker-panel {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-secondary);
  text-align: left;
}

.docker-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}

.docker-header h3 {
  margin: 0 0 4px;
  font-size: 15px;
}

.docker-header p,
.docker-guidance p,
.docker-check p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.45;
}

.docker-notice {
  margin-top: 12px;
  padding: 10px;
  border-radius: 8px;
  background: rgba(59, 130, 246, 0.08);
  color: var(--text-primary);
  font-size: 12px;
}

.docker-checks {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.docker-check {
  display: flex;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.docker-check strong {
  display: block;
  margin-bottom: 2px;
  font-size: 12px;
}

.docker-status {
  width: 8px;
  height: 8px;
  margin-top: 4px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #f59e0b;
}

.docker-status--ready {
  background: #22c55e;
}

.docker-status--missing,
.docker-status--unsupported,
.docker-status--error {
  background: #ef4444;
}

.docker-guidance {
  margin-top: 12px;
}

.docker-guidance p + p {
  margin-top: 5px;
}

.docker-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0 6px;
}

.docker-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.docker-guidance small,
.docker-placeholder,
.docker-error {
  color: var(--text-muted);
  font-size: 11px;
}

.docker-error {
  margin-top: 12px;
  color: var(--danger, #ef4444);
}

.docker-panel--compact {
  margin-top: 18px;
}

@media (max-width: 560px) {
  .docker-checks {
    grid-template-columns: 1fr;
  }
}
</style>
