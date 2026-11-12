# Integration verification — 2026-11-13

## Reproducible UI checks

- `node --test prototypes/dwf-ui/qa/layout.test.mjs` — 15 passed. Six supplied graphs, mutations, stable geometry, valid topology, joins, multi-input groups and caption clearance.
- `node prototypes/dwf-ui/qa/paired-routes.test.mjs` — passed. Reciprocal pairs, exact edge identities, 6px spacing, centered group ports, resized groups, duplicate returns, three-node cycles and splitting an edge.
- `node prototypes/dwf-ui/qa/browser-checks.mjs` — passed in Chrome. Status summaries, run/participant selection, history, skills, clipboard success/failure, keyboard/modal navigation, narrow screens, mutated graphs and local-only resources.
- `node prototypes/dwf-ui/qa/review-regressions.mjs` — passed. Caption/node clearance, two-destination and many-way joins, five-input group, fit overview, native Chrome 200% zoom, forward/backward focus clearance. No failures or browser exceptions.
- `node prototypes/dwf-ui/qa/browser-paired.mjs URL EVIDENCE_DIRECTORY` — passed against the integrated repository. Six graphs at 1440×900, 1024×768 and 390×844, totaling 18 states. No route/node or label/node collisions, horizontal page overflow or browser exceptions. Exact rendered widths are 2.3px forward and 1.25px reverse. Keyboard edge selection, head/body opacity, session details and stable history pass. A coordinate-free graph mutation renders six nodes, eight edges and two reciprocal pairs.

The paired-arrow browser regression requires one separately painted arrowhead per edge after all route/label masks. Route bodies carry no markers. This covers the previously hidden lower half of the green arrowhead. Screenshots of the integrated research, development and seven-member group maps were visually inspected.

## Repository regression suite

`npm test` passed on the integrated tree. The harness, product and runtime suites passed 34, 114 and 47 tests respectively. Controlled acceptance, recovery and workflow suites passed 12 scenarios and 116 steps.

## Integration fixes

The inherited layout test found a return caption overlapping the next input caption at a five-input group. Input-bank spacing now reserves the paired reply caption as well as the forward caption. The original test passes with its collision oracle intact.

Session traces and counts increase group height. The initial view retains the existing minimum 80% readable scale, so the research map at 1280×720 requires vertical navigation. Its full-caption visibility check now exercises Fit. Initial and fitted screenshots remain available in the local evidence.

## Limits

This is a standalone prototype with fictional runs and session IDs. Live DWF adaptation, persistent CLI service lifecycle and real OpenCode attachment are pending. The production runtime is exercised separately by the repository suite.

Verified browsers are Chrome desktop and emulated viewport sizes. Physical touch hardware, screen readers and other engines require further verification. Dense cross-linked graphs, nested groups and very large participant collections need additional routing work. Large maps use pan/zoom and a fit overview.

The user approved merging the final Lines revision. Earlier DWF reviews concern their own snapshots. No new independent critic score is assigned to this integration.

Raw screenshots, browser profiles and logs remain outside published files or in ignored `.evidence/` directories.
