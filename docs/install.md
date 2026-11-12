# Установка на новый компьютер

Выполняй команды в обычном терминале своего пользователя. Основной путь рассчитан
на Bash в Linux. Сначала проверь существующую установку. Сохрани её каталоги,
настройки и команды, если они уже используются.

## 1. Подготовить доступ и Node.js

Потребуются Git, npm и Node.js в PATH. Рекомендуется Node **24 LTS** из
[официальной установки](https://nodejs.org/en/download). DWF поддерживает диапазон
`^22.19.0 || ^24.0.0 || >=26`. При использовании менеджера Node настрой его
инициализацию и версию по умолчанию для новых терминалов и login-shell.
При использовании nvm проверь его загрузку также в неинтерактивном `bash -lc`.

Получи доступ к приватным репозиториям
[Ramurio/dwf-oc](https://github.com/Ramurio/dwf-oc) и
[Ramurio/ramu-skills](https://github.com/Ramurio/ramu-skills).
Войди в GitHub через credential manager или `gh auth login` своим аккаунтом.
Для SSH используй адреса вида `git@github.com:Ramurio/dwf-oc.git`.
Проверь доступ выбранным способом.

```sh
node --version
npm --version
git --version
git ls-remote https://github.com/Ramurio/dwf-oc HEAD
git ls-remote https://github.com/Ramurio/ramu-skills HEAD
```

Также нужны сеть для npm и OpenCode и свой доступ к `openai/gpt-6.1-sol` с
reasoning `high`. Авторизация OpenCode выполняется на шаге 5.
Учётные данные вводи только в штатном процессе входа.

## 2. Установить исходники

Выбери постоянные каталоги. Если они уже существуют, сначала проверь их содержимое
и `git status`. Следующие команды предназначены для свободных путей.

```sh
mkdir -p "$HOME/src"
git clone https://github.com/Ramurio/dwf-oc "$HOME/src/dwf-oc"
git clone https://github.com/Ramurio/ramu-skills "$HOME/src/ramu-skills"
cd "$HOME/src/dwf-oc"
npm ci
./node_modules/.bin/opencode --version
node ./dwf.mjs schema
git rev-parse HEAD
git -C "$HOME/src/ramu-skills" rev-parse HEAD
```

Ожидаются `opencode v2.2.5` и схема DWF. Сохрани обе ревизии для воспроизведения.
Lockfile закрепляет версии зависимостей. Postinstall OpenCode выбирает бинарник
платформы. Оставь scripts и optional dependencies включёнными.

## 3. Зарегистрировать постоянные команды

Проверь занятые имена. На новом компьютере команды и файлы могут отсутствовать.

```sh
type -a dwf opencode
mkdir -p "$HOME/.local/bin"
ls -l "$HOME/.local/bin/dwf" "$HOME/.local/bin/opencode"
```

Если команды уже установлены, сравни пути и версии. Сохрани рабочую установку.
Для свободных имён создай ссылки.

```sh
ln -s "$HOME/src/dwf-oc/dwf.mjs" "$HOME/.local/bin/dwf"
ln -s "$HOME/src/dwf-oc/node_modules/.bin/opencode" "$HOME/.local/bin/opencode"
```

Повторный `ln` вернёт `File exists` и сохранит существующий файл. Проверь ссылки
через `ls -l`. Каталог исходников должен оставаться на выбранном месте.

Добавь следующую строку один раз в действующий login-файл Bash. Используется первый
существующий файл из `~/.bash_profile`, `~/.bash_login`, `~/.profile`.
Если всех трёх нет, создай `~/.profile`. Сохрани остальное содержимое файла.
Для Zsh используй `~/.zprofile`.

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Примени строку к текущему терминалу и проверь команды из другого каталога.

```sh
export PATH="$HOME/.local/bin:$PATH"
hash -r
cd /
command -v node npm dwf opencode
dwf schema
opencode --version
bash -lc 'cd /; command -v node npm dwf opencode; dwf schema; opencode --version'
env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin bash -lc 'node --version; dwf schema; opencode --version'
```

Ожидаются `dwf` и `opencode` из `~/.local/bin` и `opencode v2.2.5`.
Повтори проверку в новом терминале после выхода и входа или перезагрузки.
В Zsh для проверки используй `zsh -lc`.

## 4. Установить управляющий скилл

Ведущий агент получает `dwf-oc` из канонического
[Ramurio/ramu-skills](https://github.com/Ramurio/ramu-skills/tree/main/skills/dwf-oc).
Он составляет workflow и управляет запуском через CLI.
Скиллы участников `code-work`, `code-review`, `code-verify` и другие уже поставляются
с DWF. DWF подключает их автоматически в общем профиле OpenCode.

Для ведущего агента в OpenCode 2.2.5 скопируй весь каталог управляющего скилла.
В нём должна сохраниться инструкция `references/cli.md`.
Если целевой каталог уже существует, сначала сравни версию и сохрани локальные правки.

```sh
OC_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
mkdir -p "$OC_CONFIG_DIR/skills"
cp -R "$HOME/src/ramu-skills/skills/dwf-oc" "$OC_CONFIG_DIR/skills/dwf-oc"
cp "$HOME/src/ramu-skills/LICENSE" "$OC_CONFIG_DIR/skills/dwf-oc/LICENSE"
```

OpenCode 2.2.5 автоматически читает каталог `skills` пользовательского профиля.
Проверь `opencode api skill.list`.
В `data` должен появиться `id: "dwf-oc"`. При первом чтении дай конфигурации
загрузиться и повтори команду. В новой сессии попроси агента загрузить `dwf-oc`
и прочитать `references/cli.md`.

Для другого агента используй его поддерживаемый каталог скиллов.

## 5. Авторизовать участников DWF

Пользователь и участники DWF используют один сервис OpenCode и один вход.
Уже подключённый аккаунт доступен DWF сразу. Для первого входа через ChatGPT
выполни команду в обычном терминале.

```sh
opencode auth login openai --method chatgpt-browser
opencode auth list
opencode models
```

Следуй подсказкам OpenCode и браузера своим аккаунтом.
Сообщи агенту только о завершении входа. `auth list` должен показывать подключённый
OpenAI. В OpenCode 2.2.5 метод `chatgpt-browser` называется `Codex browser (legacy)`.
Он предоставляет каталог Codex с вариантами Sol Fast и Ultrafast. У метода
`Sign in with ChatGPT` в этой версии другой каталог с ограниченным списком моделей.
[Реализация входа Codex](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/plugin/provider/openai.ts)
и [каталог token-sharing](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/plugin/provider/chatgpt.ts).

Выбирай в workflow точное имя из `opencode models`. DWF проверяет доступность
модели и reasoning перед запуском. Для другого способа входа используй
`opencode auth login openai` и подсказки OpenCode.
Вход сохраняется после перезагрузки. DWF подключит общий сервис при следующем обращении.

## 6. Проверить первый запуск

Перейди в каталог целевого проекта. Следующая проверка читает README через
настоящую модель и расходует лимит аккаунта. Файлы проекта сохраняются.
Git для этой проверки необязателен. Схема хранится вне проекта.

```sh
mkdir -p "$HOME/.cache/dwf"
cat > "$HOME/.cache/dwf/first-run.json" <<'JSON'
{
  "task": "Прочитай README проекта и кратко опиши назначение. Не меняй файлы. Если README нет, сообщи об этом.",
  "workspace": "directory",
  "merge": false,
  "entry": "review",
  "roles": {
    "reviewer": {"model": {"provider": "openai", "modelId": "gpt-6.1-sol"}, "reasoning": "high"}
  },
  "nodes": {"review": {"role": "reviewer"}},
  "transitions": {"review": {"approve": null, "changes": null}}
}
JSON
# Сначала перейди в целевой проект через cd.
dwf start --file "$HOME/.cache/dwf/first-run.json"
# Подставь runId из предыдущего ответа.
dwf inspect <runId> --watch
```

Успешный итоговый snapshot содержит `state.status: "succeeded"` и отчёт участника.
Проверь сохранённый результат через `dwf inspect <runId>`.
При `failed`, `blocked` или `service.unavailable` прочитай причину ошибки.

Здесь явно выбраны **GPT-6.1 Sol, high, обычная скорость**.
Для дальнейшей разработки открой `opencode` в чистом целевом Git-проекте.
Попроси ведущего агента загрузить `dwf-oc` и составить процесс
`worker → reviewer → verifier`. Замечания возвращаются прежнему worker.
После доработки снова идут reviewer и verifier.
Укажи всем ролям `openai/gpt-6.1-sol`, `high` и включи `merge: true`.
Добавь само поручение и критерии готовности.

Контроллер DWF выполняет merge после актуальных одобрений проверяющих.
До интеграции сохраняй исходную ветку чистой и на прежнем коммите.
Проверь `result.integration.status: "merged"` в результате запуска.

## Справка и диагностика

### Пути и версии

`npm ci` устанавливает зависимости локально. Регистрация команд выполняется на
шаге 3. Пользователь и DWF используют OpenCode **2.2.5** из одной установки.
DWF проверяет точную версию.
Сохраняй её при обновлениях. Команда `opencode upgrade` изменяет закреплённый бинарник.

Если команда пропала после входа, проверь login-файл и инициализацию Node.
Для non-login терминала без унаследованного PATH добавь строку из шага 3 в
`~/.bashrc` или `~/.zshrc`. При другой версии проверь `type -a opencode`,
порядок PATH и устаревшие aliases. До исправления доступны абсолютные пути
`node "$HOME/src/dwf-oc/dwf.mjs"` и `"$HOME/src/dwf-oc/node_modules/.bin/opencode"`.

### Профили и сохранность настроек

Обычный профиль использует `~/.config/opencode`, `~/.local/share/opencode`
и `~/.local/state/opencode`. DWF добавляет versioned-файлы агентов и скиллов,
а также `plugins/dwf-tools.js` для соблюдения возможностей ролей внутри
DWF-сессий. Пользовательские настройки провайдеров и плагинов сохраняются.

`OPENCODE_CONFIG_DIR`, `XDG_*` и `OPENCODE_DB` выбирают профиль OpenCode для обеих
команд. Используй одинаковое окружение для `opencode` и `dwf`.
Другой `DWF_STATE_DIR` должен быть абсолютным. Он содержит запуски, пресеты
и рабочие деревья. Смена этого каталога сохраняет общий вход и каталог моделей.
Старые запуски продолжают использовать свою сохранённую базу до завершения.

Авторизацию проверяй через `opencode auth list`.
Команда `auth export` выводит секреты. Храни учётные данные вне публикуемых файлов.

### Повторные установки и обновления

Повторный `npm ci` заменяет `node_modules`. Выполняй его после завершения активных
workflow и сессий этой установки. При обновлении исходников сначала сохрани
локальные изменения. Затем обнови зависимости и проверь версии.
Несовместимый сервис требует явного обновления после завершения работы.

Повторное `cp -R` в существующий каталог скилла может создать вложенную копию.
Сначала сравни содержимое и сохрани локальные правки. Затем обнови каталог явно.
Общие скиллы поддерживаются в каноническом `ramu-skills`.

`Repository not found` при clone часто означает отсутствие доступа к приватному
репозиторию. При ошибке postinstall проверь Node, сеть и optional dependencies.
При недоступной модели проверь `opencode auth list` и `opencode models`
в том же окружении, где запускается DWF.
В новых графах задавай обычную модель явно. Текущий fallback обычных ролей DWF
использует `gpt-6.1-sol-ultrafast`.
[Настройки CLI и моделей](workflow.md#настройки-и-хранение).

### Границы проверки

Путь проверен на Linux x64 с временными пользовательскими каталогами.
Физическая перезагрузка, ручной OAuth-вход и вызов настоящей модели в новом
профиле оставлены пользователю. macOS, ARM и Zsh этим прогоном не проверены.
Windows находится вне поддерживаемого пути DWF.
[Результаты изолированной проверки](install-verification.md).

Проверки проекта запускаются через `npm test` из каталога установки.
Для `npm run test:real` нужен отдельный авторизованный профиль.
[Подробности проверок](development.md#проверки).
