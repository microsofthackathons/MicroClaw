export type WindowsNodeMxcApprovalDecision = "deny" | "allow-once" | "allow-always";

export function resolveWindowsNodeMxcAllowedDecisions(request: {
  approvalLayer: "gateway" | "node";
  allowedDecisions: WindowsNodeMxcApprovalDecision[];
}): WindowsNodeMxcApprovalDecision[] {
  return request.approvalLayer === "gateway"
    ? request.allowedDecisions
    : request.allowedDecisions.filter((decision) => decision !== "allow-always");
}
