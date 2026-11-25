import type { Tone } from "../components/ui";

/** One colour meaning per status, shared by every screen. */
export function projectStatusTone(status: string): Tone {
  if (status === "ACTIVE") return "green";
  if (status === "ON_HOLD") return "amber";
  if (status === "COMPLETED") return "brand";
  return "neutral";
}

export function certificateStatusTone(status: string, overdue: boolean): Tone {
  if (overdue) return "red";
  if (status === "PAID") return "green";
  if (status === "APPROVED") return "blue";
  if (status === "SUBMITTED") return "amber";
  return "neutral";
}
