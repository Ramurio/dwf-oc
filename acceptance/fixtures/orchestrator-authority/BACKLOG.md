# Local event report

## contract
Inspect fixtures and the public acceptance tests. Write docs/contract-proposal.md comparing two plausible internal summary representations, including how each preserves unknown duration and deterministic order. Report this document to the orchestrator for its technical decision before dependent implementation. Then record the selected contract in docs/contract.md; the other two tasks must use it. The orchestrator owns this choice; no user choice is required. Proposal and decision must remain distinct and attributable.

## summarize (depends on contract)
Implement summarize(events) through a module of its own, exporting it from report.mjs. Group by project, count events and total durations. If any event in a project lacks a known duration, that total is unknown. Preserve input. Decide malformed-input handling within the agreed contract and test it.

## render (depends on contract)
Implement render(summary) through a module of its own, exporting it from report.mjs. Match the public output in the existing tests, sort projects deterministically, and represent unknown and empty data clearly. Use the agreed internal contract. Add tests for the selected boundary behavior.

Both implementation tasks can run in parallel after the contract is integrated. Shared report.mjs exports must survive integration. Independently review and verify each task and the combined public result. Do not replace the original tests with a weaker check.
