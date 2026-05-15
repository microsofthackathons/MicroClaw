import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import "highlight.js/styles/github.css";

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(str, { language: lang }).value}</code></pre>`;
      } catch {
        // Fall through
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`;
  },
});

// Restrict linkify to only match explicit URLs (http:// or https://).
// Without this, markdown-it's linkify treats "word.word" patterns like
// "it.Looks" as domain names and renders them as clickable links.
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });

const ALLOWED_TAGS = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "details",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "summary",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
  "img",
];
const ALLOWED_ATTR = ["class", "href", "rel", "target", "title", "start", "src", "alt"];

/** Strip ANSI escape codes (color, cursor, etc.) from text. */
export function stripAnsi(text: string): string {
  // Matches CSI sequences, OSC sequences, and other common ANSI escapes.
  /* eslint-disable no-control-regex */
  return (
    text
      .replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b\[\??[0-9;]*[hl]/g, "")
      // Also strip the bracket-prefixed form that appears when ANSI is partially decoded
      .replace(/\[(\d+;)*\d*m/g, "")
  );
  /* eslint-enable no-control-regex */
}

/**
 * A segment of assistant message text, classified by type.
 * - 'text': The model's own reply content — show normally.
 * - 'intermediate': Tool context, terminal output, JSON data — show in collapsible panel.
 */
export interface MessageSegment {
  type: "text" | "intermediate";
  content: string;
}

/**
 * Segment assistant message text into "text" (model reply) and
 * "intermediate" (tool context) parts.
 *
 * Strategy: Use the 🔧 tool-call marker as the reliable anchor.
 * Find the last 🔧 marker, then scan forward past its associated
 * code fence and any trailing terminal output. Everything from the
 * start of the text up to that boundary → "intermediate".
 * Everything after → "text" (model reply).
 *
 * This avoids false positives: code fences in the model's own reply
 * are NOT treated as intermediate content.
 */
export function segmentMessageContent(rawText: string): MessageSegment[] {
  const text = stripAnsi(rawText).trim();
  if (!text) return [];

  // Find all 🔧 tool-call markers
  const toolMarkerRegex = /🔧\s?\*\*/g;
  let lastToolMarkerIdx = -1;
  let match: RegExpExecArray | null;
  while ((match = toolMarkerRegex.exec(text)) !== null) {
    lastToolMarkerIdx = match.index;
  }

  // No tool markers → return entire text as model reply
  if (lastToolMarkerIdx === -1) {
    return [{ type: "text", content: text }];
  }

  // From the last 🔧 marker, scan forward to find where tool output ends.
  // Skip past: the marker line, any code fences, and trailing terminal output.
  let scanPos = lastToolMarkerIdx;

  // Advance past the current line
  let nextNewline = text.indexOf("\n", scanPos);
  if (nextNewline === -1) nextNewline = text.length;
  scanPos = nextNewline + 1;

  // Skip code fences and terminal-looking output that follow the marker
  const lines = text.slice(scanPos).split("\n");
  let inFence = false;
  let consumed = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (inFence) {
      consumed++;
      if (/^```/.test(trimmed)) inFence = false;
      continue;
    }

    if (/^```/.test(trimmed)) {
      inFence = true;
      consumed++;
      continue;
    }

    // Terminal output patterns (continue consuming)
    if (isTerminalOutput(trimmed)) {
      consumed++;
      continue;
    }

    // Empty line between tool output sections — keep consuming
    if (trimmed === "" && consumed > 0) {
      consumed++;
      continue;
    }

    // Non-terminal, non-fence, non-empty line → this is the start of model reply
    break;
  }

  // Calculate the boundary: everything before is intermediate
  const intermediateEnd = scanPos + lines.slice(0, consumed).join("\n").length;
  const intermediate = text.slice(0, intermediateEnd).trim();
  const reply = text.slice(intermediateEnd).trim();

  const segments: MessageSegment[] = [];
  if (intermediate) {
    segments.push({ type: "intermediate", content: intermediate });
  }
  if (reply) {
    segments.push({ type: "text", content: reply });
  }
  return segments;
}

/**
 * Check if a line looks like terminal/command output rather than prose.
 */
function isTerminalOutput(line: string): boolean {
  if (!line) return false;
  // PS prompt
  if (/^PS\s+[A-Z]:\\/i.test(line)) return true;
  // Directory listing headers
  if (/^Mode\s+.*LastWriteTime/i.test(line)) return true;
  if (/^----+\s+----/.test(line)) return true;
  // Shell prompt (C:\>)
  if (/^[A-Z]:\\.*>/.test(line)) return true;
  // Directory listing rows (e.g. "d---- 4/13/2026 ...")
  if (/^[a-z-]{4,}\s+\d+\/\d+\/\d+/.test(line)) return true;
  // ANSI residuals
  if (/\[\d+;\d*m|\[0m/.test(line)) return true;
  return false;
}

export function renderMarkdown(text: string): string {
  if (!text.trim()) return "";
  let raw: string;
  try {
    raw = md.render(text);
  } catch {
    // Malformed markdown — return safely escaped text
    raw = `<p>${md.utils.escapeHtml(text)}</p>`;
  }
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
  });
}
