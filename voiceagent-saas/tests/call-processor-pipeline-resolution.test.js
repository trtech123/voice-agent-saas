// voiceagent-saas/tests/call-processor-pipeline-resolution.test.js
// Verifies the per-campaign voice pipeline flag resolution.
// Spec: §3.5 of 2026-04-08-unbundled-voice-pipeline-design.md
import { describe, it, expect } from "vitest";
import { resolveVoicePipeline } from "../call-processor.js";

describe("resolveVoicePipeline", () => {
  it("uses campaign.voice_pipeline when set", () => {
    expect(resolveVoicePipeline({ voice_pipeline: "unbundled" }, { default_voice_pipeline: "convai" })).toBe("unbundled");
    expect(resolveVoicePipeline({ voice_pipeline: "convai" }, { default_voice_pipeline: "unbundled" })).toBe("convai");
  });

  it("falls back to tenant.default_voice_pipeline when campaign value is null", () => {
    expect(resolveVoicePipeline({ voice_pipeline: null }, { default_voice_pipeline: "unbundled" })).toBe("unbundled");
    expect(resolveVoicePipeline({}, { default_voice_pipeline: "unbundled" })).toBe("unbundled");
  });

  it("defaults to convai when both are null", () => {
    expect(resolveVoicePipeline({}, {})).toBe("convai");
    expect(resolveVoicePipeline(null, null)).toBe("convai");
  });
});
