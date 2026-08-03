# Moraqeb System Review — 2026-08-02

## Verdict

Moraqeb is a promising OSINT decision-support prototype with strong technical provenance, but it is not yet safe to treat as autonomous, verified intelligence. The Executive view is the best product surface. The long-form Blog and dashboard still need product and evidence-quality work.

## Evidence-v13 hardening update — 2026-08-03

The active branch now includes a major evidence-v13 hardening increment. The score below remains the published evidence-v10 baseline; it has **not** been raised to 9.5 without a fresh independent release audit.

Verified in the current source tree:

- Complete Node suite: **135 passed, 0 failed, 1 skipped**.
- Blog, Posts, and Executive latest-promotion gates require complete bilingual citation metadata, exact resolved evidence IDs, immutable snapshot lineage, and no unsupported claims.
- OpenSky uses one global state-vector request followed by deterministic regionalization.
- NASA FIRMS uses product-aware exact deduplication, rolling 24-hour windows, partial-coverage semantics, and set-based deltas that do not treat window expiry as de-escalation.
- Citation parsing protects abbreviations, binds trailing citations correctly, separates semicolon claims, catches short/table facts, and rejects factual laundering through inference tags.
- Source-family corroboration excludes social-only, stale, contextual, and syndicated duplicates from high-confidence treatment.
- Blog and Posts now use concise reader paths, collapsed audit details, validated archives, localized accessibility controls, and progressive Posts filtering/loading.
- Executive, Blog, and Posts use **Segoe UI** for Arabic and no longer download Noto Sans Arabic.

Runtime verification before this update produced fresh validated evidence-v13 Post and Blog artifacts. Executive evidence-v13 generation previously failed closed and retained the last trusted artifact; the current source adds deterministic fresh-evidence selection for the next Executive generation. A new independent artifact/claim/desktop-mobile audit is still required before revising the score.

| Area | Score | Verdict |
|---|---:|---|
| Accuracy | 7.0/10 | Selected primary-source facts check out; degraded feeds, low-confidence social reporting, partial citation coverage, and overlapping FIRMS regions limit certainty. |
| Usefulness | 7.0/10 | Executive actions and Chat synthesis are useful; Blog is too long and noisy for routine decisions. |
| User friendliness | 6.5/10 | Executive is strong; Blog and Posts expose too much audit syntax and evidence detail. |
| Reliability/security | 8.5/10 | Immutable snapshots, exact hashes, durable queueing, archive-first writes, safe public errors, and release tests are strong. |
| Overall | 7.0/10 | Useful with human verification; not a substitute for verified intelligence or operational source confirmation. |

## What was checked

- Live dashboard, Executive, Blog, Posts, Chat, and Voice pages.
- Latest bilingual Post, Blog, and Executive artifacts.
- Exact SHA-256 lineage against immutable synthesized snapshots.
- Queue completion, retries, restart behavior, health, browser console, syntax, inline scripts, and the complete Node test suite.
- Selected source claims against Yahoo Finance, the New York Fed, FRED, BBC, Indian Express, Al Jazeera, and the collected NASA FIRMS records.

## Accuracy findings

### Confirmed

- Latest artifact hashes match the exact immutable snapshot bytes.
- Yahoo WTI was independently confirmed at **84.67**, as of **2026-07-31 20:59:59Z**, with the correct prior-day move of **+1.29%**.
- NY Fed GSCPI was independently re-fetched at **1.249401668** for June 2026.
- The BBC source supports the reported Gaza fatality headline.
- Indian Express supports the reported 845-train Mokama disruption.
- Al Jazeera supports the report that Saudi Crown Prince Mohammed bin Salman urged dialogue.
- NASA FIRMS timestamps now use the latest satellite acquisition time rather than sweep time.

### Material limitations

1. **Source availability is incomplete.** Recent sweeps returned roughly 18–20 usable sources out of 29. ACLED lacked credentials, OpenSky was rate-limited, and some space/news sources failed.
2. **FIRMS regions overlap.** Iran is contained within the Middle East box, so regional counts must not be added as unique detections. The dashboard no longer presents their sum and generation context now warns against aggregation, but the underlying regional buckets remain overlapping.
3. **FIRMS identifies thermal anomalies, not attacks.** Military attribution requires independent corroboration.
4. **Blog citation coverage remains partial.** The latest long-form briefing still contains dozens of validator-flagged claims. Some are genuinely analytical or weakly supported; some are false positives caused by lexical citation matching.
5. **Low-confidence social evidence remains present.** Telegram-derived conflict reports are correctly labeled low confidence but should not trigger operational action without confirmation.
6. **Older archives contain weaker generations.** The current pipeline is stronger, but the Posts/Blog history still exposes legacy uncited or partially supported artifacts.

## Usefulness

### Strong

- The Executive view quickly communicates risk, developments, decisions, actions, uncertainty, and evidence gaps.
- Chat gives a useful synthesized answer and explicitly distinguishes source observation from inference.
- Action recommendations around logistics continuity, fuel/freight sensitivity, corroboration, and escalation monitoring are practical.
- Exact snapshot lineage makes every generated artifact auditable.

### Weak

- The Blog is a 13–15 minute report with a large evidence wall and too many unsupported markers. It is better as an analyst appendix than an executive product.
- Posts are easy to scan but raw evidence IDs and governance tags dominate the reading experience.
- The dashboard is visually compelling but still produces alarm fatigue: many thermal alerts, dense panels, and limited prioritization.
- “Cross-source signals” is often dominated by one source family rather than actual multi-source corroboration.

## User experience

| Surface | Score | Notes |
|---|---:|---|
| Executive | 8.5/10 | Clear hierarchy, good RTL, evidence collapsed, no public model branding. |
| Chat | 7.5/10 | Clear prompts and useful answer; responses and evidence panels are still long. |
| Voice | 6.5/10 | Understandable tap-to-start interaction; limited onboarding and status explanation. |
| Dashboard | 6.5/10 | Attractive and information-rich; dense and prone to alarm fatigue. False-zero and hard-coded alert presentation were corrected. |
| Posts | 5.5/10 | Scannable cards, but raw IDs/tags and legacy weak posts reduce trust. |
| Blog | 4.5/10 | Excessive reading effort and evidence clutter for executive use. |

## Corrections made during this audit

- Switched Executive, Post, and Blog generation to one canonical English analysis followed by constrained Arabic translation.
- Enforced matching bilingual citations, numerical tokens, ordering, confidence, and risk structure.
- Made uncited factual Posts fail and retry rather than silently becoming latest.
- Preserved actual Yahoo exchange observation times.
- Corrected Yahoo daily percentage changes; the former implementation compared against the close preceding a five-day chart window.
- Preserved NASA FIRMS acquisition timestamps and stale/unknown semantics.
- Removed hard-coded dashboard “Wartime Stagflation Risk” and “High Alert” labels.
- Changed unavailable Air, ACLED, and Space states from factual zeroes to unavailable/degraded presentation.
- Removed the misleading global sum of overlapping FIRMS regional buckets from the dashboard.

## Recommendation

Use Moraqeb as a **human-in-the-loop monitoring and hypothesis-generation system**. Treat the Executive page as the primary product. Do not use Blog/Post claims for consequential decisions unless the cited source is opened and independently verified.

Priority next steps:

1. Redesign Blog and Posts using the Executive presentation pattern.
2. Deduplicate FIRMS detections geographically and expose a real unique count.
3. Build source-specific freshness policies, especially for closed markets and social reports.
4. Improve multilingual citation validation so translated claims inherit canonical evidence semantics without lexical false positives.
5. Add a corroboration score requiring independent source families before escalation labels.
6. Hide or clearly label legacy weak archives.
