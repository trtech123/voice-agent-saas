import { config } from "dotenv";
config();

const API_KEY = process.env.ELEVENLABS_API_KEY;
/** CLI: node scripts/delete-el-agent.js [agent_id] */
const AGENT_ID =
  process.argv[2] ||
  process.env.AGENT_ID ||
  "agent_1901kp9evmwzeb3ssvnjtsek61kq";

console.log("Deleting agent:", AGENT_ID);

const res = await fetch(
  `https://api.elevenlabs.io/v1/convai/agents/${AGENT_ID}`,
  {
    method: "DELETE",
    headers: { "xi-api-key": API_KEY },
  }
);

console.log("Status:", res.status);
console.log("Response:", res.ok ? "Deleted" : await res.text());

process.exit(0);