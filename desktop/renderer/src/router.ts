import { createRouter, createWebHashHistory } from "vue-router";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      redirect: "/chat",
    },
    {
      path: "/home",
      redirect: "/chat",
    },
    {
      path: "/studio",
      redirect: "/chat",
    },
    {
      path: "/skills",
      redirect: "/settings/skills",
    },
    {
      path: "/chat/market",
      name: "agent-market",
      component: () => import("@/views/AgentMarketView.vue"),
    },
    {
      path: "/chat/:agentId?",
      name: "chat",
      component: () => import("@/views/ChatView.vue"),
    },
    {
      path: "/settings/:section?",
      name: "settings",
      component: () => import("@/views/SettingsView.vue"),
    },
    {
      path: "/setup",
      name: "setup",
      component: () => import("@/views/SetupWizard.vue"),
    },
    {
      path: "/plugins",
      name: "plugins",
      component: () => import("@/views/PluginsView.vue"),
    },
    {
      path: "/phone",
      redirect: "/settings/channels",
    },
  ],
});

export default router;
