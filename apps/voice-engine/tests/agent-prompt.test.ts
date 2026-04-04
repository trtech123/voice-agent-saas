// apps/voice-engine/tests/agent-prompt.test.ts
import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildRecordingConsentMessage, buildGreetingInstruction } from "../src/agent-prompt.js";

describe("buildSystemPrompt", () => {
  const baseCampaign = {
    script: "אתה נציג מכירות של [שם העסק]. בדוק התעניינות בנכסים.",
    questions: [
      { question: "מה התקציב שלך?", key: "budget" },
      { question: "באיזה אזור אתה מחפש?", key: "area" },
    ],
    whatsapp_followup_template: "הנה הנכסים שמתאימים לך: [link]",
  };

  const baseTenant = {
    name: "נדלן ישראל",
    business_type: "real_estate",
  };

  const baseContact = {
    name: "דני כהן",
    phone: "972501234567",
    custom_fields: { area: "תל אביב" },
  };

  it("includes the campaign script", () => {
    const prompt = buildSystemPrompt(baseCampaign, baseTenant, baseContact);
    expect(prompt).toContain("בדוק התעניינות בנכסים");
  });

  it("replaces [שם העסק] with tenant name", () => {
    const prompt = buildSystemPrompt(baseCampaign, baseTenant, baseContact);
    expect(prompt).toContain("נדלן ישראל");
    expect(prompt).not.toContain("[שם העסק]");
  });

  it("includes qualification questions", () => {
    const prompt = buildSystemPrompt(baseCampaign, baseTenant, baseContact);
    expect(prompt).toContain("מה התקציב שלך?");
    expect(prompt).toContain("באיזה אזור אתה מחפש?");
  });

  it("includes contact name if available", () => {
    const prompt = buildSystemPrompt(baseCampaign, baseTenant, baseContact);
    expect(prompt).toContain("דני כהן");
  });

  it("handles missing contact name gracefully", () => {
    const prompt = buildSystemPrompt(baseCampaign, baseTenant, {
      ...baseContact,
      name: null,
    });
    expect(prompt).not.toContain("null");
    expect(typeof prompt).toBe("string");
  });

  it("includes identity guard and anti-hallucination rules", () => {
    const prompt = buildSystemPrompt(baseCampaign, baseTenant, baseContact);
    // Must not reveal AI identity
    expect(prompt).toMatch(/אל תגיד.*בוט|AI|בינה מלאכותית/);
    // Must include opt-out instruction
    expect(prompt).toContain("mark_opt_out");
  });

  it("includes tool usage instructions", () => {
    const prompt = buildSystemPrompt(baseCampaign, baseTenant, baseContact);
    expect(prompt).toContain("score_lead");
    expect(prompt).toContain("end_call");
  });

  it("includes recording consent instruction", () => {
    const prompt = buildSystemPrompt(baseCampaign, baseTenant, baseContact);
    expect(prompt).toContain("השיחה מוקלטת");
  });
});

describe("buildRecordingConsentMessage", () => {
  it("returns the Hebrew recording consent disclosure", () => {
    const msg = buildRecordingConsentMessage();
    expect(msg).toContain("שים לב, השיחה מוקלטת");
  });
});

describe("buildGreetingInstruction", () => {
  it("includes tenant name", () => {
    const instruction = buildGreetingInstruction("נדלן ישראל", "דני כהן");
    expect(instruction).toContain("נדלן ישראל");
  });

  it("includes contact name when provided", () => {
    const instruction = buildGreetingInstruction("נדלן ישראל", "דני כהן");
    expect(instruction).toContain("דני כהן");
  });

  it("omits contact name when null", () => {
    const instruction = buildGreetingInstruction("נדלן ישראל", null);
    expect(instruction).not.toContain("null");
  });
});
