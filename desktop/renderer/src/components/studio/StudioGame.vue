<template>
  <div ref="gameContainer" class="studio-game-container"></div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import Phaser from "phaser";
import { StudioScene } from "./StudioScene";
import { CANVAS_WIDTH, CANVAS_HEIGHT } from "./StudioLayout";

const props = defineProps<{
  width?: number;
  height?: number;
}>();

const gameContainer = ref<HTMLDivElement>();
let game: Phaser.Game | null = null;
let visibilityObserver: IntersectionObserver | null = null;
/** Whether the container element is intersecting the viewport. */
let elementVisible = false;
/** Whether the document/window is visible to the user. */
let documentVisible = !document.hidden;

function syncPauseState() {
  if (!game) return;
  if (elementVisible && documentVisible) {
    game.resume();
  } else {
    game.pause();
  }
}

function onDocumentVisibilityChange() {
  documentVisible = !document.hidden;
  syncPauseState();
}

onMounted(() => {
  if (!gameContainer.value) return;

  const w = props.width || CANVAS_WIDTH;
  const h = props.height || CANVAS_HEIGHT;

  game = new Phaser.Game({
    type: Phaser.CANVAS,
    width: w,
    height: h,
    parent: gameContainer.value,
    scene: [StudioScene],
    pixelArt: true,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      // Let Phaser compute the size from parent; CSS sets the parent width
      width: w,
      height: h,
    },
    fps: {
      target: 12,
      forceSetTimeOut: true,
    },
    backgroundColor: "#2d2d3d",
    audio: {
      noAudio: true,
    },
    // Prevent Phaser from stealing focus and keyboard events from the chat compose
    input: {
      keyboard: {
        target: gameContainer.value,
      },
    },
  });

  // Pause/resume the game loop when the container is hidden/shown.
  // The component stays alive via v-show so we cannot rely on mount/unmount.
  visibilityObserver = new IntersectionObserver(
    ([entry]) => {
      elementVisible = entry.isIntersecting;
      syncPauseState();
    },
    { threshold: 0 },
  );
  visibilityObserver.observe(gameContainer.value);

  // Also pause when the window is minimized or the tab is backgrounded.
  document.addEventListener("visibilitychange", onDocumentVisibilityChange);
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onDocumentVisibilityChange);
  visibilityObserver?.disconnect();
  visibilityObserver = null;
  if (game) {
    game.destroy(true);
    game = null;
  }
});
</script>

<style scoped>
.studio-game-container {
  width: 100%;
  height: 100%;
}

.studio-game-container :deep(canvas) {
  width: 100% !important;
  height: 100% !important;
  display: block;
  border-radius: 14px;
}
</style>
