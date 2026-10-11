// The simulator: stands in for Claude when no API key is configured.
// It is deliberately honest — every deliverable is stamped SIMULATED, and the
// structure it produces comes from the real skill files, not from thin air.

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
    words: ['sales', 'outbound', 'cold', 'b2b', 'prospect', 'leads', 'lead gen', 'pipeline', 'enablement', 'deck', 'revops', 'crm', 'abm'],
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

export function planFromPlaybooks(title, brief, maxSteps = 7) {
  const text = `${title} ${brief}`.toLowerCase();
  const words = new Set(text.match(/[a-z0-9][a-z0-9/-]*/g) || []);
  const scored = Object.entries(PLAYBOOKS).map(([key, pb]) => {
    let s = 0;
    for (const w of pb.words) if (w.includes(' ') ? text.includes(w) : words.has(w)) s += w.length > 4 ? 2 : 1;
    return { key, s };
  }).sort((a, b) => b.s - a.s);
  const chosen = scored[0].s > 0 ? [scored[0].key] : [FALLBACK];
  if (scored[1] && scored[1].s > 0 && scored[1].s >= scored[0].s * 0.6) chosen.push(scored[1].key);

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
      const plan = planFromPlaybooks(ctx.title, ctx.brief);
      return { text: JSON.stringify(plan), latencyMs: 2500 };
    }
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
      const rs = [
        'Strong spine. Tighten the opening and make the metric explicit. Approved with notes.',
        'Good, and shippable. I would pull the second recommendation forward. Approved.',
        'Clear and specific. Needs one more proof point before it goes to the client. Approved with notes.',
        'This is the right direction. Trim the assumptions and it is done. Approved.',
      ];
      return { text: pick(rs, seed), latencyMs: 900 };
    }
    case 'synth': {
      const parts = (ctx.outputs || []).map((o) => `- **${o.agentName}** (${o.skill}): ${o.headline}`).join('\n');
      const text = `# Executive summary: ${topicOf(ctx)}\n\n> SIMULATED OUTPUT. Add an Anthropic API key and switch to Live for real analysis.\n\n## The call\nRun this as one coordinated push. Research first, offer second, copy and channels third, measurement alongside all of it.\n\n## What the team produced\n${parts}\n\n## Decisions for God\n1. Approve the offer and positioning direction.\n2. Choose the single north-star metric (our pick: qualified conversions per week).\n3. Release budget for the first two-week test.\n\n## Next 7 days\n- Day 1-2: lock research and offer.\n- Day 3-4: copy and creative to draft.\n- Day 5: measurement live, QA.\n- Day 6-7: soft launch to 10% of traffic and review.\n\n## How we'll know it worked\nA 20% lift in qualified conversions against the 4-week baseline, with CAC at or below target.`;
      return { text, latencyMs: 3500 };
    }
    case 'work':
    default: {
      const { agent, skill, instruction } = ctx;
      const topic = topicOf(ctx);
      const acts = (BANK[skill?.name] || ['Define the objective, pick one metric, and ship a small test this week.', 'Document what you learn so the next brief starts smarter.'])
        .map((a) => a.replaceAll('{topic}', topic));
      const heads = skill ? headingsOf(skill.body, 5) : [];
      const prior = (ctx.priorOutputs || []).slice(0, 3);
      const assumptions = [
        `The brief is the source of truth: "${(ctx.brief || '').slice(0, 110).replace(/\s+/g, ' ')}${(ctx.brief || '').length > 110 ? '...' : ''}"`,
        'Budget, timing and brand constraints are as stated; anything missing is flagged below.',
        prior.length ? `Builds on the work of ${prior.map((p) => p.agentShort).join(', ')}` : 'No upstream work yet; this is the first pass.',
      ];
      const text = `# ${skill?.title || 'Deliverable'}: ${topic}

> SIMULATED OUTPUT (${agent.name}, ${agent.role}). Structure follows the \`${skill?.name}\` skill. Switch to Live mode for real, brief-specific work.

**Task:** ${instruction}

## Assumptions
${bullet(assumptions)}

## Framework this skill applies
${heads.length ? bullet(heads.map((h) => `${h}`)) : '- (framework from the skill library)'}

## Recommendations
${acts.map((a, i) => `${i + 1}. ${a}`).join('\n')}

## Next actions
${bullet([`${agent.short}: finalise the first draft within 2 days.`, 'Theo: copy pass once the direction is approved.', 'Dee: confirm tracking is in place before anything goes live.'])}

## How we'll know it worked
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
