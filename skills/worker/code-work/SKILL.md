---
name: code-work
description: Implement or change code, diagnose bugs and regressions, and design interfaces within an assigned task using focused behavioral checks.
license: MIT
metadata:
  author: Ramurio
---

# Code work

## Establish the change

Use the task's agreed requirements and the project's conventions as acceptance criteria. Read the affected code, callers and existing checks before editing. Identify the public interface where the behavior appears, such as a CLI command, HTTP endpoint or exported function.

Choose the simplest solution that fully meets those criteria. Reuse suitable project code, platform features and installed dependencies before adding your own. Preserve behavior callers rely on unless the task changes it. Consider errors, partial completion, retries and concurrency where relevant. Keep refactoring within the task and preserve useful existing coverage.

## Shape the interface

For consequential design choices, compare alternatives against real callers. An interface includes arguments, results, errors, ordering, invariants, configuration and relevant performance constraints. Use the project's vocabulary and architecture.

Keep knowledge local and prefer a small interface that hides substantial implementation complexity. Before adding an abstraction, consider removing it. If removal eliminates forwarding, direct use may be simpler. If it spreads the same rules or setup across callers, the abstraction may earn its place. Add extension points and interchangeable implementations for concrete needs.

Expose behavior that can be checked. Pass external dependencies where substitution is needed. Keep code readable and raise unresolved consequential requirements or design decisions through the host's clarification or completion mechanism.

## Check behavior as you change it

Work one meaningful behavior at a time.

1. Reuse a suitable existing test or add a focused one where coverage is missing. Derive the expected result from the requirements, a worked example or an independent oracle.
2. Run it before changing the implementation. Confirm the failure is caused by the missing or incorrect behavior. Resolve broken setup separately.
3. Make the smallest complete implementation change, then run the check again.
4. Continue with the next behavior. Run relevant regression checks after the changes, including any refactoring.

Test observable results through the public interface. Keep expectations independent of the implementation's algorithm. Avoid coupling tests to private methods or internal call order. Use real local dependencies when practical. Substitute external services, time or randomness where needed for reliable checks. For work without meaningful executable behavior, choose another appropriate check.

## Diagnose a failure

Establish the observed and expected behavior from the report, code, logs and tests. Build a fast, reproducible feedback loop using a focused test, CLI command, HTTP request or replay. Record the failing observation. Reduce input or steps while preserving the symptom when that helps isolate the cause.

For intermittent failures, repeat the scenario and record the failure rate. For slowdowns, measure a baseline under comparable conditions.

Consider plausible causes and the evidence that would distinguish them. Probe the strongest hypothesis, changing one relevant variable at a time. Reconsider alternatives when evidence disagrees. Distinguish a supported cause from an assumption.

Once the cause is supported, use the behavior-checking loop above to verify the fix and retain a regression check where practical. Re-run the original scenario with its full input. Compare performance under equivalent conditions. Remove temporary instrumentation and debug artifacts.

## Report evidence

Summarize the changes, checks actually run and their results. For a bug fix, include the supported cause and before-and-after evidence. State missing checks, remaining uncertainty and what would resolve any blocker. Redact secrets in captured evidence. Follow the host's completion and output-format instructions.
