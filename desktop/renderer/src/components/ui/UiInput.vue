<template>
  <label
    class="ui-input"
    :class="[`ui-input--${size}`, { 'ui-input--invalid': invalid, 'ui-input--toggle': showPassword } ]"
  >
    <span v-if="$slots.label" class="ui-input__label"><slot name="label" /></span>
    <span class="ui-input__wrap">
      <input
        class="ui-input__control"
        :type="inputType"
        :placeholder="placeholder"
        :value="modelValue"
        :disabled="disabled"
        :autocomplete="autocomplete"
        @input="onInput"
        @blur="emit('blur', $event)"
        @focus="emit('focus', $event)"
        @keydown="emit('keydown', $event)"
      />
      <button
        v-if="showPassword"
        type="button"
        class="ui-input__toggle"
        :disabled="disabled"
        :aria-label="revealed ? 'Hide password' : 'Show password'"
        @click="revealed = !revealed"
      >
        <svg
          v-if="!revealed"
          class="ui-input__toggle-icon"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <svg
          v-else
          class="ui-input__toggle-icon"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="m3 3 18 18" />
          <path d="M10.58 10.58a2 2 0 0 0 2.83 2.83" />
          <path d="M9.88 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.8 21.8 0 0 1-5.08 5.55" />
          <path d="M6.61 6.61A21.77 21.77 0 0 0 1 12s4 8 11 8a10.94 10.94 0 0 0 5.39-1.39" />
        </svg>
      </button>
    </span>
    <span v-if="$slots.hint" class="ui-input__hint"><slot name="hint" /></span>
  </label>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "blur", event: FocusEvent): void;
  (e: "focus", event: FocusEvent): void;
  (e: "keydown", event: KeyboardEvent): void;
}>();

const props = withDefaults(
  defineProps<{
    modelValue: string;
    type?: string;
    placeholder?: string;
    size?: "sm" | "md" | "lg";
    invalid?: boolean;
    disabled?: boolean;
    showPassword?: boolean;
    autocomplete?: string;
  }>(),
  {
    type: "text",
    placeholder: "",
    size: "md",
    invalid: false,
    disabled: false,
    showPassword: false,
    autocomplete: "off",
  },
);

const revealed = ref(false);
const inputType = computed(() => {
  if (props.showPassword) {
    return revealed.value ? "text" : "password";
  }
  return props.type;
});

function onInput(event: Event) {
  const target = event.target as HTMLInputElement;
  emit("update:modelValue", target.value);
}
</script>

<style scoped>
.ui-input {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.ui-input__label {
  color: var(--text-secondary, #636878);
  font-size: 13px;
  font-weight: 500;
}

.ui-input__wrap {
  position: relative;
  display: block;
}

.ui-input__control {
  width: 100%;
  border: 1px solid var(--border-default, var(--border, #e8eaef));
  background: var(--surface-panel, var(--bg-secondary, #ffffff));
  color: var(--text-primary, #1e1f25);
  border-radius: var(--radius-lg, 12px);
  font-family: inherit;
  outline: none;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    background 0.15s ease;
}

.ui-input__control::placeholder {
  color: var(--text-muted, #a3a8b8);
}

.ui-input--sm .ui-input__control {
  height: 34px;
  padding: 0 10px;
  border-radius: var(--radius-md, 8px);
  font-size: 13px;
}

.ui-input--md .ui-input__control {
  height: 40px;
  padding: 0 12px;
  font-size: 14px;
}

.ui-input--lg .ui-input__control {
  height: 46px;
  padding: 0 14px;
  font-size: 15px;
}

.ui-input--toggle .ui-input__control {
  padding-right: 58px;
}

.ui-input__control:focus-visible {
  border-color: color-mix(in srgb, var(--action-primary, #18181b) 45%, transparent);
  box-shadow: 0 0 0 3px var(--focus-ring, rgba(0, 0, 0, 0.18));
}

.ui-input__control:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.ui-input--invalid .ui-input__control {
  border-color: var(--status-danger, #dc2626);
}

.ui-input--invalid .ui-input__control:focus-visible {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--status-danger, #dc2626) 28%, transparent);
}

.ui-input__toggle {
  position: absolute;
  top: 50%;
  right: 10px;
  transform: translateY(-50%);
  border: 0;
  background: transparent;
  color: var(--text-secondary, #636878);
  cursor: pointer;
  line-height: 0;
  padding: 2px;
}

.ui-input__toggle:hover:not(:disabled) {
  color: var(--text-primary, #1e1f25);
}

.ui-input__toggle:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.ui-input__hint {
  color: var(--text-muted, #a3a8b8);
  font-size: 12px;
}

.ui-input__toggle-icon {
  display: block;
}
</style>
