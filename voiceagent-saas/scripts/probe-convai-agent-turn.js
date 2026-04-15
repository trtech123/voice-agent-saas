#!/usr/bin/env node
// voiceagent-saas/scripts/probe-convai-agent-turn.js
//
// Read Convai turn-taking + related fields from ElevenLabs (no Supabase).
//
// Usage:
//   ELEVENLABS_API_KEY=... node scripts/probe-convai-agent-turn.js <agent_id>
//
// API: GET https://api.elevenlabs.io/v1/convai/agents/{agent_id}

const agentId = process.argv[2];
const EL_KEY = process.env.ELEVENLABS_API_KEY;

if (!agentId) {
  console.error("usage: node scripts/probe-convai-agent-turn.js <elevenlabs_agent_id>");
  process.exit(1);
}
if (!EL_KEY) {
  console.error("ELEVENLABS_API_KEY env var required");
  process.exit(1);
}

const res = await fetch(
  `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(agentId)}`,
  { headers: { "xi-api-key": EL_KEY } },
);

if (!res.ok) {
  console.error("EL GET agent failed:", res.status, await res.text());
  process.exit(1);
}

const j = await res.json();
const cc = j.conversation_config || {};
const turn = cc.turn || {};
const agent = cc.agent || {};

const summary = {
  agent_id: j.agent_id,
  name: j.name,
  turn: {
    turn_timeout: turn.turn_timeout,
    turn_eagerness: turn.turn_eagerness,
    mode: turn.mode,
    initial_wait_time: turn.initial_wait_time,
    silence_end_call_timeout: turn.silence_end_call_timeout,
    soft_timeout_config: turn.soft_timeout_config ?? null,
    speculative_turn: turn.speculative_turn,
    retranscribe_on_turn_timeout: turn.retranscribe_on_turn_timeout,
  },
  agent_surface: {
    disable_first_message_interruptions: agent.disable_first_message_interruptions,
    first_message_preview: (agent.first_message || "").slice(0, 200),
  },
};

console.log(JSON.stringify(summary, null, 2));
