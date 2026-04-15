import { config } from "dotenv";
config();

const API_KEY = process.env.ELEVENLABS_API_KEY;
const AGENT_ID = "agent_1901kp9evmwzeb3ssvnjtsek61kq";

const patch = {
  conversation_config: {
    turn: {
      turn_timeout: 12,
      turn_eagerness: "patient",
      speculative_turn: false,
      mode: "turn",
      retranscribe_on_turn_timeout: false,
      silence_end_call_timeout: -1,
    },
  },
};

console.log("Reverting disable_first_message_interruptions...");

const res = await fetch(
  `https://api.elevenlabs.io/v1/convai/agents/${AGENT_ID}`,
  {
    method: "PATCH",
    headers: {
      "xi-api-key": API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  }
);

console.log("Status:", res.status);
process.exit(0);