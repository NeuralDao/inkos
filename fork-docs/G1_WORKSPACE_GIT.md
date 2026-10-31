# G1 — приватный Git-доступ к рабочим результатам Studio

**Подготовлено:** 31.10.2026. **Статус:** [NeuralDao/inkos-workspace](https://github.com/NeuralDao/inkos-workspace) **создан и проверен как Private через GitHub**; у подключённого ChatGPT есть read/write. В `main` безопасно инициализированы `.gitignore` и пустой `g1-run.md`. Локальный каталог и синхронизация с ним **не проверены**, Studio, API и генерация **NOT RUN**. Рукописи и ключи не загружены.

## Решение

Хранить исходники и документацию в публичном `NeuralDao/inkos`, а **результаты генерации и сохранённые состояния книги — в отдельном приватном репозитории** (рабочее имя `NeuralDao/inkos-workspace`). **Не делать `git add -f` в публичном `inkos`:** его `.gitignore` правильно исключает `works/`, `inkos.json`, `.inkos/` и пользовательские данные. Приватный репозиторий не является заменой резервной копии; не включать в него ничего, что нельзя доверить GitHub.

Для Studio задать отдельный project root, например `C:\Projects\inkos-workspace`. Подтверждение кода: `packages/studio/src/api/index.ts` вычисляет root по аргументу CLI, затем по `INKOS_PROJECT_ROOT`, затем по `cwd` (**аргумент имеет приоритет**). `packages/core/src/harness/work-store.ts` задаёт `works/<work-id>/work.json`; `StateManager.bookDir()` использует `works/<work-id>/source/`. Это каталог конкретной книги, а не старый корневой `books/`. Проверено по `custom/main` 31.10.2026.

Пример фактической структуры после создания Work:

```text
C:\Projects\
  inkos\                              # исходники, публичный Git
  inkos-workspace\                    # отдельный проект Studio, приватный Git
    .git\                             # локальная Git-служебная папка
    .gitignore                         # разрешить только works/ и безопасные заметки
    inkos.json                         # только локально, В GIT НЕ ПОПАДАЕТ
    .inkos\secrets.json               # только локально, В GIT НЕ ПОПАДАЕТ
    works\
      <реальный-work-id>\
        work.json                      # manifest
        source\
          book.json                    # конфиг книги (не конфиг ключей)
          story\                      # канон, планы, персонажи, state, context/trace
          chapters\                   # главы, версии/ревизии
```

Не угадывать `work-id` по русскому названию: прочитать созданную папку из `works/`. `book.json` — настройки книги, `inkos.json` — настройки проекта (с возможными секретными полями), путать их нельзя. В Work могут присутствовать другие файлы и snapshots: отслеживать именно фактически созданные файлы, а не исчерпывающий выдуманный список.

## Один раз за компьютером: настройка без изменения исходников InkOS

**Уже готово на GitHub (проверено через подключённое приложение):** `NeuralDao/inkos-workspace`, **Private**, ветка `main`, права ChatGPT read/write. `.gitignore` и `g1-run.md` находятся в приватном remote. **Не делать `git init` и не создавать второй первый commit:** достаточно клонировать этот репозиторий.

**Локально, PowerShell 7:**

```powershell
$workspace = 'C:\Projects\inkos-workspace'
if (Test-Path -LiteralPath $workspace) {
  Write-Warning 'Каталог уже существует. Не клонировать и не перезаписывать данные; сначала проверить его содержимое.'
} else {
  git clone https://github.com/NeuralDao/inkos-workspace.git $workspace
}
```

После успешного `clone`, проверить именно этот каталог:

```powershell
git -C 'C:\Projects\inkos-workspace' remote -v
git -C 'C:\Projects\inkos-workspace' branch --show-current
git -C 'C:\Projects\inkos-workspace' status --short
```

Ожидается `origin` с адресом **приватного** `NeuralDao/inkos-workspace`, ветка `main`, чистое дерево. Если `C:\Projects\inkos-workspace` уже существует, или Studio ранее работала с другой папкой, **не перемещать/перезаписывать данные**: выяснить фактический project root и наличие книг, сохранить резервную копию и только затем выбирать способ подключения.

**Правило безопасной выгрузки:** текущая `.gitignore` фильтрует пути, **не содержимое**; даже приватному GitHub не должны передаваться ключи. `inkos.json`, `.inkos/secrets.json`, `.env*` остаются локальными, как и SQLite-проекции памяти. Перед публикацией сверять `git diff --cached` и фактический `remote`; скрипт ниже дополнительно проверяет характерные префиксы ключей, но не заменяет ручного просмотра.

**Инициализация нового проекта до запуска Studio:** в `packages/cli/src/commands/studio.ts` запуск `inkos studio --project <path>` автоматически создаёт `inkos.json` при его отсутствии, но сейчас задаёт `language: zh`. Для G1 явно создать рабочую конфигурацию **`en`** через CLI `inkos init --lang en` в корне именно `inkos-workspace`, до первого запуска Studio. `packages/cli/src/project-bootstrap.ts` проверяет отсутствие `inkos.json` и не перезаписывает существующий проект; добавляет служебные файлы (`.env`, `.nvmrc`, `.node-version`) и дополняет существующий `.gitignore`, поэтому после инициализации необходимо ещё раз проверить tracked diff. **Это локальная конфигурационная операция, а не запуск генерации или LLM API.**

```powershell
$workspace = 'C:\Projects\inkos-workspace'
$cli = 'C:\Projects\inkos\packages\cli\dist\index.js'
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
  Write-Warning 'CLI dist не найден. Не запускать install/build без отдельного согласования; проверить локальную установку.'
} elseif (Test-Path -LiteralPath (Join-Path $workspace 'inkos.json')) {
  Write-Warning 'inkos.json уже существует; не перезаписывать.'
} else {
  Push-Location -LiteralPath $workspace
  try { node $cli init --lang en } finally { Pop-Location }
}
git -C $workspace status -sb
```

После этого конфигурацию сервиса OpenRouter и ключ заполнять через штатный интерфейс Studio **только локально**. `inkos.json` нельзя добавлять в Git независимо от его содержимого, `.inkos/secrets.json` также остаётся локальным.

**Настройка Studio:** указать локальный `$workspace` как отдельный project root — `packages/studio/src/api/index.ts` читает сначала аргумент запуска, затем `INKOS_PROJECT_ROOT`, затем рабочий каталог процесса. Запущенный ранее процесс необходимо остановить перед корректным запуском с новым root. Сами команды запуска Studio и проверки требуют отдельного разрешения и сверки локальной установки; не пытаться создавать книгу, пока [PR #13](https://github.com/NeuralDao/inkos/pull/13) не прошёл согласованные проверки/приёмку и не интегрирован по решению владельца.

## Цикл G1: один завершённый шаг Studio → один Git checkpoint

Сначала настроить Studio на этот project root, затем выполнять отдельные завершённые действия: создание `foundation` (Architect), `Write Next` для главы 1, далее 2, далее 3. **Не синхронизировать во время записи файлов, при активной генерации или в середине ревизии**; дождаться успешного завершения действия и убедиться, что Studio показывает готовый результат.

Узнать реальный ID:

```powershell
$workspace = 'C:\Projects\inkos-workspace'
Get-ChildItem (Join-Path $workspace 'works') -Directory | Select-Object Name
```

Для каждой контрольной точки, указав найденный ID (может содержать кириллицу):

```powershell
$workspace = 'C:\Projects\inkos-workspace'
$workId = '<реальный-work-id>'
git -C $workspace add -A -- "works/$workId"
git -C $workspace diff --cached --name-only
git -C $workspace diff --cached --stat
git -C $workspace diff --cached --check
# До commit просмотреть staged содержимое/секреты:
git -C $workspace diff --cached
# Только после проверки, что remote приватный, изменения относятся к ОДНОЙ книге и секретов нет:
git -C $workspace commit -m "G1: foundation checkpoint"
git -C $workspace push origin main
```

При переходе к главе 1/2/3 менять только сообщение коммита, например `G1: chapter 1 checkpoint`. Это **ручной контрольный цикл** без автоматической отправки/развёртывания. Если Git сообщит `nothing to commit`, не считать ошибкой генерации: сначала сверить actual project root и реальные новые файлы. Если статус не закончен, **не пушить**.

Для нескольких книг не использовать бездумное `git add -A` на корне: оно захватит все пользовательские Work. Путь `works/$workId` ограничивает staged изменения конкретной книгой. Проверить также файлы, которые могли быть staged ранее.

### Необязательная команда-обёртка (без Codex и ручного ZIP)

После синхронизации публичного кода `C:\Projects\inkos\` с обновлённым `custom/main` доступен [fork-docs/workspace/Save-G1Checkpoint.ps1](./workspace/Save-G1Checkpoint.ps1). Скрипт **подготовлен и статически прочитан, но НЕ запускался (NOT RUN)**. Он не создаёт репозиторий и не настраивает Studio; сначала нужно выполнить одноразовые шаги выше. В отличие от ручного `git add`, он проверяет, что:
- Git-root действительно совпадает с выбранным workspace, ветка `main`, а `origin` не ведёт в публичный `NeuralDao/inkos`;
- `.gitignore` запрещает файлы корня, секретные пути уже не отслеживаются;
- staged пути относятся **только** к выбранному `workId` и, при наличии, к `g1-run.md`;
- SQLite и подозрительные пути секретов не добавлены; выполняется поиск типичных префиксов API-ключей **в staged текстах без вывода совпадений**, а также `git diff --cached --check`. Эта простая проверка **не обнаруживает все возможные секреты** — ручной просмотр остаётся обязательным.

По умолчанию скрипт **только готовит staged diff**, не выполняет commit/push:

```powershell
$checkpoint = 'C:\Projects\inkos\fork-docs\workspace\Save-G1Checkpoint.ps1'
& $checkpoint -WorkId '<реальный-work-id>' -Label 'foundation'
git -C 'C:\Projects\inkos-workspace' diff --cached
```

После просмотра diff и **проверки Private в GitHub** повторить для тех же staged данных:

```powershell
& $checkpoint -WorkId '<реальный-work-id>' -Label 'foundation' -Publish -PrivateConfirmed
```

Будет отдельное ручное подтверждение `PUSH`. Флаг `-PrivateConfirmed` — **утверждение самого пользователя**, не автоматическая проверка видимости; перед первым отправлением рукописи ChatGPT должен проверить её через подключённый GitHub. Если push не удастся после commit, **не делать reset**: локальный commit сохранён, отдельно разобраться с `git push origin main`. Если нужна ещё более простая автоматизация после успешного первого цикла, обсудить её на фактической установленной среде, без CI и автопуша.


## Что передавать ChatGPT и что анализировать

После каждого завершённого push достаточно написать **ссылку на приватный репозиторий, имя Work и commit SHA (или сообщение «пушнул foundation/главу N»)**. ChatGPT независимо проверяет доступ и актуальный commit, читает `works/<work-id>/work.json`, `source/book.json`, нужный `story/` и `chapters/`, а также изменения с прошлого checkpoint. **Исходники InkOS в приватный репозиторий не дублировать.**

Зафиксировать для сопоставимости G1 в *необязательном* `g1-run.md` (готовый [безопасный шаблон](./workspace/g1-run.template.md), скопировать в корень **приватного** workspace) **без ключей и секретных конфигов**: `Run ID`, commit исходников InkOS, версия brief R3 v1.0, `service=openrouter`, `model=openrouter/free`, режим `INKOS_OPENROUTER_FREE_ONLY=1`, этап `foundation/chapter-1/2/3`, успех/ошибка, время (достаточно приблизительного), и внешняя статистика OpenRouter Activity. Если нужен снимок настроек `inkos.json`, подготовить **отдельное вручную проверенное резюме только разрешённых полей**, никогда не коммитить сырой файл. Для первой проверки необязательное резюме можно прислать текстом в чат.

**Границы:** ChatGPT не видит локальную незакоммиченную работу и не может сам определить, что Studio «ждёт следующей команды». Он читает только то, что действительно отправлено в GitHub. Не ставить автопуш, webhook и CI, пока не проверены безопасность данных и доступ. Предыдущий G1 [draft PR #13](https://github.com/NeuralDao/inkos/pull/13) — изменения **движка**, отдельный приватный workspace — **данные**, и они не смешиваются. Для первого live G1 по-прежнему нужны отдельные разрешения и техническое ревью PR.

## Критерии готовности перед первым push произведения

- [ ] GitHub repo создан и **Private**, ChatGPT подтвердил доступ к нему
- [ ] Studio project root и путь локального Git **совпадают** (но не с папкой исходников)
- [ ] `.gitignore` исключает `.inkos/`, `inkos.json`, `.env`, SQLite-кэши
- [ ] В staged diff **только выбранный Work**, без ключей/секретов
- [ ] Действие в Studio завершено, файловые записи не продолжаются
- [ ] Известны фактический commit InkOS и checkpoint созданной книги
