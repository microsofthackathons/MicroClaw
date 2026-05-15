<template>
  <div class="agent-avatar" :style="{ width: resolvedSize + 'px', height: resolvedSize + 'px' }">
    <img v-if="src" :src="src" :alt="name" loading="lazy" class="agent-avatar-img" />
    <span v-else class="agent-avatar-fallback" :style="{ fontSize: resolvedSize * 0.4 + 'px' }">
      {{ initial }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  src?: string;
  name: string;
  size?: number;
}>();

const resolvedSize = computed(() => props.size ?? 36);
const initial = computed(() => props.name.charAt(0).toUpperCase());
</script>

<style scoped>
.agent-avatar {
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  background: var(--bg-tertiary);
}
.agent-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.agent-avatar-fallback {
  color: var(--text-muted);
  font-weight: 600;
  line-height: 1;
}
</style>
