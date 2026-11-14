# Дополнение операторского скилла dwf-oc

Текст для синхронизации ведущим в исходники внешнего скилла (ramu-skills).
В этом репозитории нет копии операторского `dwf-oc`; встроенные ролевые скиллы
не должны запускать вложенные workflow вместо внешнего оператора.

## Continue after interruption

Use `dwf continue <runId>` for an existing failed/interrupted DWF run, then
`dwf inspect <runId>` or `dwf inspect <runId> --watch`. Correct the reported
provider/environment problem first. Do not replace the run with `start` or
edit SQLite. Preserve its ID, worktree, sessions and recorded evidence.

A deliberately cancelled run requires the user's explicit intent and
`--resume-cancelled`. Never silently undo stop. If continuation is blocked,
read `recovery.reason/problems` and `resolutionTemplate`. Ask the user to
confirm the observed external result, explicitly permit retry, or abort.
Copy the supplied template, fill each action and evidence, and submit it with
`--resolution-file`. Keep its exact operation/attempt/revision/token binding;
refresh and recheck stale decisions. A confirm is user evidence, not a DWF
success or approval. Never infer an unknown command's result or authorize
its repetition yourself. Consult `docs/continuation.md` for the full contract.
