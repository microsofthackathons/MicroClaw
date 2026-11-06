<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M3 10a9 9 0 1 1 2.7 8.4" />
    <path d="M3 4v6h6" />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number; strokeWidth?: number }>(), { size: 14, strokeWidth: 2 });
</script>
