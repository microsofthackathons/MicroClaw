import { describe, it, expect } from "vitest";
import { ref } from "vue";
import { parsePlanProgress, stripPlanMarkers, usePlanProgress } from "./usePlanProgress";

describe("parsePlanProgress", () => {
  it("returns null when no plan block is found", () => {
    expect(parsePlanProgress("hello world")).toBeNull();
    expect(parsePlanProgress("```json\n[]\n```")).toBeNull();
  });

  it("parses a basic plan block with no step markers", () => {
    const text = `好的，我来帮你整理桌面

\`\`\`json:plan
[
  {"step": 1, "label": "扫描桌面文件"},
  {"step": 2, "label": "按文件类型分类"},
  {"step": 3, "label": "把截图移到 Screenshots/"}
]
\`\`\`

Let me start...`;

    const result = parsePlanProgress(text);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(3);
    expect(result!.completed).toBe(0);
    expect(result!.currentIndex).toBe(-1);
    expect(result!.steps[0]).toEqual({ step: 1, label: "扫描桌面文件", status: "not-started" });
    expect(result!.steps[1]).toEqual({ step: 2, label: "按文件类型分类", status: "not-started" });
  });

  it("tracks step start markers", () => {
    const text = `\`\`\`json:plan
[{"step": 1, "label": "Scan"}, {"step": 2, "label": "Move"}]
\`\`\`

<!-- step:1:start -->
scanning...
<!-- step:1:done -->

<!-- step:2:start -->
moving...`;

    const result = parsePlanProgress(text)!;
    expect(result.steps[0].status).toBe("done");
    expect(result.steps[1].status).toBe("in-progress");
    expect(result.completed).toBe(1);
    expect(result.currentIndex).toBe(1);
  });

  it("tracks all steps done", () => {
    const text = `\`\`\`json:plan
[{"step": 1, "label": "A"}, {"step": 2, "label": "B"}]
\`\`\`

<!-- step:1:start -->
<!-- step:1:done -->
<!-- step:2:start -->
<!-- step:2:done -->`;

    const result = parsePlanProgress(text)!;
    expect(result.completed).toBe(2);
    expect(result.currentIndex).toBe(-1);
    expect(result.steps.every((s) => s.status === "done")).toBe(true);
  });

  it("returns null for invalid JSON in plan block", () => {
    const text = `\`\`\`json:plan
not valid json
\`\`\``;
    expect(parsePlanProgress(text)).toBeNull();
  });

  it("returns null for empty array plan block", () => {
    const text = `\`\`\`json:plan
[]
\`\`\``;
    expect(parsePlanProgress(text)).toBeNull();
  });

  it("uses the LAST plan block when multiple exist (SKILL.md example + actual)", () => {
    const text = `The skill says to use this format:

\`\`\`json:plan
[
  {"step": 1, "label": "扫描桌面文件"},
  {"step": 2, "label": "按文件类型分类"},
  {"step": 3, "label": "把截图移到 Screenshots/"},
  {"step": 4, "label": "把 PDF 移到 Finance/"},
  {"step": 5, "label": "把图片移到 Media/"},
  {"step": 6, "label": "删除重复的空文件"}
]
\`\`\`

OK, here is my actual plan:

\`\`\`json:plan
[
  {"step": 1, "label": "Scan desktop files"},
  {"step": 2, "label": "Analyze folder structure"},
  {"step": 3, "label": "Rename 'New folder'"},
  {"step": 4, "label": "Review and confirm"}
]
\`\`\`

<!-- step:1:start -->
<!-- step:1:done -->
<!-- step:2:start -->
<!-- step:2:done -->
<!-- step:3:start -->
<!-- step:3:done -->
<!-- step:4:start -->
<!-- step:4:done -->`;

    const result = parsePlanProgress(text)!;
    expect(result.total).toBe(4);
    expect(result.steps[0].label).toBe("Scan desktop files");
    expect(result.completed).toBe(4);
  });

  it("parses step markers across concatenated text from multiple messages", () => {
    // Simulates getHistoryPlan concatenating multiple messages with \n
    const msg1 = `\`\`\`json:plan
[{"step": 1, "label": "Scan"}, {"step": 2, "label": "Move"}, {"step": 3, "label": "Done"}]
\`\`\`

<!-- step:1:start -->`;
    const msg2 = `<!-- step:1:done -->
<!-- step:2:start -->`;
    const msg3 = `<!-- step:2:done -->
<!-- step:3:start -->
<!-- step:3:done -->`;

    const combined = [msg1, msg2, msg3].join("\n");
    const result = parsePlanProgress(combined)!;
    expect(result.total).toBe(3);
    expect(result.completed).toBe(3);
    expect(result.steps.every((s) => s.status === "done")).toBe(true);
  });
});

describe("stripPlanMarkers", () => {
  it("removes plan blocks and step markers", () => {
    const text = `Hello

\`\`\`json:plan
[{"step": 1, "label": "A"}]
\`\`\`

<!-- step:1:start -->
doing work
<!-- step:1:done -->

All done!`;

    const result = stripPlanMarkers(text);
    expect(result).not.toContain("json:plan");
    expect(result).not.toContain("<!-- step");
    expect(result).toContain("Hello");
    expect(result).toContain("doing work");
    expect(result).toContain("All done!");
  });

  it("returns original text when no markers present", () => {
    expect(stripPlanMarkers("hello world")).toBe("hello world");
  });

  it("handles markers with extra whitespace", () => {
    const text = "before <!-- step:1:start --> after <!-- step:2:done --> end";
    const result = stripPlanMarkers(text);
    expect(result).not.toContain("step:");
    expect(result).toContain("before");
    expect(result).toContain("after");
    expect(result).toContain("end");
  });
});

describe("usePlanProgress", () => {
  it("reactively computes plan from ref", () => {
    const text = ref("");
    const { plan, hasPlan, cleanText } = usePlanProgress(text);

    expect(hasPlan.value).toBe(false);
    expect(plan.value).toBeNull();

    text.value = `\`\`\`json:plan
[{"step": 1, "label": "Test"}]
\`\`\`

<!-- step:1:start -->
working...`;

    expect(hasPlan.value).toBe(true);
    expect(plan.value!.total).toBe(1);
    expect(plan.value!.steps[0].status).toBe("in-progress");
    expect(cleanText.value).not.toContain("json:plan");
    expect(cleanText.value).toContain("working...");
  });
});
