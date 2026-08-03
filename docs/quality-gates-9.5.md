# Moraqeb 9.5/10 Quality Gates

A score of 9.5 is earned only when every release-blocking gate below passes against a fresh immutable generation. Green unit tests alone are insufficient.

## 1. Factual accuracy — target 9.5

- Audit at least 50 factual claims across Post, Brief, and Executive outputs.
- Zero wrong prices, percentages, dates, entities, or availability-to-zero conversions.
- Zero stale observations described as current.
- At least 98% of sampled claims must match the cited source exactly; any material contradiction is a release blocker.
- Recommendations and scenarios must be labeled analytical, not observed.

## 2. Citation integrity — target 10.0

- 100% of factual sentences in every promoted artifact have at least one valid evidence ID.
- Every citation must match the claim's material entities and quantities.
- Trailing citations after sentence punctuation must remain attached to the preceding claim.
- `[UNSUPPORTED]`, partial validation, malformed IDs, or unclassified substantive claims cannot become `latest.json`.
- Evidence disclosures preserve source, observation time, freshness, confidence, and safe URL.

## 3. Bilingual parity — target 10.0

- One canonical analysis followed by constrained Arabic translation.
- Exact parity for risk, development order/count, evidence IDs, numbers, confidence, actions, and uncertainties.
- Arabic uses Modern Standard Arabic, RTL layout, Arabic shell labels, and locale-aware dates.
- Translation may change wording only; it may not add, remove, merge, or reinterpret intelligence.

## 4. Source semantics and corroboration — target 9.5

- Every evidence record reports source-specific `fresh`, `aging`, `stale`, or `unknown` state.
- Unavailable remains unknown and never becomes zero.
- High confidence requires at least two fresh, independent, non-social source families.
- Multiple regions from one provider are one source family, not corroboration.
- NASA FIRMS overlapping boxes are deduplicated by satellite, instrument, acquisition time, and coordinate; regional counts are never summed.
- Thermal anomalies never imply military cause without independent corroboration.

## 5. Decision usefulness — target 9.5

- Executive surfaces no more than three prioritized developments.
- Each development states what happened, why it matters, business impact, recommended action, confidence, and corroboration state.
- Brief reading time is at most five minutes and Post reading time at most one minute.
- Material changes are snapshot-bound and thresholded; noisy transitions involving unavailable data are suppressed.

## 6. UX and accessibility — target 9.5

- Main narrative contains no raw evidence IDs or `[OBSERVED]`/`[INFERENCE]` tokens; full traceability remains in closed audit disclosures.
- Only validated current and archive artifacts are shown by default.
- Every interactive control is keyboard-operable, has a visible focus state, and is at least 44×44 CSS pixels.
- No horizontal overflow at 360, 768, 1280, or 1440 CSS pixels.
- English and Arabic render correctly at desktop and mobile widths.
- Reduced-motion preferences are honored and browser console errors are zero.

## 7. Reliability and release safety — target 10.0

- Candidate artifact is archived before promotion and is promoted atomically only after quality gates pass.
- Immutable snapshot SHA-256 matches the exact bytes used for generation.
- Queue has zero pending, running, or failed jobs after verification.
- Public errors remain generic and no provider body or credential reaches logs, APIs, artifacts, or Git.
- Full tests, syntax checks, 12 dashboard inline-script checks, `git diff --check`, secret scan, Docker health, and live browser verification all pass.

## Score policy

A critical factual, citation, bilingual, security, or promotion defect caps the overall score at 7.0. Source usability below 90%, any promoted partial artifact, or any unsupported high-confidence conclusion caps it at 8.5. Moraqeb may be scored 9.5 only after an independent reviewer reproduces the acceptance checks on the current generation version.
