<template>
  <header class="settings-section-header">
    <div class="settings-section-heading">
      <h3 class="settings-section-title">{{ title }}</h3>
      <p v-if="description" class="settings-section-description">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="settings-section-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<style scoped>
.settings-section-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 10px;
}

.settings-section-heading {
  flex: 1 1 240px;
  min-width: 0;
}

.settings-section-title {
  margin: 0;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
}

.settings-section-description {
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.settings-section-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  max-width: 100%;
}
</style>
