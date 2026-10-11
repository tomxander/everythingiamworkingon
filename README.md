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
| Output | Every deliverable is rendered in the interface and saved as Markdown in `deliverables/`. Tasks also show the intake brief, the pages read and the open questions. |

## How work flows

1. **Intake.** A task is submitted and queued. Up to `MAX_ACTIVE_TASKS` run concurrently.
2. **Research.** If the request names a website, the research lead reads it: the homepage plus up to five key pages (product, pricing, about, contact, case studies). From those pages it extracts titles, headings, calls to action, forms, contact methods and detected tracking, and writes an evidence-based **client profile**. Profiles are cached per site for six hours and reused by later tasks for the same client.
3. **Brief.** The CMO turns the request into a structured intake brief: objective, goal type, primary metric, target, timeframe, budget, audience, assumptions and open questions. A one-line instruction such as "get this site more leads" becomes something the team can execute against.
4. **Plan.** The CMO decomposes the task into 3 to 7 workstreams (owner, skill, instruction, dependencies, optional consult) tailored to the evidence and the goal type. The plan is validated and repaired, with a deterministic fallback planner.
5. **Execute.** Each agent's system prompt contains the company charter, its persona and memory, the shared client context (intake brief, profile, sources read) and the full text of the selected skill. In live mode agents can also read additional public pages (`fetch_url`) and their skill's reference files.
6. **Review and revise.** A peer reviews each deliverable and returns a verdict. If the reviewer finds a real problem (unsupported claims, generic advice, or actions that need access the team does not have), the author revises once.
7. **Synthesise.** The CMO produces an executive summary covering the recommendation, contributions, risks, open questions and a seven-day plan.
8. **Persist.** State, deliverables, client profiles and metrics are saved to `data/` and `deliverables/`.

Agents work asynchronously and do not ask clarifying questions. They state assumptions explicitly, and the open questions are surfaced to you on the task so the next brief can answer them. Treat deliverables as drafts for human review.

## Grounding and limits

- Claims about a client must cite a page the team read. Anything else is labelled **Not verified**.
- If a site cannot be read (blocked, offline, or rendered entirely client-side), the task proceeds, a warning is shown, and the team is told explicitly that nothing about the site is verified.
- The team cannot log in to ad platforms, analytics, a CRM or the client's CMS and cannot change a live site. Deliverables are recommendations and ready-to-use assets, with the person who should apply them named.
- Page reading is limited to public `http(s)` pages. Requests to private, loopback and link-local addresses are blocked, including via redirects and DNS tricks.
- Traffic, conversion rates, lead quality and the sales process are invisible from outside the company. Provide them in the brief.

**Writing a good request.** Include the site, the goal and a number: *"Get acsiatech.com more qualified leads: 40 enquiries a month within 90 days. Budget $5k. Buyers are OEM procurement leads. Competitors: ..."* The brief field is where the baseline, budget, ideal customer and what has already been tried belong.

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
| `API_TIMEOUT_MS` | `180000` | Per-request timeout for model calls. |
| `PORT`, `HOST` | `4747`, `127.0.0.1` | Server binding. See [Security](#security). |
| `ALLOW_PRIVATE_FETCH` | unset | Set to `1` only for testing against a local site. Disables the private-address block on page reading. |
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
  llm.js       Messages API client: tool-use loop, timeouts, retries, truncation recovery, usage accounting
  tools.js     Safe web reading, site crawler, page analysis, tool definitions for agents
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
- Agents can only read public web pages. Private, loopback and link-local addresses are refused at connection time, so redirects and DNS rebinding cannot reach internal services. Page content is treated as untrusted data.
- There is no authentication. Anyone who can reach the server can issue commands and, if a key is loaded, incur API spend. Do not expose it to untrusted networks without adding access control.
- API keys are held in process memory only.
- Model output is escaped before rendering in the browser.

## Testing

```
npm test
```

Twenty-six tests cover floor-plan connectivity, roster and skill integrity, planning and routing, a complete simulated task, persistence and recovery, idle behaviour, safe web fetching (including private-address and redirect protection), site crawling and findings, and the live path against a local fake API: tool use, truncation recovery, review-driven revision, timeouts and unreachable sites.

## Licence and credits

- Created by [@tomxander](https://github.com/tomxander), built with Claude Code.
- Marketing skills by [Corey Haines](https://github.com/coreyhaines31/marketingskills), used under the MIT licence. See `vendor/marketingskills/LICENSE`.
