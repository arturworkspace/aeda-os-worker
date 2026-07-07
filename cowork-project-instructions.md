# aeda OS — Project Instructions
Last updated: July 6, 2026 — Slices 1–5B live, Slice 6 active, Slice 7 (Outreach Sequencer) scoped, pending build

## Two Codebases

| | aeda-workspace | aeda-os-worker |
|--|--|--|
| Type | Next.js UI layer | Background job engine |
| Stack | Next.js App Router, TypeScript, Tailwind, MongoDB, Anthropic API | Node.js, TypeScript, Agenda.js, Express, MongoDB |
| Deploy | Vercel | Railway |
| URL | https://aeda-workspace.vercel.app | https://splendid-liberation-production-57ef.up.railway.app |
| Local | ~/Documents/Aeda Docs/Aedaworkspace/aeda-workspace | ~/Documents/Aeda Docs/Aedaworkspace/aeda-os-worker |
| GitHub | — | arturworkspace/aeda-os-worker |

Both share: MongoDB Atlas, database = aeda-workspace

## Hard Rules — Never Break
- NEVER create middleware.ts — fatal Vercel build error
- NEVER run npm run dev — Mac 8GB RAM, crashes
- Worker imports: always use .js extension (ESM)
- Models: claude-sonnet-4-6 (agents) | claude-haiku-4-5-20251001 (background/classification)
- Workspace deploy: vercel --prod
- Worker deploy: railway up --service splendid-liberation (run from aeda-os-worker/ directory; git push does NOT trigger auto-deploy on this project — confirmed 2026-07-07)
- Auth: HTTP-only cookie "aeda-session" — never expose

## Authentication
Single user: artur@aedawallet.com
Session: aeda-session (HTTP-only cookie)
Env vars in Vercel: ADMIN_EMAIL, ADMIN_PASSWORD
robots.txt blocks all crawlers, noindex on all pages

## Environment Variables

### Vercel (workspace)
ANTHROPIC_API_KEY, MONGODB_URI, ADMIN_EMAIL, ADMIN_PASSWORD,
OS_WORKER_URL=https://splendid-liberation-production-57ef.up.railway.app

### Railway (worker)
ANTHROPIC_API_KEY, MONGODB_URI, TZ=Europe/Prague, LOG_LEVEL=info,
R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN

Note: current scope is drafts.create only (Slice 2/3 pattern). Slice 7 (Outreach Sequencer) adds read-only threads.get for reply detection — new scope, pending @vagho sign-off before implementation. No send-scope planned; sends remain human-triggered from Gmail directly.

## Agent Roster — 20 Agents

Identity lives in `src/lib/agents.ts` (id, name, handle, role, department, color, reportsTo, greeting). System prompts live separately in `src/prompts/`, one file per agent, routed through `src/prompts/index.ts`'s `AGENT_PROMPTS` map, combined with a shared context block via `getSystemPrompt()`.

| ID | Name | Role | Reports To | Notes |
|----|------|------|-----------|-------|
| artur | Artur Kartshikyan | CEO & Founder | self | Digital duplicate. Does not respond in rooms — real Artur posts. |
| hamazasp | Hamazasp Avetisyan | CTO & Co-Founder | artur | |
| arshak | Arshak Varzhapetyan | CFO & Co-Founder | artur | |
| alex | Alex | COO | artur | |
| tatev | Tatevik Simonyan | CCO/CMO | artur | |
| laura | Laura | CPO | artur | |
| narek | Narek | CLO | artur | **Hard veto** |
| chris | Chris | Strategic Advisor | artur | |
| anna | Anna | AI Workspace Advisor | artur | |
| vagho | Vagho | Security Officer | artur | **Hard veto** |
| mike | Mike Vardanyan | Product Designer | tatev | |
| ruzan | Ruzan | Copywriter | tatev | |
| sofi | Sofi | SMM Specialist | tatev | |
| syuzi | Syuzi | Payments, Settlement & Fee Specialist | arshak | Corrected this session — was previously misassigned to artur |
| lilit | Lilit | Project Manager / Orchestrator | artur | Converts decisions into tasks with owners/deadlines |
| karo | Karo | QA Specialist | hamazasp | Mandatory sign-off per slice, coordinates with lilit/laura/narek/mike |
| hasmik | Hasmik | Research & Intelligence | artur | Background job only — not a chat agent. Agent ID in `agents.ts` may be `"trainer"`; unconfirmed — verify before touching. |
| julia | Julia | Senior Fundraising & IR | artur | Added this session. Color `#CA8A04`. Owns outreach sequences (Slice 7). |
| ofelya | Ofelya | Brand/UX/Marketing/SEO Auditor | artur | Added this session. Color `#A21CAF`. Independent — audits tatev/mike/sofi/ruzan, does not create. |
| cnb | @cnb | Internal Regulatory Challenger | artur | Added this session. Color `#7F1D1D`. Adversarial to narek by design — stress-tests compliance positions. |

None of julia/ofelya/cnb hold hard-veto status — that stays with narek and vagho only.

**Unconfirmed:** exact hex colors for syuzi, lilit, karo, hasmik have not been directly verified against `agents.ts` this session — confirm before relying on them for UI work.

### Governance
- Only @artur and @lilit create tasks
- @vagho security review mandatory per slice
- @anna acceptance test mandatory per slice
- @karo QA mandatory per slice
- @narek and @vagho hold hard veto — no slice closes over their objection
- Agents must issue formal governance warnings even when Artur contradicts rules
- Governing principle: "Autonomous preparation, human-authorized execution" — no agent touches keys/funds/transfers or auto-sends investor/marketing communications without a human action to trigger send

## 6 Discussion Rooms

Artur is confirmed absent from every room's agent array — he posts, agents respond.

1. Fundraising — Close $500K pre-seed. Members: all non-artur agents including julia.
2. Marketing — Brand, content, launch
3. Legal — T&C, MiCA, GDPR, contracts
4. Product — App, UX, specs. Members include julia (added this session — her coordination touches product timing).
5. Board Room — Strategy, OKRs, decisions
6. Training — Knowledge sharing, research briefs, team learning. Added this session. Members: all 19 non-artur agents.

## Brand Rules
- aeda always lowercase — never "AEDA"
- aeda = technology network — never CASP/VASP/EMI/payment processor
- Colors: True Blue #0275FE | Cashless Green #1CFEBA | Very Black #020617
- Font: Inter (product) | League Spartan (logo only)
- UI: light mode, dark sidebar (#020617), white content area

## Features Built — Live in Production

### Core Workspace
Team Dashboard, Org Chart, Task Board (kanban),
Projects, Agent Pages (streaming chat + file upload + email paste),
Discussion Rooms (multi-agent), Financial Dashboard,
Expense Tracker, Investor Pipeline CRM, Broadcast,
Global Search (Cmd+K), Notifications, File Upload

### aeda OS Layer (Slices 1–5B)

Slice 1 — os-worker spine on Railway: MongoDB collections,
Agenda.js jobs, audit log, $5/mo budget cap

Slice 2 — Email bridge: artur@aeda.am →
Cloudflare Email Worker → Railway webhook → Gmail drafts.
@mention routing, trusted sender allowlist,
8,000-char truncation, rate limiting

Slice 3 — Founder Surfaces: Inbox tab on agent pages,
os_inbox_items/os_email_drafts, dismiss/bulk-delete, 30s polling

Slice 4 — Gmail API attachment extraction (docx/PDF);
Agent Costs dashboard at /os-dashboard;
agent commentary and draft text in inbox UI

Slice 5A — Knowledge Base at /knowledge:
- Verification gate (Claude Haiku): confirmed/unverifiable/contradicted/opinion
- 3 input modes: URL fetch, PDF/file upload, manual text
- Source URL displayed on every card (clickable link)
- Org scope (shared by role) + Professional scope (one agent)
- Trust levels: verified / informational / signal
- Contradiction detection — blocks false info permanently
- Context injection via getKnowledgeFeed() into every agent chat (3 tiers: permanent org facts + org intelligence + professional)
- Filter tabs: All | Permanent | Temporary | Regulation | Technology | Market | Competitor | Stablecoin Apps | Remittance | Partner | Education | LinkedIn Insights | General
- "Run @hasmik now" button with live progress panel (3 phases)
- API proxy at /api/os/trigger-hasmik → Railway worker

Slice 5B — @hasmik weekly Agenda.js job (Monday 19:00 Prague):
Phase 1 — 7 org domains (regulation, technology, product, market, competitor, partner, influencer)
Phase 2 — 12 agent professional domains
Phase 3 — Fundraising intelligence (raises + opportunities)
Two-step LLM: Sonnet+web_search research → Haiku JSON structure
~$0.55/run, ~$2.20/month, hard-capped at $5/month

Fundraising Intel — /fundraising-intel page:
- Tab 1: Raises This Week (filter by round type) — Company + amount + investors — "+ Add to Pipeline" pushes investor to /investors CRM
- Tab 2: Open Opportunities (accelerators, grants, programs) — aeda eligibility assessment — Apply / Mark Applied / Dismiss actions

## Slice 6 — Vault & Document Intelligence (Active, not yet complete)

- `vaultdocuments` MongoDB collection exists; no UI built yet
- Goal: upload NDAs, term sheets, investor decks, signed contracts
- Vault mental model: final/signed documents only — not working drafts. Work happens in tasks/agent chats; a future "Save to Vault" button on task completion will bridge the two
- Architecture defined: three-tab UI (Documents / Templates / Standards), Claude-native PDF extraction (replacing pdf-parse), agent review routing (@narek + @vagho annotate)
- R2 storage temporarily bypassed — documents save to MongoDB only; `r2Key` field is optional (`required: false`)
- **Open pre-condition (@narek):** Anthropic DPA must be confirmed to cover third-party confidential document text before real counterparty NDAs are uploaded
- **@vagho open items:** P1 R2 write token fix, P2 filename sanitization, P4 Anthropic DPA
- **@karo open items:** four manual verifications outstanding (standard approval flow, agent injection end-to-end)
- Sidebar structure: INTELLIGENCE (Knowledge, OS Dashboard) / FUNDRAISING (Investors, Intel, Room) / WORK / ROOMS / COMPANY (Vault, Expenses, Finance) / AGENTS

## Slice 7 — Investor Outreach Sequencer (Scoped, not yet built)

- Goal: run @julia's pre-approved 4-email cadence (Day 1 → 4 → 9 → 14, narek-approved content) against a selected investor list from one place, with CRM-style status per investor
- Decision this session: draft-preparation is automated, send is human-triggered from Gmail directly (Option 1) — no in-app send button, no gmail.send scope
- New collection planned: `os_outreach_sequences` — sequenceId, investorId, currentStep (1–4), stepDueDates, draftIds, repliedAt, status (active/stopped/completed)
- New Agenda.js job planned: `outreach.processSequences` — daily, checks due steps, polls Gmail thread via read-only `threads.get`, Haiku-classifies reply vs auto-reply/bounce, generates next draft via @julia (Sonnet) if no genuine reply, pushes to `os_email_drafts`
- **Blocked on:** @vagho review of the new read-only Gmail scope before implementation starts
- Manual "Mark Replied" fallback considered sufficient below ~25–30 concurrent sequences (per @chris); revisit automated reply-detection threshold if list grows past that

## Knowledge Base — @hasmik Weekly Scan

### Org Intelligence Domains
| Domain | Category | Key Sources |
|--------|----------|-------------|
| regulation | regulation | EBA, ESMA, EC, ECB, CNB, CBA + SEC, CFTC, FinCEN, OCC, Fed, CFPB + FATF, Moneyval + 7 media |
| technology | technology | Solana, Anthropic, Railway, Vercel, NestJS, Flutter, MongoDB, Helius, Cloudflare |
| product | technology | Circle, Bridge, Sumsub, Privy, Dynamic, Transak, Ramp, Phantom, Crossmint |
| market | market | EU pre-seed VC signals, EECA corridor deals, Crunchbase, Sifted |
| competitor | competitor | Stablecoin Apps (11) + Remittance (8) |
| partner | partner | Bridge.xyz, Sky Labs, Sumsub, Circle |
| influencer | education | 30 thought leaders via newsletters/blogs |

### Competitor Taxonomy
Stablecoin Apps (tag: stablecoin-app): Rizon, Sling Money, Zixi Pay, Parsek, PEXX, Dollarize, DolarApp, Stables, Bmoni, Payy, Sentz

Remittance (tag: remittance): Wise (exited Armenia 2024 — flag if returns), Revolut, Swift, Visa, Mastercard, Remitly, MoneyGram, Western Union

### Regulatory Monitoring Tiers
Tier 1A EU: EBA, ESMA, European Commission, ECB, CNB (Czech), CBA (Armenia)
Tier 1B USA: SEC, CFTC, FinCEN, OCC, Federal Reserve, CFPB
Tier 2 AML: FATF, Moneyval
Tier 3 Media: The Paypers, Finextra, CoinDesk Policy, DL News, Circle Policy Hub, Fireblocks Blog, Chainalysis Blog

### Influencer Monitoring (30 thought leaders)
Monitored via newsletters/blogs (not LinkedIn direct):
Marcel van Oost, Arthur Bedel, Simon Taylor, Nic Carter, Nathan Sexer, Jeremy Allaire, Linas Beliunas, Alex Johnson, Patrick McKenzie, Lex Sokolin, Ron Shevlin, Jason Mikula, Richard Turrin, Theodora Lau, Jake Chervinsky, Caitlin Long, David Birch, Chris Skinner, Ghela Boskovich, Anne Boden, Spiros Margaris, Efi Pylarinou, Brett King, Matt Harris, Adrienne Harris, Karen Webster, Jason Henrichs, David Parker, Leda Glyptis, Miranda Steinhauser

## Scheduled Jobs (Railway, TZ=Europe/Prague)

| Job | Schedule | Description |
|-----|----------|--------------|
| heartbeat.lilitStandup | Daily 07:00 | Morning standup |
| system.nightlyBackup | Daily 03:00 | R2 backup |
| system.costRollup | Daily 03:30 | Cost aggregation |
| processInboundEmail | On-demand | Email processing |
| hasmik.weeklyIntelligence | Monday 19:00 Prague | Full intelligence scan (3 phases) — confirmed against `hasmik.weeklyIntelligence.ts` line 563 |
| outreach.processSequences | Daily (planned) | Slice 7 — not yet implemented |

Manual trigger: POST /jobs/hasmik-intelligence/trigger on Railway
Or via workspace: /knowledge → Intelligence tab → "Run @hasmik now"

## MongoDB Collections (aeda-workspace database)

| Collection | Purpose |
|-----------|---------|
| knowledges | Knowledge base (verified brain) |
| fundraisingrounds | Weekly fintech raises |
| fundingopportunities | Open accelerators/grants |
| os_inbox_items | Agent inbox |
| os_email_drafts | Email draft responses |
| os_audit_log | All agent actions |
| os_cost_ledger | Per-call API cost tracking |
| os_agenda_jobs | Agenda.js scheduler |
| agents | Agent profiles — **note:** four orphaned documents exist here from a failed sync attempt; app reads agents from code, not this collection. Harmless but inaccurate if queried directly. Cleanup: one `deleteMany` call, still pending. |
| tasks | Task board |
| projects | Project management |
| investors | Investor pipeline CRM |
| expenses | Expense tracker |
| vaultdocuments | Vault (full documents) |
| os_outreach_sequences | Slice 7 — planned, not yet created |

## Knowledge Base Architecture

### Classification (3-axis)
Permanence: permanent (never expires) | temporary (7–90 days)
Category: regulation / technology / market / competitor / partner / education / general
Sub-category (competitor only, via tags): stablecoin-app | remittance

### Trust Levels
verified → injected as fact (official .gov/.eu sources)
informational → injected with [Context — not authoritative:] prefix
signal → inbox-only if Low confidence; injected if High confidence

### Verification Statuses
pending | confirmed | unverifiable | contradicted | opinion
Contradicted entries: NEVER injected into any agent context

### getKnowledgeFeed() injection tiers
Tier 1: Permanent org knowledge (always injected)
Tier 2: Temporary org intelligence (active + not expired, not contradicted)
Tier 3: Professional knowledge (targeted to specific agent only)

## Key Business Context

Company: VanCoin LLC, IČO 21204161, Prague, Czech Republic
Product: aedawallet.com — non-custodial EURC wallet, EUR→AMD
Stage: Pre-seed, raising $500K at $5M pre-money
Equity: Artur 80% | Arshak 10% | Ham 10%
App stack: NestJS + Flutter + Solana + MongoDB + AWS
Partners: Bridge.xyz (EU on-ramp) | Sky Labs (Armenia) | Sumsub (KYC)
Ground truth: Wise exited Armenia corridor 2024, has not returned

**Financials flagged stale:** Burn $31K/mo, Cash $107K, Runway 3.4mo, and the Y0–Y5 revenue curve are all sourced to Model v9 as of May 10, 2026. Not refreshed this session. Confirm current figures with @arshak before using them in any investor-facing material — this was explicitly flagged during Slice 7 scoping and is still open.

## Known Backlog (non-critical)
- Duplicate key error on inbox write — non-blocking
- Gmail attachment PDF extraction via Gmail API direct (Cloudflare 200KB CPU limit prevents raw email PDF parsing)
- `resetBrokenScores` script — fix ~100 old Hasmik entries stuck at `score=3` from the pre-fix broken JSON parser
- Orphaned `agents` collection documents (see MongoDB Collections table above)

## On the Horizon (not started)
- "Save to Vault" button on task completion — bridges agent work → Vault
- Wiki (internal processes) — deferred to post-funding
- Gmail API attachment extraction slice (see Known Backlog)
- @hasmik agent-ID verification (`"trainer"` vs `"hasmik"` in `agents.ts`) before any implementation touching it
- Full narek/vagho system-prompt sync against their skill files — agreed to require explicit review before writing, given hard-veto status; not yet actioned

## How to Work on This Project
1. Identify which repo: workspace or worker
2. Always specify which files to edit with exact paths
3. TypeScript check before worker deploy: npx tsc --noEmit
4. Workspace deploy: vercel --prod
5. Worker deploy: railway up --service splendid-liberation (from aeda-os-worker/; git push alone does not deploy — Railway has no active GitHub auto-deploy hook on this service)
6. Never run npm run dev
7. Never create middleware.ts
8. Test at https://aeda-workspace.vercel.app after every deploy
