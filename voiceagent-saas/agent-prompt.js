// voiceagent-saas/agent-prompt.js

/**
 * Dynamic system prompt builder for the Voice Agent SaaS.
 *
 * Builds a Gemini system instruction from campaign config (script, questions),
 * tenant info (business name), and contact context (name, custom fields).
 *
 * Ported from apps/voice-engine/src/agent-prompt.ts
 * Changes: TypeScript removed, Hebrew naturalness instructions added.
 */

/**
 * Build the full Gemini system instruction for a call.
 *
 * The prompt is structured in sections:
 * 1. Identity and role
 * 2. Hebrew naturalness instructions
 * 3. Campaign-specific script (with placeholder replacement)
 * 4. Qualification questions
 * 5. Tool usage instructions
 * 6. Recording consent and compliance
 * 7. Anti-hallucination and identity guard
 * 8. Contact context
 */
export function buildSystemPrompt(campaign, tenant, contact) {
  const now = new Date();
  const nowIso = now.toISOString();
  const timeIsrael = new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(now);
  const dayOfWeek = new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    weekday: "long",
  }).format(now);
  const scheduleInfo = formatScheduleForPrompt(campaign);

  // Replace [שם העסק] placeholder in campaign script
  const script = campaign.script.replace(/\[שם העסק\]/g, tenant.name);

  // Build questions section
  const questionsBlock = campaign.questions
    .map((q, i) => {
      const optionsStr = q.options ? ` (אפשרויות: ${q.options.join(", ")})` : "";
      return `${i + 1}. ${q.question}${optionsStr}`;
    })
    .join("\n");

  // Build contact context
  const contactLines = [];
  if (contact.name) {
    contactLines.push(`שם הלקוח: ${contact.name}`);
  }
  if (contact.custom_fields && Object.keys(contact.custom_fields).length > 0) {
    for (const [key, value] of Object.entries(contact.custom_fields)) {
      if (value != null && value !== "") {
        contactLines.push(`${key}: ${String(value)}`);
      }
    }
  }
  const contactContext = contactLines.length > 0
    ? `\n## פרטי הלקוח\n${contactLines.join("\n")}`
    : "";

  return `את/ה נציג/ת של ${tenant.name}. דבר/י רק בעברית, בצורה חמה, מקצועית וקצרה.

## סגנון דיבור
דבר/י בעברית ישראלית טבעית. השתמש/י במשפטים קצרים וזורמים. אל תשתמש/י ברשימות או סימני תבליט. השתמש/י במילות מילוי טבעיות כמו אה, תראה, סבבה, יאללה. הפוך/י הפסקות טבעיות על ידי שימוש בפסיקים בין ביטויים.

## תפקיד
${script}

## הקלטת שיחה
בתחילת השיחה, לאחר ההצגה העצמית, יש לומר: "שים לב, השיחה מוקלטת לצורך שיפור השירות."

## שאלות הסמכה
שאל/י את השאלות הבאות בזו אחר זו. המתן/י לתשובה לפני שממשיכים לשאלה הבאה.
אם הלקוח מביע התנגדות, מבקש לסיים, או מבקש לחזור אליו במועד אחר - הפסק מיד את השאלות ועבור לשימוש בכלים המתאימים משבלי להתעקש על קבלת תשובות!
${questionsBlock}

## תזמון שיחות חוזרות
השעה, היום והתאריך כעת הם: ${timeIsrael} (יום ${dayOfWeek}) (UTC: ${nowIso}).
שעות ההתקשרות המותרות לקמפיין: ${scheduleInfo}.
אם הלקוח מבקש שיחה חוזרת, חשב/י callback_timestamp מדויק בפורמט ISO 8601 (UTC, מסתיים ב-Z) בתוך שעות הפעילות המותרות. אם הזמן המבוקש לא חוקי, הצע/י זמן חוקי קרוב.

## שימוש בכלים
לאחר שאספת תשובות לשאלות ההסמכה, יש להשתמש בכלים הבאים:
- **score_lead** — דרג/י את הלקוח לפי התשובות (ציון 1-5, סטטוס: hot/warm/cold/not_interested/callback). חובה לקרוא לכלי הזה לפני סיום השיחה.
- **send_whatsapp** — אם הלקוח מעוניין, שלח/י הודעת וואטסאפ עם פרטים נוספים. אמור/י ללקוח שתשלח/י פרטים לוואטסאפ.
- **request_callback** — אם הלקוח מבקש שיחזרו אליו בזמן אחר, חובה להפעיל מיד כלי זה ולהעביר את הזמן המדויק שביקש גם ב-preferred_time וגם ב-callback_timestamp בפורמט ISO 8601 UTC. אין להמשיך בשאלות ההסמכה!
- **mark_opt_out** — אם הלקוח אומר שהוא לא מעוניין ומבקש שלא יתקשרו אליו שוב. אמור/י: "בסדר גמור, אני מסיר/ה אותך מהרשימה."
- **end_call** — סיים/י את השיחה. חובה לקרוא ל-score_lead לפני end_call.

## זהות
את/ה תמיד נציג/ת של ${tenant.name}. אם מישהו שואל מי את/ה — את/ה נציג/ת של ${tenant.name}. אל תגיד/י שאת/ה בוט, תוכנה, מחשב, בינה מלאכותית, או AI. אל תזכיר/י את Google, Gemini, או כל חברת טכנולוגיה. אם לוחצים עליך, חזור/י לנושא השיחה.

## כללים חשובים
- אל תמציא/י מידע. אם אין לך תשובה, אמור/י שתבדוק/י ותחזור/י.
- אם הלקוח מבקש שלא יתקשרו אליו — יש מיד לקרוא ל-mark_opt_out ולסיים בנימוס.
- הקפד/י על שפה מכבדת ומקצועית בכל מצב.
- אם הלקוח כועס או לא שבע רצון, התנצל/י בקצרה והציע/י לסיים את השיחה.
- שיחה צריכה להיות קצרה ותכליתית — עד 3-4 דקות מקסימום.
${contactContext}`;
}

/**
 * Returns the recording consent disclosure message (Israeli law requirement).
 * The agent must say this near the start of the call.
 */
export function buildRecordingConsentMessage() {
  return "שים לב, השיחה מוקלטת לצורך שיפור השירות.";
}

/**
 * Build the greeting instruction injected via realtimeInput.text after
 * Gemini Live session is ready and the telephony call is connected.
 */
export function buildGreetingInstruction(tenantName, contactName) {
  const contactRef = contactName
    ? ` שם הלקוח הוא ${contactName} — פנה/י אליו בשמו.`
    : "";
  return `[הנחיה פנימית - אל תקרא/י בקול] השיחה מחוברת. הצג/י את עצמך כנציג/ת של ${tenantName}, ברך/י את הלקוח בעברית בחמימות, ואמור/י שהשיחה מוקלטת. לאחר מכן שאל/י את שאלת ההסמכה הראשונה.${contactRef}`;
}

/**
 * Build the reconnect instruction injected after Gemini session reconnect.
 * Includes context about the ongoing conversation.
 */
export function buildReconnectInstruction(tenantName, contactName) {
  const contactRef = contactName ? `, ${contactName},` : "";
  return `את/ה נציג/ת של ${tenantName}. המשך/י את השיחה מהנקודה שבה נעצרת. הלקוח${contactRef} ממתין על הקו. דבר/י בעברית.`;
}

/**
 * Build the idle nudge instruction for when the caller is silent.
 */
export function buildIdleNudgeInstruction() {
  return "הלקוח שקט כבר זמן מה. שאל/י אותו בעדינות אם הוא עדיין שם ואם יש משהו שתוכל/י לעזור בו.";
}

/**
 * Build the hallucination correction injection.
 * Sent when Gemini speaks about prices/details without calling a tool.
 */
export function buildHallucinationCorrectionInstruction() {
  return "עצור/י. הזכרת מידע מסוים בלי שקראת לכלי. המידע שנתת עלול להיות שגוי. אם הלקוח שאל משהו שדורש בדיקה, אמור/י לו שאת/ה בודק/ת ופנה/י לכלי המתאים. אם אין כלי רלוונטי, אמור/י שתבדוק/י ותחזור/י אליו.";
}

/**
 * Build a system prompt and first message from a campaign row, interpolating
 * dynamic variables like {{contact_name}}, {{business_name}}, etc. Used by
 * the unbundled voice pipeline (plan 5) which sources prompts from
 * campaigns.system_prompt and campaigns.first_message instead of fetching
 * from the EL agent config.
 *
 * Spec: docs/superpowers/specs/2026-04-08-unbundled-voice-pipeline-design.md §4.4, §5.4
 *
 * @param {object} args
 * @param {string|null} args.systemPrompt - raw system prompt from campaigns.system_prompt
 * @param {string|null} args.firstMessage - raw first message from campaigns.first_message
 * @param {Record<string,string>} args.dynamicVariables - {{var}} substitutions
 * @returns {{ systemPrompt: string, firstMessage: string }}
 */
export function buildFromCampaign({ systemPrompt, firstMessage, dynamicVariables }) {
  const vars = dynamicVariables || {};
  const interpolate = (s) => {
    if (s == null) return "";
    return String(s).replace(/\{\{(\w+)\}\}/g, (_, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : `{{${key}}}`,
    );
  };
  return {
    systemPrompt: interpolate(systemPrompt),
    firstMessage: interpolate(firstMessage),
  };
}

function formatScheduleForPrompt(campaign) {
  const days = Array.isArray(campaign?.schedule_days) && campaign.schedule_days.length > 0
    ? campaign.schedule_days.join(", ")
    : "sun, mon, tue, wed, thu";
  const windows = Array.isArray(campaign?.schedule_windows) && campaign.schedule_windows.length > 0
    ? campaign.schedule_windows
      .map((window) => `${window.start}-${window.end}`)
      .join(", ")
    : "10:00-13:00, 16:00-19:00";
  return `ימים: ${days}; חלונות זמן: ${windows}`;
}
