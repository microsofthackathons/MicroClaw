import { t } from "@/i18n";
import { ElMessageBox } from "element-plus";
import type {
  LocalModelAPI,
  LocalModelOperation,
  LocalModelResult,
} from "../../../src/local-model-types";

type TransitionAPI = Pick<LocalModelAPI, "getOperation" | "cancel" | "resume">;
export type LocalModelRelease = "ready" | "declined" | "pending";

export async function confirmLocalModelSwitch(): Promise<boolean> {
  try {
    await ElMessageBox.confirm(t("localModel.switchCloudConfirm"), t("settings.confirm"), {
      confirmButtonText: t("localModel.switchCloudContinue"),
      cancelButtonText: t("localModel.keepLocalSetup"),
      type: "warning",
    });
    return true;
  } catch (error) {
    if (error === "cancel" || error === "close") return false;
    throw error;
  }
}

function unwrap(result: LocalModelResult<LocalModelOperation | null>) {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** Release only the operation the user agreed to cancel; never replay a wizard answer. */
export async function releaseLocalModelSetup(
  api: TransitionAPI | undefined,
  confirmCancellation: () => Promise<boolean>,
  isCurrent: () => boolean = () => true,
): Promise<LocalModelRelease> {
  if (!api) return "ready";
  const initial = unwrap(await api.getOperation());
  if (!isCurrent()) return "declined";
  if (!initial?.busy) return "ready";

  if (!initial.cancellationPending && !(await confirmCancellation())) return "declined";
  if (!isCurrent()) return "declined";
  const current = unwrap(await api.getOperation());
  if (!isCurrent()) return "declined";
  if (!current?.busy) return "ready";
  if (current.id !== initial.id) throw new Error(t("localModel.setupChanged"));

  let outcome = current.cancellationPending ? current : unwrap(await api.cancel(current.id));
  if (outcome?.busy && outcome.phase === "interrupted") {
    unwrap(await api.resume());
    outcome = unwrap(await api.getOperation());
  }
  if (!isCurrent()) return "declined";
  return outcome?.busy ? "pending" : "ready";
}
