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

Static demo runs and session IDs remain fictional. The shared assets also serve real DWF runs via `dwf ui --start`; see [live service checks and limits](../../docs/ui.md). The original design-integration evidence above is retained as history.

Verified browsers are Chrome desktop and emulated viewport sizes. Physical touch hardware, screen readers and other engines require further verification. Dense cross-linked graphs, nested groups and very large participant collections need additional routing work. Large maps use pan/zoom and a fit overview.

The user approved merging the final Lines revision. Earlier DWF reviews concern their own snapshots. No new independent critic score is assigned to this integration.

Raw screenshots, browser profiles and logs remain outside published files or in ignored `.evidence/` directories.

## Initial live service checks — before review, integration pending DWF

- `npm test`: 34 harness, 120 product and 47 runtime tests passed; 12 Cucumber scenarios / 116 steps passed.
- `npm run test:ui`: 6 service/adapter tests, 15 existing layout tests, paired-route checks and isolated real CLI/OpenCode/Chrome verification passed.
- `qa/browser-checks.mjs` and `qa/review-regressions.mjs`: passed, including the added missing-session-identity regression (unknown IDs never assert same/fresh context).
- Actual browser checks cover two projects, incoming runs, status/history/geometry preservation, reconnect, mixed fixed and repeat data-driven groups, legacy planner observation, clipboard readback and generated commands opened in private PTYs. Both directory mode and an actual verifier's private worktree session were opened.
- `qa/browser-paired.mjs` against a private ephemeral static server: 18 viewport/fixture cases passed, no geometry collisions or browser errors; graph mutation retained two real reciprocal pairs.
- The runtime archive test initially found omitted UI modules; the archive allowlist now includes the three UI modules and the shared assets. The regression passes without changing its oracle.

No external paid model calls, personal databases, shared browser profiles or user service shutdowns were used. OS reboot, other browser engines, physical touch and very large databases remain unverified. Raw evidence remains ignored. These checks do not claim an independent review score or completed merge/push.

## Review revision

The review reproduced two adapter defects: shared standalone/group history also
shared the active-platform flag, and inherited `Object.prototype` properties were
mistaken for groups. Focused tests failed before the fixes. History now keeps the
actual visit location; only that platform is active, the current-participant list
is unique, and current navigation reaches the matching platform. Group lookup
and feedback-edge classification use own keys. Valid `toString`,
`hasOwnProperty` and `valueOf` nodes retain role, calls and session entry.

Known DWF result envelopes now show their saved `summary`, with findings,
artifacts and other fields in readable disclosures. Service `outcome` is not the
primary result. The exact source (including serialized legacy envelopes) remains
in a closed-by-default original-result disclosure. No summary is invented for
arbitrary old objects. Inspector history, command copying and deliberate open
state survive live refreshes. `ui-data.mjs`, `ui-service.mjs` and `ui-server.mjs`
were expanded into normal readable blocks without a new lifecycle abstraction.

`npm run test:ui` passed: 10 adapter/service tests, 15 layout tests, paired-route
checks, real CLI/OpenCode/Chrome session tests, and the added controlled-record
view regressions. The latter cover `r → batch(r)`, one actual active platform,
unique summary/current navigation, shared history, readable participant/workflow
envelopes, original-data retention and special node names. The browser
screenshots were visually inspected. Lines browser-checks and review-regressions
passed; browser-paired passed 18 cases with no collisions or browser errors.
These are worker checks, not independent reviewer/verifier approval or Git
integration.

The activity revision also retains the actual mapped participant ID when a
steering visit executes independently at its template platform. A focused test
first reproduced the missing identity/activity after separating platform status;
the adapter now enumerates observed standalone identities. The controlled browser
view additionally checks current navigation and shared history for that case.

Final full regression after the mapped-steering fix: `npm test` passed 34
harness, 124 product and 47 runtime tests; controlled acceptance, recovery and
workflow suites passed 12 scenarios / 116 steps. `npm run test:steps` completed
its dry run (13 scenarios / 128 steps skipped, not executed). Syntax checks and
`git diff --check` passed. All worker background checks have finished. Renewed
independent review/verifier and integration remain with DWF.

## Standalone identity selection revision

The next review found that standalone nodes exposed multiple participant IDs in
API data but only groups offered an inspector picker. A browser regression first
failed with an empty picker after reopening a template with both its original
standalone identity and a mapped steering identity. The inspector now offers all
identities for multi-identity standalone nodes, including its no-invocation view.
Primitive cards and initial details prefer an active or observed identity over a
newer input that has not been admitted; prepared inputs remain uncounted.

The controlled-record browser regression now starts with an ordinary standalone
call before grouped and standalone mapped calls. It checks reopening, original
tasks/results/session commands, actual clipboard readback, switching back to
mapped history, retention of the deliberate selection on refresh, and switching
out of the empty view for an unadmitted identity. The adapter regression verifies
all three IDs and exact observed-call counts (0, 2, 1). The controlled screenshot
was visually inspected; the synthetic IDs are not claimed as executed sessions.

Updated `npm run test:ui` passed: 11 adapter/service tests, 15 layout tests,
paired-route checks, real CLI/OpenCode browser tests and the expanded identity
view regression. Lines browser-checks and review-regressions passed, including
native 200% zoom and backward focus clearance. Browser-paired again passed 18
cases with no geometry collisions or browser errors. `npm run test:steps` was a
dry run only (13 scenarios / 128 steps skipped); syntax and diff checks passed.

Final full `npm test` for this revision passed: 34 harness, 125 product and 47
runtime tests, plus 12 controlled acceptance/recovery/workflow scenarios and
116 steps. All background commands have finished. Renewed independent review,
verifier and Git integration are still DWF's responsibility; no merge/push was
performed by this worker. Existing browser/reboot/large-database limits remain.

## Paired skip captions and historical verifier directory — before approved clarification

The five-reviewer graph from independent verification reproduced a collision
between `step_1 → step_3` and the paired reply `step_4 → step_0`. Both a fixed-metric
unit oracle and real CLI/Chrome DOM bounds failed before the change. Skip lanes
now reserve the second caption of a reciprocal pair as well as the forward
caption, including clearance above the platforms. No workflow-specific routing
or coordinates were introduced. The real CLI regression passed at 1440, 1024
and 390px widths in Fit and 100% modes; its screenshots were visually inspected.
The 6px paired spacing, stroke widths and arrowhead paint order are unchanged.

The historical-directory defect was independently reproduced twice in this
revision: a verifier returns changes and then approve, retaining one actual
session ID but moving between two verification snapshots. Launching the copied
first-call command in a private PTY opens the right session, whose native
`session.get` location is still the second snapshot. OpenCode 2.2.5 does not
honor the positional directory as an override for an existing session. The
expanded `acceptance/ui-browser.mjs` deliberately fails this assertion; therefore
`npm run test:ui` is NOT green for the current files. The command implementation
has not been changed to mutate a user's native session without agreement.

Resolution needs an approved entry contract: explicitly move an idle session to
the selected historical directory with ownership/activity safeguards and a
visible warning (recommended), or relax the historical-directory requirement and
show the current session directory honestly. Forking would not enter the same
session. Plain `cd` is not a fix. No native session is moved by the UI itself.

Other current checks passed: `npm run test:product` (126 tests), 12 service/adapter
and 15 layout tests, paired-route checks, controlled identity view regressions,
Lines browser-checks and review-regressions, browser-paired (18 cases, no geometry
collisions or browser errors), syntax and diff checks. The full `npm test` was not
rerun in this blocked revision. Previous full-suite results above belong to their
earlier files. Both private PTYs are now explicitly reaped on test completion;
only their own forked process groups are terminated during test cleanup. All
commands have finished and isolated sandboxes were cleaned. No merge/push or
independent approval is claimed.


## Approved current-session entry contract

The assigning lead explicitly selected existing-session entry in its current
native context, with the historical call directory shown separately. This
supersedes the historical-directory requirement and blocked RED assertion above;
no move, fork, forced directory or session mutation was authorized or added.
The command is the pinned native `opencode --session ID` with saved profile
environment, without a historical positional directory.

The adapter now distinguishes the saved call directory, last saved session
directory and actual current `session.get().location`. Native location is read
from an already running service with run-ownership checks, deduplicated across
shared histories; neither UI polling nor selection starts a native service or
changes a session. Failure to read location leaves it explicitly unknown. A
saved last directory is labeled non-live, and a confirmed missing native session
has no entry command. The live inspector warns when native and historical
directories differ and notes that location can change before entry.

Updated focused tests first failed on the positional directory and missing
context fields. The real CLI/browser test now executes the copied command in
private PTYs for both early and latest calls of one verifier session after its
verification worktree changes. Both retain the actual native location and ID;
message history and the full native session-ID list are unchanged. The early
call's task/result/history remain available. An unavailable discovery path in the completed isolated run record (without
changing native registration or stopping its process) makes current location unknown,
shows the explicitly non-live saved directory and then recovers. Controlled
view tests also cover unknown location without a native service. The context
screenshots were visually inspected. The paired-skip regression remains active
at 1440/1024/390px in Fit and 100% modes.

Final `npm run test:ui` passed: 13 adapter/service tests, 15 layout tests,
paired-route checks, real CLI/OpenCode/Chrome entry tests and controlled view
regressions. Native session removal during explicit isolated teardown also
confirms that UI polling does not recreate it or offer a misleading command.
Lines browser-checks/review-regressions passed; browser-paired passed 18 cases
without geometry collisions or browser errors. Full `npm test` passed 34 harness,
127 product and 47 runtime tests and 12 Cucumber scenarios / 116 steps. The only
subsequent changes were test-harness refinements and documentation, verified by
the final UI suite; application modules did not change. `npm run test:steps` was
a dry run only (13 scenarios / 128 steps skipped). Syntax and diff checks passed.

The first unavailable-location test physically hid native registration; recovery
was intermittent because the native endpoint sometimes became unavailable even
after restoring the file. That was not a safe read-only outage simulation. The
final test changes only the discovery path in its own completed saved run record,
leaves the real native registration untouched, and checks the native service is
still alive and unmoved. It passed three consecutive real-browser repetitions,
then the final full UI suite. This setup correction did not change product code
or relax the unknown-location expectation.

All worker commands, private PTYs and ephemeral servers have finished, and
sandboxes were cleaned. No merge/push was performed. Independent review/verifier
and integration remain with DWF. Existing Chrome/reboot/very-large-database
limitations still apply; live directory reads add native observation work and
have not been benchmarked against very large saved histories.
