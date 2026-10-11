# 4EVR HQ

A multi-agent marketing operations platform. A team of 14 specialist AI agents plans, executes, reviews and reports on marketing work, coordinated by a CMO agent, with a live operations view of who is doing what, what they are saying to each other, and what it costs.

Agent expertise comes from the open-source [marketingskills](https://github.com/coreyhaines31/marketingskills) library (50 skills, MIT), vendored in `vendor/marketingskills`. Each agent loads the full playbooks for the skills it owns into its system prompt.

Created by [@tomxander](https://github.com/tomxander), built with Claude Code.

## Contents

- [Quick start](#quick-start)
- [Capabilities](#capabilities)
- [How work flows](#how-work-flows)
- [Execution modes](#execution-modes)
- [Configuration](#configuration)
- [Agent roster](#agent-roster)
- [Architecture](#architecture)
- [Extending](#extending)
- [Security](#security)
- [Testing](#testing)
- [Licence and credits](#licence-and-credits)

## Quick start

Requirements: Node.js 20 or newer.

```
npm install
npm start
```

Open http://127.0.0.1:4747.

With no API key the platform runs in **simulated mode**, which exercises the full workflow without calling any model. To run real agents, supply an Anthropic API key:

```
ANTHROPIC_API_KEY=sk-ant-... npm start
```

The key can also be entered in the Settings panel. It is held in server memory only and never written to disk.

## Capabilities

| Area | Description |
|---|---|
| Task intake | Submit a task with an optional brief from the command console. Leave the assignee on "Vera plans it" for CMO-led planning, or assign directly to one specialist. Twelve templates are included. |
| Planning | The CMO decomposes a task into 3 to 7 workstreams with owners, skills, dependencies and optional peer consults. Output is validated and repaired, with a deterministic fallback planner. |
| Execution | Specialists run in dependency order and in parallel where possible. Upstream deliverables are passed downstream as context. |
| Review | Each deliverable receives a structured peer review. The CMO synthesises an executive summary. |
| Observability | Tasks, inter-agent communications, per-agent status and workload, deliverables, token and cost metering against a budget cap, department output, skill utilisation, and an event log. |
| Operations view | A live floor plan of the office shows agents moving between workstations as they work, consult and review. Select any agent to inspect their skills, memory and statistics, or message them directly. |
| Output | Every deliverable is rendered in the interface and saved as Markdown in `deliverables/`. |

## How work flows

1. **Intake.** A task is submitted and queued. Up to `MAX_ACTIVE_TASKS` run concurrently.
2. **Plan.** The CMO agent produces a JSON plan assigning each workstream to an agent and one of that agent's skills.
3. **Execute.** Each agent's system prompt contains the company charter, its persona and recent memory, and the full text of the selected skill. The task brief and upstream deliverables are supplied as the user message. Workstreams may begin with a consult in which the agent asks a colleague a targeted question.
4. **Review.** A peer reviews each deliverable and records a strength, an improvement and a verdict.
5. **Synthesise.** The CMO produces an executive summary covering the recommendation, contributions, risks, open decisions and a seven-day plan.
6. **Persist.** State, deliverables and metrics are saved to `data/` and `deliverables/`.

Agents work asynchronously and do not ask clarifying questions. They state assumptions explicitly and proceed. Treat deliverables as drafts for human review.

## Execution modes

| | Simulated (default) | Live |
|---|---|---|
| Requirement | None | `ANTHROPIC_API_KEY` |
| Behaviour | A built-in simulator selects specialists by keyword playbook and produces deliverables structured from the real skill outlines. Output is clearly marked SIMULATED. | Real model calls with the full skill text, prompt caching on the skill block, and retries with backoff on 429 and 5xx responses. |
| Cost | None. Token and cost figures are estimates of what live calls would use. | Metered. A configurable budget cap (default $5) reverts the platform to simulated mode when reached. |

Live mode has been verified against a local fake of the Messages API (request format, skill injection, caching marker, plan repair, retries, budget cap) but not against the production API in this repository's test suite. If a live call fails, the last API error is shown in Settings.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Enables live mode. |
| `MODEL` | `claude-sonnet-5-5` | Model used for all agent calls. |
| `PRICE_IN`, `PRICE_OUT` | `3`, `15` | USD per million input and output tokens, used for cost estimates. Defaults are placeholders: set them to your actual rates. |
| `BUDGET_CAP_USD` | `5` | Estimated spend at which live mode reverts to simulation. |
| `MAX_ACTIVE_TASKS` | `3` | Concurrent tasks. |
| `PORT`, `HOST` | `4747`, `127.0.0.1` | Server binding. See [Security](#security). |
| `DATA_DIR`, `DELIVERABLES_DIR` | `./data`, `./deliverables` | Persistence locations. |
| `SKILLS_DIR` | `./vendor/marketingskills/skills` | Skill library location. |
| `ANTHROPIC_BASE_URL` | Anthropic API | Override for proxies or testing. |

## Agent roster

| Department | Agent | Skills |
|---|---|---|
| Strategy | Vera Quill, CMO | marketing-plan, marketing-council, product-marketing, launch, marketing-ideas |
| Strategy | Dr. Sol Okafor, Research & Insights | customer-research, competitors, competitor-profiling, marketing-psychology |
| Strategy | Indigo Park, Offers & Pricing | offers, pricing, marketing-ideas, product-marketing |
| SEO & Content | Rafael Moreno, SEO | seo-audit, site-architecture, programmatic-seo, schema |
| SEO & Content | Priya Raman, Content & AI Search | ai-seo, content-strategy, aso, directory-submissions |
| Creative | Theo Blackwood, Copy | copywriting, copy-editing, emails, social |
| Creative | Zuri Adeyemi, Creative Director | ad-creative, image, video, social, launch |
| Creative | Kenji Watanabe, Community & Social | community-marketing, social, influencer-marketing, referrals |
| Growth & Data | Nadia Petrov, Growth & CRO | cro, signup, onboarding, popups, paywalls, ab-testing |
| Growth & Data | Dmitri Volkov, Analytics & Attribution | analytics, attribution, ab-testing, marketing-loops |
| Lifecycle & Paid | Oskar Bergström, Lifecycle & Retention | emails, sms, churn-prevention, lead-magnets, free-tools, referrals |
| Lifecycle & Paid | Camila Reyes, Paid Media | ads, ad-creative, attribution, ab-testing |
| Revenue & Reach | Harper Cole, RevOps & Sales Enablement | revops, sales-enablement, cold-email, prospecting |
| Revenue & Reach | Imani Brooks, PR & Partnerships | public-relations, co-marketing, events, influencer-marketing, launch |

## Architecture

```
server/
  index.js     HTTP and WebSocket server, scheduling loops, static files
  company.js   Task pipeline, planner, consults, reviews, synthesis, metrics, persistence
  llm.js       Messages API client with retries, usage accounting and simulator switch
  mock.js      Simulator and keyword playbooks
  roster.js    Agent definitions and company charter
  skills.js    Skill loader and brief-to-skill matching
  sim.js       Agent state, movement, timing
  life.js      Idle behaviour between tasks
  map.js       Floor plan, walkability grid, A* pathfinding
public/        Browser client: canvas renderer and interface (no build step, no image assets)
vendor/        marketingskills (MIT)
tests/         node:test suites
```

The server is authoritative. It streams state to the browser over WebSocket at 10 Hz and pushes task, communication, deliverable and metric events as they occur. The client has no build step and no runtime dependencies. The only server dependency is `ws`.

## Extending

- **Add an agent.** Add an entry to `server/roster.js` with an id, short name, room, free desk slot, skills and persona. Add a workstation in `server/map.js` if the room is full.
- **Add or change a skill.** Place a folder containing `SKILL.md` in the skills directory and reference it from an agent.
- **Tune the simulator.** Edit `PLAYBOOKS` in `server/mock.js`.
- **Connect marketing accounts.** marketingskills includes CLI integrations under `tools/clis`. They are deliberately not wired in, since granting agents write access to ad accounts or inboxes should sit behind an explicit approval flow.

## Security

- The server binds to `127.0.0.1` by default and rejects cross-origin WebSocket connections.
- There is no authentication. Anyone who can reach the server can issue commands and, if a key is loaded, incur API spend. Do not expose it to untrusted networks without adding access control.
- API keys are held in process memory only.
- Model output is escaped before rendering in the browser.

## Testing

```
npm test
```

Fifteen tests cover floor-plan connectivity, roster and skill integrity, planning, a complete simulated task, persistence and recovery, idle behaviour, and the live path against a local fake API.

## Licence and credits

- Created by [@tomxander](https://github.com/tomxander), built with Claude Code.
- Marketing skills by [Corey Haines](https://github.com/coreyhaines31/marketingskills), used under the MIT licence. See `vendor/marketingskills/LICENSE`.
