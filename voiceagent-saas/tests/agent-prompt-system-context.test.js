import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../agent-prompt.js";

describe("buildSystemPrompt callback scheduling context", () => {
  it("includes time context and legal schedule guidance", () => {
    const prompt = buildSystemPrompt(
      {
        script: "שלום מ-[שם העסק]",
        questions: [{ question: "מה נשמע?" }],
        schedule_days: ["sun", "mon", "tue"],
        schedule_windows: [{ start: "09:00", end: "12:00" }],
      },
      { name: "Acme", business_type: "services" },
      { name: "דני", custom_fields: {} },
    );

    expect(prompt).toContain("## תזמון שיחות חוזרות");
    expect(prompt).toContain("UTC:");
    expect(prompt).toContain("שעות ההתקשרות המותרות לקמפיין:");
    expect(prompt).toContain("ימים: sun, mon, tue; חלונות זמן: 09:00-12:00");
    expect(prompt).toContain("callback_timestamp");
    expect(prompt).toContain("ISO 8601");
  });

  it("falls back to default schedule text when campaign schedule is missing", () => {
    const prompt = buildSystemPrompt(
      {
        script: "שלום מ-[שם העסק]",
        questions: [{ question: "מה נשמע?" }],
      },
      { name: "Acme", business_type: "services" },
      { name: null, custom_fields: {} },
    );

    expect(prompt).toContain("ימים: sun, mon, tue, wed, thu");
    expect(prompt).toContain("חלונות זמן: 10:00-13:00, 16:00-19:00");
  });
});
