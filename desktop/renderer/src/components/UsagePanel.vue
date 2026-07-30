<!--
  UsagePanel — Right-side drawer (Agent Profile) per 2026-04-22 design.

  Slides in from the right when the user clicks "Usage" in the sidebar.
  Three visual states:
    • Normal         — gateway connected + usage query succeeds.
    • Model offline  — gateway running but usage query fails (usually a
                       missing/invalid model config). Hero swaps to crash
                       GIF with a banner + "Open Settings" CTA. Reuses the
                       PPT's "budget exhausted" slot since MicroClaw has
                       no token-budget feature yet.
    • Gateway offline — sticky bottom banner with a retry button.
-->
<template>
  <!-- Backdrop (mask) behind the drawer -->
  <div
    class="usage-backdrop"
    :class="{ 'is-visible': isOpen }"
    @click="close"
    aria-hidden="true"
  ></div>

  <aside class="usage-drawer" :class="[{ 'is-offline': modelOffline, 'is-visible': isOpen }]">
    <div class="drawer-scroll">
      <!-- Header: agent identity + close -->
      <header class="panel-header">
        <div class="panel-header-left">
          <img :src="mascotSmall" class="panel-avatar" alt="" />
          <div class="panel-header-text">
            <div class="panel-agent-name">{{ agentName }}</div>
            <div class="panel-agent-desc">{{ t("usage.agentDesc") }}</div>
          </div>
        </div>
        <button class="drawer-close" @click="close" :title="t('usage.close')" aria-label="Close">
          <svg
            width="16"
            height="16"
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
      </header>

      <!-- Hero card with status pill overlay -->
      <!--
          The pill is a sibling of .hero-card (not inside it) and anchored
          to the top-right of the full-width .hero-wrap, so it stays fixed
          at the drawer's right edge regardless of how small the hero card
          shrinks. Placing it inside .hero-card used to let overflow:hidden
          clip it, and centering the shrunken card used to drag the pill
          toward the middle.
        -->
      <div class="hero-wrap">
        <span class="status-pill" :class="statusPillClass">
          <span class="status-pill-dot"></span>
          {{ statusLabel }}
        </span>
        <div class="hero-card" :class="{ 'hero-error': modelOffline }">
          <img :src="modelOffline ? mascotCrash : mascotHero" class="hero-img" alt="" />
        </div>
      </div>

      <!-- Model-offline alert -->
      <div v-if="modelOffline" class="offline-alert">
        <div class="offline-alert-body">
          <div class="offline-alert-title">{{ t("usage.modelOfflineTitle") }}</div>
          <div class="offline-alert-hint">{{ t("usage.modelOfflineHint") }}</div>
        </div>
        <button class="offline-alert-btn" @click="goSettings">{{ t("usage.openSettings") }}</button>
      </div>

      <!-- Token usage (last 30 days) -->
      <section class="panel-section">
        <div class="section-head">
          <span class="section-title">{{ t("usage.tokenUsageTitle") }}</span>
          <span class="section-sub">{{ t("usage.tokenUsage30d") }}</span>
        </div>

        <div v-if="loading && !hasData" class="stat-grid">
          <div class="stat-card stat-card-wide">
            <div class="stat-label">{{ t("usage.tokenTotal") }}</div>
            <div class="stat-value"><span class="skeleton"></span></div>
          </div>
          <div class="stat-card">
            <div class="stat-label">{{ t("usage.tokenInput") }}</div>
            <div class="stat-value"><span class="skeleton"></span></div>
          </div>
          <div class="stat-card">
            <div class="stat-label">{{ t("usage.tokenOutput") }}</div>
            <div class="stat-value"><span class="skeleton"></span></div>
          </div>
          <div class="stat-card">
            <div class="stat-label">{{ t("usage.tokenCache") }}</div>
            <div class="stat-value"><span class="skeleton"></span></div>
          </div>
          <div class="stat-card">
            <div class="stat-label">{{ t("usage.tokenToday") }}</div>
            <div class="stat-value"><span class="skeleton"></span></div>
          </div>
        </div>
        <div v-else class="stat-grid" :class="{ 'stat-grid-dim': modelOffline || !hasData }">
          <div class="stat-card stat-card-wide">
            <div class="stat-label">{{ t("usage.tokenTotal") }}</div>
            <div class="stat-value">{{ formatTokens(totals.total) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">{{ t("usage.tokenInput") }}</div>
            <div class="stat-value">{{ formatTokens(totals.input) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">{{ t("usage.tokenOutput") }}</div>
            <div class="stat-value">{{ formatTokens(totals.output) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">{{ t("usage.tokenCache") }}</div>
            <div class="stat-value">{{ formatTokens(totals.cache) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">{{ t("usage.tokenToday") }}</div>
            <div class="stat-value">{{ formatTokens(totals.today) }}</div>
          </div>
        </div>

        <div class="chip-row">
          <template v-if="loading && !hasData">
            <span class="chip"><span class="skeleton skeleton-sm"></span></span>
            <span class="chip"><span class="skeleton skeleton-sm"></span></span>
            <span class="chip"><span class="skeleton skeleton-sm"></span></span>
          </template>
          <template v-else>
            <span class="chip"
              >{{ counts.requests.toLocaleString() }} {{ t("usage.requestsLabel") }}</span
            >
            <span class="chip"
              >{{ counts.sessions.toLocaleString() }} {{ t("usage.sessionsLabel") }}</span
            >
            <span class="chip"
              >{{ counts.toolCalls.toLocaleString() }} {{ t("usage.toolCallsLabel") }}</span
            >
          </template>
        </div>
      </section>

      <!-- Gateway-offline sticky banner -->
      <div v-if="gatewayOffline" class="gateway-banner">
        <span class="gateway-banner-text">{{ t("usage.gatewayOffline") }}</span>
        <button class="gateway-banner-btn" @click="loadData" :disabled="loading">
          {{ loading ? "…" : t("usage.retryConnect") }}
        </button>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { useGatewayStore } from "@/stores/gateway";
import { useUsagePanel } from "@/composables/useUsagePanel";
import { useChatStore } from "@/stores/chat";
import { t } from "@/i18n";
import mascotHero from "@/assets/book.gif";
import mascotCrash from "@/assets/crash.gif";
import mascotAvatar from "@/assets/normal.png";

const mascotSmall = mascotAvatar; // small avatar in header (still shot)

const router = useRouter();
const gateway = useGatewayStore();
const chatStore = useChatStore();
const { isOpen, close } = useUsagePanel();

// --- State ---
const data = ref<any>(null);
const loading = ref(false);
const modelErrored = ref(false);

const agentName = computed(() => t("app.name"));

// --- Derived ---
const gatewayOffline = computed(() => !gateway.ready || gateway.status !== "running");
const hasData = computed(() => !!data.value);
// A model error is any chat-flow error that points at the model endpoint /
// auth / quota / rate-limit / network. `aborted` and `empty_response` are
// not model-offline conditions.
const chatModelError = computed(() => {
  const code = chatStore.lastError?.code;
  if (!code) return false;
  return (
    code === "not_found" ||
    code === "model_not_found" ||
    code === "unauthorized" ||
    code === "rate_limited" ||
    code === "network" ||
    code === "server_error"
  );
});
const modelOffline = computed(
  () => (modelErrored.value || chatModelError.value) && !gatewayOffline.value,
);

const statusPillClass = computed(() => ({
  "status-pill-ok": !modelOffline.value && !gatewayOffline.value,
  "status-pill-error": modelOffline.value,
  "status-pill-warn": gatewayOffline.value && !modelOffline.value,
}));

const statusLabel = computed(() => {
  if (modelOffline.value) return t("usage.statusModelOffline");
  if (gatewayOffline.value) return t("usage.statusGatewayOffline");
  return t("usage.statusWorking");
});

const totals = computed(() => {
  const d = data.value;
  if (!d) return { total: 0, input: 0, output: 0, cache: 0, today: 0 };
  const today = new Date().toISOString().split("T")[0];
  const todayEntry = d.aggregates?.daily?.find((x: any) => x.date === today);
  const todayTokens =
    todayEntry?.tokens ??
    (todayEntry?.input || 0) + (todayEntry?.output || 0) + (todayEntry?.cacheRead || 0);
  return {
    total: d.totals?.totalTokens || 0,
    input: d.totals?.input || 0,
    output: d.totals?.output || 0,
    cache: d.totals?.cacheRead || 0,
    today: todayTokens,
  };
});

const counts = computed(() => {
  const d = data.value;
  if (!d) return { requests: 0, sessions: 0, toolCalls: 0 };
  return {
    requests: d.aggregates?.messages?.total || 0,
    sessions: d.sessions?.length || 0,
    toolCalls: d.aggregates?.tools?.totalCalls || 0,
  };
});

// --- Helpers ---
function formatTokens(n: number): string {
  if (!n && n !== 0) return "—";
  if (n < 1000) return String(n);
  return n.toLocaleString();
}

async function loadData() {
  if (loading.value) return;
  loading.value = true;
  try {
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 30 * 86_400_000).toISOString().split("T")[0];
    data.value = await (window as any).openclaw.usage.getDetailedStats({ startDate, endDate });
    modelErrored.value = false;
  } catch {
    data.value = null;
    modelErrored.value = !gatewayOffline.value;
  } finally {
    loading.value = false;
  }
}

function goSettings() {
  close();
  router.push("/settings");
}

// --- Lifecycle: load data whenever panel opens, and refresh on gateway reconnect ---
watch(isOpen, (open) => {
  if (open) {
    // Delay data loading until slide-in animation completes
    setTimeout(() => {
      if (!gatewayOffline.value) loadData();
    }, 300);
  }
});

const stopGatewayWatch = watch(
  () => gateway.ready && gateway.status === "running",
  (online, wasOnline) => {
    if (isOpen.value && online && !wasOnline) {
      loadData();
    }
  },
);

onUnmounted(() => {
  stopGatewayWatch();
});
</script>

<style scoped>
/* ── Drawer shell ── */
/*
  Drawer top aligns with .chat-view (below the 56px .app-header).
  Drawer inner content bottom sits 56px (one header-height) above the
  window bottom edge.
*/
.usage-drawer {
  --app-header-height: 56px;
  position: fixed;
  top: 56px;
  right: 0;
  bottom: 0;
  --usage-drawer-width: clamp(320px, 35vw, 460px);
  --usage-drawer-padding: clamp(10px, 1.5vw, 20px);
  width: var(--usage-drawer-width);
  max-width: 100vw;
  background: var(--bg-secondary, #ffffff);
  border-left: 1px solid var(--border);
  border-top-left-radius: 16px;
  border-bottom-left-radius: 16px;
  border-bottom-right-radius: 16px;
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.1);
  z-index: 201;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── Backdrop (mask) ── */
.usage-backdrop {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: rgba(255, 255, 255, 0.5);
  backdrop-filter: blur(1px);
  z-index: 200;
  border-radius: 16px;
  opacity: 0;
  transition: opacity 0.2s ease;
  pointer-events: none;
}

html.dark .usage-backdrop {
  background: rgba(0, 0, 0, 0.45);
}
.usage-backdrop.is-visible {
  opacity: 1;
  pointer-events: auto;
}

.drawer-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: clamp(12px, 2vh, 20px) var(--usage-drawer-padding) clamp(16px, 3vh, 32px);
  display: flex;
  flex-direction: column;
  gap: clamp(8px, 1.5vh, 18px);
}

/* ── Slide transition ── */
.usage-drawer {
  transform: translateX(100%);
  opacity: 0;
  pointer-events: none;
  transition:
    transform 0.2s ease-in,
    opacity 0.2s ease-in;
}
.usage-drawer.is-visible {
  transform: translateX(0);
  opacity: 1;
  pointer-events: auto;
  transition:
    transform 0.28s ease-out,
    opacity 0.28s ease-out;
}

/* ── Header ── */
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.panel-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.panel-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
  background: #fff1ea;
  flex-shrink: 0;
}

.panel-header-text {
  min-width: 0;
}

.panel-agent-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.2;
}

.panel-agent-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drawer-close {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border: none;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 50%;
  display: grid;
  place-items: center;
  transition:
    background 0.15s,
    color 0.15s;
}

.drawer-close:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

/* ── Hero card ── */
/*
  .hero-wrap is the positioning context for the status pill so the pill
  can anchor to the drawer's right edge independently of the (possibly
  much narrower) .hero-card square below it.
*/
.hero-wrap {
  position: relative;
  width: 100%;
  flex-shrink: 0;
}

.hero-card {
  position: relative;
  border-radius: 16px;
  background: #f9f5f2;
  /*
    Wide landscape card (full drawer width). The mascot GIF is 1:1 and
    rendered at card height via object-fit:contain, so it stays complete
    and centered while the peach background fills the entire strip — the
    designer's reference look (image 2).
  */
  width: 100%;
  height: clamp(140px, 22vh, 220px);
  flex-shrink: 0;
  padding: clamp(8px, 1.5vw, 12px);
  display: grid;
  place-items: center;
  overflow: hidden;
  transition: background 0.3s;
}

.hero-card.hero-error {
  background: linear-gradient(180deg, #fdecec 0%, #f5d6d6 100%);
}

.hero-img {
  /*
    Render the 1:1 mascot at a modest size so it occupies only the
    middle of the landscape strip, leaving the peach background visible
    on both sides (designer reference image 2). We size by HEIGHT, and
    cap the width to ~50% of the strip so the square sits centered
    regardless of how wide the drawer becomes.
  */
  display: block;
  height: clamp(96px, 16vh, 160px);
  width: auto;
  max-width: 50%;
  object-fit: contain;
  object-position: center center;
}

.status-pill {
  position: absolute;
  top: 8px;
  left: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  /* Keep "Working" / "工作中" on a single line so the pill never wraps
     or gets clipped when the drawer narrows. */
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(4px);
  z-index: 1;
}

.status-pill-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.status-pill-ok {
  color: #0a9f55;
}
.status-pill-warn {
  color: #b56a00;
}
.status-pill-error {
  color: #d03838;
}

/* ── Model-offline alert ── */
.offline-alert {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  background: #fdecec;
  border: 1px solid #f5c8c8;
  border-radius: 12px;
}

.offline-alert-body {
  min-width: 0;
}

.offline-alert-title {
  font-size: 13px;
  font-weight: 600;
  color: #a32020;
  line-height: 1.3;
}

.offline-alert-hint {
  font-size: 12px;
  color: #7a3030;
  margin-top: 2px;
  line-height: 1.4;
}

.offline-alert-btn {
  flex-shrink: 0;
  padding: 6px 14px;
  border: none;
  border-radius: 999px;
  background: #d03838;
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
  font-family: inherit;
}

.offline-alert-btn:hover {
  background: #b22e2e;
}

/* ── Section ── */
.panel-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.section-sub {
  font-size: 12px;
  color: var(--text-muted);
}

.section-add {
  width: 26px;
  height: 26px;
  border: none;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: 16px;
  cursor: pointer;
  border-radius: 50%;
  display: grid;
  place-items: center;
  transition:
    background 0.15s,
    color 0.15s;
}

.section-add:hover {
  background: var(--accent-selected-bg);
  color: var(--text-primary);
}

/* ── Token stat grid ── */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  transition: opacity 0.2s;
}

.stat-grid-dim {
  opacity: 0.5;
}

.stat-card {
  padding: 12px 14px;
  background: #f6f7f6;
  border: 1px solid #d8d8d8;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.stat-card-wide {
  grid-column: span 2;
  background: linear-gradient(to right, #eef6fb, #f6f7f6);
}

.stat-label {
  font-size: 12px;
  color: var(--text-muted);
}

.stat-value {
  font-size: clamp(14px, 1.8vw, 20px);
  font-weight: 600;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Chip row ── */
.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  padding: 4px 10px;
  background: #efefef;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 12px;
  color: var(--text-secondary);
}

/* ── Skeleton loading ── */
.skeleton {
  display: inline-block;
  width: 60px;
  height: 20px;
  border-radius: 4px;
  background: linear-gradient(
    90deg,
    var(--bg-tertiary, #eee) 25%,
    var(--bg-secondary, #f5f5f5) 50%,
    var(--bg-tertiary, #eee) 75%
  );
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s infinite;
}

.skeleton-sm {
  width: 40px;
  height: 14px;
}

@keyframes skeleton-shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}

/* ── Gateway banner ── */
.gateway-banner {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  background: #2b2b2b;
  color: #fff;
  border-radius: 12px;
  position: sticky;
  bottom: 8px;
}

.gateway-banner-text {
  font-size: 12px;
  line-height: 1.4;
  min-width: 0;
  opacity: 0.9;
}

.gateway-banner-btn {
  flex-shrink: 0;
  padding: 6px 14px;
  border: none;
  border-radius: 999px;
  background: #fff;
  color: #2b2b2b;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s;
  font-family: inherit;
}

.gateway-banner-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.gateway-banner-btn:hover:not(:disabled) {
  opacity: 0.85;
}

/* ── Dark mode overrides ── */
html.dark .hero-card {
  background: #2a2724;
}
html.dark .hero-card.hero-error {
  background: linear-gradient(180deg, #4a2a2a 0%, #3a2222 100%);
}
html.dark .status-pill {
  background: rgba(40, 40, 44, 0.85);
}
html.dark .status-pill-ok {
  color: #34d399;
}
html.dark .status-pill-warn {
  color: #fbbf24;
}
html.dark .status-pill-error {
  color: #f87171;
}

html.dark .offline-alert {
  background: rgba(208, 56, 56, 0.12);
  border-color: rgba(208, 56, 56, 0.35);
}
html.dark .offline-alert-title {
  color: #f87171;
}
html.dark .offline-alert-hint {
  color: #f3a8a8;
}

html.dark .stat-card {
  background: var(--bg-tertiary);
  border-color: var(--border);
}
html.dark .stat-card-wide {
  background: linear-gradient(to right, rgba(96, 165, 250, 0.12), var(--bg-tertiary));
}

html.dark .chip {
  background: var(--bg-tertiary);
  border-color: var(--border);
  color: var(--text-secondary);
}

html.dark .gateway-banner {
  background: #1a1a1d;
  color: #f5f5f5;
}
html.dark .gateway-banner-btn {
  background: #f5f5f5;
  color: #1a1a1d;
}

html.dark .skeleton {
  background: linear-gradient(
    90deg,
    var(--bg-tertiary) 25%,
    var(--bg-secondary) 50%,
    var(--bg-tertiary) 75%
  );
  background-size: 200% 100%;
}

@media (max-width: 820px) {
  .usage-drawer {
    --usage-drawer-width: clamp(240px, 40vw, 340px);
    --usage-drawer-padding: clamp(10px, 2vw, 16px);
  }

  .status-pill {
    top: 6px;
    right: 6px;
  }
}

@media (max-width: 620px) {
  .usage-drawer {
    --usage-drawer-width: calc(100vw - 8px);
    max-width: 100vw;
    --usage-drawer-padding: 12px;
  }

  .drawer-scroll {
    padding-bottom: 20px;
  }

  .stat-grid {
    grid-template-columns: 1fr;
  }

  .stat-card-wide {
    grid-column: span 1;
  }
}
</style>
