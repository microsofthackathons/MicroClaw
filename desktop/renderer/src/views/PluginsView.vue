<template>
  <div class="plugins-view">
    <div class="view-header">
      <button class="back-btn" :title="t('plugins.back')" @click="router.back()">←</button>
      <div>
        <h2>{{ t("plugins.title") }}</h2>
        <p>{{ t("plugins.desc") }}</p>
      </div>
    </div>
    <WeixinConnectionCard />
  </div>
</template>

<script setup lang="ts">
import { useRouter } from "vue-router";
import { t } from "@/i18n";
import WeixinConnectionCard from "@/components/WeixinConnectionCard.vue";
const router = useRouter();
</script>

<style scoped>
.plugins-view {
  height: 100%;
  overflow-y: auto;
  padding: 24px 32px;
  max-width: 720px;
}
.view-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 24px;
}
.view-header h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
.view-header p {
  color: var(--text-muted);
  font-size: 13px;
}
.back-btn {
  background: none;
  border: none;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 22px;
}
</style>
