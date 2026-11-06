import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadWebFonts, loadWebFontsAfterPageLoad } from "./web-fonts";

describe("web fonts", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
  });

  it("loads fonts only after the page load event", () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    loadWebFontsAfterPageLoad(document, window);

    expect(document.querySelector("#microclaw-web-fonts")).toBeNull();

    window.dispatchEvent(new Event("load"));

    expect(document.querySelector<HTMLLinkElement>("#microclaw-web-fonts")?.rel).toBe("stylesheet");
  });

  it("does not append the stylesheet more than once", () => {
    loadWebFonts(document);
    loadWebFonts(document);

    expect(document.querySelectorAll("#microclaw-web-fonts")).toHaveLength(1);
  });
});
