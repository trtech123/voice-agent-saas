# Voice Agent SaaS

Hebrew outbound AI voice agent SaaS for Israeli SMBs. Calls leads, qualifies them with AI (ElevenLabs Convai or unbundled Deepgram+OpenAI pipeline), scores them, sends WhatsApp follow-ups.

## Architecture

```
Dashboard (Railway)  →  BullMQ (Railway Redis)  →  Voice Engine (DO droplet)  →  Asterisk  →  Voicenter SIP  →  Phone
                                                         ↕
                                              ElevenLabs Convai or Unbundled (Deepgram+OpenAI+EL TTS)
```

## Deployment

### Dashboard (Railway — auto-deploy from GitHub)

Railway project is connected to `trtech123/voice-agent-saas` on GitHub.
Push to `main` triggers auto-deploy.

- **Service:** dashboard
- **Build:** `npm install && npm run build --workspace=@vam/dashboard`
- **Start:** `npm run start --workspace=@vam/dashboard`
- **Config:** `RAILPACK_CONFIG_FILE=config/dashboard.json`
- **URL:** https://dashboard-production-5c3b.up.railway.app

#### Dashboard env vars (Railway):
```
NEXT_PUBLIC_SUPABASE_URL=https://uwintyhbdslivrvttfzp.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
REDIS_URL=${{Redis.REDIS_URL}}
```

### Voice Engine (DigitalOcean droplet — manual deploy)

The merged voice engine + Asterisk gateway runs on the droplet at 188.166.166.234.

To deploy changes:
```bash
# Copy files to droplet
scp -r voiceagent-saas/* root@188.166.166.234:/opt/voiceagent-saas/

# Install deps if package.json changed
ssh root@188.166.166.234 "cd /opt/voiceagent-saas && npm install"

# Restart the service
ssh root@188.166.166.234 "systemctl restart voiceagent-saas"

# Check status
ssh root@188.166.166.234 "systemctl status voiceagent-saas"

# View logs
ssh root@188.166.166.234 "journalctl -u voiceagent-saas -f"
```

The voice engine code is in `voiceagent-saas/` (plain JS, no build step).

### Database (Supabase)

- **Project:** uwintyhbdslivrvttfzp (eu-central-1)
- **Migrations:** `supabase/migrations/`
- **RLS:** Currently disabled for development. Re-enable before production.
- **Auth trigger:** Auto-creates tenant + user on signup

To run a new migration:
```bash
# Via Supabase MCP (preferred)
mcp__supabase__apply_migration(project_id, name, query)

# Or via Supabase CLI
npx supabase db push --project-ref uwintyhbdslivrvttfzp
```

## Project Structure

```
voice-agent-marketing/
├── apps/
│   ├── dashboard/          # Next.js 14 + Tailwind (deployed on Railway)
│   └── voice-engine/       # TypeScript source (canonical types, tests)
├── packages/
│   └── database/           # Supabase types, DAL, encryption
├── voiceagent-saas/        # Plain JS merged process (deployed on droplet)
│   ├── server.js           # Fastify + ARI + BullMQ bootstrap
│   ├── call-bridge.js      # ElevenLabs / Unbundled audio bridge
│   ├── call-processor.js   # BullMQ job processor
│   ├── elevenlabs-session.js       # ElevenLabs Convai WebSocket manager
│   ├── elevenlabs-tools-adapter.js # EL tool definitions adapter
│   ├── agent-sync-processor.js     # ElevenLabs agent config sync worker
│   ├── live-turn-writer.js         # Postgres-backed call_turns writer
│   ├── janitor.js                  # Stuck call cleanup / dead letter handler
│   ├── unbundled-pipeline.js       # Deepgram + OpenAI + EL TTS orchestrator
│   ├── deepgram-session.js         # Deepgram STT WebSocket client
│   ├── llm-session.js              # OpenAI GPT-4o-mini streaming client
│   ├── tts-session.js              # ElevenLabs TTS WebSocket client
│   ├── vad.js                      # Voice Activity Detection (silence detector)
│   ├── vad-config.js               # VAD configuration constants
│   ├── agent-prompt.js     # Hebrew prompt builder
│   ├── tools.js             # Tool definitions (EL + OpenAI schemas)
│   ├── compliance.js        # DNC, schedule, audit
│   ├── whatsapp-client.js   # WhatsApp client
│   ├── media-bridge.js      # Asterisk ExternalMedia handler
│   ├── ari-client.js        # Asterisk ARI client
│   └── scripts/             # CLI tools (migrate-campaign, probe-*)
├── asterisk-gateway/       # Old separate gateway (replaced by voiceagent-saas/)
├── supabase/
│   └── migrations/         # SQL migrations
├── config/
│   ├── dashboard.json      # Railpack config for dashboard
│   └── voice-engine.json   # Railpack config (unused now)
└── docs/
    └── superpowers/
        ├── specs/           # Design specs
        └── plans/           # Implementation plans
```

## Key Configuration

### Droplet env vars (/opt/voiceagent-saas/.env):
```
PORT=8091
PUBLIC_BASE_URL=http://188.166.166.234:8091
SIP_GATEWAY_API_KEY=<key>
SIP_GATEWAY_EVENTS_SECRET=<key>

# Asterisk ARI
ASTERISK_ARI_BASE_URL=http://127.0.0.1:8088/ari
ASTERISK_ARI_USERNAME=<user>
ASTERISK_ARI_PASSWORD=<password>
ASTERISK_ARI_APP=voiceagent-saas-media

# Voicenter SIP
VOICENTER_PJSIP_ENDPOINT=voicenter_trunk
VOICENTER_SIP_SERVER=185.138.169.235
VOICENTER_SIP_USERNAME=<user>
VOICENTER_SIP_PASSWORD=<password>
VOICENTER_CALLER_ID=<caller_id>
VOICENTER_TRANSPORT=udp

# Audio format — slin16 eliminates ulaw transcoding
ASTERISK_MEDIA_FORMAT=slin16
ASTERISK_MEDIA_CONNECTION_NAME=voiceagent_saas_media

# Gemini (legacy fallback)
GEMINI_API_KEY=<key>
GEMINI_LIVE_MODEL=models/gemini-3.1-flash-live-preview
GEMINI_VOICE_NAME=Kore
GEMINI_WATCHDOG_IDLE_NUDGE_SEC=45

# Supabase
SUPABASE_URL=https://uwintyhbdslivrvttfzp.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<key>
SUPABASE_DIRECT_DB_URL=postgres://postgres.ref:<password>@aws-1-eu-central-1.pooler.supabase.com:6543/postgres

# Encryption
CREDENTIAL_KEK=<base64-encoded-key>

# Redis (Railway public URL for BullMQ)
REDIS_URL=redis://default:<pass>@junction.proxy.rlwy.net:47885

# ElevenLabs
ELEVENLABS_API_KEY=<key>

# Vertex AI EU (low latency)
USE_VERTEX_AI=false
GCP_PROJECT_ID=<project>
GCP_LOCATION=europe-west1
GOOGLE_APPLICATION_CREDENTIALS=/opt/voiceagent-saas/gcp-service-account.json

# VAD tuning
VAD_RMS_THRESHOLD=800
VAD_SILENCE_DEBOUNCE_MS=700
VAD_SANITY_GAP_MS=2000
VAD_CONSECUTIVE_SILENT_FRAMES=3
VAD_AGENT_AUDIO_TAIL_MS=200
```

#### Unbundled voice pipeline env vars (plan 1, 2026-04-08):
```
DEEPGRAM_API_KEY=<from deepgram.com console>
OPENAI_API_KEY=<from platform.openai.com>

# Behavior tunables (defaults match spec, safe to leave as-is)
DEEPGRAM_BARGE_GATE_MS=150          # min ms after last TTS chunk before a Deepgram partial counts as barge
LLM_MAX_ROUNDS_PER_CALL=50          # cap on total LLM rounds across a whole call
LLM_HISTORY_WINDOW_TURNS=20         # sliding history window size
BARGE_LOOP_THRESHOLD=5              # barge count that triggers loop detection
BARGE_LOOP_WINDOW_MS=30000          # window for the threshold above
```

### Voicenter SIP
- Extension: F53WYCSk
- Server: 185.138.169.235 (sip09.voicenter.co resolved to IP)
- Transport: UDP 5060
- Asterisk endpoint: voicenter_trunk

### Phone number format
Israeli numbers are converted from international (972...) to local (0...) format before dialing via Voicenter.

## Voice pipeline feature flag (plan 1, 2026-04-08)

Each campaign can independently use one of two voice pipelines:

- **`convai`** (default) — the existing ElevenLabs Convai bundled stack. Single WebSocket, EL handles STT + turn detection + LLM + TTS.
- **`unbundled`** — Deepgram STT + OpenAI gpt-4o-mini LLM + ElevenLabs `eleven_turbo_v2_5` TTS, with our own VAD driving turn commits. Built across plans 2-5 of `2026-04-08-unbundled-pipeline-*.md`.

Resolution at dequeue: `campaign.voice_pipeline ?? tenant.default_voice_pipeline ?? 'convai'`. Snapshotted into the call's in-memory cfg so mid-queue flag flips do not affect in-flight calls. Per-campaign rollback is a single SQL update — instant, no code deploy.

To migrate a campaign to unbundled:
```bash
node voiceagent-saas/scripts/migrate-campaign-to-unbundled.js <campaign_id>          # dry run
node voiceagent-saas/scripts/migrate-campaign-to-unbundled.js <campaign_id> --apply  # commit
```

To roll back:
```sql
UPDATE campaigns SET voice_pipeline = 'convai' WHERE id = '<campaign_id>';
```

## Testing a call

From the dashboard: Campaign → "התקשר עכשיו" button → enter phone number → call

Or via CLI:
```bash
node -e "
const{Queue}=require('bullmq');
const q=new Queue('call-jobs',{connection:{url:'redis://default:<pass>@junction.proxy.rlwy.net:47885'}});
q.add('call',{
  tenantId:'<tenant_id>',
  campaignId:'<campaign_id>',
  contactId:'<contact_id>',
  campaignContactId:'<campaign_contact_id>'
}).then(j=>{console.log('Job:',j.id);process.exit(0)});
"
```

## FlyingCarpet coexistence

FlyingCarpet runs on the same droplet independently:
- Port 8090 (this SaaS uses 8091)
- ARI app: flyingcarpet-media (this uses voiceagent-saas-media)
- SIP endpoint: meta_whatsapp_calling (this uses voicenter_trunk)
Do not modify FlyingCarpet files or config.
