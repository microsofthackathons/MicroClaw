import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const parserUrl = pathToFileURL(createRequire(import.meta.url).resolve("markdown-it")).href;
const parserScript = `
  import { readFileSync } from "node:fs";
  import MarkdownIt from ${JSON.stringify(parserUrl)};

  const parser = new MarkdownIt({ html: true, linkify: true, typographer: true });
  parser.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
  const rendered = parser.render(readFileSync(0, "utf8"));
  process.stdout.write(String(rendered.length));
`;

describe("Markdown parser performance with renderer options", () => {
  it.each([
    ["unclosed multiline reference labels", "[" + "line\n".repeat(128_000)],
    ["unclosed multiline reference titles", '[item]: /path "\n' + "line\n".repeat(128_000)],
    ["unknown URL schemes", "unknown://".repeat(80_000)],
    ["unmatched smartquotes", '"x'.repeat(100_000) + "'x".repeat(100_000)],
    ["repeated mailto prefixes", "mailto:".repeat(120_000) + "x"],
    ["unclosed inline HTML comments", "prefix " + "<!--".repeat(100_000)],
    ["unclosed processing instructions", "prefix " + "<?".repeat(200_000)],
    ["unclosed HTML declarations", "prefix " + "<!A".repeat(150_000)],
    ["unclosed CDATA sections", "prefix " + "<![CDATA[".repeat(50_000)],
  ])(
    "finishes parsing %s in a bounded subprocess",
    (_name, input) => {
      const output = execFileSync(
        process.execPath,
        ["--input-type=module", "--eval", parserScript],
        {
          input,
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
        },
      );

      expect(Number(output)).toBeGreaterThan(0);
    },
    15_000,
  );
});
