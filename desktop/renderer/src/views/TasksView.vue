<template>
  <div class="tasks-view">
    <div class="view-header">
      <h2>{{ t("tasks.title") }}</h2>
      <p class="view-desc">{{ t("tasks.desc") }}</p>
      <el-button
        size="small"
        :loading="taskStore.loading"
        @click="taskStore.fetchTasks()"
        style="margin-top: 8px"
        >{{ t("tasks.refresh") }}</el-button
      >
    </div>

    <div v-if="taskStore.error" class="empty-state">
      <div class="empty-title">{{ t("tasks.loadFailed") }}</div>
      <div class="empty-desc">{{ taskStore.error }}</div>
    </div>

    <div v-else-if="taskStore.loading" class="empty-state">
      <div class="empty-title">{{ t("tasks.loading") }}</div>
    </div>

    <div v-else-if="taskStore.tasks.length === 0" class="empty-state">
      <div class="empty-title">{{ t("tasks.empty") }}</div>
      <div class="empty-desc">
        {{ t("tasks.emptyDesc") }}
      </div>
    </div>

    <el-table
      v-else
      :data="taskStore.tasks"
      style="width: 100%"
      :header-cell-style="{ background: 'var(--bg-secondary)' }"
    >
      <el-table-column prop="name" :label="t('tasks.colName')" />
      <el-table-column prop="cron" :label="t('tasks.colCron')" width="180" />
      <el-table-column prop="agentId" :label="t('tasks.colAgent')" width="150" />
      <el-table-column :label="t('tasks.colStatus')" width="100">
        <template #default="{ row }">
          <el-tag :type="row.enabled ? 'success' : 'info'" size="small">
            {{ row.enabled ? t("tasks.enabled") : t("tasks.disabled") }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('tasks.colLastRun')" width="160">
        <template #default="{ row }">
          <span v-if="row.lastRun">{{ new Date(row.lastRun).toLocaleString(locale) }}</span>
          <span v-else class="text-muted">—</span>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup lang="ts">
import { onActivated, onMounted } from "vue";
import { useTaskStore } from "@/stores/tasks";
import { t, locale } from "@/i18n";

const taskStore = useTaskStore();

onMounted(() => {
  taskStore.fetchTasks();
});

onActivated(() => {
  taskStore.fetchTasks();
});
</script>

<style scoped>
.tasks-view {
  height: 100%;
  overflow-y: auto;
  padding: 24px 32px;
}

.view-header {
  margin-bottom: 24px;
}

.view-header h2 {
  font-size: 20px;
  font-weight: 600;
}

.view-desc {
  color: var(--text-secondary);
  font-size: 13px;
  margin-top: 4px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 0;
  color: var(--text-muted);
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 12px;
}

.empty-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-secondary);
}

.empty-desc {
  font-size: 13px;
  margin-top: 8px;
  text-align: center;
  max-width: 300px;
}

.text-muted {
  color: var(--text-muted);
}
</style>
