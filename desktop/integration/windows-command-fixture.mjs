import assert from "node:assert/strict";

export function exactField(prompt, label) {
  const lines = prompt.split("\n");
  const simple = lines.find((line) => line.startsWith(`${label}: `));
  if (simple) return simple.slice(label.length + 2);
  const start = lines.indexOf(`${label} [JSON fragments; join without separators]:`);
  if (start < 0) throw new Error(`Missing exact field ${label}`);
  const fragments = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^ {2}\[(\d+)\/(\d+)\] (.*)$/.exec(line);
    if (!match) break;
    assert.equal(Number(match[1]), fragments.length + 1);
    fragments.push(match[3]);
  }
  return fragments.join("");
}

export function windowsCommand(argv) {
  return argv
    .map((value) => {
      if (value && !/\s|"/.test(value)) return value;
      let result = '"';
      let slashes = 0;
      for (const character of value) {
        if (character === "\\") {
          slashes++;
          continue;
        }
        if (character === '"') {
          result += "\\".repeat(slashes * 2 + 1) + '"';
          slashes = 0;
          continue;
        }
        result += "\\".repeat(slashes) + character;
        slashes = 0;
      }
      return result + "\\".repeat(slashes * 2) + '"';
    })
    .join(" ");
}
