<template>
  <section class="placeholder-view">
    <div class="placeholder-empty">
      <span class="placeholder-badge">{{ badge }}</span>
      <h1 class="placeholder-title">{{ title }}</h1>
      <p class="placeholder-desc">{{ description }}</p>

      <div class="placeholder-grid">
        <article v-for="card in cards" :key="card.title" class="placeholder-card">
          <div class="placeholder-card__icon">{{ card.icon }}</div>
          <div class="placeholder-card__body">
            <div class="placeholder-card__title">{{ card.title }}</div>
            <div class="placeholder-card__desc">{{ card.description }}</div>
          </div>
        </article>
      </div>

      <div class="placeholder-footer">
        <div class="placeholder-footer__label">当前阶段</div>
        <div class="placeholder-footer__text">{{ footer }}</div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  badge: string;
  title: string;
  description: string;
  footer: string;
  cards: Array<{
    icon: string;
    title: string;
    description: string;
  }>;
}>();
</script>

<style scoped>
.placeholder-view {
  height: 100%;
  overflow-y: auto;
  background: var(--bg-primary);
}

.placeholder-empty {
  padding: 48px 48px 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.placeholder-badge {
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  border: 0.5px solid var(--border);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  margin-bottom: 16px;
}

.placeholder-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
  text-align: center;
  margin: 0 0 10px;
  letter-spacing: -0.02em;
}

.placeholder-desc {
  margin: 0 0 32px;
  max-width: 680px;
  text-align: center;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-secondary);
}

.placeholder-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  width: 100%;
  max-width: 720px;
}

.placeholder-card {
  min-height: 200px;
  padding: 20px;
  border-radius: 18px;
  background: var(--bg-tertiary);
  border: 0.5px solid var(--border);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  transition: background 0.15s;
}

.placeholder-card:hover {
  background: #ede8e4;
}

.placeholder-card__icon {
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  background: transparent;
  border: 1px solid rgba(39, 35, 32, 0.12);
  font-size: 18px;
  color: var(--text-primary);
  flex-shrink: 0;
}

.placeholder-card__body {
  margin-top: auto;
}

.placeholder-card__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
  line-height: 1.3;
}

.placeholder-card__desc {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-secondary);
  line-height: 1.6;
}

.placeholder-footer {
  width: 100%;
  max-width: 720px;
  margin-top: 16px;
  padding: 20px;
  border-radius: 18px;
  background: var(--bg-tertiary);
  border: 0.5px solid var(--border);
}

.placeholder-footer__label {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  margin-bottom: 6px;
}

.placeholder-footer__text {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-secondary);
}

@media (max-width: 900px) {
  .placeholder-empty {
    padding: 32px 24px 24px;
  }

  .placeholder-grid {
    grid-template-columns: 1fr;
  }
}
</style>
