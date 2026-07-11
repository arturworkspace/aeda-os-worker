---
name: aeda-os-worker-conventions
description: Hard constraints and gotchas for the aeda-os-worker repo. Reference this before making changes to avoid repeating solved mistakes.
---

# aeda-os-worker Conventions

This skill documents non-negotiable constraints and known gotchas specific to the aeda-os-worker repository (TypeScript worker service deployed on Railway).

## Overview

aeda-os-worker is a background job processor that runs scheduled and event-driven tasks for the aeda AI Network Space. It handles agent jobs (Hasmik research, Julia email drafting), cron tasks, and API integrations (Anthropic, Gmail, Perplexity).

- **Runtime**: Node.js with ESM modules (`"type": "module"` in package.json)
- **Deployment**: Railway (auto-deploy on push to main)
- **Database**: MongoDB Atlas (shared with aeda-workspace)
- **LLM**: Anthropic Claude API (Sonnet for research, Haiku for classification)

## Hard Constraints

### All imports must use .js extension

This is an ESM project. Every relative import MUST include the `.js` extension, even when the source file is `.ts`:

```typescript
// CORRECT
import { getDb } from './db.js';
import { runAgentLoop } from '../lib/agentLoop.js';

// WRONG — will fail at runtime
import { getDb } from './db';
import { runAgentLoop } from '../lib/agentLoop';
```

The TypeScript compiler outputs `.js` files, and Node.js ESM resolution requires explicit extensions.

### TypeScript check before any deploy

Before pushing to main or manual Railway deploy:
```bash
npx tsc --noEmit
```

Railway builds will fail on type errors, but catching them locally is faster.

### Never create middleware.ts

This constraint applies to both repos. No middleware.ts file — it breaks the build.

### Deploy is git push (Railway auto-deploy)

Railway auto-deploys on push to main. There is no manual deploy command like Vercel's `vercel --prod`. If you need to force a redeploy without code changes, use the Railway dashboard.

## Known Gotchas

### Gmail RFC 2822 headers required for threading

When creating Gmail drafts that are replies (follow-ups), these headers are mandatory for proper threading:
- `From:` — RFC 2822 format
- `Date:` — RFC 2822 format
- `In-Reply-To:` — the original message's Message-ID
- `References:` — chain of Message-IDs
- `Content-Transfer-Encoding: 8bit` — required for UTF-8 body

Missing any of these causes Gmail desktop client to fail to render the message body in conversation view.

### Context management requires beta header

When using Anthropic's `context_management.edits` feature:
- Call `client.beta.messages.create()`, not `client.messages.create()`
- Include `betas: ['context-management-2025-06-27']` in the request
- The response includes `context_management.applied_edits` with cleared token counts

### Prompt caching with cacheSystemPrompt

The `agentLoop` supports system prompt caching via `cacheSystemPrompt: true`. When enabled:
- System prompt is wrapped in a content block with `cache_control: { type: "ephemeral" }`
- Track `cacheCreationTokens` and `cacheReadTokens` in the result
- Cache hits are logged — watch for `cacheReadTokens > 0` to confirm it's working

### Budget guards are daily, not monthly

Cost tracking in budget guards resets daily (configurable via `DAILY_BUDGET_RESET_HOUR` env var), not monthly. The `$5/month` cap mentioned in commits is actually `$5/day` in the code.

### Cache tokens are NOT double-subtracted

Anthropic's `input_tokens` field already excludes cache tokens — do not subtract `cache_read_input_tokens` again. This was fixed after incorrect double-subtraction caused budget guard inaccuracy.

### Placeholder validation before draft save

Email drafts with unresolved placeholders like `[First Name]` or `[Company]` must be caught BEFORE saving to MongoDB. The validation happens in the drafting job, and errors surface in Julia's Inbox with `processing_status: 'blocked'`.

### exactOptionalPropertyTypes in tsconfig

This project has `exactOptionalPropertyTypes: true`. You cannot assign `undefined` to optional properties via ternary:

```typescript
// WRONG — fails with exactOptionalPropertyTypes
return {
  contextEditsApplied: edits.length > 0 ? edits : undefined,
};

// CORRECT — conditionally add the property
const result: LoopResult = { finalResponse, iterations, ... };
if (edits.length > 0) {
  result.contextEditsApplied = edits;
}
return result;
```

### InboxItem processing_status enum

Valid values for `processing_status` on InboxItem documents: `'received'`, `'processing'`, `'draft_created'`, `'error'`, `'blocked'`. The `'blocked'` status was added for placeholder validation failures (commit f7f2f65).

### Reply detection uses firstEmailSentAt, not emailThreadId

When detecting if an investor has replied, query by `firstEmailSentAt` existence (confirms we sent the first email), not `emailThreadId` (which may not be populated).

## Before You Deploy

- [ ] `npx tsc --noEmit` passes with no errors
- [ ] All imports use `.js` extension
- [ ] No `.env` files staged for commit
- [ ] Budget/cost changes tested with correct daily reset logic
- [ ] Gmail drafts include all RFC 2822 headers if threaded
- [ ] Push to main triggers Railway auto-deploy — verify in Railway dashboard
