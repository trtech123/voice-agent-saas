import { describe, it, expect } from "vitest";
import { buildElevenLabsClientTools } from "../elevenlabs-tools-adapter.js";

describe("buildElevenLabsClientTools", () => {
  const tools = buildElevenLabsClientTools();
  const EXPECTED_TOOL_NAMES = [
    "score_lead",
    "send_whatsapp",
    "request_callback",
    "mark_opt_out",
    "end_call",
  ];

  it("returns all 5 tools", () => {
    expect(tools).toHaveLength(5);
    const names = tools.map((t) => t.name);
    for (const name of EXPECTED_TOOL_NAMES) {
      expect(names).toContain(name);
    }
  });

  it("uses type 'client' (not 'client_tool')", () => {
    for (const tool of tools) {
      expect(tool.type).toBe("client");
    }
  });

  it("sets expects_response to true on every tool", () => {
    for (const tool of tools) {
      expect(tool).toHaveProperty("expects_response", true);
    }
  });

  it("sets execution_mode to post_tool_speech", () => {
    for (const tool of tools) {
      expect(tool).toHaveProperty("execution_mode", "post_tool_speech");
    }
  });

  it("each tool has name, description, and parameters", () => {
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.parameters).toBe("object");
    }
  });

  it("does not contain any tool with type 'client_tool'", () => {
    for (const tool of tools) {
      expect(tool.type).not.toBe("client_tool");
    }
  });
});
