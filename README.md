# aeda os worker

the always-on spine for aeda operations. this standalone node.js + typescript service handles job scheduling, llm api calls with cost tracking, execution packages with state machine, and nightly backups.

## architecture

- **job scheduling**: agenda (mongodb-backed)
- **llm calls**: anthropic api via modelRouter with budget enforcement
- **state machine**: execution packages with formal approval workflow
- **storage**: mongodb atlas (shared with aeda workspace), cloudflare r2 for backups
- **deployment**: railway (auto-deploy on push to main)

## standing constraints

**do not create `middleware.ts`** anywhere in this codebase.

**do not run `npm run dev`** or any local dev server. verification is via:
- `npm run build` - compile typescript
- `npm run smoke` - run smoke test against atlas
- `npx tsx scripts/<script>.ts` - run individual scripts

## required environment variables

| variable | description |
|----------|-------------|
| `MONGODB_URI` | mongodb atlas connection string (shared with aeda workspace) |
| `ANTHROPIC_API_KEY` | anthropic api key for llm calls |
| `R2_ENDPOINT` | cloudflare r2 endpoint url |
| `R2_ACCESS_KEY_ID` | r2 access key id |
| `R2_SECRET_ACCESS_KEY` | r2 secret access key |
| `R2_BUCKET` | r2 bucket name for backups |
| `LOG_LEVEL` | (optional) log level: trace, debug, info, warn, error, fatal. default: info |
| `PORT` | (optional) http server port for webhooks. default: 3000 |
| `WEBHOOK_SECRET` | (optional) shared secret for webhook authentication |
| `GMAIL_CLIENT_ID` | (optional) google oauth2 client id for gmail api |
| `GMAIL_CLIENT_SECRET` | (optional) google oauth2 client secret |
| `GMAIL_REFRESH_TOKEN` | (optional) gmail refresh token for artur@aedawallet.com |

## deployment (railway)

1. connect the github repo to railway
2. set all required environment variables in railway dashboard
3. railway auto-deploys on push to main
4. the worker starts automatically and registers scheduled jobs

## scheduled jobs

| job | schedule | description |
|-----|----------|-------------|
| `heartbeat.lilitStandup` | 07:00 europe/prague daily | morning standup summary from lilit |
| `system.nightlyBackup` | 03:00 europe/prague daily | backup all collections to r2 |
| `system.costRollup` | 03:30 europe/prague daily | aggregate yesterday's costs |
| `process-inbound-email` | on-demand (webhook triggered) | process inbound email, classify, route, draft reply |

## configuration

### approval matrix

edit `src/config/approvalMatrix.json` to change required signers and veto holders for each package type. changes take effect on next deployment.

```json
{
  "external_comms": { "requiredSigners": ["tatev", "narek"], "vetoHolders": ["narek", "vagho"] },
  "product_feature": { "requiredSigners": ["laura", "hamazasp"], "vetoHolders": ["narek", "vagho"] },
  ...
}
```

### budgets

budgets are stored in the `os_budgets` collection. to modify:

```javascript
// in mongodb shell
db.os_budgets.updateOne(
  { scope: "global", key: "global" },
  { $set: { monthlyCapUsd: 100, warnAtPct: 80 } }
)
```

## running the smoke test

```bash
# ensure env vars are set (or use .env file with dotenv)
npx tsx scripts/smoke.ts
```

the smoke test:
1. creates and transitions execution packages
2. verifies illegal transitions are blocked
3. makes an llm call and verifies cost tracking
4. tests budget blocking
5. tests memory write and supersede
6. cleans up all test documents
7. prints total cost

## backup restore procedure

1. find the backup date in r2: `backups/YYYY-MM-DD/`

2. run the restore script:
```bash
npx tsx scripts/restore.ts <collection-name> <backup-date>
# example: npx tsx scripts/restore.ts os_audit_log 2024-01-15
```

3. the script restores to `restored_<collection-name>` (never overwrites live data)

4. inspect the restored collection:
```javascript
db.restored_os_audit_log.find().limit(10)
```

5. if satisfied, rename to replace the original:
```javascript
db.restored_os_audit_log.renameCollection("os_audit_log", {dropTarget: true})
```

## collections

| collection | description | append-only |
|------------|-------------|-------------|
| `os_audit_log` | all system events | yes |
| `os_execution_packages` | execution package state machine | no (state transitions allowed) |
| `os_cost_ledger` | per-call llm costs | yes |
| `os_budgets` | budget caps and warnings | no |
| `os_memory` | versioned memory entries | yes (supersede creates new doc) |
| `os_cost_daily` | daily cost rollups | no (derived data) |
| `os_founder_inbox` | notifications for founder | no |
| `os_agenda_jobs` | agenda job state | no (managed by agenda) |
| `os_inbox_items` | inbound emails processed | yes |
| `os_email_drafts` | agent-generated draft replies | no (status transitions allowed) |
| `investor_pipeline` | crm for investor tracking | no |

## development

```bash
# install dependencies
npm install

# build
npm run build

# type check without building
npm run typecheck
```

## hasmik weekly intelligence job

the `hasmik.weeklyIntelligence` job runs Monday 19:00 Prague. it researches domains and writes entries to the `knowledges` collection.

### agentScope array pattern

`agentScope` accepts `string | string[]`. when multiple agents need the same professional entry (e.g., @narek and @cnb both need regulation intel), use the array pattern:

```typescript
agentScope: ['narek', 'cnb']  // both agents receive the entry
```

this avoids duplicate research passes. the entry is written once with:
- `targetAgent`: first element (`narek`)
- `relevantAgents`: full array (`['narek', 'cnb']`)

the Tier 3 query in `getKnowledgeFeed` checks both fields, so secondary agents also receive shared entries.

**when to use**: any time a new Phase 2 agent shares a domain with an existing agent. add them to the array, don't duplicate the research prompt.

## model tiers

| tier | primary model | fallback |
|------|--------------|----------|
| frontier | claude-opus-4-7 | claude-sonnet-4-6 |
| production | claude-sonnet-4-6 | claude-sonnet-4-6 |
| background | claude-haiku-4-5-20251001 | claude-sonnet-4-6 |

all llm calls go through `modelRouter.routedCall()` which enforces budget limits via `budgetGuard`.

## brand rules

- always use lowercase "aeda" (never "Aeda" or "AEDA")
- aeda is a technology network - never describe as CASP, VASP, EMI, or payment processor

## slice 2: email bridge setup

### gmail api setup

1. create oauth2 credentials in google cloud console
2. enable the gmail api
3. generate refresh token:
```bash
GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=yyy node scripts/get-gmail-token.js
```
4. add `GMAIL_REFRESH_TOKEN` to railway env vars
5. create a label "Pending Send" in artur@aedawallet.com gmail

### cloudflare email worker

see `cloudflare-worker/README.md` for deployment instructions.

the worker is deployed manually via cloudflare dashboard, not via CI.

### webhook endpoint

POST `/webhook/inbound-email` receives emails from cloudflare worker.

requires `X-Webhook-Secret` header matching `WEBHOOK_SECRET` env var.

### email processing flow

1. cloudflare worker receives email at artur@aeda.am
2. forwards to artur@aedawallet.com AND posts to railway webhook
3. webhook creates inbox item and queues processing job
4. @artur classifies email and decides routing
5. @lilit creates task
6. assigned agent drafts reply (if needed)
7. draft pushed to gmail with "Pending Send" label
