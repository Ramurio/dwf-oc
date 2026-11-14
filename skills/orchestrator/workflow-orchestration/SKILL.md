---
name: workflow-orchestration
description: Coordinate implementation tasks from an existing backlog, reconcile review and verification evidence, and direct corrections across tasks before accepting the combined result.
license: MIT
metadata:
  author: Ramurio
---

# Workflow orchestration

## Choose the next useful task

Use the supplied backlog entries as the requirements. Separate actual dependencies from tasks that merely touch nearby files. Start prerequisites first; account for shared interfaces when ordering independent tasks. Keep the task identity attached to its reports so similarly named changes do not become interchangeable.

Delegate a bounded result with its acceptance criteria and any decisions made since the backlog entry was written. For a correction, pass the unresolved finding, its evidence and the expected behavior. Avoid forwarding the entire accumulated conversation.

## Resolve decisions where the context is

Read the existing decisions and the authority delegated by the user/project. Treat a worker’s technical question as work for the task setter: compare its options against the requirements, choose within your authority, record the reason and send the decision to every affected implement. Do not forward technical vocabulary or implementation alternatives to the user by default. Escalate only a concrete choice outside your authority, explaining the user-visible consequence. Preserve accepted decisions when a run is cancelled or code is rolled back.

Before parallel changes to shared behavior, settle the common interface, ownership and compatibility assumptions. A missing dependency in the tracker is not evidence of independence. If research is needed, delegate a bounded preparation first, then use its report to authorize the dependent implementation. Other independent work can proceed.

Read the immutable artifact links in participant reports, not paths in another live worktree. If material was not attached or is unavailable, request it from its author through the same implement before deciding from it. Distinguish a technical decision request from an exceptional user decision; a blocked report alone does not establish that user approval is needed.

## Reconcile results

Read the reported change and the independent findings together. Distinguish implementation completion, review approval and observed verification. Missing evidence stays missing; a confident summary does not substitute for the required check.

Follow each finding through its correction and subsequent check. Prefer continuing the responsible implementer for fixes. If feedback contradicts another task's contract, identify the conflicting assumptions and send a concrete compatibility assignment. Repeated identical findings without progress need a diagnosis or a decision, not another unchanged request.

## Assess the combined result

Compare shared interfaces, assumptions and user scenarios across completed tasks. Individually passing changes can still disagree about formats, ownership or error handling. Ask for a reproducer that exercises their interaction, then direct the fix to the responsible task.

Track which revision each check covers. After a change, distinguish evidence about an earlier result from checks of the current combined result. Preserve unresolved failures and checks that could not run in the final handoff. Report task outcomes, supporting checks and remaining work concisely.
