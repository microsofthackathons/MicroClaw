<template>
  <div class="channels-view" :class="{ embedded }">
    <div class="view-header">
      <h2 :class="{ 'settings-group-title': embedded }">{{ t("channels.title") }}</h2>
    </div>
    <WeixinConnectionCard show-messages />
    <div v-if="otherChannels.length" class="channel-grid">
      <div v-for="channel in otherChannels" :key="channel.id" class="channel-card">
        <div class="channel-icon">{{ channel.icon }}</div>
        <div class="channel-info">
          <div class="channel-name">{{ channel.name }}</div>
          <div class="channel-type">{{ channel.type }}</div>
        </div>
        <div class="channel-status" :class="channel.connected ? 'online' : 'offline'">
          {{ channel.connected ? t("channels.connected") : t("channels.disconnected") }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { t } from "@/i18n";
import { useChannelStore } from "@/stores/channels";
import WeixinConnectionCard from "@/components/WeixinConnectionCard.vue";

withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false });
const channelStore = useChannelStore();
const otherChannels = computed(() =>
  channelStore.channels.filter((channel) => channel.id !== "openclaw-weixin"),
);
onMounted(() => {
  void channelStore.fetchChannels();
});
</script>

<style scoped>
.channels-view {
  height: 100%;
  overflow-y: auto;
  padding: 24px 32px;
  max-width: 720px;
  font-family: inherit;
}
.channels-view.embedded {
  height: auto;
  overflow: visible;
  padding: 0;
  max-width: none;
}
.view-header {
  margin-bottom: 24px;
}
.channels-view.embedded .view-header {
  margin-bottom: 8px;
}
.view-header h2 {
  font-size: 20px;
  font-weight: 600;
}
.view-header h2.settings-group-title {
  margin: 0;
  padding-left: 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.07em;
}
.channel-grid {
  display: grid;
  gap: 12px;
  margin-top: 20px;
}
.channel-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border: 1px solid var(--border);
  border-radius: 12px;
}
.channel-icon {
  font-size: 24px;
}
.channel-info {
  flex: 1;
}
.channel-name {
  font-size: 14px;
}
.channel-type,
.channel-status {
  font-size: 12px;
  color: var(--text-muted);
}
.channel-status.online {
  color: var(--success-color, #18a874);
}
</style>
