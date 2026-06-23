<template>
  <button
    :type="type"
    class="ui-button"
    :class="[
      `ui-button--${variant}`,
      `ui-button--${size}`,
      {
        'ui-button--block': block,
        'ui-button--loading': loading,
      },
    ]"
    :disabled="disabled || loading"
  >
    <span v-if="loading" class="ui-button__spinner" aria-hidden="true"></span>
    <span class="ui-button__label"><slot /></span>
  </button>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: "default" | "secondary" | "outline" | "ghost" | "destructive";
    size?: "sm" | "md" | "lg" | "icon";
    type?: "button" | "submit" | "reset";
    block?: boolean;
    loading?: boolean;
    disabled?: boolean;
  }>(),
  {
    variant: "default",
    size: "md",
    type: "button",
    block: false,
    loading: false,
    disabled: false,
  },
);
</script>

<style scoped>
.ui-button {
  --btn-bg: var(--action-primary, #18181b);
  --btn-fg: var(--action-primary-foreground, #ffffff);
  --btn-border: transparent;

  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: var(--radius-pill, 999px);
  border: 1px solid var(--btn-border);
  background: var(--btn-bg);
  color: var(--btn-fg);
  font-family: inherit;
  font-weight: 600;
  letter-spacing: 0.2px;
  line-height: 1;
  cursor: pointer;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    opacity 0.15s ease,
    transform 0.08s ease;
}

.ui-button:hover:not(:disabled) {
  opacity: 0.92;
}

.ui-button:active:not(:disabled) {
  transform: translateY(1px);
}

.ui-button:focus-visible {
  outline: 2px solid var(--focus-ring, rgba(0, 0, 0, 0.22));
  outline-offset: 2px;
}

.ui-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ui-button--sm {
  height: 34px;
  padding: 0 14px;
  border-radius: var(--radius-md, 8px);
  font-size: 13px;
}

.ui-button--md {
  height: 40px;
  padding: 0 16px;
  border-radius: var(--radius-lg, 12px);
  font-size: 14px;
}

.ui-button--lg {
  height: 48px;
  padding: 0 22px;
  font-size: 15px;
}

.ui-button--icon {
  width: 40px;
  height: 40px;
  padding: 0;
  border-radius: var(--radius-lg, 12px);
}

.ui-button--block {
  width: 100%;
}

.ui-button--default {
  --btn-bg: var(--action-primary, #18181b);
  --btn-fg: var(--action-primary-foreground, #ffffff);
  --btn-border: transparent;
}

.ui-button--secondary {
  --btn-bg: var(--surface-hover, #f5f6f8);
  --btn-fg: var(--text-primary, #1e1f25);
  --btn-border: var(--border-default, var(--border, #e8eaef));
}

.ui-button--outline {
  --btn-bg: transparent;
  --btn-fg: var(--text-primary, #1e1f25);
  --btn-border: var(--border-default, var(--border, #e8eaef));
}

.ui-button--ghost {
  --btn-bg: transparent;
  --btn-fg: var(--text-secondary, #636878);
  --btn-border: transparent;
}

.ui-button--ghost:hover:not(:disabled) {
  background: var(--surface-hover, #f5f6f8);
  opacity: 1;
}

.ui-button--destructive {
  --btn-bg: var(--status-danger, #dc2626);
  --btn-fg: #ffffff;
  --btn-border: transparent;
}

.ui-button__spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, currentColor 40%, transparent);
  border-top-color: currentColor;
  animation: ui-spin 0.8s linear infinite;
}

.ui-button__label {
  display: inline-flex;
  align-items: center;
}

@keyframes ui-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
