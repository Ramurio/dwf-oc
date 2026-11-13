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

## Reconcile results

Read the reported change and the independent findings together. Distinguish implementation completion, review approval and observed verification. Missing evidence stays missing; a confident summary does not substitute for the required check.

Follow each finding through its correction and subsequent check. Prefer continuing the responsible implementer for fixes. If feedback contradicts another task's contract, identify the conflicting assumptions and send a concrete compatibility assignment. Repeated identical findings without progress need a diagnosis or a decision, not another unchanged request.

## Assess the combined result

Compare shared interfaces, assumptions and user scenarios across completed tasks. Individually passing changes can still disagree about formats, ownership or error handling. Ask for a reproducer that exercises their interaction, then direct the fix to the responsible task.

Track which revision each check covers. After a change, distinguish evidence about an earlier result from checks of the current combined result. Preserve unresolved failures and checks that could not run in the final handoff. Report task outcomes, supporting checks and remaining work concisely.
