// voiceagent-saas/tests/agent-prompt-campaign-source.test.js
// Verifies the new buildFromCampaign factory used by the unbundled pipeline.
// Spec: docs/superpowers/specs/2026-04-08-unbundled-voice-pipeline-design.md §4.4, §5.4
import { describe, it, expect } from "vitest";
import { buildFromCampaign } from "../agent-prompt.js";

describe("agent-prompt buildFromCampaign", () => {
  it("interpolates {{contact_name}} in the system prompt", () => {
    const result = buildFromCampaign({
      systemPrompt: "אתה מדבר עם {{contact_name}} מ-{{business_name}}.",
      firstMessage: "שלום {{contact_name}}",
      dynamicVariables: { contact_name: "תום", business_name: "Voice Agent" },
    });
    expect(result.systemPrompt).toBe("אתה מדבר עם תום מ-Voice Agent.");
  });

  it("interpolates {{contact_name}} in the first message", () => {
    const result = buildFromCampaign({
      systemPrompt: "test",
      firstMessage: "שלום {{contact_name}}, מה שלומך?",
      dynamicVariables: { contact_name: "דני" },
    });
    expect(result.firstMessage).toBe("שלום דני, מה שלומך?");
  });

  it("leaves unknown placeholders untouched", () => {
    const result = buildFromCampaign({
      systemPrompt: "{{unknown_var}} stays",
      firstMessage: "test",
      dynamicVariables: {},
    });
    expect(result.systemPrompt).toBe("{{unknown_var}} stays");
  });

  it("handles missing systemPrompt with empty string fallback", () => {
    const result = buildFromCampaign({
      systemPrompt: null,
      firstMessage: "שלום",
      dynamicVariables: {},
    });
    expect(result.systemPrompt).toBe("");
  });

  it("handles missing firstMessage with empty string fallback", () => {
    const result = buildFromCampaign({
      systemPrompt: "test",
      firstMessage: null,
      dynamicVariables: {},
    });
    expect(result.firstMessage).toBe("");
  });

  it("returns both interpolated strings as a single object", () => {
    const result = buildFromCampaign({
      systemPrompt: "system {{a}}",
      firstMessage: "first {{b}}",
      dynamicVariables: { a: "X", b: "Y" },
    });
    expect(result).toEqual({ systemPrompt: "system X", firstMessage: "first Y" });
  });

  it("interpolates the same variable multiple times", () => {
    const result = buildFromCampaign({
      systemPrompt: "{{name}} and {{name}} again",
      firstMessage: "",
      dynamicVariables: { name: "דני" },
    });
    expect(result.systemPrompt).toBe("דני and דני again");
  });
});
