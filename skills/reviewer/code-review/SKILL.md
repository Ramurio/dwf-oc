---
name: code-review
description: Review code changes against requirements, tracing correctness, data safety, compatibility, test quality and justified design. Reassess fixes in follow-up reviews.
license: MIT
metadata:
  author: Ramurio
---

# Code review

## Understand the change

Use the original task, agreed requirements and applicable project instructions as the review criteria. Treat the implementation report as claims to check against the code. Preserve project files and work within the available review permissions.

Use the supplied base, target revision and complete diff, including uncommitted changes. Cover every changed-file section, continuing past truncated output. Read the relevant current files and follow changed behavior into callers, dependencies and tests. Trace how inputs become outputs or stored state. For an empty diff, establish whether the requested behavior already exists.

Identify missing or inconsistent material that prevents a required review through the host's completion mechanism. Judge load and operating conditions from the requirements and project evidence, and state consequential assumptions.

## Check requirements and implementation

First account for each requested behavior. Identify missing or partial implementation, incompatible behavior and additions outside the agreed scope. Check documented project conventions alongside the requirements.

Then examine the affected execution paths.

- **Correctness and compatibility.** Trace normal and invalid inputs, edge cases, errors and callers' existing expectations. Include existing data formats when relevant.
- **Safety and reliability.** Inspect input validation, access checks, sensitive data handling and writes. Consider partial failure, retries and concurrent operations where they can affect the changed behavior.
- **Load and performance.** Look for unbounded growth, repeated work, expensive queries and races at the expected scale. Distinguish an observed slowdown from a potential cost inferred from code.
- **Tests.** Check meaningful assertions on observable behavior, independently justified expected values and whether a test can catch the claimed regression. Check that mocks still exercise the relevant path and useful existing coverage survives. For missing coverage, name the risky behavior that could fail unnoticed.
- **Design and scope.** Assess interfaces through actual callers, including errors, ordering and invariants. Look for duplicated rules, scattered responsibilities, unnecessary forwarding or speculative configuration. Explain the concrete maintenance cost before requiring restructuring. Existing project abstractions and constraints may justify a design that initially looks unusual.

## Confirm and report findings

Before reporting a defect, trace a reachable input or situation to the incorrect result, or cite the requirement or documented rule it violates. Recheck guards, callers and intended limitations that might invalidate the finding. A comment describing a shortcut is context to assess against the task and operating conditions.

Separate required corrections from optional improvements and unresolved hypotheses. A stylistic preference or possible code smell needs investigation and a concrete justification before becoming a required change. Prioritize by consequence and suggest the smallest correction that preserves the required behavior.

Number findings. For each required correction, give the location, triggering conditions, consequence and supporting evidence. Distinguish static reasoning, checks you performed and results reported by others. Summarize the reviewed scope and material limitations, then use the host's result format and completion rules.

## Review the revision

Check prior findings against the current revision, carry forward unresolved problems and inspect fixes and their affected paths for regressions. Reopen a resolved finding when new evidence warrants it. Apply the same criteria across rounds, and require additional work only for an evidenced defect, unmet requirement or required check.
