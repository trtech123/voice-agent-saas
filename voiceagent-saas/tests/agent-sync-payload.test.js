import { describe, it, expect } from "vitest";
import { buildAgentPayload } from "../agent-sync-processor.js";

const MOCK_ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  script: "שלום, אני סוכן AI",
  voice_id: "voice123",
  tts_model: "eleven_turbo_v2_5",
};

describe("buildAgentPayload — tool placement", () => {
  it("places tools at conversation_config.agent.prompt.tools", () => {
    const payload = buildAgentPayload(MOCK_ROW);
    const tools = payload.conversation_config.agent.prompt.tools;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(5);
  });

  it("does not include platform_settings.widget.tools", () => {
    const payload = buildAgentPayload(MOCK_ROW);
    expect(payload.platform_settings).toBeUndefined();
  });

  it("each tool has type 'client'", () => {
    const payload = buildAgentPayload(MOCK_ROW);
    const tools = payload.conversation_config.agent.prompt.tools;
    for (const tool of tools) {
      expect(tool.type).toBe("client");
    }
  });

  it("each tool has expects_response true", () => {
    const payload = buildAgentPayload(MOCK_ROW);
    const tools = payload.conversation_config.agent.prompt.tools;
    for (const tool of tools) {
      expect(tool).toHaveProperty("expects_response", true);
    }
  });

  it("includes expected tool names", () => {
    const payload = buildAgentPayload(MOCK_ROW);
    const names = payload.conversation_config.agent.prompt.tools.map((t) => t.name);
    expect(names).toContain("score_lead");
    expect(names).toContain("send_whatsapp");
    expect(names).toContain("request_callback");
    expect(names).toContain("mark_opt_out");
    expect(names).toContain("end_call");
  });

  it("sets agent language to he", () => {
    const payload = buildAgentPayload(MOCK_ROW);
    expect(payload.conversation_config.agent.language).toBe("he");
  });

  it("sets tts voice_id and model_id from row", () => {
    const payload = buildAgentPayload(MOCK_ROW);
    expect(payload.conversation_config.tts.voice_id).toBe("voice123");
    expect(payload.conversation_config.tts.model_id).toBe("eleven_turbo_v2_5");
  });

  it("falls back tts model to eleven_turbo_v2_5 when tts_model is null", () => {
    const payload = buildAgentPayload({ ...MOCK_ROW, tts_model: null });
    expect(payload.conversation_config.tts.model_id).toBe("eleven_turbo_v2_5");
  });

  it("sets prompt text from script", () => {
    const payload = buildAgentPayload(MOCK_ROW);
    expect(payload.conversation_config.agent.prompt.prompt).toBe("שלום, אני סוכן AI");
  });

  it("sets first_message from row when present", () => {
    const payload = buildAgentPayload({
      ...MOCK_ROW,
      first_message: "היי, מה נשמע?",
    });
    expect(payload.conversation_config.agent.first_message).toBe("היי, מה נשמע?");
  });

  it("sets first_message to null when row has no first_message", () => {
    const payload = buildAgentPayload({ ...MOCK_ROW, first_message: undefined });
    expect(payload.conversation_config.agent.first_message).toBeNull();
  });

  it("sets turn.speculative_turn false at create time", () => {
    const payload = buildAgentPayload(MOCK_ROW);
    expect(payload.conversation_config.turn).toEqual({
      mode: "turn",
      speculative_turn: false,
    });
  });
});
