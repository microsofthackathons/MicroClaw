export type WeixinLoginCliActivationOutcome =
  | "reload-requested"
  | "already-active"
  | "reload-failed";

export interface WeixinLoginCliOutcomeParser {
  readonly outcome: WeixinLoginCliActivationOutcome | null;
  push(chunk: string): string;
  finish(): string;
}

function parseOutcomeLine(
  line: string,
  outcomeToken: string,
): WeixinLoginCliActivationOutcome | null {
  const prefix = `[microclaw-weixin-activation:${outcomeToken}] `;
  if (!line.startsWith(prefix)) return null;
  const match = line
    .slice(prefix.length)
    .match(/^(reload-requested|already-active|reload-failed)\r?$/);
  return (match?.[1] as WeixinLoginCliActivationOutcome | undefined) ?? null;
}

export function createWeixinLoginCliOutcomeParser(
  outcomeToken: string,
): WeixinLoginCliOutcomeParser {
  let pending = "";
  let outcome: WeixinLoginCliActivationOutcome | null = null;

  const consumeLine = (line: string, suffix: string): string => {
    const parsed = parseOutcomeLine(line, outcomeToken);
    if (parsed) {
      outcome = parsed;
      return "";
    }
    return `${line}${suffix}`;
  };

  return {
    get outcome() {
      return outcome;
    },
    push(chunk) {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      return lines.map((line) => consumeLine(line, "\n")).join("");
    },
    finish() {
      const tail = pending;
      pending = "";
      return tail ? consumeLine(tail, "") : "";
    },
  };
}
