# G1 — приватный Git-доступ к рабочим результатам Studio

**Подготовлено:** 31.10.2026. **Статус:** инструкция для Windows/PowerShell; локальный каталог и приватный репозиторий **не созданы**, Git-синхронизация, Studio и API **NOT RUN**. Пока доступен только публичный `NeuralDao/inkos`; доступ ChatGPT к будущему приватному репозиторию необходимо проверить после его создания. Ни один фрагмент рукописи или ключа не размещён в публичном репозитории.

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

1. В интерфейсе GitHub **создать пустой приватный** репозиторий, например `NeuralDao/inkos-workspace`. **Visibility = Private**, без шаблонных README/LICENSE/.gitignore (чтобы первый push был простым). Не менять приватность на Public впоследствии.
2. В настройках установки **GitHub-приложения ChatGPT** предоставить новому репозиторию доступ, если он выдаётся выборочно. До первой загрузки рукописи попросить ChatGPT проверить, что он **видит репозиторий как приватный**. В данный момент такой репозиторий не создан/не подтверждён.
3. Убедиться, что `C:\Projects\inkos-workspace` не является `C:\Projects\inkos` и не лежит внутри него. Если Studio уже использует другую папку с данными — **не перемещать и не удалять её вслепую**; подставить существующий проектный путь и сначала сохранить резервную копию.
4. В корне рабочего проекта создать **собственный** `.gitignore` (не копировать `.gitignore` публичного исходного репозитория):

```gitignore
# Default deny at project root: no inkos.json, .inkos/, .env, logs, keys.
/*
!/.gitignore
!/works/
!/g1-run.md

# Generated search/cache stores are rebuildable; SQLite sidecars can mutate
# during a Studio operation and should never go into Git.
/works/**/memory.db*
/works/**/*.db
/works/**/*.db-*
/works/**/*.sqlite
/works/**/*.sqlite-*
/works/**/*.sqlite3
/works/**/*.sqlite3-*

# Defensive exclusions for accidental nested secrets and local dependencies.
/works/**/.env
/works/**/.env.*
/works/**/secrets*
/works/**/credentials*
/works/**/api-key*
/works/**/node_modules/
/works/**/.cache/
/works/**/tmp/
```

**Ограничение:** `.gitignore` фильтрует **пути, а не содержимое**. Секрет, случайно записанный *внутрь* главы, JSON-артефакта или prompt-trace, автоматически не обнаружится. Перед первой публикацией и перед каждым push нужно проверить `git diff --cached`; если обнаружен секрет — **не коммитить**, исправить локально и сменить ключ. Даже из приватной истории Git удалить секрет впоследствии непросто. Не использовать `git add -f` для обхода правил.

5. После создания и проверки приватного remote, в PowerShell (`<URL>` заменить фактической HTTPS-ссылкой с GitHub, **без токена в URL**):

```powershell
$workspace = 'C:\Projects\inkos-workspace'
git -C $workspace init -b main
git -C $workspace remote add origin https://github.com/NeuralDao/inkos-workspace.git
git -C $workspace add -- .gitignore
git -C $workspace diff --cached --name-only
git -C $workspace commit -m "chore: initialize private InkOS workspace"
git -C $workspace push -u origin main
```

`git init` и push выполнять **только после проверки пути, приватности remote и сохранения резервной копии при наличии старых данных**. Эти команды не выполнены ChatGPT. Не использовать токены в аргументах или git remote URL.

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

## Что передавать ChatGPT и что анализировать

После каждого завершённого push достаточно написать **ссылку на приватный репозиторий, имя Work и commit SHA (или сообщение «пушнул foundation/главу N»)**. ChatGPT независимо проверяет доступ и актуальный commit, читает `works/<work-id>/work.json`, `source/book.json`, нужный `story/` и `chapters/`, а также изменения с прошлого checkpoint. **Исходники InkOS в приватный репозиторий не дублировать.**

Зафиксировать для сопоставимости G1 в *необязательном* `g1-run.md` **без ключей и секретных конфигов**: `Run ID`, commit исходников InkOS, версия brief R3 v1.0, `service=openrouter`, `model=openrouter/free`, режим `INKOS_OPENROUTER_FREE_ONLY=1`, этап `foundation/chapter-1/2/3`, успех/ошибка, время (достаточно приблизительного), и внешняя статистика OpenRouter Activity. Если нужен снимок настроек `inkos.json`, подготовить **отдельное вручную проверенное резюме только разрешённых полей**, никогда не коммитить сырой файл. Для первой проверки необязательное резюме можно прислать текстом в чат.

**Границы:** ChatGPT не видит локальную незакоммиченную работу и не может сам определить, что Studio «ждёт следующей команды». Он читает только то, что действительно отправлено в GitHub. Не ставить автопуш, webhook и CI, пока не проверены безопасность данных и доступ. Предыдущий G1 [draft PR #13](https://github.com/NeuralDao/inkos/pull/13) — изменения **движка**, отдельный приватный workspace — **данные**, и они не смешиваются. Для первого live G1 по-прежнему нужны отдельные разрешения и техническое ревью PR.

## Критерии готовности перед первым push произведения

- [ ] GitHub repo создан и **Private**, ChatGPT подтвердил доступ к нему
- [ ] Studio project root и путь локального Git **совпадают** (но не с папкой исходников)
- [ ] `.gitignore` исключает `.inkos/`, `inkos.json`, `.env`, SQLite-кэши
- [ ] В staged diff **только выбранный Work**, без ключей/секретов
- [ ] Действие в Studio завершено, файловые записи не продолжаются
- [ ] Известны фактический commit InkOS и checkpoint созданной книги
