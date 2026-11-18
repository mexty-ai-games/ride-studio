# Ride Studio

A phone web app that turns a motorbike ride into an episode of a daily video series for Mexty: "Je pars de chez moi, j'arrive chez X dans 25 minutes. À l'arrivée, cette entreprise aura sa formation. Top chrono."

While riding, Fabien talks hands-free with a voice co-host. Claude Code workers build real Mexty content in the meantime. The phone shows every change live and records everything; on arrival the video is on the phone.

```
phone/    PWA (Vite, React 19, Tailwind 4, zustand): Setup, Live, Arrival, Settings, STT bake-off;
          voice loop, canvas compositor (9:16 master + 16:9), MediaRecorder → IndexedDB
server/   Backend (Node, Express, ws): session hub, director (Claude Haiku 5.5), STT/TTS proxies,
          worker router, preview renderer (headless Chromium, CDP screencast → JPEG frames),
          change-event bus, budget guard, encrypted settings
agent/    ride-agent daemon for Fabien's machines: Claude Agent SDK sessions with the machine's
          own Claude Code login, MEXTY + EDVERSE MCP tools only
skill/    The atomic-write skill every worker runs with
shared/   Wire protocol (phone ↔ server ↔ device)
```

## How the pieces talk

- **Phone ↔ server**: one WebSocket. JSON control messages, plus binary frames for mic audio (PCM16 16 kHz), Claude's voice (PCM16 24 kHz) and preview tiles (JPEG).
- **Voice**: the mic stream goes to the server, which forwards it to the chosen STT vendor (ElevenLabs Scribe v3 Live with turn prediction, Deepgram Flux, or OpenAI) behind one interface in `server/src/stt`. End of turn → director → sentences → ElevenLabs streaming TTS → phone. API keys never leave the server, so the phone needs no vendor tokens. Barge-in is detected on the phone (instant) with a server-side backstop.
- **Director**: `server/src/director.ts`. Two sentences at most, French, tools `start_episode`, `end_episode`, `dispatch_task`, `get_status`, `set_layout`, `focus_tile`, `mark_beat`. Dispatches return at once. Milestones and budget alerts arrive as `[événements]` turns and are announced when nobody is speaking.
- **Workers**: `dispatch_task` → router (`server/src/hub.ts`): paired devices that are online first, then Claude Managed Agents if enabled, and a scripted demo runner when neither exists. One resumable session per worker, so follow-ups keep their context.
- **Change events**: the worker's own MCP tool calls (`server/src/events.ts`) and Mexty's `content:changed` webhook (`POST /api/mexty/events`, HMAC-signed) feed the same bus; duplicates are merged.
- **Previews**: one headless Chromium page per target opens Mexty's viewer with `?live=1`, logged in with a short service session minted by the Mexty backend. CDP screencast frames are capped at 10 fps per tile and step down in size under back-pressure. If Mexty is not reachable, the tile falls back to a built-in viewer driven by the tool calls.

## Run it locally

```bash
npm install
npm run build
npm start            # http://localhost:8787, access code "ride"
npm test -w server
```

For development: `npm run dev:server` and `npm run dev:phone` (Vite proxies `/api` and `/ws`).
Without API keys and devices the app runs in demo mode: scripted co-host, demo workers, built-in preview. The recording pipeline is the real one.

## Deploy (Railway)

The `Dockerfile` builds everything on Playwright's image (Chromium included). Mount a volume at `/data`.

| Variable | Purpose |
|---|---|
| `ACCESS_CODE` | Passcode for the phone app |
| `SESSION_SECRET` | Signs session cookies |
| `SETTINGS_KEY` | Encrypts the API keys saved from Settings |
| `RIDE_STUDIO_SECRET` | Shared with the Mexty backend (webhook signature, preview session) |
| `DATA_DIR` | `/data` |

Anthropic and ElevenLabs keys (and optionally Deepgram, OpenAI) are entered in Settings → Clés API.

## Pair a machine

In Settings → Appareils, tap "Associer un appareil" and run on the machine (Node 22+, Claude Code logged in, MEXTY and EDVERSE MCP servers added to Claude Code):

```bash
git clone https://github.com/mext-ai/ride-studio && cd ride-studio
npm install && npm run build -w agent
node agent/dist/agent/src/index.js pair <code> --server https://<ride-studio-host> --name aiden
node agent/dist/agent/src/index.js        # the daemon; keep it running
```

The daemon only makes an outbound WebSocket connection. Workers get no built-in tools (`tools: []`) and a permission callback that allows only the MCP servers listed in Settings.

## Connect Mexty

On the Mexty backend (API, MCP and collab services), set:

- `RIDE_STUDIO_SECRET`: same value as here
- `RIDE_STUDIO_WEBHOOK_URL`: `https://<ride-studio-host>/api/mexty/events`
- `RIDE_STUDIO_USER_ID`: Fabien's Mexty user id

See `docs/ride-studio-events.md` in the backend repo and `docs/live-mode.md` in the website repo.
