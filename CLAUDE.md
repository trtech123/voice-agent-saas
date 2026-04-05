# Voice Agent SaaS

Hebrew outbound AI voice agent SaaS for Israeli SMBs. Calls leads, qualifies them with Gemini AI, scores them, sends WhatsApp follow-ups.

## Architecture

```
Dashboard (Railway)  →  BullMQ (Railway Redis)  →  Voice Engine (DO droplet)  →  Asterisk  →  Voicenter SIP  →  Phone
                                                         ↕
                                                   Gemini 3.1 Flash Live (Google AI Studio)
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
│   ├── call-bridge.js      # Gemini Live audio bridge
│   ├── call-processor.js   # BullMQ job processor
│   ├── gemini-session.js   # Gemini WebSocket manager
│   ├── agent-prompt.js     # Hebrew prompt builder
│   ├── tools.js            # Gemini tool definitions
│   ├── compliance.js       # DNC, schedule, audit
│   ├── whatsapp-client.js  # Green API client
│   ├── audio-utils.js      # slin16 downsample (24k→16k)
│   ├── media-bridge.js     # Asterisk ExternalMedia handler
│   └── ari-client.js       # Asterisk ARI client
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
ASTERISK_MEDIA_FORMAT=slin16
GEMINI_LIVE_MODEL=models/gemini-3.1-flash-live-preview
GEMINI_VOICE_NAME=Kore
GEMINI_API_KEY=<key>
VOICENTER_PJSIP_ENDPOINT=voicenter_trunk
SUPABASE_URL=https://uwintyhbdslivrvttfzp.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<key>
REDIS_URL=redis://default:<pass>@junction.proxy.rlwy.net:47885
USE_VERTEX_AI=false  # Set to true when gemini-3.1 is available on Vertex AI EU
```

### Voicenter SIP
- Extension: F53WYCSk
- Server: 185.138.169.235 (sip09.voicenter.co resolved to IP)
- Transport: UDP 5060
- Asterisk endpoint: voicenter_trunk

### Phone number format
Israeli numbers are converted from international (972...) to local (0...) format before dialing via Voicenter.

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
