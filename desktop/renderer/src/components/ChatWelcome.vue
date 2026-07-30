<template>
  <div v-if="mode === 'hero'" class="welcome-state">
    <h1 class="welcome-heading">
      <template v-if="isAgentMode">{{ agent!.name }}</template>
      <template v-else>{{ t("home.heading1") }}<br />{{ t("home.heading2") }}</template>
    </h1>
    <p class="welcome-subheading">
      <template v-if="isAgentMode">{{ agent!.description }}</template>
      <template v-else>{{ t("home.subheading") }}</template>
    </p>
    <div class="fan-container">
      <div
        v-for="card in heroCards"
        :key="card.id"
        class="fan-card"
        :class="`fan-card--${card.id}`"
        :style="card.style"
        @click="emit('select', card.prompt)"
      >
        <div class="fan-card-img-area">
          <img :src="card.image" class="fan-card-img" alt="" />
        </div>
        <div class="fan-card-body">
          <div class="fan-card-name">{{ card.title }}</div>
          <div class="fan-card-desc">{{ card.desc }}</div>
        </div>
      </div>
    </div>
  </div>

  <div v-else class="compose-suggestions">
    <button v-if="suggestionsScrolled" class="suggestions-arrow" @click="scrollSuggestions(-1)">
      <IconChevronLeft />
    </button>
    <div class="suggestions-scroll" ref="suggestionsScrollRef" @scroll="onSuggestionsScroll">
      <button
        v-for="suggestion in suggestions"
        :key="suggestion.label"
        class="suggestion-chip"
        @click="emit('select', suggestion.prompt)"
      >
        {{ suggestion.label }}
      </button>
    </div>
    <button class="suggestions-arrow" @click="scrollSuggestions(1)">
      <IconChevronRight />
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { t, locale } from "@/i18n";
import IconChevronLeft from "@/components/icons/IconChevronLeft.vue";
import IconChevronRight from "@/components/icons/IconChevronRight.vue";
import type { Agent } from "@/stores/agents";
import dailyNewsImg from "@/assets/daily news.png";
import desktopImg from "@/assets/email.png";
import travelImg from "@/assets/travel.png";

const props = defineProps<{
  mode: "hero" | "chips";
  agent?: Agent;
}>();

const emit = defineEmits<{
  select: [prompt: string];
}>();

const isAgentMode = computed(() => props.agent && props.agent.id !== "main");

const defaultCards = computed(() => {
  void locale.value;
  return [
    {
      id: "news",
      image: dailyNewsImg,
      title: t("home.card.news.title"),
      desc: t("home.card.news.desc"),
      prompt: t("home.card.news.prompt"),
      style:
        "--rot: 12deg; --dx: clamp(35px, 6vw, 75px); --hover-dx: clamp(22px, 2.8vw, 38px); --hover-dy: -24px; z-index: 3",
    },
    {
      id: "desktop",
      image: desktopImg,
      title: t("home.card.desktop.title"),
      desc: t("home.card.desktop.desc"),
      prompt: t("home.card.desktop.prompt"),
      style: "--rot: 0deg; --hover-dx: 0px; --hover-dy: -36px; z-index: 2",
    },
    {
      id: "travel",
      image: travelImg,
      title: t("home.card.travel.title"),
      desc: t("home.card.travel.desc"),
      prompt: t("home.card.travel.prompt"),
      style:
        "--rot: -12deg; --dx: clamp(-75px, -6vw, -35px); --hover-dx: clamp(-38px, -2.8vw, -22px); --hover-dy: -24px; z-index: 1",
    },
  ];
});

const heroCards = computed(() => {
  if (!isAgentMode.value) return defaultCards.value;
  const tasks = props.agent!.quickTasks ?? [];
  return tasks.slice(0, 3).map((task, i) => ({
    id: `task-${i}`,
    image: defaultCards.value[i % defaultCards.value.length].image,
    title: task.title,
    desc: task.desc,
    prompt: task.title,
    style: defaultCards.value[i % defaultCards.value.length].style,
  }));
});

const suggestions = computed(() => [
  { label: t("suggestion.docOrganize.label"), prompt: t("suggestion.docOrganize.prompt") },
  { label: t("suggestion.posterDesign.label"), prompt: t("suggestion.posterDesign.prompt") },
  { label: t("suggestion.webDesign.label"), prompt: t("suggestion.webDesign.prompt") },
  { label: t("suggestion.imageGen.label"), prompt: t("suggestion.imageGen.prompt") },
  { label: t("suggestion.emailSummary.label"), prompt: t("suggestion.emailSummary.prompt") },
  { label: t("suggestion.copywriting.label"), prompt: t("suggestion.copywriting.prompt") },
  { label: t("suggestion.weightTracker.label"), prompt: t("suggestion.weightTracker.prompt") },
  { label: t("suggestion.wrongAnswers.label"), prompt: t("suggestion.wrongAnswers.prompt") },
  { label: t("suggestion.meetingNotes.label"), prompt: t("suggestion.meetingNotes.prompt") },
  { label: t("suggestion.dataAnalysis.label"), prompt: t("suggestion.dataAnalysis.prompt") },
]);

const suggestionsScrollRef = ref<HTMLDivElement>();
const suggestionsScrolled = ref(false);

function scrollSuggestions(dir: 1 | -1) {
  const el = suggestionsScrollRef.value;
  if (!el) return;
  el.scrollBy({ left: dir * 160, behavior: "smooth" });
}

function onSuggestionsScroll() {
  const el = suggestionsScrollRef.value;
  if (!el) return;
  suggestionsScrolled.value = el.scrollLeft > 0;
}
</script>

<style scoped>
.welcome-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px 20px 0;
  overflow: visible;
  flex: 1;
  min-height: 0;
  padding-bottom: clamp(20px, 5vh, 120px);
}

.welcome-heading {
  font-size: clamp(20px, 1.8vw, 24px);
  font-weight: 700;
  color: var(--text-primary);
  text-align: center;
  margin-bottom: 8px;
  letter-spacing: -0.02em;
  line-height: 1.4;
}

.welcome-subheading {
  font-size: clamp(14px, 1.3vw, 17px);
  font-weight: 500;
  color: var(--text-secondary);
  text-align: center;
  margin-bottom: clamp(28px, 6vh, 84px);
  position: relative;
  z-index: 10;
}

.fan-container {
  position: relative;
  width: 100%;
  height: clamp(260px, 38vh, 500px);
  flex-shrink: 1;
  min-height: 0;
}

.fan-card {
  position: absolute;
  left: 50%;
  bottom: clamp(16px, 3vh, 40px);
  width: clamp(180px, 22vw, 340px);
  height: clamp(220px, 34vh, 440px);
  margin-left: clamp(-170px, -12vw, -90px);
  transform-origin: center bottom;
  transform: translateX(var(--dx, 0px)) rotate(var(--rot)) translateY(0) translateZ(0);
  transition:
    transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1),
    box-shadow 0.25s ease;
  cursor: pointer;
  border-radius: 24px;
  box-shadow:
    0 4px 20px rgba(0, 0, 0, 0.11),
    0 1px 4px rgba(0, 0, 0, 0.06);
  overflow: hidden;
  will-change: transform;
}

.fan-card:hover {
  transform:
    translateX(calc(var(--dx, 0px) + var(--hover-dx, 0px)))
    rotate(var(--rot))
    translateY(var(--hover-dy, -36px))
    translateZ(0);
  z-index: 10 !important;
  box-shadow: var(--card-shadow-hover);
}

html.dark .fan-card {
  box-shadow:
    0 4px 20px rgba(0, 0, 0, 0.3),
    0 1px 4px rgba(0, 0, 0, 0.2);
}

html.dark .fan-card:hover {
  box-shadow: var(--card-shadow-hover);
}

.fan-card--news,
.fan-card--task-0 {
  background: #edeae2;
  --card-bg: #edeae2;
}
.fan-card--email,
.fan-card--desktop,
.fan-card--task-1 {
  background: #f0e8da;
  --card-bg: #f0e8da;
}
.fan-card--travel,
.fan-card--task-2 {
  background: #eceae8;
  --card-bg: #eceae8;
}

html.dark .fan-card--news,
html.dark .fan-card--task-0 {
  background: #35332e;
  --card-bg: #35332e;
}
html.dark .fan-card--email,
html.dark .fan-card--desktop,
html.dark .fan-card--task-1 {
  background: #38342c;
  --card-bg: #38342c;
}
html.dark .fan-card--travel,
html.dark .fan-card--task-2 {
  background: #333236;
  --card-bg: #333236;
}

/*
  In dark mode the underlying photo has a light cream/white background
  that fights the dark card surface — producing a hard horizontal split.
  Dim the photo and add a vignette so the image blends into the card
  surface from all sides instead of cutting off mid-card.
*/
html.dark .fan-card-img {
  filter: brightness(0.62) saturate(0.85) contrast(0.95);
}

html.dark .fan-card-img-area::after {
  content: "";
  position: absolute;
  inset: 0;
  background:
    linear-gradient(
      to bottom,
      var(--card-bg) 0%,
      transparent 22%,
      transparent 70%,
      rgba(0, 0, 0, 0.25) 100%
    ),
    radial-gradient(ellipse at center, transparent 55%, var(--card-bg) 100%);
  pointer-events: none;
  z-index: 1;
}

.fan-card::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 48%;
  height: 110px;
  background: linear-gradient(to bottom, var(--card-bg) 20%, transparent 100%);
  z-index: 1;
  pointer-events: none;
}

.fan-card-body {
  position: absolute;
  top: 22px;
  left: 20px;
  max-width: 60%;
  z-index: 2;
}

.fan-card-name {
  font-size: clamp(12px, 1.3vw, 17px);
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.01em;
  margin-bottom: 6px;
  line-height: 1.3;
}

.fan-card-desc {
  font-size: clamp(10px, 1vw, 13px);
  color: var(--text-secondary);
  line-height: 1.55;
}

.fan-card-img-area {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 68%;
}

.fan-card-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: bottom center;
  display: block;
}

.compose-suggestions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.suggestions-scroll {
  display: flex;
  gap: 8px;
  overflow: hidden;
  flex: 1;
  scroll-behavior: smooth;
}

.suggestions-arrow {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 0.5px solid var(--border);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s;
}

.suggestions-arrow:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.suggestion-chip {
  padding: 6px 14px;
  border-radius: 20px;
  border: 0.5px solid var(--border);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s;
  white-space: nowrap;
}

.suggestion-chip:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}
</style>
