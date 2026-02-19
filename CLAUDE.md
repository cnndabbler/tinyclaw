# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TinyClaw is a multi-agent, multi-team, multi-channel 24/7 AI assistant framework. It coordinates isolated AI agents across Discord, Telegram, and WhatsApp using a file-based message queue. Agents can collaborate in teams via chain execution and parallel fan-out.

## Build Commands

```bash
npm run build              # Build all TypeScript (main + visualizer)
npm run build:main         # Build main source only (tsc)
npm run build:visualizer   # Build visualizer only (tsc -p tsconfig.visualizer.json)
```

No test suite exists. Testing is done manually via `./tinyclaw.sh start` and log inspection with `./tinyclaw.sh logs [queue|discord|telegram|all]`.

## Running Locally

```bash
npm install
npm run build
./tinyclaw.sh start        # Start daemon (tmux-based, auto-builds if needed)
./tinyclaw.sh status       # Check daemon status
./tinyclaw.sh logs all     # View all logs
./tinyclaw.sh stop         # Stop daemon
./tinyclaw.sh restart      # Restart daemon
```

## Architecture

### Message Flow

```
Channel Clients → File Queue (incoming/) → Queue Processor → Agent Invocation → File Queue (outgoing/) → Channel Clients
```

1. **Channel clients** (`src/channels/`) listen for messages and write JSON files to `~/.tinyclaw/queue/incoming/`
2. **Queue processor** (`src/queue-processor.ts`) polls incoming/, moves to processing/, resolves agent routing, invokes the AI provider
3. **Responses** are written to outgoing/ and picked up by channel clients for delivery
4. All queue operations use atomic file moves to prevent race conditions

### Agent Routing (`src/lib/routing.ts`)

- `@agent_id message` routes to a specific agent
- `@team_id message` routes to the team's leader agent
- Unrouted messages go to the "default" agent
- Agents can mention teammates via `[@teammate: message]` tags, which enqueues sub-messages

### Agent Isolation

Each agent has its own workspace at `~/tinyclaw-workspace/{agent_id}/` with independent `.claude/` config, conversation history, and heartbeat prompt. Skills in `.agents/skills/` are symlinked and shared across agents.

### Provider Support (`src/lib/invoke.ts`)

Three AI providers with model resolution:
- **Anthropic Claude** (default): `claude -c -p message` — models: sonnet, opus, etc.
- **OpenAI Codex**: `codex exec resume --last --model [model] message`
- **OpenCode**: `opencode run --format json --model [model] -c message`

### Team Collaboration

Teams have a leader agent who processes the user message. The leader can delegate to teammates via mention tags. Teammate messages are enqueued and processed in parallel. The conversation completes when all branches resolve.

## Key Source Files

### TypeScript (`src/`)
- `queue-processor.ts` — Main message routing, team coordination, agent invocation (~700 lines, central orchestrator)
- `channels/discord-client.ts`, `telegram-client.ts`, `whatsapp-client.ts` — Channel listeners/senders
- `lib/invoke.ts` — AI provider invocation and model resolution
- `lib/routing.ts` — Agent routing and teammate mention parsing
- `lib/config.ts` — Settings loader, path management, model ID mapping
- `lib/types.ts` — Core interfaces: Agent, Team, Message, Settings
- `visualizer/team-visualizer.tsx` — React/Ink TUI dashboard for team monitoring

### Bash (`lib/`)
- `daemon.sh` — Start/stop/restart, tmux session management, auto-build
- `common.sh` — Channel registry (ALL_CHANNELS, CHANNEL_* arrays), settings loader, utilities
- `agents.sh` — Agent CRUD commands
- `teams.sh` — Team CRUD commands
- `setup-wizard.sh` — Interactive onboarding

### CLI Entry
- `tinyclaw.sh` — Main CLI dispatcher, sources all lib/ scripts, handles command routing

## Configuration

Settings live at `$TINYCLAW_HOME/settings.json` (default `~/.tinyclaw/settings.json`). Contains workspace path, enabled channels, model/provider config, agent definitions, and team definitions. Invalid JSON is auto-repaired using `jsonrepair` with a backup created.

Environment variables: `TINYCLAW_HOME` (data dir), `DISCORD_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN` (from `.env`).

## Adding a New Channel

1. Create `src/channels/{channel}-client.ts` with message listening/sending
2. Add channel ID to `ALL_CHANNELS` in `lib/common.sh`
3. Fill in `CHANNEL_DISPLAY`, `CHANNEL_SCRIPT`, `CHANNEL_ALIAS`, `CHANNEL_TOKEN_KEY`, `CHANNEL_TOKEN_ENV` arrays in `lib/common.sh`
4. Build and test

## Conventions

- **TypeScript**: Strict mode, ES2020 target, CommonJS modules. Async/await throughout, no callbacks. Visualizer has a separate tsconfig (`tsconfig.visualizer.json`) for React/JSX support.
- **Bash**: Requires Bash 4.0+. snake_case functions, SCREAMING_CASE constants. ANSI color output via RED/GREEN/YELLOW/BLUE/NC variables.
- **Queue files**: JSON format, atomic file operations between queue directories (incoming → processing → done/failed).
