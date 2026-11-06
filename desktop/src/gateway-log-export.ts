const MAX_GATEWAY_LOG_LINES = 1_000;
const MAX_GATEWAY_LOG_BYTES = 5 * 1024 * 1024;

export function formatGatewayLogExport(value: unknown): string {
  if (!Array.isArray(value)) {
    throw new Error("Gateway logs must be an array");
  }
  if (value.length > MAX_GATEWAY_LOG_LINES) {
    throw new Error(`Gateway logs cannot exceed ${MAX_GATEWAY_LOG_LINES} lines`);
  }

  let totalBytes = 0;
  const lines = value.map((line) => {
    if (typeof line !== "string") {
      throw new Error("Each Gateway log line must be a string");
    }
    const normalizedLine = line.replace(/\r\n?|\n/g, "\r\n");
    totalBytes += Buffer.byteLength(normalizedLine, "utf8") + 2;
    if (totalBytes > MAX_GATEWAY_LOG_BYTES) {
      throw new Error("Gateway logs cannot exceed 5 MB");
    }
    return normalizedLine;
  });
  return lines.length > 0 ? `${lines.join("\r\n")}\r\n` : "";
}

export function createGatewayLogExportFilename(date = new Date()): string {
  const timestamp = date
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d{3}Z$/, "Z");
  return `microclaw-gateway-logs-${timestamp}.log`;
}
