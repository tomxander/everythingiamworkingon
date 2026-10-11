# 4EVR HQ

**A marketing agency run entirely by AI agents, in a pixel-art office. You play God.**

I built 4EVR as an experiment: what if a marketing agency were a team of AI specialists you could watch work? Fourteen agents live in a top-down pixel-art headquarters. They walk around, take coffee breaks, chat, consult each other and do real marketing work. I give them commands from the **God Console**, and the CMO plans each job, hands it to the right specialists, reviews the results and reports back. Every message, token and deliverable is tracked.

Each agent's expertise comes from the open-source [marketingskills](https://github.com/coreyhaines31/marketingskills) library (50 skills, MIT, vendored in `vendor/marketingskills`). Every specialist loads the full playbooks for the skills they own, so the SEO lead works from `seo-audit` and the lifecycle lead from `churn-prevention`.

Built by [@tomxander](https://github.com/tomxander), with [Claude Code](https://claude.ai/code) as my pair-programming partner.

```
npm install
npm start            # → http://127.0.0.1:4747
```

It runs immediately with **no API key** in simulated mode. To make the agents really think with Claude:

```
ANTHROPIC_API_KEY=sk-ant-... npm start
```

…or paste a key in **⚙ Settings** (held in server memory only, never written to disk).

## What you can do

| | |
|---|---|
| **Assign a task** | Type a command (and optional brief) in the God Console. Leave "Vera plans it" and the CMO splits it across specialists, or pick one person to work directly. 12 templates included. |
| **Watch** | Click anyone to inspect their persona, skills, memory and stats. Double-click to follow. Scroll to zoom, drag to pan, `F` to fit, `Space` to pause, 1×/2×/4× speed. |
| **Talk** | Chat with any agent from the inspector. They answer in character. |
| **Wield powers** | 📣 Announce (the office gathers and listens), ☕ Coffee round, 🏛 Town Hall, ✨ Bless, ⚡ Smite (lightly). |
| **Track** | **Tasks** (plan, workstreams, reviews), **Comms** (every consult, review and bit of banter), **Team** (energy, mood, status), **Output** (every deliverable as Markdown, also saved to `deliverables/`), **Metrics** (tokens, cost vs. budget cap, department output, a heat-map of the Skill Vault), **Log**. |

## How a task flows

1. **God → Vera (CMO).** She walks to the war-room whiteboard and plans 3–7 workstreams as JSON: owner, skill, instruction, dependencies, optional consult.
2. **Specialists work** in dependency order, in parallel where possible. Each agent's system prompt is: company charter + persona + memory + the full text of their chosen skill. Upstream deliverables are passed downstream.
3. **Consults.** Some workstreams start with the specialist walking to a colleague's desk to ask a question and get advice.
4. **Peer review.** A teammate reviews each deliverable (strength, improvement, verdict).
5. **Synthesis.** Vera writes the executive summary for God, then presents it at the pulpit while the team gathers.

## Two modes

| | Simulated (default) | Live |
|---|---|---|
| Needs | nothing | `ANTHROPIC_API_KEY` |
| Agents | a built-in simulator: keyword playbooks pick specialists, deliverables are structured from the real skill headings and clearly stamped **SIMULATED** | real Claude calls with the full skill text, prompt caching on the skill block, retries on 429/5xx |
| Cost | free (tokens/cost shown are estimates) | metered; **budget cap** (default $5, adjustable) drops back to simulation when hit |

Set `MODEL` to change the model (default `claude-sonnet-5-5`), `PRICE_IN` / `PRICE_OUT` (USD per million tokens) for cost estimates, `BUDGET_CAP_USD`, `MAX_ACTIVE_TASKS` (default 3).

> Prices are placeholders you should set to your real rates. Planner output is validated: unknown agents or skills are dropped or repaired, and the system falls back to the playbook planner if the model's JSON is unusable.

## The team

| Dept | Who | Skills |
|---|---|---|
| Strategy | **Vera Quill** (CMO) · **Dr. Sol Okafor** (Research) · **Indigo Park** (Offers & Pricing) | marketing-plan, marketing-council, product-marketing, launch · customer-research, competitors, competitor-profiling, marketing-psychology · offers, pricing |
| SEO & Content | **Rafa Moreno** · **Priya Raman** | seo-audit, site-architecture, programmatic-seo, schema · ai-seo, content-strategy, aso, directory-submissions |
| Creative | **Theo Blackwood** (Copy) · **Zuri Adeyemi** (Creative Director) · **Kenji Watanabe** (Community) | copywriting, copy-editing, emails, social · ad-creative, image, video · community-marketing, influencer-marketing, referrals |
| Growth & Data | **Nadia Petrov** · **Dee Volkov** | cro, signup, onboarding, popups, paywalls, ab-testing · analytics, attribution, marketing-loops |
| Lifecycle & Paid | **Oskar Bergström** · **Camila Reyes** | emails, sms, churn-prevention, lead-magnets, free-tools · ads, ad-creative, attribution |
| Revenue & Reach | **Harper Cole** · **Imani Brooks** | revops, sales-enablement, cold-email, prospecting · public-relations, co-marketing, events |

Plus **Pixel**, the office dog (no skills, excellent morale impact).

## Project layout

```
server/
  index.js      HTTP + WebSocket server, game loops, static files
  map.js        office layout, walkability grid, A* pathfinding
  sim.js        time, movement, speech bubbles, effects (no business logic)
  life.js       ambient behaviour: coffee, banter, whiteboards, ping pong…
  company.js    task pipeline, planner, consults, reviews, finale, God's powers, metrics, persistence
  llm.js        Anthropic Messages API client (+ simulator switch, retries, accounting)
  mock.js       the simulator and the keyword playbooks
  roster.js     the 14 agents (persona, skills, look) and the company charter
  skills.js     loads vendor/marketingskills, matches skills to briefs
public/         the client: canvas renderer, procedural pixel art (no image assets), UI
vendor/         marketingskills (MIT)
tests/          node --test (engine, simulated e2e, live path against a fake Anthropic API)
```

## Extend it

- **Add an agent:** add an entry in `server/roster.js` (id, short, room, a free `slot` in that room, skills, look). Add a desk in `server/map.js` if the room is full.
- **Add a skill:** drop a folder with `SKILL.md` into `vendor/marketingskills/skills/` (or set `SKILLS_DIR`) and list it on an agent.
- **Change the playbooks used by the simulator:** `PLAYBOOKS` in `server/mock.js`.
- **Connect real accounts:** marketingskills ships 60+ zero-dependency CLIs under `tools/clis`. They are not wired in here on purpose: giving agents write access to ad accounts and inboxes deserves its own approval flow.

## Safety notes

- The server binds to `127.0.0.1` by default. Set `HOST=0.0.0.0` only on a network you trust: anyone who can reach the page controls the office and the API key.
- WebSocket connections from other origins are rejected.
- Agents never ask clarifying questions; they list assumptions and proceed. Deliverables are drafts for a human to review.

## Tests

```
npm test
```

15 tests cover map connectivity, roster/skill integrity, planning, a full simulated task end to end, persistence, ambient life, and the live-Claude path against a local fake Anthropic server (headers, skill injection, caching marker, JSON plan repair, retries, budget cap).

## Credits

- Created by [@tomxander](https://github.com/tomxander), built with Claude Code.
- Marketing skills by [Corey Haines](https://github.com/coreyhaines31/marketingskills), used under the MIT licence (see `vendor/marketingskills/LICENSE`).
- Everything else is original and procedural: the sprites, furniture and floors are all drawn in code.
