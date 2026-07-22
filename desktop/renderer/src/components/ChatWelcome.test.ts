import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { VueWrapper } from "@vue/test-utils";
import ChatWelcome from "./ChatWelcome.vue";
import chatWelcomeSource from "./ChatWelcome.vue?raw";
import type { Agent } from "@/stores/agents";

function cardStackOrders(wrapper: VueWrapper) {
  return wrapper.findAll<HTMLElement>(".fan-card").map((card) => {
    return card.element.style.getPropertyValue("--stack-order");
  });
}

describe("ChatWelcome fan cards", () => {
  it("preserves the default fan stacking order with overridable custom properties", () => {
    const wrapper = mount(ChatWelcome, {
      props: { mode: "hero" },
    });

    expect(cardStackOrders(wrapper)).toEqual(["3", "2", "1"]);
  });

  it("uses the same overridable stacking order for agent quick tasks", () => {
    const agent: Agent = {
      id: "test-agent",
      name: "Test agent",
      description: "Test description",
      quickTasks: [
        { title: "First", desc: "First task" },
        { title: "Second", desc: "Second task" },
        { title: "Third", desc: "Third task" },
      ],
    };
    const wrapper = mount(ChatWelcome, {
      props: { mode: "hero", agent },
    });

    expect(cardStackOrders(wrapper)).toEqual(["3", "2", "1"]);
  });

  it("raises hovered cards above every base stack level", () => {
    const baseRule = chatWelcomeSource.match(/\.fan-card\s*\{(?<body>[\s\S]*?)\}/)?.groups?.body;
    const hoverRule = chatWelcomeSource.match(/\.fan-card:hover\s*\{(?<body>[\s\S]*?)\}/)?.groups
      ?.body;

    expect(baseRule).toMatch(/z-index:\s*var\(--stack-order\)/);
    expect(hoverRule).toMatch(/z-index:\s*4/);
  });
});
