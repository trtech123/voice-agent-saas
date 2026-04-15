// voiceagent-saas/tests/tools-openai-schema.test.js
// Verifies the OpenAI function-calling schema export matches the internal
// tool catalog and includes all 5 production tools with correct shape.
// Spec: docs/superpowers/specs/2026-04-08-unbundled-voice-pipeline-design.md §3.3, §4.3
import { describe, it, expect } from "vitest";
import { buildOpenAIToolSchema, buildToolDefinitions } from "../tools.js";

describe("buildOpenAIToolSchema", () => {
  it("returns an array of OpenAI function-calling tool objects", () => {
    const schema = buildOpenAIToolSchema();
    expect(Array.isArray(schema)).toBe(true);
    expect(schema.length).toBeGreaterThan(0);
    for (const tool of schema) {
      expect(tool).toHaveProperty("type", "function");
      expect(tool).toHaveProperty("function");
      expect(tool.function).toHaveProperty("name");
      expect(tool.function).toHaveProperty("description");
      expect(tool.function).toHaveProperty("parameters");
      expect(tool.function.parameters).toHaveProperty("type", "object");
      expect(tool.function.parameters).toHaveProperty("properties");
    }
  });

  it("includes all 5 production tools by name", () => {
    const schema = buildOpenAIToolSchema();
    const names = schema.map((t) => t.function.name).sort();
    expect(names).toEqual([
      "end_call",
      "mark_opt_out",
      "request_callback",
      "score_lead",
      "send_whatsapp",
    ]);
  });

  it("emits the same set of tool names as the legacy buildToolDefinitions()", () => {
    const openai = buildOpenAIToolSchema().map((t) => t.function.name).sort();
    const legacy = buildToolDefinitions().map((t) => t.name).sort();
    expect(openai).toEqual(legacy);
  });

  it("score_lead has score and reason parameters", () => {
    const schema = buildOpenAIToolSchema();
    const tool = schema.find((t) => t.function.name === "score_lead");
    expect(tool).toBeTruthy();
    const props = tool.function.parameters.properties;
    expect(props).toHaveProperty("score");
    expect(props.score.type).toBe("integer");
    expect(props).toHaveProperty("reason");
    expect(props.reason.type).toBe("string");
  });

  it("send_whatsapp has a message parameter required", () => {
    const schema = buildOpenAIToolSchema();
    const tool = schema.find((t) => t.function.name === "send_whatsapp");
    expect(tool.function.parameters.properties).toHaveProperty("message");
    expect(tool.function.parameters.required).toContain("message");
  });

  it("end_call has no required parameters", () => {
    const schema = buildOpenAIToolSchema();
    const tool = schema.find((t) => t.function.name === "end_call");
    expect(tool.function.parameters.required ?? []).toEqual([]);
  });

  it("request_callback requires preferred_time and callback_timestamp", () => {
    const schema = buildOpenAIToolSchema();
    const tool = schema.find((t) => t.function.name === "request_callback");
    expect(tool.function.parameters.properties).toHaveProperty("preferred_time");
    expect(tool.function.parameters.properties).toHaveProperty("callback_timestamp");
    expect(tool.function.parameters.required).toContain("preferred_time");
    expect(tool.function.parameters.required).toContain("callback_timestamp");
  });
});
