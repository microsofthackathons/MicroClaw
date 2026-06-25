<template>
  <div
    v-if="modelValue"
    class="ui-dialog-overlay"
    @mousedown.self="onOverlayMouseDown"
  >
    <section class="ui-dialog" :class="[`ui-dialog--${size}`, `ui-dialog--${variant}`]" role="dialog" aria-modal="true">
      <header
        v-if="$slots.header || title || showClose"
        class="ui-dialog__header"
        :class="[`ui-dialog__header--${titleAlign}`]"
      >
        <slot name="header">
          <h2 v-if="title" class="ui-dialog__title">{{ title }}</h2>
        </slot>
        <button
          v-if="showClose"
          type="button"
          class="ui-dialog__close"
          aria-label="Close"
          @click="close"
        >
          <span aria-hidden="true">x</span>
        </button>
      </header>

      <div class="ui-dialog__content">
        <slot />
      </div>

      <footer v-if="$slots.footer" class="ui-dialog__footer">
        <slot name="footer" />
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "close"): void;
}>();

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title?: string;
    size?: "sm" | "md" | "lg";
    variant?: "default" | "elevated";
    titleAlign?: "left" | "center";
    closeOnOverlay?: boolean;
    showClose?: boolean;
  }>(),
  {
    title: "",
    size: "md",
    variant: "default",
    titleAlign: "left",
    closeOnOverlay: true,
    showClose: true,
  },
);

function close() {
  emit("update:modelValue", false);
  emit("close");
}

function onOverlayMouseDown() {
  if (props.closeOnOverlay) close();
}
</script>

<style scoped>
.ui-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: grid;
  place-items: center;
  background: var(--surface-overlay, rgba(255, 255, 255, 0.72));
  backdrop-filter: blur(8px);
  padding: 20px;
}

.ui-dialog {
  width: min(100%, 520px);
  border-radius: var(--radius-xl, 20px);
  background: var(--surface-panel, var(--bg-secondary, #ffffff));
  color: var(--text-primary, #1e1f25);
  border: 1px solid var(--border-default, var(--border, #e8eaef));
}

.ui-dialog--elevated {
  box-shadow: var(--card-shadow-hover, 0 14px 36px rgba(0, 0, 0, 0.13));
}

.ui-dialog--sm {
  max-width: 420px;
}

.ui-dialog--md {
  max-width: 520px;
}

.ui-dialog--lg {
  max-width: 680px;
}

.ui-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: relative;
  gap: 12px;
  padding: 20px 22px 10px;
}

.ui-dialog__header--center {
  justify-content: center;
}

.ui-dialog__header--center .ui-dialog__title {
  text-align: center;
}

.ui-dialog__title {
  font-size: 20px;
  line-height: 1.2;
  font-weight: 700;
}

.ui-dialog__close {
  position: absolute;
  right: 22px;
  top: 50%;
  transform: translateY(-50%);
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 0;
  background: transparent;
  color: var(--text-secondary, #636878);
  cursor: pointer;
}

.ui-dialog__close:hover {
  background: var(--surface-hover, #f5f6f8);
  color: var(--text-primary, #1e1f25);
}

.ui-dialog__content {
  padding: 12px 22px 22px;
}

.ui-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 0 22px 20px;
}
</style>
