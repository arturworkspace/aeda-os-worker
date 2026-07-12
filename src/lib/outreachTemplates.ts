// Fixed, founder-approved investor-outreach follow-up templates rendered deterministically —
// no LLM call. Follow-up 1 and Follow-up 2 are 100% fixed text with a single variable
// (the greeting name), so generating them with Sonnet on every run was pure latency/cost
// overhead with zero benefit (and non-zero drift risk — see @ham's code review of commit
// 429a326 and the founder's "արագացնենք համակարգը" request). The cold email keeps a light
// LLM step (see investorResearch.ts) because it has a real personalization decision
// (firm-name clause present/absent); these two do not.

import { sanitizeForPrompt } from './promptSafety.js';

export const JULIA_SIGNATURE = `Best,
Julia Maklakova
Fundraising Manager`;

/** Best-effort extraction of a safe first name from investor.name for the email greeting.
 * Falls back to null (renders as plain "Hi,") for anything that doesn't look like a normal
 * personal first token — mirrors what the LLM was previously instructed to do. */
export function extractFirstName(fullName?: string | null): string | null {
  if (!fullName) return null;
  const trimmed = sanitizeForPrompt(fullName, 200).trim();
  if (!trimmed || /^unknown$/i.test(trimmed)) return null;
  const first = trimmed.split(/\s+/)[0];
  if (!first || first.length < 2 || first.length > 40) return null;
  // Letters (incl. common Latin accents), apostrophes, hyphens only — guards against a
  // firm name, an email address, or garbage data being used as a greeting name.
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ'-]+$/.test(first)) return null;
  return first;
}

function renderGreeting(firstName: string | null): string {
  return firstName ? `Hi ${firstName},` : 'Hi,';
}

/** Build a reply subject from the original first-email subject, avoiding "Re: Re:" doubling.
 * Falls back to a generic subject if no original is available (should be rare — follow-ups
 * always fire off an existing first-email draft, but stay defensive). */
export function buildReplySubject(originalSubject?: string | null, fallback = 'Re: Following up on aeda'): string {
  if (!originalSubject) return fallback;
  const trimmed = originalSubject.trim();
  if (!trimmed) return fallback;
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

export function renderFollowUp1Body(firstName: string | null): string {
  return `${renderGreeting(firstName)}

A quick follow-up with the simplest way to think about aeda.

Most cross-border products improve the customer interface while continuing to rely on the same underlying correspondent infrastructure. aeda addresses the infrastructure gap.

Our routing layer connects licensed partners and identifies more efficient paths across fragmented markets. For individuals, that can mean lower costs and shorter waiting times. For businesses, more reliable cross-border flows. For financial institutions, access to new corridors without rebuilding the infrastructure themselves.

Would a short call this week be useful?

${JULIA_SIGNATURE}`;
}

export function renderFollowUp2Body(firstName: string | null): string {
  return `${renderGreeting(firstName)}

One final note on the broader opportunity behind aeda.

The immediate problem is clear: an $81B corridor remains underserved because it still depends on correspondent banking infrastructure built in the 1970s — SWIFT rails that are slow, costly, and fragmented. The longer-term opportunity is larger.

As onchain settlement, programmable money, and agentic commerce develop, more transactions will be initiated by platforms and software rather than manually by individuals. These transactions will require infrastructure that can route value securely, intelligently, and continuously across markets.

aeda is building that routing layer — starting with today's cross-border payment gap and designed for the next generation of digital commerce.

We have completed the MVP, signed service partnerships, built a 200+ person waitlist, and bootstrapped $75K. We are raising a $500K pre-seed round.

Happy to send the deck or walk you through the model in a short call.

${JULIA_SIGNATURE}`;
}
