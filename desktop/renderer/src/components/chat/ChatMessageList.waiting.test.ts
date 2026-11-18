import { createPinia } from "pinia";
import { shallowMount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { useChatStore } from "@/stores/chat";
import ChatMessageList from "./ChatMessageList.vue";

vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe("waiting animation rotation", () => {
  let wrapper: VueWrapper | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    window.openclaw = createBrowserOpenClawMock();
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.useRealTimers();
  });

  function mountWaiting() {
    const pinia = createPinia();
    const store = useChatStore(pinia);
    store.streaming = true;
    wrapper = shallowMount(ChatMessageList, { global: { plugins: [pinia] } });
    const images = wrapper.findAll<HTMLImageElement>(".chat-waiting-gif img");
    const visibleImage = () =>
      images.find((image) => image.element.style.display !== "none")!.element;
    return { store, images, visibleImage };
  }

  function setLoaded(image: HTMLImageElement, loaded: boolean, failed = false) {
    Object.defineProperties(image, {
      complete: { configurable: true, value: loaded || failed },
      naturalWidth: { configurable: true, value: loaded ? 1024 : 0 },
    });
  }

  async function rotate() {
    vi.advanceTimersByTime(2000);
    await nextTick();
  }

  it("retains the current image until another one loads, then shows the existing loaded node", async () => {
    const { images, visibleImage } = mountWaiting();
    images.forEach((image) => setLoaded(image.element, false));
    setLoaded(images[0].element, true);
    const first = visibleImage();

    await rotate();
    await rotate();
    expect(visibleImage()).toBe(first);

    setLoaded(images[1].element, true);
    await rotate();
    expect(visibleImage()).toBe(images[1].element);
    expect(wrapper!.findAll(".chat-waiting-gif img").map((image) => image.element)).toEqual(
      images.map((image) => image.element),
    );
  });

  it("skips a failed image and keeps the last good image when no replacement is ready", async () => {
    const { images, visibleImage } = mountWaiting();
    images.forEach((image) => setLoaded(image.element, false));
    setLoaded(images[0].element, true);
    setLoaded(images[1].element, false, true);
    setLoaded(images[2].element, true);

    await rotate();
    expect(visibleImage()).toBe(images[2].element);
    setLoaded(images[0].element, false, true);
    await rotate();
    expect(visibleImage()).toBe(images[2].element);
  });

  it.each(["text", "tool", "partial-plan", "stop"])(
    "stops rotating when %s replaces waiting feedback",
    async (state) => {
      const { store, images, visibleImage } = mountWaiting();
      images.forEach((image) => setLoaded(image.element, true));
      await rotate();
      const current = visibleImage();
      if (state === "text") store.streamText = "The reply has arrived.";
      if (state === "tool") store.streamToolCalls = [{ id: "tool", name: "search", done: false }];
      if (state === "partial-plan") store.streamText = "```json:plan\n{";
      if (state === "stop") store.streaming = false;
      await nextTick();
      expect(vi.getTimerCount()).toBe(0);

      await rotate();
      if (state === "stop") {
        expect(wrapper!.find(".chat-waiting-gif").exists()).toBe(false);
      } else {
        expect(wrapper!.get(".chat-waiting-gif").classes()).toContain("chat-waiting-gif--hidden");
        expect(images.find((image) => image.element.style.display !== "none")!.element).toBe(
          current,
        );
      }
    },
  );

  it("releases the timer when leaving the chat while still waiting", async () => {
    const { images } = mountWaiting();
    images.forEach((image) => setLoaded(image.element, true));
    await nextTick();
    expect(vi.getTimerCount()).toBe(1);
    wrapper!.unmount();
    wrapper = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });
});
