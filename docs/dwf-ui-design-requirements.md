# Approved DWF UI requirements

## Current decision — 2026-11-13

The user selected Lines and approved merging the paired-arrow prototype. Actual opposing transitions share a path with two parallel directions, 6px apart, with a thicker green forward line and a thinner purple return line. Primitive and group side ports are centered. Blocks show graphical session continuity and call counts; session explanations are available on selection. Arrowheads must remain complete when paths are close. The executable prototype and its checks are in `prototypes/dwf-ui`.

The initial implementation remains a fictional-data prototype. Live DWF adaptation and the persistent `dwf ui --start/--stop` service are subsequent work.

## Original architectural exploration brief

The user wants beautiful, minimalist, immediately understandable workflow maps. The two accepted families are Lines and Containment. The previous Sol/Astra variants were almost identical because the brief overconstrained preservation of the baseline composition. The user now explicitly authorizes LARGE visual and information-architecture improvements within each family. A cosmetic revision does not satisfy this task.

Automatic map generation is a permanent acceptance requirement. A beautiful hand-positioned example does not establish that arbitrary workflow maps will be beautiful. Spend substantial effort on automatic layout, edge routing, groups, loops, changing participant counts and stable runtime updates. Give future implementers explicit criteria and evidence for this requirement.

A person opening DWF should immediately understand the selected workflow architecture, all possible transitions, the active work, and which primitive each participant belongs to. List recent runs across projects, newest selected initially. Keep models and reasoning in details. Clicking a primitive exposes model, reasoning, speed, expandable skills, task, result, invocation history and the copyable OpenCode command for the selected invocation. Historical inspection must not rewrite current execution. Distinguish independent participants and continuing versus fresh contexts using actual session IDs. Do not use a wave selector or display raw JSON panels.

This assignment is an interactive architectural design experiment in prototypes/dwf-ui. The user authorized structural changes to that prototype. Develop a visibly different, stronger spatial/interaction system, test it, and document tradeoffs. Production CLI lifecycle, backend persistence and live OpenCode integration belong to later implementation. Use clearly fictional demo IDs. Keep the existing DWF runtime source untouched. Never start, steer or stop other DWFs, change global configuration, install skills, or push branches yourself.

# Deliverable

Keep baseline.html as the unchanged comparison snapshot. Deliver the redesigned working entry at index.html (local CSS/JS modules are fine), a short design.md explaining the MAJOR structural decisions, and CHECKS.md with actual verification and limitations. Update the prototype README for the actual local launch command. Keep code readable and use existing source where it helps. Favor a small solution, not a framework migration for its own sake.

The new map must derive placement and connections from graph DATA, using a reusable layout/routing method. There must not be a different hand-authored SVG/path table for each example, nor positions keyed to workflow IDs or names. A narrow, documented adapter from DWF nodes/groups/transitions and runtime participants to the view model is sufficient. Do not claim full production integration. Explain which unsupported graph cases need future work honestly.

Include a small set of varied graph data fixtures accessible through the run/example selection: the two core workflows below, a simple chain/branch/join, a loop with multiple returns, a different group size, and a moderately sized 15–25-node graph with long labels. Fixtures can overlap these structural cases, but must genuinely exercise more than the two original examples. Layout must also survive adding/renaming nodes and changing participant count without coordinate edits. Preserve orientation across runtime status and historical-selection updates. Larger graphs may use clear pan/zoom/fit or semantic disclosure while keeping labels readable.

Core research graph: scientist calls scouts (2 fixed parallel members), then returns to scientist; scientist calls researchers (4 data-driven parallel members), then returns to scientist; scientist calls committee; committee approve exits, changes returns to scientist. Control transitions and result delivery are different. Scientist/scouts keep their individual sessions, researchers have fresh sessions on reentry, committee fresh per review. Provide an old and a current researcher invocation.
Core development graph: worker -> reviewer -> verifier -> end; reviewer changes -> the same worker, verifier changes -> the same worker. Show old/current worker calls in the same session.

# Design guidance

Explore the structural opportunities before polishing. Make the primary visual grammar intentional: hierarchy, routes, invocation versus return, scope/group boundaries, current execution versus selected historical data. Use proximity, alignment, whitespace and restrained color for meaning. Show only text that enables navigation or comprehension. Preserve familiar primitive labels. Avoid decorative dashboards and explanatory paragraphs compensating for unreadable geometry. Favor direct visual relationships and progressive details. Compare real rendered candidate screens with the baseline and show where the architecture became easier to understand.

# Verification environment

Every browser process must use its own temporary profile and OS-assigned debugging port. Do not kill unrelated processes or share a fixed port. The reusable qa/browser-probe.mjs is available as a starting point. Reviewer screenshots/scripts go in ignored .evidence/<critic-name>/ INSIDE the review workspace because image reading outside the workspace can be denied. Chrome user profiles can be in /tmp. Open your actual screenshots with the image reader. Close only your own browser/server processes before finishing. Never fabricate a browser result or infer visual quality from source alone.
