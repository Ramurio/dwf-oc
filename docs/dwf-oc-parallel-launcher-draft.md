# Launcher dwf-oc: проверенный материал для синхронизации

Ниже — краткая методическая сводка, не самостоятельный полный скилл.
Кандидат подготовлен из canonical с заменой устаревших советов, а не добавлением
этого документа поверх них. Его исходная редакция проверена двумя независимыми
живыми пробами; последующая поправка entrypoint о пресетах проверена адресно
по публичному CLI, без повторного запуска моделей.
Canonical и установленная копия **не менялись**; синхронизацию выполняет ведущий.

Полная кандидатная копия: `~/.dwf/acceptance/context-implement-20261113/skill-candidate/dwf-oc`.
Текущий SHA-256 manifest: `903ec577cd44be9907ef2a46db6690523033e95a124f20d742c48302d4572752`.
В живых пробах использовался `09f0b21347f22d1752dfab139023ee55c33a8d9ce4f06c38b7cdc59252534aba`;
историческая копия и границы проверок указаны в сводке приёмки.
Изменены только `SKILL.md` и `references/cli.md`; примеры графов валидированы.
Результаты и границы проверок: [приёмка xit.6](context-implement-acceptance.md).
Для синхронизации переносить проверенные изменения этих двух файлов, не весь
этот текст и не сырые журналы. Глобальные модели/defaults не менялись.

## Several implementation tasks

Read the project instructions and task source first. Preserve exact requirements,
acceptance criteria, dependencies and agreed decisions in addressed `taskPackages`.
Keep the original user request as workflow `task`; do not duplicate the backlog
in every role's instructions. Set human-readable package titles for the UI.

For multiple implementation tasks use `implements` inside **one** workflow, with
one instance per task and an explicit, justified concurrency setting. Admit ready
independent tasks together; dependencies wait for integrated results. Do not
replace this with a flat sequential task list or hidden nested `dwf start` calls.
Use the public `dwf schema` to obtain the current definition contract. Build the
graph yourself, then use public `dwf start --file`, `inspect`, and the common UI.

Use shared role templates for each task's worker/reviewer/verifier cycle, and
separate required review/verification of the integrated tree. The orchestrator
issues addressed assignments and integration/revision decisions. DWF performs
integration and preserves conflict materials; send corrections to the responsible
instance rather than rerunning successful independent work. Individual approval
is not approval of the final integrated tree.

Keep responsibilities separate: role system contract defines authority/output,
method skills define work technique, task packages hold requirements, node and
orchestrator assignments hold concrete instructions. Do not repeat these layers
or put CLI workflow launch instructions in participant method skills.

Observe actual status, waiting reasons and events, not just the last summary.
After a failure fix its cause and use `dwf continue <runId>`; do not start a
replacement run or edit the database. Explicit stop and uncertain external
results require the public continuation decision flow, not silent retry. See
[the continuation supplement](dwf-oc-continuation-skill.md).

## Named presets

Inspect the saved definition with `dwf preset show` before choosing how to launch.
Only presets without task packages accept `start --preset ... --task-file`.
For `taskPackages`, explicitly update the addressed packages for the new request
and launch the materialized definition with `start --file`; the task-file shortcut
does not replace package requirements.
