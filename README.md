# DWF — независимое исполнение workflow на OpenCode

DWF исполняет workflow из ИИ-участников с разными ролями. Внешний агент собирает
workflow под поручение пользователя или использует сохранённый пресет.
DWF управляет переходами, возвратом замечаний и интеграцией результата.
OpenCode исполняет участников и хранит их разговоры.

Обычный путь разработки — `worker → reviewer → verifier`. Замечания возвращаются
прежнему worker. После доработки проверки повторяются. При `merge: true`
контроллер выполняет локальный merge после актуальных одобрений reviewer
и verifier. Роль `orchestrator` можно добавить для итогового отчёта.

## Установка и первый запуск

Нужны Git, npm, поддерживаемый Node.js и доступ к приватным репозиториям проекта.
Рекомендуется Node 24 LTS. OpenCode 2.2.5 закреплён в зависимостях.

Следуй [инструкции установки](docs/install.md). Она описывает получение исходников,
`npm ci`, регистрацию `dwf` и `opencode` в PATH, управляющий скилл `dwf-oc`
и авторизацию в отдельном профиле DWF. В конце есть первый запуск с чтением
README через настоящую модель.

После установки открой целевой проект в агенте со скиллом `dwf-oc`, опиши задачу
и критерии готовности. Попроси составить workflow с worker, reviewer и verifier,
возвратом замечаний прежнему worker и `merge: true`. Для всех ролей укажи
`openai/gpt-6.1-sol`, reasoning `high`, обычную скорость.

CLI запускается из каталога целевого проекта. Для разработки нужна чистая
Git-ветка. Агент сохраняет схему вне проекта и выполняет команды.

```sh
dwf schema
dwf start --file /absolute/path/to/workflow.json
dwf inspect <runId> --watch
```

`start` возвращает `runId`. Работа продолжается после выхода CLI и закрытия
наблюдения. DWF создаёт отдельное рабочее дерево. До merge исходная ветка
должна оставаться чистой и на прежнем коммите. Итог интеграции доступен
в `result.integration.status` со значением `merged`.

[Пример схемы и справка CLI](docs/workflow.md) описывают настройки участников,
пресеты, параллельные группы, уточнения и остановку. Для исследований есть
схема [research-mid](docs/research-mid.md).

## Карта проекта

| Путь | Назначение |
| --- | --- |
| [dwf.mjs](dwf.mjs) | Вход CLI, запуск, просмотр, управление и пресеты |
| [workflow-definition.mjs](workflow-definition.mjs) | Проверка схемы, роли, системные инструкции и одобрения |
| [workflow-runtime.mjs](workflow-runtime.mjs), [workflow-groups.mjs](workflow-groups.mjs) | Контроллер, переходы, сессии и параллельные группы |
| [opencode-runtime.mjs](opencode-runtime.mjs) | Собственный сервис OpenCode и модельное исполнение |
| [run-store.mjs](run-store.mjs), [workflow-git.mjs](workflow-git.mjs) | SQLite DWF, рабочие деревья, снимки и локальный merge |
| [research-workflow.mjs](research-workflow.mjs), [workflows/](workflows/) | Исследовательские роли и схема research-mid |
| [role-skills.mjs](role-skills.mjs), [skills/](skills/) | Подключение и копии ролевых скиллов |
| `*.test.mjs`, [acceptance/](acceptance/) | Тесты продукта, Cucumber-сценарии и испытательный контур |
| [docs/](docs/) | Установка, техническая справка и история |

Состояние по умолчанию находится в `~/.dwf` вне целевого проекта.
DWF хранит запуски и пресеты в `dwf.sqlite`, собственный профиль OpenCode
находится в `opencode/`. Корень меняется через `DWF_STATE_DIR`.

## Документация и проверки

- [Установка и первый запуск](docs/install.md), [границы проверки установки](docs/install-verification.md)
- [Workflow, CLI и хранение](docs/workflow.md)
- [Скиллы и проверки проекта](docs/development.md) — `npm test` из каталога DWF
- [История разработки, интервью и эксперименты](docs/development-history.md)
- [Поручение автономного развития](docs/autonomous-goal.md) — действует при отдельном поручении пользователя

Исходники — [Ramurio/dwf-oc](https://github.com/Ramurio/dwf-oc).
