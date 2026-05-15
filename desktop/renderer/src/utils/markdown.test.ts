import { describe, it, expect } from "vitest";
import { renderMarkdown, stripAnsi, segmentMessageContent } from "./markdown";

describe("renderMarkdown", () => {
  it("renders simple text as paragraph", () => {
    const result = renderMarkdown("Hello world");
    expect(result).toContain("<p>");
    expect(result).toContain("Hello world");
  });

  it("returns empty string for empty/whitespace input", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("   ")).toBe("");
    expect(renderMarkdown("\n")).toBe("");
  });

  it("renders bold text", () => {
    const result = renderMarkdown("**bold**");
    expect(result).toContain("<strong>bold</strong>");
  });

  it("renders code blocks with syntax highlighting", () => {
    const result = renderMarkdown("```javascript\nconsole.log('hi');\n```");
    expect(result).toContain("<pre");
    expect(result).toContain("<code");
  });

  it("renders inline code", () => {
    const result = renderMarkdown("Use `npm install` to install");
    expect(result).toContain("<code>");
    expect(result).toContain("npm install");
  });

  it("renders links", () => {
    const result = renderMarkdown("[Google](https://google.com)");
    expect(result).toContain("<a");
    expect(result).toContain("https://google.com");
  });

  it("sanitizes script tags (XSS prevention)", () => {
    const result = renderMarkdown('<script>alert("xss")</script>');
    expect(result).not.toContain("<script");
  });

  it("sanitizes event handlers (XSS prevention)", () => {
    const result = renderMarkdown('<img onerror="alert(1)" src="x">');
    // markdown.ts uses html:true and relies on DOMPurify to strip dangerous
    // attributes. <img> is in ALLOWED_TAGS so the tag itself is preserved,
    // but the inline event handler must be removed.
    expect(result).not.toContain("onerror");
    expect(result).not.toContain("alert");
  });

  it("allows safe HTML tags after sanitization", () => {
    const result = renderMarkdown("# Heading\n\n- item 1\n- item 2");
    expect(result).toContain("<h1>");
    expect(result).toContain("<li>");
  });

  it("handles malformed markdown gracefully (error boundary)", () => {
    // Extremely long input that could cause issues
    const longInput = "x".repeat(100_000);
    expect(() => renderMarkdown(longInput)).not.toThrow();
    const result = renderMarkdown(longInput);
    expect(result).toBeTruthy();
  });
});

describe("stripAnsi", () => {
  it("strips CSI color sequences", () => {
    expect(stripAnsi("\x1b[32;1mGreen\x1b[0m")).toBe("Green");
  });

  it("strips bracket-prefixed ANSI residuals", () => {
    expect(stripAnsi("[32;1mMode [0m[32;1m Length[0m")).toBe("Mode  Length");
  });

  it("returns plain text unchanged", () => {
    expect(stripAnsi("Hello world")).toBe("Hello world");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("strips multiple ANSI codes in complex output", () => {
    const input = "[32;1m---- [0m [32;1m------[0m [32;1m-------------[0m";
    const result = stripAnsi(input);
    expect(result).not.toContain("[32;1m");
    expect(result).not.toContain("[0m");
    expect(result).toContain("----");
  });
});

describe("segmentMessageContent", () => {
  it("returns entire text as 'text' when no tool markers present", () => {
    const result = segmentMessageContent("Hello, how can I help you?");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("text");
    expect(result[0].content).toBe("Hello, how can I help you?");
  });

  it("returns empty array for empty/whitespace input", () => {
    expect(segmentMessageContent("")).toHaveLength(0);
    expect(segmentMessageContent("   ")).toHaveLength(0);
  });

  it("separates tool context (before 🔧) from model reply (after)", () => {
    const input = `Some preamble text

🔧 **exec**
\`\`\`json
{"command": "ls"}
\`\`\`

d---- 4/13/2026 folder1

C:\\a contains folder1 and folder2.`;

    const result = segmentMessageContent(input);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("intermediate");
    expect(result[0].content).toContain("🔧");
    expect(result[1].type).toBe("text");
    expect(result[1].content).toContain("folder1 and folder2");
  });

  it("does NOT treat model code blocks as intermediate content", () => {
    const input = `Here is the code:

\`\`\`python
print("hello")
\`\`\`

That should work.`;

    const result = segmentMessageContent(input);
    // No 🔧 marker → everything is text, code blocks are not separated
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("text");
    expect(result[0].content).toContain("```python");
    expect(result[0].content).toContain("That should work");
  });

  it("handles multiple 🔧 markers — uses last one as boundary", () => {
    const input = `🔧 **read**
\`\`\`json
{"path": "/file1"}
\`\`\`

File content here

🔧 **exec**
\`\`\`json
{"command": "echo hi"}
\`\`\`

The result is: hi`;

    const result = segmentMessageContent(input);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("intermediate");
    // Both tool markers should be in intermediate
    expect(result[0].content).toContain("**read**");
    expect(result[0].content).toContain("**exec**");
    expect(result[1].type).toBe("text");
    expect(result[1].content).toContain("The result is: hi");
  });

  it("strips ANSI codes before segmenting", () => {
    const input = `[32;1mMode[0m output\n\n🔧 **exec**\n\nClean reply`;
    const result = segmentMessageContent(input);
    const allContent = result.map((s) => s.content).join(" ");
    expect(allContent).not.toContain("[32;1m");
  });

  it("handles 🔧 marker at the very end (no reply text)", () => {
    const input = `🔧 **exec**
\`\`\`json
{"command": "rm -rf /"}
\`\`\``;

    const result = segmentMessageContent(input);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("intermediate");
  });

  it("handles text before and after tool with terminal output lines", () => {
    const input = `Let me check...

🔧 **exec**
\`\`\`json
{"command": "dir"}
\`\`\`

Mode  Length  Name
----  ------  ----
d---- folder1

Found 1 folder.`;

    const result = segmentMessageContent(input);
    expect(result).toHaveLength(2);
    expect(result[1].type).toBe("text");
    expect(result[1].content).toContain("Found 1 folder");
  });
});
