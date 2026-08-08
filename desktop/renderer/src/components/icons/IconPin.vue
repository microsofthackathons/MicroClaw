<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="m15 4.5-4 4-4.5 1.5L5 11.5l7.5 7.5 1.5-1.5 1.5-4.5 4-4" />
    <path d="M9 15 4.5 19.5" />
    <path d="m14.5 4 5.5 5.5" />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 14 });
</script>
