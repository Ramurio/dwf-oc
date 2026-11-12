# Lines / relay map

## Architectural choice

The baseline uses an icon station, a common vertical spine, and horizontal participant fans. This version uses **ranked relay platforms**, **vertical participant combs**, and **external return channels**. It is still a connected line map, not a dashboard or nested-card navigation tree.

Three structural alternatives were considered:

- **Vertical decision tree:** familiar branches, but the research returns would repeatedly cross the tree and parallel groups would consume the width.
- **Folded circuit / perimeter ring:** compact loops, but visually promotes reentry over ordinary progress and gives branching groups awkward inside/outside ownership.
- **Horizontal relay lanes — implemented:** progress consistently moves right; alternate calls separate vertically; groups distribute and collect on opposite sides; earlier destinations are reached through labeled lower channels. Costs: long chains need horizontal navigation, and many returns can form a ladder.

These are implementation choices within the approved Lines redesign, not changes to workflow semantics, runtime architecture, storage, or acceptance criteria.

## What changed structurally

1. **There is no main spine.** Each outgoing transition leaves a separate port. Columns express control depth, not the order of invocations. Branches and joins use the same grammar in every example.
2. **A primitive is a labeled platform, not an icon plus disconnected caption.** Its name, familiar role, and observed status travel together. End is explicitly a terminal, not an agent.
3. **A parallel group is an open distribution/collection circuit.** The solid left comb calls each named participant. The thin purple right comb collects results. Header selection inspects the primitive; individual rows inspect independent participants. Fixed/data-driven membership is explicit. Members show call counts and graphical traces joining calls with the same session ID. Working members have a filled accent marker.
4. **Opposing transitions share a route.** An actual forward edge and one reverse result/reentry edge use parallel paths 6px apart. Forward green strokes are 2.3px and purple return strokes are 1.25px. Their heads point in opposite directions, with labels beside the paths. Longer cycles keep their own external return channels. Centered side-port banks apply to primitives and groups. A pair occupies one bank position, with the two paths straddling its center. Caption spacing reserves room for both labels at multi-input groups. White route casing separates crossings, and arrowheads paint above every casing and label mask.
5. **Inspection does not restructure the map.** A modal session sheet sits over the existing geometry. It shows the selected invocation’s actual ID and the preceding ID together, before task/result and model/skills. History affects details only. The sheet uses native modal semantics, explicit Tab-boundary handling, Escape, and focus return. Measured sticky-header scroll padding and focus clearance keep backward keyboard navigation visible at native enlarged zoom. On narrow screens it becomes a nearly full-screen reading surface.
6. **Density is navigable rather than silently miniaturized.** Initial scale never drops below 80%; larger maps can scroll/drag. Fit explicitly enters overview when necessary; the percentage button returns to 100%. Current-participant navigation finds the observed active participant. Runs collapse into a compact disclosure on narrow screens.

## Reusable layout and adapter

`fixtures.mjs → toGraph(run) → layoutGraph(graph, {measure}) → SVG renderer`.

The narrow view model is:

- node: unique `id`, `label`, familiar `role`, `participants`, optional `group: fixed | data-driven`;
- participant: unique `id`, `name`, `role`, reentry memory policy, ordered `invocations`;
- invocation: fictional actual `session`, task/result, state, model/reasoning/speed/skills;
- transition: unique `id`, `from`, `to`, `label`, `kind: control | result`, optional `reentry`.

This is **not a production runtime parser**. A future adapter must supply real nodes, groups, transitions and observations without replacing session identity with role names. No runtime source is imported or changed.

`layout.mjs` performs:

1. measured title/member wrapping and intrinsic platform sizing;
2. DAG longest-path ranking after excluding explicit result/reentry edges;
3. stable barycentric layer ordering;
4. neighbor alignment with isotonic stack compaction, maintaining non-overlap without greedy downward drift;
5. orthogonal gutter routing for adjacent ranks, upper channels for skipped ranks, shared offset paths for actual opposing transitions and lower channels for remaining result/reentry edges;
6. centered caption-sized target-port banks, measured horizontal caption segments beyond the routing tracks, paired-label clearance, wrapped return captions and rounded corners. Platforms grow for many-way joins rather than compressing their captions. Lower channels reserve the lettering and its paint mask below the lowest platform.

The browser supplies real canvas font metrics (reserving bold member widths); Node has a conservative metric fallback. Placement never reads invocation state, selected history, workflow IDs, or fixture names. Edits to names, node count and membership recalculate dimensions and routes. Runtime-state changes do not change geometry. Viewport resizing may refit, but inspection does not.

## Evidence and comparison

Actual browser captures are generated by `node prototypes/dwf-ui/qa/browser-checks.mjs` into ignored `.evidence/implementation/`. These are local implementation evidence, not independent criticism or scores.

Compare `baseline-1440x900.png` with `research-1440x900.png`: both scout participants are now visible, group ownership is adjacent to each member, the four researchers no longer stretch across the width, and reentry is separate from result delivery. `build-1440x900.png` has individually traceable correction channels. `branch.png`, `returns.png`, `ensemble.png`, and `large-overview.png` demonstrate the same system on different structures. `large-readable.png` deliberately shows readable panning rather than claiming overview text is readable.

`modified-graph*.png` shows a renamed scientist, three additional researchers, and an added validation branch, without coordinates. `wide-labels.png` exercises pathological wide glyphs. The screenshots were opened and visually inspected during implementation; checks and limitations are in `CHECKS.md`. `qa/review-regressions.mjs` additionally renders a coordinate-free two-destination join at four viewports, a six-way join and a five-input group, and replays backward Tab at native 200% Chrome zoom. Its `review-after-*` images and report record the feedback fixes, not independent approval.

## Limits and future work

- Supported: explicit acyclic forward control, branches/joins, skipped ranks, flat parallel groups, explicit result/reentry edges, self-reentry, disconnected forward components. Implicit control cycles are rejected with a useful error: the adapter must identify reentry.
- Nested groups, dynamic group virtualization, and hundreds of participants are not implemented. Dense cross-linked graphs or dozens of returns need congestion-aware routing/edge bundling beyond these gutters. No universal aesthetic guarantee is claimed.
- Long maps intentionally need pan/zoom. Overview captions can be too small to read; 100% and current navigation are the reading modes.
- Text-only CSS enlargement and actual CDP pinch zoom were exercised. Native Chrome page zoom at 200% is also covered by the review regressions (a preference only in their temporary profile, verified by actual viewport reflow and DPR). Assistive-technology use, touch hardware and non-Chrome browsers still need inspection.
- All data is fictional and static. Live backend updates, persistence, production CLI lifecycle, and real OpenCode attachment are out of scope.
- The final paired-arrow revision was approved for merging by the user on 2026-11-13. Historical DWF critic scores concern their reviewed revisions. Current implementation checks and user approval are recorded separately in `review-summary.json`.
