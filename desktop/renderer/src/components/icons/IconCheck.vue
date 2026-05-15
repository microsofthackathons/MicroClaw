<template>
  <svg :width="size" :height="size" viewBox="0 0 20 20" fill="none">
    <circle cx="10" cy="10" r="10" fill="currentColor" />
    <path
      d="M6 10.5l2.5 2.5 5.5-5.5"
      stroke="#fff"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 20 });
</script>
