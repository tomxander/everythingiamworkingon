// The simulator: stands in for Claude when no API key is configured.
// It is deliberately honest — every deliverable is stamped SIMULATED, and the
// structure it produces comes from the real skill files, not from thin air.

import { siteFindings } from './tools.js';

const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];
const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);

// ---------- playbooks: which specialists a type of brief calls for ----------
// step: [agentId, skill, instruction, dependsOn[], consult?]
export const PLAYBOOKS = {
  launch: {
    words: ['launch', 'release', 'announce', 'announcement', 'debut', 'unveil', 'go-to-market', 'gtm', 'product hunt', 'new product', 'new feature'],
    steps: [
      ['sol', 'customer-research', 'Mine the target customer\'s own language, pains and the alternatives they compare us against.', []],
      ['indigo', 'offers', 'Shape the launch offer: value stack, price anchor, guarantee and a reason to act now.', [0]],
      ['theo', 'copywriting', 'Write the launch hero, announcement email subject lines and three tagline options.', [0, 1], 'zuri'],
      ['imani', 'public-relations', 'Find the news hook, the three journalists or creators to pitch, and write the pitch.', [0, 1]],
      ['camila', 'ads', 'Plan the launch-week paid push: channels, budget split, targeting and kill criteria.', [2]],
      ['dee', 'analytics', 'Define launch tracking: events, UTMs, the single north-star metric and a day-by-day dashboard.', []],
    ],
  },
  seo: {
    words: ['seo', 'search', 'rank', 'ranking', 'organic', 'google', 'keywords', 'blog', 'traffic', 'backlinks', 'content marketing', 'sitemap'],
    steps: [
      ['sol', 'competitors', 'Map the competitors who take the clicks we want and what they do better.', []],
      ['rafa', 'seo-audit', 'Audit technical health and on-page basics; list fixes by impact and effort.', []],
      ['priya', 'content-strategy', 'Build a topic cluster plan: pillars, supporting pieces, and the first ten briefs.', [0, 1], 'rafa'],
      ['priya', 'ai-seo', 'Make the content citeable by AI search: answer-first structure, entities and sources.', [1]],
      ['rafa', 'programmatic-seo', 'Assess whether a templated-page play is viable here and sketch the first template.', [0]],
      ['dee', 'analytics', 'Set up organic reporting: rank, clicks, assisted conversions and a monthly review rhythm.', []],
    ],
  },
  paid: {
    words: ['ads', 'ad', 'paid', 'ppc', 'adwords', 'meta ads', 'facebook', 'instagram ads', 'linkedin ads', 'tiktok', 'cac', 'roas', 'campaign', 'budget'],
    steps: [
      ['sol', 'customer-research', 'Pull the audience\'s exact words and objections for ad hooks.', []],
      ['camila', 'ads', 'Design the account structure, targeting, bidding and budget plan with clear kill and scale rules.', [0]],
      ['zuri', 'ad-creative', 'Produce a creative testing matrix: 3 concepts x 3 hooks, with formats.', [0], 'theo'],
      ['theo', 'copywriting', 'Write headlines, primary text and CTAs for each concept.', [0, 2]],
      ['dee', 'attribution', 'Specify how we will attribute results honestly: windows, holdouts and what we will not claim.', []],
    ],
  },
  lifecycle: {
    words: ['email', 'newsletter', 'drip', 'onboarding', 'retention', 'churn', 'lifecycle', 'welcome', 'sms', 'nurture', 'win-back', 'referral', 'activation'],
    steps: [
      ['sol', 'customer-research', 'Find the moments where customers decide to stay or leave.', []],
      ['oskar', 'emails', 'Design the sequence: triggers, timing, goal of each message and the exit rules.', [0]],
      ['theo', 'emails', 'Write the first three emails in full, subject lines and previews included.', [1], 'oskar'],
      ['oskar', 'churn-prevention', 'Build the save-offer and failed-payment recovery flow.', [0]],
      ['nadia', 'onboarding', 'Audit the first-run experience and propose the activation milestone.', [0]],
    ],
  },
  cro: {
    words: ['conversion', 'cro', 'landing', 'landing page', 'homepage', 'website', 'signup', 'sign-up', 'checkout', 'pricing page', 'optimize', 'a/b', 'ab test', 'funnel', 'popup', 'form'],
    steps: [
      ['sol', 'customer-research', 'Gather visitor intent and objections to ground the page work.', []],
      ['nadia', 'cro', 'Audit the page: clarity, hierarchy, friction and proof. Rank fixes by expected lift.', [0]],
      ['theo', 'copywriting', 'Rewrite the hero, value proposition and primary CTA with two alternatives each.', [0, 1], 'nadia'],
      ['nadia', 'ab-testing', 'Write the test plan: hypothesis, variants, sample size and the stopping rule.', [1, 2]],
      ['dee', 'analytics', 'Instrument the funnel so each step is measurable before the test runs.', []],
    ],
  },
  pricing: {
    words: ['pricing', 'price', 'packaging', 'tiers', 'monetization', 'monetisation', 'plans', 'discount', 'freemium', 'offer'],
    steps: [
      ['sol', 'competitors', 'Benchmark competitor pricing and packaging, and note where they are weak.', []],
      ['indigo', 'pricing', 'Recommend tiers, value metric and price points with the reasoning.', [0]],
      ['indigo', 'offers', 'Craft the headline offer: guarantee, bonuses and risk reversal.', [1]],
      ['nadia', 'paywalls', 'Design the upgrade moments and the pricing page flow.', [1]],
      ['theo', 'copywriting', 'Write the pricing page copy and the plan names.', [1, 2]],
    ],
  },
  sales: {
    words: ['sales', 'outbound', 'cold', 'cold email', 'prospect', 'prospecting', 'pipeline', 'enablement', 'deck', 'revops', 'crm', 'abm'],
    steps: [
      ['sol', 'customer-research', 'Define the ideal buyer, the trigger events and their language.', []],
      ['harper', 'prospecting', 'Build the target list criteria and a qualification scorecard.', [0]],
      ['harper', 'cold-email', 'Write a 4-touch outbound sequence with personalization hooks.', [0, 1], 'theo'],
      ['theo', 'copy-editing', 'Edit the sequence: cut a third, remove every cliche, sharpen the asks.', [2]],
      ['harper', 'revops', 'Define lead stages, handoff SLAs and the marketing-to-sales feedback loop.', [1]],
    ],
  },
  pr: {
    words: ['pr', 'press', 'media', 'journalist', 'partnership', 'partner', 'co-marketing', 'event', 'conference', 'webinar', 'influencer', 'creator', 'awareness'],
    steps: [
      ['sol', 'competitors', 'Review how the category is covered and what stories are already told.', []],
      ['imani', 'public-relations', 'Develop the story angles, a target media list and the pitch.', [0]],
      ['imani', 'co-marketing', 'Identify three partners for a joint campaign and the offer to each.', [0]],
      ['kenji', 'influencer-marketing', 'Shortlist creators, define the brief and compensation approach.', [0]],
      ['theo', 'copywriting', 'Write the pitch email and the one-paragraph boilerplate.', [1]],
    ],
  },
  social: {
    words: ['social', 'community', 'brand', 'twitter', 'linkedin', 'tiktok', 'reddit', 'discord', 'content calendar', 'video', 'viral', 'instagram', 'youtube'],
    steps: [
      ['sol', 'customer-research', 'Find where our audience actually hangs out and what they share.', []],
      ['kenji', 'community-marketing', 'Design the community play: where, what we give first, and the member journey.', [0]],
      ['zuri', 'social', 'Build a two-week content calendar with formats and hooks.', [0], 'kenji'],
      ['zuri', 'video', 'Storyboard the three short videos most likely to travel.', [2]],
      ['theo', 'social', 'Write the first week of posts, ready to publish.', [2]],
    ],
  },
  leadgen: {
    words: ['lead', 'leads', 'lead gen', 'enquiries', 'inquiries', 'enquiry', 'inquiry', 'inbound', 'more leads', 'generate leads', 'demand'],
    steps: [
      ['nadia', 'cro', 'Audit the path from landing to enquiry using the site evidence: calls to action, forms, trust signals and friction. Rank fixes by expected lift.', [], 'dee'],
      ['rafa', 'seo-audit', 'Audit technical and on-page SEO for the pages that should bring in qualified enquiries. List fixes by impact and effort.', []],
      ['theo', 'copywriting', 'Rewrite the homepage hero, value proposition and primary call to action, plus one landing page for the highest-intent offer.', [0, 1], 'nadia'],
      ['oskar', 'lead-magnets', 'Design the lead magnet and nurture sequence that converts visitors who are not ready to enquire yet.', [0]],
      ['camila', 'ads', 'Plan a small paid lead-generation test: channels, audiences, budget split, offer and kill rules.', [2]],
      ['dee', 'analytics', 'Specify lead tracking end to end: events, form attribution, UTM rules, CRM source fields and a weekly lead dashboard. Start from the tracking actually detected on the site.', []],
    ],
  },
  strategy: {
    words: ['strategy', 'plan', 'positioning', 'marketing plan', 'roadmap', 'growth plan', 'everything', 'full', 'brand strategy', 'audit'],
    steps: [
      ['sol', 'customer-research', 'Synthesize who the customer is, what they want and how they talk.', []],
      ['sol', 'competitors', 'Map the competitive landscape and the open positioning space.', []],
      ['indigo', 'offers', 'Define the core offer and where it should sit on price.', [0, 1]],
      ['priya', 'content-strategy', 'Outline the content engine: pillars, cadence and distribution.', [0, 1]],
      ['camila', 'ads', 'Recommend the paid channel mix with budget and expected payback.', [0, 2]],
      ['nadia', 'cro', 'Pick the three conversion fixes with the highest expected lift.', [0]],
    ],
  },
};

const FALLBACK = 'strategy';

export function planFromPlaybooks(title, brief, maxSteps = 7, hintKey = null) {
  const text = `${title} ${brief}`.toLowerCase();
  const words = new Set(text.match(/[a-z0-9][a-z0-9/-]*/g) || []);
  const scored = Object.entries(PLAYBOOKS).map(([key, pb]) => {
    let s = 0;
    for (const w of pb.words) if (w.includes(' ') ? text.includes(w) : words.has(w)) s += w.length > 4 ? 2 : 1;
    return { key, s };
  }).sort((a, b) => b.s - a.s);
  let chosen = scored[0].s > 0 ? [scored[0].key] : [FALLBACK];
  if (scored[1] && scored[1].s > 0 && scored[1].s >= scored[0].s * 0.6) chosen.push(scored[1].key);
  // the intake step has already worked out what the goal really is: trust it over keyword luck
  if (hintKey && PLAYBOOKS[hintKey]) chosen = [hintKey, ...chosen.filter((k) => k !== hintKey).slice(0, 1)];

  const steps = []; const seen = new Map(); // `${agent}:${skill}` -> index
  for (const key of chosen) {
    const base = steps.length; const localToGlobal = [];
    PLAYBOOKS[key].steps.forEach(([agent, skill, instruction, deps, consult], i) => {
      const k = `${agent}:${skill}`;
      if (seen.has(k)) { localToGlobal[i] = seen.get(k); return; }
      if (steps.length >= maxSteps) { localToGlobal[i] = 0; return; }
      const idx = steps.length;
      steps.push({ agent, skill, instruction, deps: [...new Set(deps.map((d) => localToGlobal[d]).filter((d) => d !== undefined && d !== idx))], consult: consult || null });
      seen.set(k, idx); localToGlobal[i] = idx;
    });
    void base;
  }
  return { summary: `Playbook: ${chosen.join(' + ')}`, steps };
}

// ---------- action banks used to flesh out simulated deliverables ----------
const BANK = {
  'customer-research': ['Run 5 five-minute interviews with recent buyers and tag verbatims by job-to-be-done.', 'Mine reviews, support tickets and Reddit threads for the exact phrases customers use about {topic}.', 'Build a one-page "voice of customer" doc: top 5 pains, top 5 outcomes, top 3 objections.'],
  competitors: ['Profile the 4 closest alternatives on positioning, pricing, proof and weak spots.', 'Draft an "Us vs. them" matrix that is honest about where each competitor wins.', 'Pick the single claim competitors cannot make about {topic} and own it.'],
  offers: ['Stack the offer: core promise, 2 bonuses and a risk-reversal guarantee.', 'Anchor against the cost of the status quo, then name the price.', 'Add a time-boxed reason to act that is real, not manufactured.'],
  pricing: ['Choose one value metric the customer already understands and price along it.', 'Offer three tiers with a clear "recommended" middle option.', 'Test price with a Van Westendorp survey before changing live prices.'],
  copywriting: ['Lead with the outcome, not the feature; keep the hero under 12 words.', 'Write three headline angles: outcome, objection-flip and curiosity. Test the first two.', 'Replace every vague claim with a specific number or example.'],
  'copy-editing': ['Run the Seven Sweeps: clarity, voice, so-what, proof, specificity, emotion, risk.', 'Cut a third of the words, then cut the adverbs.', 'Read it aloud; rewrite every sentence you stumble on.'],
  'seo-audit': ['Fix crawl and index issues first (canonicals, redirects, orphan pages).', 'Rewrite titles and meta for the 20 pages with highest impressions and lowest CTR.', 'Improve Core Web Vitals on the templates that carry most traffic.'],
  'site-architecture': ['Flatten the hierarchy so key pages sit within 3 clicks of the homepage.', 'Group URLs into pillar/cluster paths and add contextual internal links.'],
  'programmatic-seo': ['Pick one repeatable pattern with real search demand (e.g. "[tool] alternatives").', 'Pilot 20 pages with unique data per page before scaling to thousands.'],
  schema: ['Add Organization, Product and FAQ schema; validate with the Rich Results test.'],
  'ai-seo': ['Open each article with a self-contained 40-60 word answer.', 'Add quotable statistics with sources and clear entity names.', 'Track citations monthly across the major AI search tools.'],
  'content-strategy': ['Choose 3 pillar topics tied to revenue, not just volume.', 'Ship 2 cornerstone pieces per month plus 6 supporting posts.', 'Add a distribution plan to every brief before writing starts.'],
  ads: ['Start with one campaign per intent tier (brand, high-intent, prospecting).', 'Cap test spend at 20% of budget; kill any ad set under target after 3x CPA.', 'Scale winners in 20% steps so the algorithm does not reset.'],
  'ad-creative': ['Test hooks before offers: 3 hooks x 3 formats gives 9 cheap tests.', 'Make the first 2 seconds carry the whole message.', 'Refresh creative every 2 to 3 weeks or at frequency above 3.'],
  attribution: ['Use platform data for optimisation and a blended MER view for truth.', 'Run one geo or time holdout to measure incrementality.'],
  analytics: ['Define 8 core events and name them consistently.', 'Enforce a UTM convention in a shared sheet.', 'Build one weekly dashboard with a single owner.'],
  'ab-testing': ['Write the hypothesis as "Because X, changing Y will move Z".', 'Pre-compute sample size; do not peek before it is reached.', 'Document every test, win or lose, in a shared log.'],
  cro: ['Make the primary CTA unmistakable and repeat it after each proof block.', 'Move social proof next to the first CTA.', 'Remove two form fields and measure completion.'],
  signup: ['Cut signup to email plus one field and defer the rest to onboarding.'],
  onboarding: ['Define the "aha" milestone and guide every new user to it inside the first session.', 'Replace the product tour with a checklist tied to the milestone.'],
  popups: ['Trigger on intent (exit or scroll depth), never on page load.'],
  paywalls: ['Show the paywall right after the user feels value, with the benefit they just used.'],
  emails: ['Send a welcome within 5 minutes; the first email should deliver one quick win.', 'Space the next messages at day 1, 3 and 7 with one job each.', 'Segment by behaviour, not just signup date.'],
  sms: ['Use SMS only for time-sensitive, high-value moments and always make opt-out easy.'],
  'churn-prevention': ['Add a cancel flow that asks why and offers a pause, downgrade or targeted save.', 'Set up dunning emails that retry failed payments on a schedule.'],
  referrals: ['Reward both sides and make the share action one click.'],
  'lead-magnets': ['Build a single-job asset that solves one narrow problem in under 10 minutes.'],
  'free-tools': ['Ship a free calculator tied to the core job; gate only the export.'],
  'community-marketing': ['Give first: seed useful answers for 30 days before any promotion.', 'Name 3 community champions and give them early access.'],
  social: ['Post 4x a week: 1 insight, 1 story, 1 proof, 1 question.', 'Repurpose each long piece into 5 native short posts.'],
  video: ['Open with the payoff, then show how; keep every cut under 3 seconds.'],
  image: ['Use a consistent visual system so each asset is recognisable at thumbnail size.'],
  'influencer-marketing': ['Prefer 10 micro-creators with genuine fit over one famous name.', 'Pay for usage rights, not just posts.'],
  'public-relations': ['Lead with the news hook, then the data, then the person.', 'Warm up 10 journalists with useful comments before pitching.'],
  'co-marketing': ['Pair with partners whose audience overlaps by problem but not by product.'],
  events: ['Pick one flagship event and build the whole quarter around its pipeline.'],
  revops: ['Write one definition of MQL, SQL and SAL and enforce an SLA for follow-up.'],
  'sales-enablement': ['Give sales a one-pager, three objection answers and a demo script.'],
  'cold-email': ['Keep emails under 90 words; one ask; personalise the first line with a real trigger.'],
  prospecting: ['Score accounts on fit and intent; work only the top tier first.'],
  launch: ['Run a 3-phase launch: tease, ship, sustain. Plan day-30 as carefully as day-1.'],
  'marketing-plan': ['Pick 3 priorities for the quarter and say what we will not do.'],
  'marketing-ideas': ['Shortlist the 5 plays with the best effort-to-impact ratio and test one this week.'],
  'marketing-psychology': ['Use loss aversion and social proof where they are honest, never manufactured scarcity.'],
  'product-marketing': ['Write the positioning statement: for X who need Y, we are Z that does W unlike V.'],
  'marketing-council': ['Convene a board of advisors with conflicting lenses and record where they disagree.'],
  aso: ['Optimise title and keyword field first; test screenshots as the biggest conversion lever.'],
  'directory-submissions': ['Submit to the 15 directories where buyers already look, with consistent copy.'],
  'marketing-loops': ['Pick one weekly loop: collect, decide, ship, review. Automate the collect step first.'],
};

function headingsOf(body, n = 5) {
  const hs = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => m[1].replace(/[*`]/g, '').replace(/^\d+[.)]\s*/, '').trim());
  const skip = /before (writing|starting)|related skills?|task-specific questions?|^context$|reference|routing|output format|common mistakes/i;
  return [...new Set(hs.filter((h) => !skip.test(h) && h.length < 60))].slice(0, n);
}

const bullet = (items) => items.map((x) => `- ${x}`).join('\n');

function topicOf(ctx) { return (ctx.title || 'the brief').replace(/[.:]+$/, ''); }

export function mockComplete(kind, ctx) {
  const seed = hash(`${kind}|${ctx.title}|${ctx.agent?.id}|${ctx.skill?.name}`);
  switch (kind) {
    case 'plan': {
      const plan = planFromPlaybooks(ctx.title, ctx.brief, 7, ctx.intake?.playbook);
      return { text: JSON.stringify(plan), latencyMs: 2500 };
    }
    case 'kickoff_brief': {
      const st = ctx.steps || []; const i = ctx.intake || {};
      const who = st.map((x) => `${x.short} takes ${x.skill}${x.deps.length ? ` after ${x.deps.join(' and ')}` : ''}`).join('; ');
      const risk = (i.assumptions || []).find((a) => /baseline|target/i.test(a)) ? 'We have no baseline, so measurement has to go in first' : 'Handoffs are where this slips, so say early what you need';
      return { text: `Team, here is the picture. ${i.objective || ctx.title}. We will judge it on ${String(i.metric || 'one metric').toLowerCase()}. ${who}. Biggest risk: ${risk}. Owners, confirm and tell me what you need from each other.`, latencyMs: 2200 };
    }
    case 'kickoff_reply': {
      const a = ctx.agent || {}; const as = ctx.assignment || {};
      const first = String(as.instruction || '').split(/[.;]/)[0].replace(/^(Audit|Write|Build|Design|Plan|Define|Specify|Rewrite|Assess|Map|Find|Develop|Identify|Shortlist|Produce|Recommend|Review|Outline|Edit|Pick|Mine|Gather|Synthesize|Shape|Make)\b/, (m) => m.toLowerCase());
      const needs = (ctx.needsFrom || []).length ? `I need ${ctx.needsFrom.join(' and ')}'s output before I finalise.` : 'I can start straight away.';
      const feeds = (ctx.feedsInto || []).length ? ` ${ctx.feedsInto.join(' and ')}: you will get my headline findings first.` : '';
      const lead = ctx.leadNote && ctx.leadNote.short !== 'Vera' ? `${ctx.leadNote.short}, understood. ` : '';
      const risk = ctx.risk ? ` Risk: ${ctx.risk}.` : '';
      return { text: `${lead}I will ${first}. ${needs}${feeds}${risk}`.replace(/\s+/g, ' ').trim(), latencyMs: 900 };
    }
    case 'handoff': {
      const h = String(ctx.headline || 'the main findings are in the deliverable').replace(/[.]+$/, '');
      const asm = ctx.assumption ? String(ctx.assumption).replace(/[.]+$/, '') : null;
      return { text: `${ctx.to.short}, the headline from my ${ctx.fromSkill}: ${h}. ${asm ? `One assumption to check: ${asm.charAt(0).toLowerCase()}${asm.slice(1)}.` : 'I worked from the brief as written.'} Tell me if that breaks your ${ctx.toSkill}.`, latencyMs: 800 };
    }
    case 'align': {
      const have = new Set((ctx.subs || []).map((x) => `${x.agent}:${x.skill}`));
      const out = ALIGN_RULES.filter((r) => r.pair.every((k) => have.has(k))).slice(0, 2).map((r) => ({ rule: r.id, agents: r.pair.map((k) => k.split(':')[0]), issue: r.issue, question: r.question }));
      return { text: JSON.stringify({ conflicts: out }), latencyMs: 1800 };
    }
    case 'align_reply': { const r = ALIGN_RULES.find((x) => x.id === ctx.rule); const side = ctx.side === 1 ? 1 : 0; return { text: r ? r.positions[side] : 'I can flex on timing but not on measurement.', latencyMs: 800 }; }
    case 'decision': { const r = ALIGN_RULES.find((x) => x.id === ctx.rule); return { text: r ? r.decision : 'We sequence the changes and measure each one.', latencyMs: 900 }; }
    case 'escalate_reply': return { text: ctx.retry ? `Understood. Retry once with a tighter scope, and tell me if the same thing happens (${String(ctx.error || '').slice(0, 80)}).` : `Proceed without it. I will flag the gap in the summary so God knows it is missing.`, latencyMs: 700 };
    case 'reflect': {
      const out = []; const r = ctx.review || {};
      if (r.improvement) out.push({ scope: 'agent', text: `${ctx.skillTitle || 'In this skill'}: ${String(r.improvement).replace(/[.]+$/, '')}.`, tags: ['review'] });
      if (r.verdict === 'approve' && r.strength && !r.improvement) out.push({ scope: 'agent', text: `Keep doing this: ${String(r.strength).replace(/[.]+$/, '')}.`, tags: ['strength'] });
      return { text: JSON.stringify({ lessons: out }), latencyMs: 700 };
    }
    case 'retro': return { text: JSON.stringify(ctx.retro || { wentWell: [], wentWrong: [], lessons: [], rules: [] }), latencyMs: 2500 };
    case 'hr': return { text: ctx.fallback, latencyMs: 1200 };
    case 'hire': return { text: JSON.stringify(ctx.profile), latencyMs: 1500 };
    case 'consolidate': return { text: (ctx.lessons || []).map((l) => `- ${l}`).join('\n'), latencyMs: 1200 };
    case 'study': return { text: JSON.stringify({ lessons: [] }), latencyMs: 500 };
    case 'intake': return { text: JSON.stringify(ctx.intake), latencyMs: 2500 };
    case 'profile': return { text: ctx.snapshot?.pages?.length ? heuristicProfile(ctx.snapshot, ctx.brief) : '# Client profile\n\nNo pages could be read.', latencyMs: 3500 };
    case 'chat': {
      const a = ctx.agent || {};
      const quirk = a.quirks?.length ? pick(a.quirks, seed) : 'Noted.';
      const opens = ['Of course, God.', 'Understood.', 'On it.', 'Good question.', 'Right away.'];
      const tail = /task|work|do|make|write|build|plan|launch/i.test(ctx.title || '') ? ' If you want it done properly, assign it as a task and I will get the team on it.' : '';
      return { text: `${pick(opens, seed >> 2)} ${quirk}${tail}`, latencyMs: 600 };
    }
    case 'consult_q': {
      const qs = [
        `Quick one, ${ctx.to.short}: for "${topicOf(ctx)}", what would you push back on first?`,
        `Do you have 2 minutes? I want a sanity check on my angle for ${topicOf(ctx)}.`,
        `${ctx.to.short}, what's the one thing I'm about to miss on ${topicOf(ctx)}?`,
      ];
      return { text: pick(qs, seed), latencyMs: 800 };
    }
    case 'consult_a': {
      const quirk = ctx.to.quirks?.length ? pick(ctx.to.quirks, seed) : 'Make it specific.';
      const as = [
        `${quirk} Lead with the strongest proof you've got, and cut the rest.`,
        `I'd test the bolder angle first. ${quirk}`,
        `Looks solid. Tighten the promise and make the next step obvious. ${quirk}`,
      ];
      return { text: pick(as, seed >> 3), latencyMs: 800 };
    }
    case 'review': {
      // simulated reviewers still read the deliverable: every comment below comes from checking it
      const md = String(ctx.markdown || '');
      const sec = (name) => (md.match(new RegExp(`## ${name}\\n([\\s\\S]*?)(?:\\n## |$)`)) || [])[1] || '';
      const assumptions = sec('Assumptions').split('\n').filter((l) => /^\s*[-*]/.test(l)).length;
      const recs = sec('Recommendations'); const next = sec('Next actions');
      const strengths = [];
      if (/## Evidence from the site/.test(md)) strengths.push('Grounded in real pages from the client\'s own site.');
      if (/## Web research/.test(md) && !/Web search was not available/.test(md)) strengths.push('Backed by a live web search, with the sources listed.');
      if (/## Team input considered/.test(md)) strengths.push('Builds on what teammates said instead of starting cold.');
      if (/## Lessons applied/.test(md)) strengths.push('Applies lessons the team has already learned.');
      strengths.push('Clear structure with concrete recommendations.');
      const fixes = [];
      if (assumptions > 3) fixes.push('Cut the assumptions to the three that would change the recommendation.');
      if (recs && !/\d/.test(recs)) fixes.push('Put a number or threshold on each recommendation so success can be checked.');
      if (next && !/\b(by|within|day|week|friday|monday)\b/i.test(next)) fixes.push('Give every next action an owner and a date.');
      if (recs && (recs.match(/^\s*\d+\./gm) || []).length < 3) fixes.push('Offer a second option and say why it was rejected.');
      if (!/Not verified|could not be verified|not verified/i.test(md)) fixes.push('Say what could not be verified from outside the company, and how to check it.');
      if (/Web search was not available/.test(md)) fixes.push('Re-run the research once search is available and cite what it finds.');
      const strength = pick(strengths, seed); const improvement = fixes.length ? pick(fixes, seed >> 2) : null;
      return { text: JSON.stringify({ verdict: 'approve', strength, improvement }), latencyMs: 900 };
    }
    case 'synth': {
      const parts = (ctx.outputs || []).map((o) => `- **${o.agentName}** (${o.skill}): ${o.headline}`).join('\n');
      const text = `# Executive summary: ${topicOf(ctx)}\n\n> SIMULATED OUTPUT. Add an Anthropic API key and switch to Live for real analysis.\n\n## The call\nRun this as one coordinated push. Research first, offer second, copy and channels third, measurement alongside all of it.\n\n${(ctx.decisions || []).length ? `## Decisions made along the way\n${ctx.decisions.map((d) => `- ${d.decision}`).join('\n')}\n\n` : ''}## What the team produced\n${parts}\n\n${(ctx.intake?.openQuestions || []).length ? `## Open questions for God\n${ctx.intake.openQuestions.map((q) => `- ${q}`).join('\n')}\n\n` : ''}## Decisions for God\n1. Approve the offer and positioning direction.\n2. Choose the single north-star metric (our pick: qualified conversions per week).\n3. Release budget for the first two-week test.\n\n## Next 7 days\n- Day 1-2: lock research and offer.\n- Day 3-4: copy and creative to draft.\n- Day 5: measurement live, QA.\n- Day 6-7: soft launch to 10% of traffic and review.\n\n## How we'll know it worked\nA 20% lift in qualified conversions against the 4-week baseline, with CAC at or below target.`;
      return { text, latencyMs: 3500 };
    }
    case 'work':
    default: {
      const { agent, skill, instruction } = ctx;
      const topic = (ctx.intake?.objective || topicOf(ctx)).replace(/[.:]+$/, '');
      // simulated agents act on the lessons they were given, so the learning loop is real even without a model
      const L = (ctx.lessons || []).join(' ').toLowerCase();
      const act = { trim: /assumptions to the three/.test(L), numbers: /number or threshold/.test(L), alt: /second option/.test(L), unverified: /could not be verified/.test(L) };
      const acts = (BANK[skill?.name] || ['Define the objective, pick one metric, and ship a small test this week.', 'Document what you learn so the next brief starts smarter.'])
        .map((a) => a.replaceAll('{topic}', topic));
      const heads = skill ? headingsOf(skill.body, 5) : [];
      const prior = (ctx.priorOutputs || []).slice(0, 3);
      const assumptions = [
        ...(ctx.intake ? ctx.intake.assumptions.slice(0, 3) : [`The brief is the source of truth: "${(ctx.brief || '').slice(0, 110).replace(/\s+/g, ' ')}${(ctx.brief || '').length > 110 ? '...' : ''}"`, 'Budget, timing and brand constraints are as stated; anything missing is flagged below.']),
        prior.length ? `Builds on the work of ${prior.map((p) => p.agentShort).join(', ')}` : 'No upstream work yet; this is the first pass.',
      ];
      let assumptionList = assumptions; if (act.trim) assumptionList = assumptions.slice(0, 3);
      const recLines = acts.map((a, i) => `${i + 1}. ${a}${act.numbers ? ' Success check: review at day 14 against the baseline.' : ''}`);
      if (act.alt) recLines.push(`${recLines.length + 1}. Alternative considered: run the smaller version first and expand only if the day-14 check passes.`);
      const text = `# ${skill?.title || 'Deliverable'}: ${topic}

> SIMULATED OUTPUT (${agent.name}, ${agent.role}). Structure follows the \`${skill?.name}\` skill. Switch to Live mode for real, brief-specific work.

**Task:** ${instruction}

## Assumptions
${bullet(assumptionList)}

${ctx.snapshot?.pages?.length ? `## Evidence from the site\n${bullet(siteEvidence(ctx.snapshot))}\n\n` : ''}${ctx.web ? `## Web research (live search)\n${ctx.web.error ? `- Web search was not available (${ctx.web.error}), so nothing here is verified against outside sources.` : bullet(ctx.web.results.map((r) => `${r.title}: ${r.url}${r.snippet ? ` (${r.snippet.slice(0, 110)})` : ''}`))}\n\n` : ''}${ctx.thread?.length ? `## Team input considered\n${bullet(ctx.thread.map((m) => `${m.kind}${m.from ? ` from ${m.from}` : ''}: ${String(m.text).slice(0, 170)}`))}\n\n` : ''}${ctx.lessons?.length ? `## Lessons applied from past work\n${bullet(ctx.lessons)}\n\n` : ''}## Framework this skill applies
${heads.length ? bullet(heads.map((h) => `${h}`)) : '- (framework from the skill library)'}

## Recommendations
${recLines.join('\n')}

## Next actions
${bullet([`${agent.short}: finalise the first draft within 2 days.`, 'Theo: copy pass once the direction is approved.', 'Dee: confirm tracking is in place before anything goes live.'])}

${act.unverified ? '## Not verified\n- Traffic, conversion rate and lead quality are not visible from outside the company. Check them in the client\'s analytics before acting on these numbers.\n\n' : ''}## How we'll know it worked
Pick one leading metric for this workstream, set the threshold before launch, and review at day 14.`;
      const words = text.split(/\s+/).length;
      return { text, latencyMs: 4000 + Math.min(9000, words * 22), headline: acts[0] };
    }
  }
}

// ---------- ambient chatter ----------
const SMALL_TALK = [
  ['Did you see that new case study?', 'Saved it. The stat on page 3 is wild.'],
  ['Coffee run?', 'Always. Oat flat white for me.'],
  ['Is it just me or is Friday coming early?', 'It is always Friday somewhere. In this office, anyway.'],
  ['The dog got into the lounge again.', 'Best employee we have. Zero meetings.'],
  ['Hot take: most dashboards are decoration.', 'I am putting that on a slide.'],
  ['Have you tried the new vending machine snack?', 'Do not. Learn from my mistake.'],
  ['Our competitors just rebranded.', 'Fourth time this year. We are on forever for a reason.'],
  ['I had an idea in the shower.', 'Write it down before it escapes.'],
  ['Remember when we only had three clients?', 'And now God keeps us busy. I love it.'],
  ['Does anyone actually read the footnotes?', 'Dee does. Dee reads everything.'],
  ['Ping pong later?', 'You are on. Loser buys coffee.'],
  ['What is the best headline you have ever read?', '"Think small." Still gives me chills.'],
];

export function smallTalk(seed = Math.random() * 1e6) {
  return pick(SMALL_TALK, Math.floor(seed));
}

export const IDLE_THOUGHTS = ['pondering...', 'sketching ideas', 'reading a case study', 'checking metrics', 'refilling coffee', 'stretching', 'reorganising tabs', 'daydreaming about CTR'];

// ---------------------------------------------------------------- intake + client profile (simulated)
const GOALS = [
  ['outbound', /\b(outbound|cold (email|outreach|call)|prospect(ing)?)\b/i, 'sales', 'Qualified meetings booked per month'],
  ['leadgen', /\b(leads?|enquir\w*|inquir\w*|inbound|generate demand|pipeline from (the )?(site|website))\b/i, 'leadgen', 'Qualified enquiries per month'],
  ['seo', /\b(seo|organic|rank(ing)?s?|search engine|backlinks?)\b/i, 'seo', 'Organic sessions and qualified organic enquiries'],
  ['paid', /\b(ads?|ppc|paid (media|social|search)|adwords|cac|roas)\b/i, 'paid', 'Cost per qualified lead'],
  ['launch', /\b(launch|release|announce|go-to-market|gtm)\b/i, 'launch', 'Launch-week signups or enquiries'],
  ['lifecycle', /\b(email|nurture|onboarding|retention|churn|lifecycle|win-?back)\b/i, 'lifecycle', 'Activation and retention rate'],
  ['cro', /\b(conversion|cro|landing page|homepage|signup|sign-up|checkout|funnel)\b/i, 'cro', 'Visitor-to-enquiry conversion rate'],
  ['pricing', /\b(pricing|packaging|tiers?|monetis\w*|monetiz\w*)\b/i, 'pricing', 'Revenue per customer'],
  ['pr', /\b(pr|press|media coverage|journalists?|partnerships?|co-marketing)\b/i, 'pr', 'Qualified referral traffic and coverage'],
  ['social', /\b(social|community|brand awareness|linkedin|instagram|tiktok|youtube)\b/i, 'social', 'Engaged followers and inbound enquiries'],
];

export function heuristicIntake(title, brief, snapshot) {
  const text = `${title}\n${brief || ''}`;
  const goal = GOALS.find(([, re]) => re.test(text)) || ['strategy', null, 'strategy', 'Qualified conversions per week'];
  const host = snapshot?.host;
  const clean = String(title).replace(/^\s*(please\s+)?(go to|visit|open)\s+\S+\s+(and\s+)?/i, '').replace(/^make them\b/i, host ? `Make ${host}` : 'Make the client').trim();
  const money = text.match(/\$\s?([\d][\d,.]*)\s?(k|m)?/i);
  const target = text.match(/(\d[\d,.]*)\s*(%|x|leads?|enquiries|inquiries|signups?|sign-ups?|customers?|users?|demos?|meetings?)/i);
  const time = text.match(/(\d+)\s*(days?|weeks?|months?)/i) || (/\bquarter\b/i.test(text) ? [null, '90', 'days'] : null);
  const assumptions = []; const open = [];
  if (!money) { assumptions.push('No budget was given. Plan for owned and organic actions first, and size any paid test separately.'); open.push('What budget is available, if any, for paid media and tools?'); }
  if (!target) { assumptions.push(`No numeric target was given. Treat "${goal[3].toLowerCase()}" as the metric and use the first two weeks to set a baseline.`); open.push('What is the current baseline and the target you want to hit?'); }
  if (!time) assumptions.push('No deadline was given. Plan in a 90-day window with a two-week quick-win phase.');
  assumptions.push('We cannot log in to analytics, ad accounts, the CRM or the CMS, so deliverables are recommendations and ready-to-use assets for the client team to apply.');
  if (snapshot?.pages?.length) assumptions.push(`Site facts come from ${snapshot.pages.length} page(s) read on ${host}. Traffic, conversion and lead-quality figures are not visible from outside and are not assumed.`);
  else if (snapshot) assumptions.push(`The site could not be read (${snapshot.errors?.[0]?.error || 'unknown error'}), so nothing about it is verified.`);
  open.push('Who is the ideal customer, and how does a good lead differ from a bad one?');
  open.push('What does the sales team do with a lead today, and how fast?');
  return {
    objective: clean.charAt(0).toUpperCase() + clean.slice(1), goalType: goal[0], playbook: goal[2], metric: goal[3],
    target: target ? target[0] : 'Not specified', timeframe: time ? `${time[1]} ${time[2]}` : '90 days (assumed)',
    budget: money ? money[0] : 'Not specified', audience: host ? `Visitors to ${host} (to be confirmed in research)` : 'Not specified',
    constraints: [], assumptions, openQuestions: open.slice(0, 4), site: host || null,
  };
}

export function siteEvidence(snapshot) {
  const pages = snapshot.pages; const home = pages[0]; const out = [];
  out.push(`Pages read: ${pages.map((p) => new URL(p.url).pathname || '/').join(', ')}`);
  if (home.title) out.push(`Homepage title: "${home.title}"`);
  const h1 = home.headings.find((h) => h.level === 1); if (h1) out.push(`Homepage headline: "${h1.text}"`);
  if (home.ctas.length) out.push(`Homepage calls to action: ${home.ctas.slice(0, 5).map((c) => `"${c.text}"`).join(', ')}`);
  const forms = pages.flatMap((p) => p.forms.map((f) => ({ page: new URL(p.url).pathname, ...f })));
  out.push(forms.length ? `Forms found: ${forms.map((f) => `${f.page} (${f.fields} fields)`).join('; ')}` : 'Forms found: none on the pages read');
  out.push(`Tracking detected: ${[...new Set(pages.flatMap((p) => p.analytics))].join(', ') || 'none'}`);
  for (const f of siteFindings(snapshot).slice(0, 4)) out.push(f);
  return out;
}

export function heuristicProfile(snapshot, brief) {
  const pages = snapshot.pages; const home = pages[0];
  const heads = pages.flatMap((p) => p.headings.filter((h) => h.level <= 2).map((h) => h.text)).filter((v, i, a) => a.indexOf(v) === i).slice(0, 10);
  const contact = pages.flatMap((p) => p.links.filter((l) => l.kind)).map((l) => `${l.kind}: ${l.text}`).filter((v, i, a) => a.indexOf(v) === i).slice(0, 4);
  const forms = pages.flatMap((p) => p.forms.map((f) => `${new URL(p.url).pathname}: ${f.fields} fields${f.names.length ? ` (${f.names.join(', ')})` : ''}`));
  return `# Client profile: ${snapshot.host}

> Built from ${pages.length} page(s) actually read on ${snapshot.host}. The facts below come from the pages. SIMULATED mode did not interpret them with a model, so positioning is limited to what the site states.

## What the site says
- Title: ${home.title || '(none)'}
- Description: ${home.description || '(none)'}
${heads.map((h) => `- ${h}`).join('\n')}

## Conversion path
- Calls to action on the homepage: ${home.ctas.map((c) => `"${c.text}"`).join(', ') || 'none found'}
- Forms: ${forms.join('; ') || 'none found on the pages read'}
- Contact methods: ${contact.join('; ') || 'none visible'}

## Tracking detected
- ${[...new Set(pages.flatMap((p) => p.analytics))].join(', ') || 'None detected'}

## Automatic observations
${siteFindings(snapshot).map((f) => `- ${f}`).join('\n') || '- none'}

## Not verified from outside the company
- Traffic volume and sources, current conversion rate, lead quality, sales process and CRM, budget, ideal customer profile and competitors.${brief ? `\n\n## Brief\n${brief.slice(0, 600)}` : ''}`;
}


// ---------------------------------------------------------------- real conflicts between workstreams (simulated mode)
// These fire only when the two workstreams really are on the plan, because that is when the conflict is real.
export const ALIGN_RULES = [
  { id: 'hero-test', pair: ['nadia:cro', 'theo:copywriting'], issue: 'The hero rewrite and the CRO test both change the same part of the homepage, so shipping both at once would confound the result.', question: 'How do we ship the new hero and still learn what worked?',
    positions: ['I need a clean control to measure lift, so the new hero has to run as a variant against the current one, not replace it.', 'The current hero is weak and I would rather ship the rewrite site-wide, but I can supply two variants if a test is what you need.'],
    decision: 'Ship the rewrite as variant B against the current hero. Nadia owns the test design and the stopping rule, Theo delivers two variants first, and nothing else on the page changes during the test.' },
  { id: 'utm-standard', pair: ['camila:ads', 'dee:analytics'], issue: 'The paid plan and the analytics plan define lead sources and UTM naming differently.', question: 'Which naming and attribution convention does the whole team use?',
    positions: ['I need campaign names I can optimise on inside the ad platforms, and I would rather not rename them for reporting.', 'One convention, defined once, or lead sources will not reconcile in the CRM. I will publish the UTM sheet today.'],
    decision: 'Dee\'s UTM convention is the standard. Camila builds every campaign to it from day one, and Dee audits the first week of data for gaps.' },
  { id: 'seo-copy', pair: ['rafa:seo-audit', 'theo:copywriting'], issue: 'The SEO audit sets title and heading constraints that the new homepage copy may break.', question: 'Where does creative freedom end and keyword discipline begin?',
    positions: ['The H1 and title carry the target term. Everything else can move, but those two cannot.', 'I can keep the target term in the H1 and put the personality in the subhead and body.'],
    decision: 'Rafa\'s keyword list is fixed for the title and H1. Theo has full creative freedom everywhere else, and Rafa signs off the final headings.' },
  { id: 'budget-offer', pair: ['camila:ads', 'indigo:offers'], issue: 'The paid test assumes an offer that the offer workstream is still redefining.', question: 'Do we test the current offer or the new one?',
    positions: ['I need the offer locked before I build creative, or I burn budget testing something we will change.', 'The new offer is stronger but untested, so I would run the old one as the control.'],
    decision: 'Lock the new offer by Wednesday. Camila tests it against the old offer as a control with a capped budget, and Indigo owns the go or no-go call.' },
];

// ---------------------------------------------------------------- who joins the team, from the actual brief (simulated mode)
export const HIRE_ROLES = [
  { key: 'automotive', domain: 'automotive', role: 'Automotive Industry Strategist', dept: 'strategy', skills: ['customer-research', 'competitors', 'product-marketing', 'marketing-psychology'], re: /\b(automotive|automaker|oem|tier-?1|adas|infotainment|vehicle|mobility|software-defined|connected car|ev charging)\b/i,
    persona: 'Ex-industry, fluent in OEM procurement cycles, functional safety and programme timelines. Translates engineering buyers into marketing language without dumbing it down.', quirks: ['Who signs the RFQ, and who vetoes it?', 'Programme timelines are measured in years.', 'Engineers read the spec sheet before the headline.'],
    step: ['customer-research', 'Write the domain brief for this industry: how buyers evaluate and buy, the jargon they use, what they distrust, the regulations and standards that matter, and what a credible proof point looks like to them. Everyone else will write and plan from it.'] },
  { key: 'ecommerce', domain: 'ecommerce', role: 'E-commerce Growth Specialist', dept: 'growth', skills: ['cro', 'ads', 'emails', 'analytics'], re: /\b(shopify|e-?commerce|dtc|d2c|online store|cart|checkout|woocommerce)\b/i,
    persona: 'Lives in cart-abandonment data. Knows what a 2% add-to-cart rate means and what to do about it.', quirks: ['What is the AOV?', 'Free shipping thresholds move baskets.', 'Mobile checkout is where it dies.'],
    step: ['cro', 'Audit the store funnel from product page to paid order and list the three changes most likely to lift conversion.'] },
  { key: 'video', domain: 'video', role: 'Video Producer', dept: 'creative', skills: ['video', 'social', 'ad-creative', 'image'], re: /\b(video|youtube|reels|tiktok|shorts|explainer|film)\b/i,
    persona: 'Storyboards in the shower. Cuts for the first three seconds and the last five.', quirks: ['Hook, proof, ask.', 'Captions on, always.', 'Cut it again.'],
    step: ['video', 'Storyboard the three short videos most likely to travel, with hooks, shot lists and captions.'] },
  { key: 'events', domain: 'events', role: 'Events & Webinar Producer', dept: 'revenue', skills: ['events', 'co-marketing', 'public-relations', 'lead-magnets'], re: /\b(webinar|conference|trade ?show|expo|summit|event)\b/i,
    persona: 'Runs events like launches: the follow-up plan is written before the invitations go out.', quirks: ['Where do the leads go the day after?', 'A speaker is a distribution channel.'],
    step: ['events', 'Plan the event programme: format, speakers, promotion timeline and the lead follow-up sequence.'] },
  { key: 'localization', domain: 'localization', role: 'Localization Lead', dept: 'content', skills: ['copywriting', 'copy-editing', 'seo-audit', 'site-architecture'], re: /\b(multilingual|locali[sz]ation|translate|international|global markets|hreflang|languages)\b/i,
    persona: 'Knows that translation is the cheap part. Adapts offers, proof and search intent for each market.', quirks: ['Same words, different intent.', 'Currency and trust signals change by market.'],
    step: ['site-architecture', 'Plan the multi-market site structure: languages, URLs, hreflang and which pages need adaptation rather than translation.'] },
  { key: 'abm', domain: 'abm', role: 'Account-Based Marketing Lead', dept: 'revenue', skills: ['prospecting', 'cold-email', 'sales-enablement', 'revops'], re: /\b(abm|account-based|named accounts|enterprise accounts|target accounts)\b/i,
    persona: 'Treats ten accounts as ten markets. Sales and marketing share one list under this person.', quirks: ['Who is on the buying committee?', 'One-to-one beats one-to-many.'],
    step: ['prospecting', 'Define the target account list criteria, the buying committee map and the first-touch plan per tier.'] },
];

export function hireRulesFor(text, existingDomains = []) {
  const out = [];
  for (const r of HIRE_ROLES) if (r.re.test(text) && !existingDomains.includes(r.domain)) out.push(r);
  return out.slice(0, 2);
}

const FIRST = ['Amara', 'Bastian', 'Chiara', 'Dev', 'Elio', 'Farah', 'Gustavo', 'Hana', 'Ibrahim', 'Jun', 'Katya', 'Lena', 'Mateo', 'Noor', 'Omar', 'Petra', 'Quinn', 'Rohan', 'Sana', 'Tariq', 'Uma', 'Viktor', 'Wen', 'Ximena', 'Yusuf', 'Zoe', 'Anika', 'Bruno', 'Cleo', 'Dario'];
const LAST = ['Almeida', 'Brandt', 'Castellanos', 'Dubois', 'Eriksson', 'Fontaine', 'Gallagher', 'Hartmann', 'Ibarra', 'Jovanovic', 'Kowalski', 'Lindgren', 'Mbeki', 'Nakamura', 'Oyelaran', 'Paczek', 'Quispe', 'Rosales', 'Santoro', 'Tanaka', 'Uddin', 'Varga', 'Weiss', 'Xu', 'Yilmaz', 'Zielinski'];
const SKINS = ['#f2d2bd', '#e8c39e', '#d9a273', '#c68a63', '#a8714a', '#6b4423', '#4a2c17'];
const HAIRS = ['#0e0e12', '#3b2314', '#6b3f1d', '#8a5a2b', '#e5c07b', '#b91c1c', '#4b5563', '#7c3aed'];
export function randomLook(seedStr, shirt) {
  const h = Math.abs(hash(seedStr));
  return { skin: SKINS[h % SKINS.length], hair: HAIRS[(h >> 3) % HAIRS.length], hairStyle: (h >> 5) % 5, shirt, pants: ['#1f2937', '#27272a', '#334155', '#1e1b3a', '#3f3f46'][(h >> 7) % 5], extra: ['none', 'glasses', 'none', 'headband', 'none', 'tie'][(h >> 9) % 6] };
}
export function pickName(seedStr, taken = new Set()) {
  const h = Math.abs(hash(seedStr));
  for (let i = 0; i < 60; i++) { const first = FIRST[(h + i * 7) % FIRST.length]; if (!taken.has(first.toLowerCase())) return { first, last: LAST[(h >> 4 + i) % LAST.length] || LAST[0] }; }
  return { first: `Hire${h % 100}`, last: LAST[h % LAST.length] };
}
