# aeda Compliance Copy Style Guide

> **Sync note**: This file must be kept in sync manually with the copy in aeda-workspace
> (`.claude/skills/aeda-compliance-copy-check/STYLE_GUIDE.md`). There is no shared package
> between the two repos.

This guide defines banned and required language for all investor-facing and external communications.
Used by the runtime compliance pre-filter (Haiku-based, flag-only) before @narek review.

---

## HIGH Severity (Never Use)

These terms trigger automatic compliance flags. Never use them in investor emails, pitch decks, or external copy.

| Banned Term | Replacement |
|-------------|-------------|
| "CASP" / "Crypto-Asset Service Provider" | "technology network" |
| "VASP" / "Virtual Asset Service Provider" | "technology network" |
| "EMI" / "Electronic Money Institution" | "technology infrastructure provider" |
| "payment processor" / "we process payments" | "cross-border payment infrastructure built on stablecoin rails and blockchain" |
| "we send money" / "we transfer money" | "connecting licensed partners" / "infrastructure enabling transfers" |
| "we hold funds" / "we custody funds" | "non-custodial" (state explicitly where relevant) |
| "Armenia" (any form) | "EU/US ↔ EECA corridor" |
| "EUR-AMD" (specific currency pair) | "EU/US ↔ EECA" |

---

## MEDIUM Severity (Context-Dependent, Flag for Review)

These may be acceptable depending on context but should be reviewed before sending.

| Term/Pattern | Concern |
|--------------|---------|
| Specific stablecoin names/tickers (EURC, USDC, etc.) | May be appropriate internally but flag for investor-facing copy |
| Unqualified speed claims ("instant", "in seconds") | Should be qualified (e.g., "under a minute", "typically within minutes") |
| The "$81B" market-size figure | Should include accompanying source context when used |
| Specific team-experience numbers/labels | Use only the approved phrasing: "former banking executives and engineers" |

---

## Required/Approved Phrasing (Positive List)

Use these exact phrasings in external communications:

| Element | Approved Phrasing |
|---------|-------------------|
| Core descriptor | "aeda is cross-border payment infrastructure built on stablecoin rails and blockchain for individuals and businesses." |
| Corridor | "EU/US ↔ EECA corridor" |
| Team | "former banking executives and engineers" |
| Entity | VanCoin LLC, Prague, Czech Republic |
| Custody position | "non-custodial" (state explicitly where relevant) |

---

## Notes

- This is a pre-@narek-review filter, not a replacement for human legal review
- HIGH severity flags should never appear in final sent emails
- MEDIUM severity flags require human judgment before proceeding
- When in doubt, flag for review rather than auto-approving
