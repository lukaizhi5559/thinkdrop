# ThinkDrop AI

ThinkDrop is a macOS desktop AI assistant that lives in a floating overlay. You type (or speak) a natural language request and ThinkDrop classifies it, routes it to the right lane, and executes it — automating browser tasks, replaying trained recipes and saved plans, managing guardian rules, and more — all without switching context from what you're working on.

## Requirements

- **macOS** 12 Monterey or later
- **Node.js v18+** — required to build and run services. ThinkDrop will prompt you to install it on first launch if missing. Download: https://nodejs.org/en/download/
- **npm** — bundled with Node.js
- **Python 3.10+** — required for the coreference resolution service. Download: https://python.org/downloads/

## Architecture

### Request flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                        ThinkDrop Electron App                        │
│                                                                      │
│  ┌─────────────────────────┐       ┌──────────────────────────────┐  │
│  │   Prompt Capture Window │       │      Results Window          │  │
│  │   (floating overlay)    │       │   (progress + output)        │  │
│  │                         │       │                              │  │
│  │  - Text / voice input   │       │  - Automation progress       │  │
│  │  - Global hotkey        │       │  - Plan progress             │  │
│  │  - Clipboard highlight  │       │  - Streaming LLM output      │  │
│  └──────────┬──────────────┘       └──────────────▲───────────────┘  │
│             │ prompt                    progress │                  │
│             ▼                                     │                  │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                      comms-graph  (:3015)                      │  │
│  │  classify → guardian entry rules → lane dispatch               │  │
│  │                                                                │  │
│  │   fast lanes (in-graph)        │   planning lane │   handoff   │  │
│  │   quick answers, memory,       │   draft a plan  │   → main    │  │
│  │   status, control, screen,     │   file, run it  │   (:3010)   │  │
│  │   web search                   │   task-by-task  │             │  │
│  └────────────────────────────────┼─────────────────┼─────────────┘  │
│                                   │                 ▼                │
│                                   │        ┌──────────────────────┐  │
│                                   │        │ Main Process :3010   │  │
│                                   └───────▶│ handoffRunner        │  │
│                                            │ planRunner           │  │
│                                            │ StateGraph (38 nodes)│  │
│                                            └──────────┬───────────┘  │
└───────────────────────────────────────────────────────┼──────────────┘
                                                        │ MCP (HTTP/JSON)
                                                        ▼
                                              (see MCP Services below)
```

### comms-graph — the front door (:3015)

Every prompt is classified into one lane before anything executes:

| Intent | Lane | What happens |
|---|---|---|
| `handoff` (0) | → main :3010 | Full StateGraph run — tools, browser automation, named apps/sites, memory reads, multi-step tasks |
| `general_quick` (1) | in-graph | Direct LLM answer (chitchat, simple knowledge) |
| `status_check` (3) | in-graph | Status/progress of a running or recent task |
| `control_signal` (4) | in-graph | Cancel/stop a **running** task (control vocabulary required — artifact deletes route to handoff) |
| `memory_store` (5) | in-graph | Store a memory, note, appointment |
| `planning` (6) | in-graph | Draft a multi-task plan file → `planRunner` executes task-by-task |
| `screen` (7) | in-graph | Paint the on-screen display surface (cards, emoji, scenes) |
| `web_search` (8) | in-graph | Standalone public-web lookup |
| `guardian` | command lane | Trigger-rule management + passphrase bypass (see Guardian Rules) |

Classification is guarded: lexical matches that would override a lane get a semantic verdict (`decision.confirmJudgment`) before they fire — e.g. "resume" the document vs. resume-the-plan, control-signal vocabulary checks, missing-detail judgments that see conversation context.

### StateGraph pipeline

Handoffs run a directed graph of nodes (wired in `StateGraphBuilder.full()`):

```
start
  │
  ├── _planFile (resume) ────────────────→ planExecutor ──→ planSkills
  ├── _planTask + authored steps ────────→ resolveAgent ──→ (automation spine)
  └── resolveReferences → clarify → decomposePrompt → parseIntent
                                                            │
                                              declined_ack ─┴─→ checkPlanCache
                                                  │           (saved-plan match
                                                  ▼            → _skillPlan)
                                             fastLanePlan
                                                  │
                                             enrichIntent → routeIntent
                                                            │
        ┌──────────────────────────────┬────────────────────┼───────────────┐
        │                              │                    │               │
  command_automate              query lanes           memory lanes    side lanes
        │                       (retrieveMemory,      (storeMemory,   (executeSettings,
        ▼                        webSearch, answer)    store/lift      executeIntrospect,
  resolveUserContext                                   Constraint)     screenOutput,
        │                                                              parseProject,
        ▼                                                              appControl)
  resolveAgent → preflightAgents
        │              (agent auth/status preflight)
        ▼
  gatherPlanContext ──(_needsPlan)──→ exit w/ planning escalation
        │
        ▼
  planSkills ──(awaitingPlanApproval)──→ end  (resume later via _planFile)
        │
        ▼
  executeCommand ◄────── auto_patch retry
        │
        ├── replan / replan_step ──→ evaluateSkills ──→ prepareReplan ──→ planSkills
        ├── ask_user / pendingQuestion ──→ logConversation (paused for input)
        ├── failedStep ──→ flagStepFailure ──→ evaluateSkills
        ├── steps remain ──→ loop
        ▼ all steps done
  reviewExecution ──FAILED──→ flagHollowFailure ──→ evaluateSkills
        │             └─ASK_USER / CORRECTED──→ logConversation
        ▼ VERIFIED / UNVERIFIABLE
  evaluateSkills ──FIX──→ prepareReplan ──→ planSkills
        │ PASS
        ▼
  logConversation ──→ advanceQueue ──(queued intents remain)──→ enrichIntent
                          │ queue empty
                          ▼
                  summarizeMultiIntent ──→ END
```

**All StateGraph nodes** (38 wired in `full()`):

| Node | Role |
|---|---|
| `resolveReferences` | Resolve pronouns + co-references via coreference-service and context refs |
| `clarify` | Pre-routing resolution gate — ask the user when intent needs clarification |
| `decomposePrompt` | Split multi-intent prompts into an intent queue |
| `parseIntent` | Task classification |
| `checkPlanCache` | Semantic match against saved plans (`skill_plan_json`) → replay plan |
| `fastLanePlan` | Deterministic plan for simple public-web lookups |
| `enrichIntent` | Post-classification enrichment (domains, slots) |
| `routeIntent` | Post-enrichment routing — sets `_advanceRoute` to the correct lane |
| `retrieveMemory` | Fetch relevant memories from user-memory-service |
| `storeMemory` | Save a memory |
| `storeConstraint` / `liftConstraint` | Save / expire a constraint rule |
| `webSearch` | Web search via DuckDuckGo / Brave / SearXNG / NewsAPI |
| `resolveUserContext` | Load user profile/context before planning |
| `resolveAgent` | Pick agents (service descriptors) for the task |
| `preflightAgents` | Auth/status preflight on selected agents |
| `gatherPlanContext` | RAG + context gather; `_needsPlan` escalation to the planning lane |
| `planSkills` | LLM step planner with the skill-contract vocabulary injected |
| `executeCommand` | Step dispatch via command-service; inline thin recovery |
| `reviewExecution` | Outcome verdict — VERIFIED / FAILED / ASK_USER / CORRECTED |
| `evaluateSkills` | Post-run judge — PASS/FIX, derives context rules for replans |
| `prepareReplan` | Replan prep (single-step vs full) |
| `flagStepFailure` | Build recovery context for step failures |
| `flagHollowFailure` | Flag hollow/empty results for replan |
| `surfacePlanFailure` | Surface provider-outage planning failures |
| `planExecutor` | Resume a stored plan file (`_planFile`) |
| `parseProject` | Match project-run prompts → plan or app-control |
| `appControl` | App-control mode terminal |
| `advanceQueue` | Multi-intent queue runner |
| `summarizeMultiIntent` | Compose the multi-intent summary |
| `preparePostScreen` | Post screen-grab routing prep |
| `screenIntelligence` | Screenshot + OCR capture |
| `screenOutput` | GhostLayer display lane |
| `executeIntrospect` | System introspection lane |
| `executeSettings` | Settings-change lane |
| `answer` | Direct LLM answer lane |
| `synthesize` | Final response compose |
| `logConversation` | Persist the turn to conversation-service + journal |

**Agent factory layer** (runs inside command-service, not StateGraph nodes):

`cli.agent` and `browser.agent` build service descriptors on demand — resolve metadata (LLM) → verify tool/site → infer capabilities → write `.md` descriptor → upsert the DuckDB agents table. `validate_agent` re-probes descriptors and auto-patches failures. `planSkills`/`resolveAgent` inject healthy agent descriptors into planning prompts; `describeAgent` exposes `startUrl`/`signInUrl` so planning lanes resolve the service host for app-knowledge lookup.

**Background jobs** (run in main process):

| Job | Schedule | What it does |
|---|---|---|
| Skill daemon re-registration | App startup (+8s) | Re-loads any `~/Library/LaunchAgents/com.thinkdrop.skill.*.plist` not active in launchd |
| Nightly agent validation | 3am daily | Runs `validate_agent` for every registered agent, auto-patches descriptors |
| Nightly skill health check | 3am daily | Probe-runs installed skills, writes `status`/`last_run`/`error_log` to user-memory |

## Reusable procedures

Three mechanisms replace one-off prompts — no code generation, no install pipeline:

**Authored plans** — a completed task plan IS a procedure. When `planRunner` marks a plan `done`, it flattens every task's compiled steps into `skill_plan_json` + `slots_json` frontmatter on the plan file (`~/.thinkdrop/plans/`). `checkPlanCache` semantically matches new prompts against those frontmatter blocks and rebinds the slots — deterministic replay with no re-planning. Mutating steps must carry literal args (`shell.run {cmd, argv}`); goal-mode steps are flagged as non-replayable by the contract gate and keep a plan out of the cache bridge.

**Recipes** — `trainer.agent` records your waypoints as you drive a site's browser session, then an LLM pass cleans the raw events into `~/.thinkdrop/skills/<agent>/<name>.skill.json`. `recipe.run` replays recipes step-by-step through `browser.act` (dispatched under the `external.skill` name for compatibility). Recipes are data, not code — no `index.cjs`, no process spawn.

**Skill contracts** — `shared/skill-contracts.cjs` is the executable form of the skill vocabulary: per-skill arg types, required args, and `mutates`/`sessionBound` flags. The stepgen injects the vocabulary block into planning prompts so steps are authored correctly, and the save/bridge gates validate emitted steps against the same contract — malformed plans are rejected at author time, not mid-run.

## Guardian rules

`when → then` trigger rules evaluated against a single shared matcher (`command-service/src/skill-helpers/rules.cjs`) at three seams:

| Seam | Where | What it watches |
|---|---|---|
| **entry** | comms-graph, after classify, before lane dispatch | `promptMatch`, bound-page hosts — covers web-search, quick, planning AND handoff lanes uniformly |
| **observation** | monitorService app/tab/URL switches | `hostMatch`, `urlMatch`, `appName`, `fileMatch`, `titleMatch` — fires on the user's own navigation too |
| **OCR** | monitorService screen captures | `ocrMatch` over on-screen text (only evaluated when an enabled OCR rule exists) |

`then` actions: `block` (prevent + blocking screen card), `ask` (require passphrase to proceed), `notify`/`show_card` (screen display, incl. emoji cards), `enqueue_task` (dispatch a task through comms-graph's proactive lane — `{{host}}`/`{{url}}`/`{{appName}}` slots interpolate what matched).

Manage rules by talking: `guardian passphrase <new> [current]` · `guardian list <pass>` · `guardian add <pass> <json>` · `guardian enable|disable|delete <id> <pass>` · `guardian allow <pass>` (one-shot bypass for a blocked prompt). Natural-language rules ("if I go to tiktok.com, email me") are drafted by one bounded LLM call, echoed back in English, and committed on `rule confirm` — matching and firing themselves contain no model.

## MCP Services

Each service is an independent process with its own dependencies:

| Service | Port | Runtime | Purpose |
|---|---|---|---|
| `comms-graph` | 3015 | Node.js | Entry — intent classify, lane routing, guardian entry seam, handoff dispatch, planning lane |
| `main` (Electron) | 3010 | Node.js | Overlay control server — handoff endpoint, StateGraph driver, plans, crons, IPC |
| `command-service` | 3007 | Node.js | Actuation — `browser.act`, `shell.run`, `dom.act`, `recipe.run`, `*.agent` factory skills |
| `user-memory-service` | 3001 | Node.js | DuckDB — profile, agents, plans, app history, monitorService (observation/OCR seams) |
| `conversation-service` | 3004 | Node.js | Session history, message store, semantic session re-activation |
| `voice-service` | 3006 | Node.js | STT (Groq Whisper), TTS (Inworld/ElevenLabs/macOS), OpenAI Realtime S2S, VAD, wake word |
| `phi4-service` | 3003 | Node.js | Intent classification, DistilBERT embeddings |
| `web-search` | 3002 | Node.js | Web search — DuckDuckGo, Brave, NewsAPI, SearXNG |
| `coreference-service` | 3005 | Python | Pronoun + reference resolution (NLP) |
| `screen-intelligence-service` | 3008 | Node.js | Screenshot OCR, active window detection |
| `personality-service` | 3012 | Node.js | Emotion engine, heartbeat, thought synthesis |

## Getting Started

### Prerequisites

```bash
# Install Node.js v18+ from https://nodejs.org
node --version   # should be v18.0.0 or later
npm --version
```

### Install & Run (Development)

```bash
# 1. Clone and install root dependencies
git clone <repo>
cd thinkdrop
yarn install

# 2. Install service dependencies (each service has its own package.json)
cd comms-graph && npm install && cd ..
cd mcp-services/command-service && npm install && cd ../..
cd mcp-services/thinkdrop-user-memory-service && npm install && cd ../..
cd mcp-services/conversation-service && npm install && cd ../..
cd mcp-services/voice-service && npm install && cd ../..
cd mcp-services/thinkdrop-phi4-service && npm install && cd ../..
cd mcp-services/thinkdrop-web-search && npm install && cd ../..
cd mcp-services/screen-intelligence-service && npm install && cd ../..
cd mcp-services/personality-service && npm install && cd ../..

# 3. Install coreference service (Python)
cd mcp-services/coreference-service
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt && cd ../..

# 4. Install stategraph module
cd stategraph-module && npm install && cd ..

# 5. Boot all backend services with the launcher script
./scripts/start-services.sh   # logs land in ./logs/, PIDs in a pids file

# 6. In another terminal — start the Electron app
yarn dev
```

`scripts/start-services.sh` boots all ten backend services in dependency order (user-memory → web-search → conversation → coreference → phi4 → command → screen-intelligence → voice → personality → comms-graph). `./scripts/stop-services.sh` tears them down.

### Global Hotkey

`Cmd+Shift+Space` — show/hide the prompt capture window from anywhere on macOS.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Shift+Space` | Show / hide prompt window |
| `Enter` | Submit prompt |
| `Shift+Enter` | New line |
| `Esc` | Close windows |
| `Cmd+C` (text selected) | Add highlighted text as context tag |

## Project Structure

```
thinkdrop/
├── comms-graph/                     # Entry service (:3015)
│   └── src/
│       ├── server.cjs               # HTTP API, lane dispatch, guardian commands
│       ├── classify.cjs             # Intent classifier + semantic gates
│       ├── decision.cjs             # Bounded YES/NO + multi-option judgments
│       ├── artifactReferent.cjs     # "delete that event" → created-artifact binding
│       ├── planning.cjs             # Plan drafting lane (stepgen w/ contracts + app knowledge)
│       ├── handoff.cjs              # Handoff dispatch to main's StateGraph
│       └── nodes/                   # Lane executors (generalQuick, webSearchExpress,
│                                    #   memoryStore, statusCheck, controlSignal,
│                                    #   screen, planning)
├── shared/                          # Modules shared across repos
│   ├── service-map.cjs              # Service/agent registry (describeAgent)
│   ├── skill-contracts.cjs          # Executable skill arg contracts
│   ├── plan-format.cjs              # Plan file frontmatter utils
│   ├── text-patterns.cjs            # Canonical regex vocabulary
│   ├── turn-facts.cjs               # Single derivation of "what is this turn"
│   └── decision-state.cjs           # Shaped decision-model state
├── stategraph-module/
│   └── src/
│       ├── StateGraphBuilder.js     # Graph wiring (full/standard/basic/minimal)
│       ├── nodes/                   # The 38 pipeline nodes (see table above)
│       ├── utils/                   # planCacheHelpers, classifyTask, localPlanTemplates…
│       └── prompts/                 # System prompt markdown files
├── src/
│   ├── main/
│   │   ├── main.js                  # Electron main + overlay control server (:3010)
│   │   ├── handoffRunner.js         # StateGraph run driver + progress events
│   │   ├── planRunner.js            # Task-plan runner + plan→skill cache bridge
│   │   ├── queueManager.js          # Task queue + cron registry
│   │   ├── scheduler.js             # launchd-based persistent task scheduler
│   │   └── preload.js               # Context bridge — IPC channel whitelist
│   └── renderer/
│       ├── components/
│       │   ├── AutomationProgress.tsx   # Live step-by-step automation UI
│       │   ├── SkillBuildProgress.tsx   # Progress UI
│       │   └── ResultsWindow.tsx        # Results + progress host
│       └── utils/
├── scripts/
│   ├── start-services.sh            # Boot all backend services
│   └── stop-services.sh             # Tear them down
└── mcp-services/
    ├── command-service/             # Actuation skills + agent factory (port 3007)
    ├── thinkdrop-user-memory-service/   # DuckDB + monitorService (port 3001)
    ├── conversation-service/        # Session + message history (port 3004)
    ├── voice-service/               # STT/TTS/realtime pipeline (port 3006)
    ├── thinkdrop-phi4-service/      # Intent classification, DistilBERT (port 3003)
    ├── thinkdrop-web-search/        # Web search (port 3002)
    ├── coreference-service/         # Pronoun/ref resolution — Python (port 3005)
    ├── screen-intelligence-service/ # Screenshot OCR, window detection (port 3008)
    └── personality-service/         # Emotion engine, thoughts (port 3012)
```

## Troubleshooting

### Node.js not detected at startup
ThinkDrop shows a dialog on launch if `node` is not in PATH. Install Node.js v18+ from https://nodejs.org and restart the app.

### A saved plan doesn't replay for a similar prompt
The plan→skill bridge only fires when a plan completes `done` AND its steps pass `skill-contracts` validation — plans whose mutating steps use goal-mode args (`shell.run {goal}` or `cli.agent` task strings) are flagged non-replayable and stay invisible to `checkPlanCache`. Re-run the task with literal args to make it cacheable.

### `Cannot find module 'keytar'`
Run `npm install` in the service that failed to start — `keytar` is a native Keychain bridge used by the main process and command-service for secret storage.

### Screen recording / accessibility permissions
ThinkDrop needs screen recording permission for screenshot capture and accessibility permission for UI automation (nut.js). Grant both in **System Settings → Privacy & Security**.

### MCP service not responding
Each service must be running independently — `./scripts/start-services.sh` boots them all and logs to `./logs/`. Check the expected ports: 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3010, 3012, 3015.

## Technical Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron |
| UI | React 18 + TypeScript + Vite |
| Styling | TailwindCSS |
| Routing | comms-graph intent lanes |
| AI pipeline | Custom StateGraph (directed node graph) |
| LLM bridge | VS Code WebSocket LLM backend (port 4000) |
| Browser automation | Playwright |
| UI automation | nut.js |
| Secret storage | keytar (macOS Keychain) |
| Task scheduling | node-cron + launchd |
| Persistence | DuckDB (user-memory-service) |
| Voice STT | Groq Whisper (whisper-large-v3-turbo) |
| Voice TTS | Inworld AI / ElevenLabs / OpenAI Realtime / macOS native |

## License

MIT
