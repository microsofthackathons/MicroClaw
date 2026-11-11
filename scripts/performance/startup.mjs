// Main-process epochs isolate retries/restarts; worker clocks remain independent.
export function collectStartupTiming(records, processId) {
  const start = records.findLastIndex(
    (event) => event.event === "main-process-start" && event.processId === processId,
  );
  const events = records
    .slice(start < 0 ? records.length : start)
    .filter((event) => event.timingVersion === 2 && event.processId === processId);
  const milestones = events.filter((event) => event.event === "startup-milestone");
  const phases = events.filter((event) => event.event === "startup-breakdown");
  const summaries = events.filter((event) => event.event === "startup-summary");
  const runtime = events.filter((event) => event.event === "startup-runtime-phase");
  const mxc = events.filter((event) => event.event === "startup-mxc-phase");
  const outcomes = events.filter((event) => event.event === "startup-outcome");
  const missing = [];
  if (!milestones.some((event) => event.phase === "renderer-loaded"))
    missing.push("renderer-loaded");
  if (!runtime.some((event) => event.phase === "preparation-total" && event.status === "success"))
    missing.push("runtime-preparation");
  if (!phases.some((event) => event.phase === "existing-gateway-check"))
    missing.push("gateway-preflight");
  if (!summaries.some((event) => event.phase === "application-service-ready"))
    missing.push("service-ready");
  return {
    version: 2,
    processId,
    coverage: events.length ? (missing.length ? "partial" : "complete") : "unavailable",
    missing,
    milestones,
    phases,
    summaries,
    runtime,
    mxc,
    outcomes,
  };
}
