import type { MeetingBriefDeliveryState } from "@chief-of-staff-demo/shared";

export interface DeliveryPresentation {
  label: string;
  className: string;
  explanation: string | null;
  isError: boolean;
}

export function deliveryPresentation(
  status: MeetingBriefDeliveryState["status"],
): DeliveryPresentation {
  switch (status) {
    case "sent":
      return { label: "Sent", className: "status-done", explanation: null, isError: false };
    case "reconciled":
      return {
        label: "Sent (reconciled)",
        className: "status-done",
        explanation: null,
        isError: false,
      };
    case "pending":
      return {
        label: "Pending",
        className: "muted",
        explanation:
          "Waiting for the quiet period; delivery resumes after 5 minutes unless superseded.",
        isError: false,
      };
    case "superseded":
      return {
        label: "Superseded",
        className: "status-active",
        explanation:
          "A newer material Calendar change superseded this revision; only the latest revision sends.",
        isError: false,
      };
    case "skipped":
      return {
        label: "Skipped",
        className: "muted",
        explanation: "Delivery was skipped because the meeting was no longer eligible.",
        isError: false,
      };
    case "failed":
      return {
        label: "Failed",
        className: "status-failed",
        explanation:
          "Delivery failed. Retry repeats only the deliver Stage and reconciles Gmail before sending.",
        isError: true,
      };
  }
}
