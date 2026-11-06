import { describe, expect, it } from "vitest";
import router from "./router";

describe("router navigation compatibility", () => {
  it("falls back from the removed Studio view to Chat", () => {
    const route = router.getRoutes().find((candidate) => candidate.path === "/studio");

    expect(route?.redirect).toBe("/chat");
  });

  it("redirects the former Skills entry to the Settings section", () => {
    const route = router.getRoutes().find((candidate) => candidate.path === "/skills");

    expect(route?.redirect).toBe("/settings/skills");
  });
});
