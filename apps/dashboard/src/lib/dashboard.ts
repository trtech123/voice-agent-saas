import type { Call, Contact } from "@vam/database";

export interface DashboardContact {
  id: string;
  name: string | null;
  phone: string;
}

export interface DashboardHotLead {
  leadId: string;
  campaignId: string;
  contact: DashboardContact;
  leadScore: number;
  leadStatus: NonNullable<Call["lead_status"]> | "cold";
  attemptCount: number;
  latestCallAt: string;
  summary: string;
  outcomeLabel: string;
  outcomeStatus: string;
}

export interface DashboardConversation {
  conversationId: string;
  leadId: string;
  campaignId: string;
  contact: DashboardContact;
  status: Call["status"];
  statusLabel: string;
  outcomeLabel: string;
  outcomeStatus: string;
  summary: string;
  timestamp: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  leadScore: number | null;
  isLive: boolean;
}

const liveStatuses: Call["status"][] = ["initiated", "ringing", "connected"];

const callStatusDisplayLabels: Record<Call["status"], string> = {
  initiated: "התחילה",
  ringing: "מצלצלת",
  connected: "פעילה",
  completed: "הסתיימה",
  failed: "נכשלה",
  no_answer: "לא נענתה",
  dead_letter: "נכשלה סופית",
};

const leadPriority: Record<NonNullable<Call["lead_status"]> | "cold", number> = {
  hot: 5,
  warm: 4,
  callback: 3,
  cold: 2,
  not_interested: 1,
};

function normalizePhone(phone: string) {
  return phone.replace(/\D/g, "");
}

export function getDashboardContact(contact: Pick<Contact, "id" | "name" | "phone"> | null | undefined): DashboardContact | null {
  if (!contact) return null;
  return {
    id: contact.id,
    name: contact.name ?? null,
    phone: contact.phone,
  };
}

export function getLeadKey(contact: DashboardContact | null | undefined, call: Pick<Call, "contact_id">) {
  return contact?.id ?? normalizePhone(contact?.phone ?? call.contact_id);
}

export function isLiveCall(status: Call["status"]) {
  return liveStatuses.includes(status);
}

export function getCallTimestamp(call: Pick<Call, "started_at" | "created_at">) {
  return call.started_at ?? call.created_at;
}

export function getLeadStatus(call: Pick<Call, "lead_status">): NonNullable<Call["lead_status"]> | "cold" {
  return call.lead_status ?? "cold";
}

export function getOutcomeFromCall(call: Pick<Call, "status" | "lead_status">) {
  if (call.lead_status === "hot") {
    return { label: "ליד חם", status: "hot" };
  }

  if (call.lead_status === "warm") {
    return { label: "ליד חמים", status: "warm" };
  }

  if (call.lead_status === "callback") {
    return { label: "ביקש חזרה", status: "callback" };
  }

  if (call.lead_status === "not_interested") {
    return { label: "לא מעוניין", status: "not_interested" };
  }

  switch (call.status) {
    case "connected":
      return { label: "בשיחה", status: "connected" };
    case "completed":
      return { label: "הושלמה", status: "completed" };
    case "ringing":
      return { label: "מצלצלת", status: "ringing" };
    case "initiated":
      return { label: "החלה", status: "initiated" };
    case "no_answer":
      return { label: "לא נענה", status: "no_answer" };
    case "failed":
      return { label: "נכשלה", status: "failed" };
    default:
      return { label: "נכשלה סופית", status: "dead_letter" };
  }
}

export function buildCallSummary(
  call: Pick<Call, "status" | "lead_status" | "qualification_answers" | "failure_reason" | "whatsapp_sent">
) {
  const answersCount = call.qualification_answers
    ? Object.keys(call.qualification_answers).filter(Boolean).length
    : 0;

  let summary = "אין סיכום זמין עדיין.";

  if (isLiveCall(call.status)) {
    summary = answersCount > 0
      ? `השיחה פעילה ונאספו עד כה ${answersCount} תשובות התאמה.`
      : "השיחה פעילה כעת ועדיין נאסף מידע.";
  } else if (call.lead_status === "hot") {
    summary = answersCount > 0
      ? `ליד חם. נאספו ${answersCount} תשובות התאמה ונדרש מעקב מהיר.`
      : "ליד חם שמוכן למעקב מהיר.";
  } else if (call.lead_status === "warm") {
    summary = answersCount > 0
      ? `הלקוח גילה עניין ונאספו ${answersCount} תשובות התאמה.`
      : "הלקוח גילה עניין ומומלץ לבצע מעקב.";
  } else if (call.lead_status === "callback") {
    summary = "הלקוח ביקש שנחזור אליו בשיחה נוספת.";
  } else if (call.lead_status === "not_interested") {
    summary = "הלקוח ציין שאינו מעוניין בהמשך.";
  } else if (call.status === "no_answer") {
    summary = "לא התקבלה תשובה מהלקוח.";
  } else if (call.status === "failed" || call.status === "dead_letter") {
    summary = call.failure_reason
      ? `השיחה נכשלה: ${call.failure_reason}`
      : "השיחה נכשלה לפני שנאסף מידע משמעותי.";
  } else if (call.status === "completed" || call.status === "connected") {
    summary = answersCount > 0
      ? `השיחה הושלמה ונאספו ${answersCount} תשובות התאמה.`
      : "השיחה הושלמה ללא סיכום נוסף.";
  }

  if (call.whatsapp_sent) {
    summary = `${summary} נשלח גם ווטסאפ להמשך.`;
  }

  return summary;
}

export function getCallStatusLabel(status: Call["status"]) {
  return callStatusDisplayLabels[status];
}

export function getHigherPriorityStatus(
  current: NonNullable<Call["lead_status"]> | "cold",
  next: NonNullable<Call["lead_status"]> | "cold"
) {
  return leadPriority[next] > leadPriority[current] ? next : current;
}
