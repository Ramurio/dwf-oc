Изучи проект. Через скилл dwf-oc запусти единый workflow с orchestrator, который
ведёт задачи Beads: dwf-oc-cuo, dwf-oc-co1, dwf-oc-8ic, dwf-oc-hni, dwf-oc-vku,
dwf-oc-22f, dwf-oc-715, dwf-oc-3af. Требования и зависимости возьми из Beads.

На каждую задачу разверни свой implement внутри общей видимой схемы:
worker ↔ reviewer → verifier → orchestrator. Orchestrator распределяет работу,
возвращает замечания и несовместимости на доработку и разрешает общий merge
после проверки итогового результата. Verifier сам merge не запускает.

Orchestrator и reviewer — Astra 6 xhigh; worker — Sol 6.1 high;
verifier — Sol 6.1 xhigh. У всех обычная скорость.
Соблюдай AGENTS.md, наблюдай запуск до завершения и обновляй Beads по факту.
