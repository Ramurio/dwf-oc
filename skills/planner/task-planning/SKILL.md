---
name: task-planning
description: Turn an assigned task and available context into a practical plan with observable outcomes, necessary dependencies, verification steps and explicit unresolved decisions.
license: MIT
metadata:
  author: Ramurio
---

# Task planning

## Establish the scope

Identify the user's objective, agreed requirements, constraints and acceptance criteria. Use the supplied context and permitted reading tools. Distinguish established facts from assumptions and proposed choices. Describe codebase details as confirmed only when the available evidence supports them.

Prefer the simplest complete approach compatible with the project. Reuse known interfaces, patterns, platform features and dependencies. Keep incidental cleanup and speculative flexibility outside the plan unless they are necessary to achieve the requested result.

## Sequence useful outcomes

Break substantial work into independently understandable steps. Each step should describe what it delivers and how that outcome can be checked. Favor small end-to-end slices that establish usable behavior. A small task may need only a short sequence.

Order steps by actual prerequisites. Distinguish work that can proceed independently from work that needs an earlier result. Include affected callers, data compatibility and failure handling when the planned change requires them.

For a broad migration, explain how intermediate states remain compatible or where coordinated integration is required. When a consequential decision lacks evidence, propose a focused investigation or experiment before committing dependent work. Identify the decision that requires the user's input and what can proceed meanwhile.

## Make completion testable

Attach suitable checks to the material outcomes. Prefer the existing public entry points and test conventions. Cover the intended behavior and relevant regressions, with independent expected results. Identify essential setup, access or data that the checks require.

Scale the detail to uncertainty and risk. Use concrete file names, commands and estimates only when supported by the context. State unresolved questions that could change scope, correctness or sequencing, along with reasonable provisional assumptions where appropriate.

## Present the plan

Summarize the approach, ordered steps, completion checks and material open decisions. Use the requested output format and omit sections that add no useful information. Keep proposals visibly separate from agreed choices. Report planned actions as future work and preserve the distinction between planning and execution.
