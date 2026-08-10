<template>
  <div class="gateway-loading">
    <div class="gateway-drag-region"></div>
    <div class="window-controls">
      <button class="win-ctrl" @click="minimizeWindow">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <button class="win-ctrl" @click="maximizeWindow">
        <svg
          v-if="isMaximized"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="2" y="8" width="14" height="14" rx="2.5" />
          <path
            d="M8 8V4.5A2.5 2.5 0 0 1 10.5 2H19.5A2.5 2.5 0 0 1 22 4.5V13.5A2.5 2.5 0 0 1 19.5 16H16"
          />
        </svg>
        <svg
          v-else
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
        </svg>
      </button>
      <button class="win-ctrl win-ctrl--close" @click="closeWindow">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
    <div class="loading-center">
      <!-- Mascot area -->
      <div class="mascot-wrap">
        <img :src="currentMascot" alt="mascot" class="mascot-img" />
      </div>

      <!-- Carousel title -->
      <h1 class="carousel-title" :style="{ opacity: textOpacity }">{{ carouselTitle }}</h1>

      <!-- Bottom area: description / progress / error -->
      <div class="loading-bottom">
        <p v-if="!isFailed" class="carousel-desc" :style="{ opacity: textOpacity }">
          {{ carouselDesc }}
        </p>

        <!-- Progress bar (0–100%) -->
        <div class="loading-track">
          <div
            class="loading-bar"
            :class="{ error: isFailed }"
            :style="{ width: displayProgress + '%' }"
          ></div>
        </div>

        <!-- Status text with percentage -->
        <div class="loading-status" :class="{ error: isFailed }">
          {{ statusText }}
          <span v-if="!isFailed" class="loading-pct">{{ Math.floor(displayProgress) }}%</span>
        </div>

        <!-- Error detail (shown when gateway reports an error) -->
        <div v-if="isFailed && props.errorMessage" class="loading-error-detail">
          {{ props.errorMessage }}
        </div>

        <!-- Retry button (timeout / failed) -->
        <button v-if="isFailed" class="loading-retry" @click="$emit('retry')">
          {{ t("gateway.retry") }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { t } from "@/i18n";

// ── Asset imports ──
import mascotFold from "@/assets/welcom_fold.png";
import mascotExpand from "@/assets/welcom_expand.png";
import mascotStock from "@/assets/stock.png";
import imgArchaeologist from "@/assets/Archaeologist.png";
import imgAstronomer from "@/assets/Astronomer.png";
import imgCoder from "@/assets/Coder.png";
import imgDiviner from "@/assets/Diviner.png";
import imgGeologist from "@/assets/Geologist.png";
import imgLawyer from "@/assets/Lawyer.png";
import imgPainter from "@/assets/Painter.png";
import imgScientist from "@/assets/Scientist.png";
import imgSinger from "@/assets/Singer.png";

const IDENTITY_IMAGES = [
  imgArchaeologist,
  imgAstronomer,
  imgCoder,
  imgDiviner,
  imgGeologist,
  imgLawyer,
  imgPainter,
  imgScientist,
  imgSinger,
];

const CAROUSEL_KEYS = [
  { title: "gateway.carousel.1.title", desc: "gateway.carousel.1.desc" },
  { title: "gateway.carousel.2.title", desc: "gateway.carousel.2.desc" },
  { title: "gateway.carousel.3.title", desc: "gateway.carousel.3.desc" },
];

const props = defineProps<{
  status: string;
  connected: boolean;
  warming: boolean;
  errorMessage?: string;
}>();
defineEmits<{ retry: [] }>();

const isFailed = computed(() => props.status === "timeout" || props.status === "failed");

// ── Window controls ──

const isMaximized = ref(false);
let unsubMaximizeChange: (() => void) | null = null;

function minimizeWindow() {
  window.openclaw?.window?.minimize?.();
}

function maximizeWindow() {
  window.openclaw?.window?.maximize?.();
}

function closeWindow() {
  window.openclaw?.window?.close?.();
}

// ── Progress (preserved from original) ──

const targetProgress = computed(() => {
  if (props.warming) return 98;
  if (props.connected) return 100;
  if (isFailed.value) return displayProgress.value; // freeze
  switch (props.status) {
    case "stopped":
      return 5;
    case "starting":
      return 70;
    case "running":
      return 90;
    default:
      return 5;
  }
});

const displayProgress = ref(0);
let progressTimer: ReturnType<typeof setInterval> | null = null;

function tick() {
  const target = targetProgress.value;
  const current = displayProgress.value;
  if (current >= target) return;

  if (target === 100) {
    displayProgress.value = Math.min(current + 4, 100);
  } else if (current >= 60) {
    const remaining = target - current;
    const step = Math.max(0.08, remaining * 0.015);
    displayProgress.value = Math.min(Math.round((current + step) * 100) / 100, target);
  } else {
    const remaining = target - current;
    const step = Math.max(0.3, remaining * 0.06);
    displayProgress.value = Math.min(Math.round((current + step) * 10) / 10, target);
  }
}

watch(
  () => props.connected,
  (val) => {
    if (val && displayProgress.value < 90) {
      displayProgress.value = 90;
    }
  },
);

const statusText = computed(() => {
  if (props.warming) return t("gateway.warming");
  if (props.connected) return t("gateway.ready");
  switch (props.status) {
    case "stopped":
    case "starting":
      return t("gateway.starting");
    case "running":
      return t("gateway.connecting");
    case "timeout":
      return t("gateway.timeout");
    case "failed":
      return t("gateway.failed");
    default:
      return t("gateway.preparing");
  }
});

// ── Mascot state machine ──

const currentMascot = ref(mascotFold);
let imageTimer: ReturnType<typeof setInterval> | null = null;
let imageIdx = 0;
let expandTimeout: ReturnType<typeof setTimeout> | null = null;

function startImageCycle() {
  stopImageCycle();
  currentMascot.value = mascotStock;
  imageIdx = 0;
  imageTimer = setInterval(() => {
    currentMascot.value = IDENTITY_IMAGES[imageIdx % IDENTITY_IMAGES.length];
    imageIdx++;
  }, 900);
}

function stopImageCycle() {
  if (imageTimer) {
    clearInterval(imageTimer);
    imageTimer = null;
  }
}

// ── Text carousel ──

const textIdx = ref(0);
const textOpacity = ref(1);
let textTimer: ReturnType<typeof setInterval> | null = null;

const carouselTitle = computed(() => t(CAROUSEL_KEYS[textIdx.value % CAROUSEL_KEYS.length].title));
const carouselDesc = computed(() => t(CAROUSEL_KEYS[textIdx.value % CAROUSEL_KEYS.length].desc));

function startTextCycle() {
  stopTextCycle();
  textIdx.value = 0;
  textOpacity.value = 1;
  textTimer = setInterval(() => {
    // Fade out
    textOpacity.value = 0;
    setTimeout(() => {
      textIdx.value = (textIdx.value + 1) % CAROUSEL_KEYS.length;
      // Fade in
      textOpacity.value = 1;
    }, 200);
  }, 3000);
}

function stopTextCycle() {
  if (textTimer) {
    clearInterval(textTimer);
    textTimer = null;
  }
  textOpacity.value = 1;
}

// ── Lifecycle: orchestrate mascot + carousels ──

onMounted(() => {
  progressTimer = setInterval(tick, 80);
  startTextCycle();

  // Track window maximize state
  window.openclaw?.window
    ?.isMaximized?.()
    .then((v: boolean) => {
      isMaximized.value = v;
    })
    .catch(() => {});
  unsubMaximizeChange =
    window.openclaw?.window?.onMaximizeChange?.((v: boolean) => {
      isMaximized.value = v;
    }) ?? null;

  // Mascot expand after 400ms
  expandTimeout = setTimeout(() => {
    if (isFailed.value) return;
    currentMascot.value = mascotExpand;
  }, 400);
});

onUnmounted(() => {
  if (progressTimer) clearInterval(progressTimer);
  if (expandTimeout) clearTimeout(expandTimeout);
  stopImageCycle();
  stopTextCycle();
  unsubMaximizeChange?.();
});

// Start image carousel when gateway begins starting
watch(
  () => props.status,
  (status) => {
    if (status === "starting" || status === "running") {
      if (!imageTimer) startImageCycle();
    }
    if (status === "timeout" || status === "failed") {
      stopImageCycle();
      stopTextCycle();
    }
  },
);

// Stop carousels when connected
watch(
  () => props.connected,
  (val) => {
    if (val) {
      stopImageCycle();
      stopTextCycle();
    }
  },
);
</script>

<style scoped>
.gateway-loading {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(
    circle at top,
    var(--bg-primary) 0%,
    var(--bg-primary) 62%,
    var(--border-light, #f2f2f2) 100%
  );
  border-radius: 16px;
  z-index: 9999;
}

.gateway-drag-region {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 36px;
  -webkit-app-region: drag;
}

/* ── Window controls ── */
.window-controls {
  position: absolute;
  top: 0;
  right: 0;
  display: flex;
  gap: 0;
  -webkit-app-region: no-drag;
  z-index: 20;
}

.win-ctrl {
  width: 46px;
  height: 32px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 0;
  cursor: pointer;
  transition: background 0.1s;
}

.win-ctrl:hover {
  background: #f0f0f0;
}

:global(html.dark) .win-ctrl:hover {
  background: var(--bg-tertiary);
}

.win-ctrl:active {
  background: color-mix(in srgb, var(--text-primary) 12%, transparent);
}

.win-ctrl--close:hover {
  background: #c42b1c;
}

.win-ctrl--close:active {
  background: #a4262c;
}

.win-ctrl--close:hover svg {
  stroke: #ffffff;
}

:global(html.dark) .win-ctrl--close:hover {
  background: #c42b1c;
}

.loading-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 20px;
}

/* ── Mascot ── */
.mascot-wrap {
  width: 293px;
  height: 293px;
  position: relative;
}

.mascot-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* ── Text carousel ── */
.carousel-title {
  margin: -32px 0 6px;
  min-height: 32px;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.03em;
  text-align: center;
  color: var(--text-primary);
  transition: opacity 0.2s ease;
}

.carousel-desc {
  max-width: 280px;
  text-align: center;
  font-size: 15px;
  font-weight: 500;
  color: var(--text-secondary);
  margin: 0 0 12px;
  transition: opacity 0.2s ease;
  line-height: 1.7;
}

/* ── Bottom area ── */
.loading-bottom {
  min-height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* ── Progress bar ── */
.loading-track {
  width: 200px;
  height: 6px;
  border-radius: 99px;
  background: var(--border);
  overflow: hidden;
  margin-bottom: 12px;
}

.loading-bar {
  height: 100%;
  background: var(--text-primary);
  border-radius: 99px;
  transition: width 0.18s linear;
  will-change: width;
}

.loading-bar.error {
  background: var(--danger);
}

/* ── Status text ── */
.loading-status {
  font-size: 13px;
  color: var(--text-muted);
  letter-spacing: -0.01em;
  display: flex;
  align-items: center;
  gap: 8px;
}

.loading-pct {
  font-variant-numeric: tabular-nums;
  min-width: 32px;
  text-align: right;
}

.loading-status.error {
  color: var(--danger);
}

/* ── Error detail ── */
.loading-error-detail {
  font-size: 12px;
  color: var(--text-muted);
  max-width: 360px;
  text-align: center;
  line-height: 1.5;
  word-break: break-word;
  margin-top: 8px;
}

/* ── Retry button ── */
.loading-retry {
  margin-top: 12px;
  min-width: 160px;
  height: 40px;
  padding: 0 28px;
  background: var(--text-primary);
  color: var(--bg-primary);
  border: none;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
  font-family: inherit;
}

.loading-retry:hover {
  opacity: 0.86;
}
</style>
