import { ref } from "vue";

// Module-level reactive ref so any component can toggle / subscribe.
const isOpen = ref(false);

export function useUsagePanel() {
  function open() {
    isOpen.value = true;
  }
  function close() {
    isOpen.value = false;
  }
  function toggle() {
    isOpen.value = !isOpen.value;
  }
  return { isOpen, open, close, toggle };
}
