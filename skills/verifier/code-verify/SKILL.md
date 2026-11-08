---
name: code-verify
description: Independently verify implemented behavior by running focused checks and user scenarios, assessing their evidence and reporting reproducible failures or verification gaps.
license: MIT
metadata:
  author: Ramurio
---

# Code verification

## Define what must be demonstrated

Use the original task, agreed acceptance criteria and applicable project instructions. Read the changed behavior and relevant test setup to choose checks that reach its public entry points. Identify the revision being checked when supplied. Treat implementation and review reports as leads to verify.

Match each material requirement to observable evidence. Reuse suitable project checks and supplement them where they miss the requested behavior. Choose expected results from the requirements, worked examples or an independent reference. Keep effort proportional to the task and its failure risks.

## Run meaningful checks

Find the documented test commands and their prerequisites. Confirm that a command actually ran the intended tests, inspect its exit status and relevant output, and account for skipped checks. A passing command is useful evidence only for behavior it exercises.

Exercise the normal user path and relevant boundaries. Include invalid input, existing data compatibility, state persistence, retries, partial failure or concurrency when the change makes them material. Prefer real local components and temporary data. When a substitute is needed for an external dependency, explain which behavior it cannot establish.

For additional checks, use small temporary scripts or direct CLI, API or UI interactions through the real entry point. Assert concrete outcomes, including error effects on state when relevant. Avoid deriving the expected answer with the implementation's own algorithm.

For an intermittent failure, record repeated outcomes and enough conditions to reproduce it. For a performance claim, compare measurements under equivalent conditions. Do not infer a successful measurement from source inspection.

## Preserve the result under test

Check what the commands will write. Keep test data and auxiliary artifacts in temporary locations where possible, using the project's supported configuration. Preserve source files and existing user data. Clean up only resources created for these checks.

If verification changes the implementation, identify the changed revision and report that the original result was not verified. Leave implementation fixes to the responsible participant. A failed setup or unavailable dependency must be distinguished from a demonstrated product defect.

## Report the evidence

For a failure, record the relevant revision, setup, input or command, expected result, actual result and material side effects. Confirm the symptom with a focused repeat when practical. Investigate enough to make the finding actionable without expanding into an implementation task.

Summarize checks actually performed, their results and coverage limits. Separate observed results from earlier reports and assumptions. State which required check remains incomplete and what would enable it. Redact secrets from captured evidence. Use the host's verdict and output format, and base approval on successful required checks of the result being evaluated.
