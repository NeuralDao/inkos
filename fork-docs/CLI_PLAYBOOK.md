# Практический CLI-playbook InkOS

Руководство для запуска InkOS из PowerShell без чата и Studio. Команды сверены с CLI текущей ветки `wip/handoff-2026-11-02`; при обновлении сборки синтаксис может измениться. Перед редкой или разрушительной операцией сверяйте `inkos <команда> --help`.

## 1. Подготовка

Нужны Node.js `>=22.16.0`, pnpm и настроенный проект InkOS. `inkos init` создаёт проект; большинство команд ищут `inkos.json` в текущей папке или выше по дереву. Команду создания книги и главы запускайте из project root, а не из папки репозитория.

```powershell
# Репозиторий с исходниками и собранным CLI
Set-Location C:\Projects\inkos-merge-custom-main
pnpm build

# Проект с книгами
Set-Location C:\Projects\inkos-g4-workspace
$cli = 'C:\Projects\inkos-merge-custom-main\packages\cli\dist\index.js'
node $cli --help
```

Если в вашей копии CLI находится в другом checkout, поменяйте только `$cli`. Перед платной командой проверьте, что `$cli` указывает на нужную сборку, текущая папка содержит `inkos.json`, а конфигурация моделей соответствует ожидаемой.

Создание/изменение книг вызывает модели и может тарифицироваться. `--json` меняет формат вывода, но не делает команду бесплатной. Не запускайте один и тот же `write next` повторно, пока не проверили результат первой команды и контрольную точку.

## 2. Рекомендуемый цикл длинной книги

### 2.1 Проверить проект и текущие книги

```powershell
node $cli doctor
node $cli status
node $cli book list
node $cli config show-models
```

`doctor` проверяет окружение; `status` показывает проект/книги; `book list` перечисляет книги; `config show-models` показывает маршрутизацию ролей. `doctor --repair-node-runtime` меняет файлы проекта (`.nvmrc`, `.node-version`), поэтому запускайте его только если это нужно.

### 2.2 Подготовить бриф и создать книгу

Пишите бриф в UTF-8 `.md` или `.txt`. В брифе задайте идею, жанр/тон, главных героев и конфликты, желаемый финал, ограничения и то, что обязано/не должно появиться. Передайте путь через `--brief`:

```powershell
$brief = 'C:\Projects\inkos-g4-workspace\story-brief.md'
node $cli book create `
  --title 'Тихий берег' `
  --genre 'социальная драма' `
  --platform other `
  --target-chapters 8 `
  --chapter-words 1800 `
  --brief $brief `
  --json
if ($LASTEXITCODE -ne 0) { throw 'Создание книги завершилось с ошибкой.' }
```

`--title` обязателен. Остальные флаги: `--genre` (по умолчанию `xuanhuan`), `--platform` (по умолчанию `tomato`), `--target-chapters` (200), `--chapter-words` (3000), `--brief <path>`, `--json`. Значения по умолчанию ориентированы на upstream, поэтому для русской книги явно задавайте жанр, платформу, объём и число глав.

В этой ветке создание длинной книги задаёт языки константами: операционный язык `en`, язык прозы `ru`; флагов `--lang` и `--narrative-lang` у `book create` нет. `book update --lang` меняет операционный язык книги (`en`/`zh`), но не предназначен для переключения языка прозы.

**Проверьте id перед повторным Create.** ID выводится из заголовка. Если сгенерированная директория с таким ID существует, но ещё не является завершённой книгой, текущая команда `book create` может удалить её перед созданием нового фундамента. Для уже существующей/незавершённой книги сначала проверьте `book list`, `work show`, резервные копии и путь Work; не повторяйте Create с тем же заголовком вслепую.

### 2.3 Проверить фундамент и выбрать одну главу

После успешного Create проверьте книгу и её артефакты:

```powershell
node $cli book list
node $cli work list
node $cli work show 'тихий-берег'
node $cli status 'тихий-берег' --chapters
```

ID в примере надо заменить на фактический ID из результата Create. Не запускайте автора, пока фундамент (план, персонажи, правила мира, карта глав) не сохранён и не просмотрен.

Запуск одной главы полным конвейером:

```powershell
node $cli write next 'тихий-берег' --count 1 --words 1800 --json
$writeExitCode = $LASTEXITCODE
if ($writeExitCode -ne 0) { throw "Глава не завершила конвейер (код $writeExitCode). Сначала проверьте статус и используйте write resume." }
.\scripts\check-pipeline.ps1 -BookId 'тихий-берег' -Chapter 1
```

`--count` — число глав за одну команду, по умолчанию `1`. Если нужен контроль после каждой главы, оставляйте `--count 1`. Не используйте `auto` для такого режима: он пишет до указанного номера подряд. `--words` временно переопределяет объём главы; иначе действует настройка книги. `--context <text>` и `--context-file <path>` добавляют разовое творческое указание. Также есть `--quiet` (`-q`) и `--notify`.

### 2.4 Диагностика и продолжение после ошибки

Первым делом сохраните весь терминальный вывод и запустите проверку статуса. Не запускайте `write next` повторно, если глава уже появилась: сначала выясните, завершена ли операция.

```powershell
node $cli status 'тихий-берег' --chapters
.\scripts\check-pipeline.ps1 -BookId 'тихий-берег' -Chapter 1
```

Если команда сообщила, что глава сохранена, но конвейер незавершён, продолжайте **ту же главу**:

```powershell
node $cli write resume 'тихий-берег' 1 --json
$resumeExitCode = $LASTEXITCODE
.\scripts\check-pipeline.ps1 -BookId 'тихий-берег' -Chapter 1
if ($resumeExitCode -ne 0) { Write-Warning "Resume остановился с кодом $resumeExitCode; прочитайте ошибку и таблицу." }
```

`write resume [book-id] [chapter]` берёт сохранённую контрольную точку и продолжает неподтверждённые этапы. Без `book-id` CLI автоматически выберет книгу, только если в проекте она одна; без номера — последнюю операцию этой книги. Команда не начинает следующую главу. При изменившемся исходном тексте, фундаменте, каноне или неоднозначном архиве resume должен остановиться: сначала выясните, какой артефакт менялся. Не удаляйте `.inkos/chapter-runs` и worker archives вручную.

Локальный `scripts/check-pipeline.ps1` находится в workspace книги, а не в репозитории CLI. Его таблица показывает подтверждённые этапы и причины пропусков/ошибок; это диагностический скрипт, он ничего не исправляет и не запускает. После последних изменений advisory post-audit его трактовка может отличаться от runtime — ориентируйтесь также на итоговый JSON и сохранённые артефакты.

### 2.5 После главы

```powershell
node $cli status 'тихий-берег' --chapters
node $cli review 'тихий-берег'
node $cli analytics 'тихий-берег'
```

`review` показывает сохранённые замечания, а не обязательно выполняет новый вызов аудитора. Новая глава может запускать аудит/ревизора автоматически согласно режиму книги. В принятом long-form процессе текст ревизора становится текстом главы после технической проверки; повторный аудит прикладывается как заметки для вычитки и не должен сам по себе отменять редакцию.

## 3. Команды длинной прозы по назначению

### Книга и Work

```text
inkos book create --title <title> [--genre <genre>] [--platform <platform>]
  [--target-chapters <n>] [--chapter-words <n>] [--brief <path>] [--json]
inkos book update [book-id] [--chapter-words <n>] [--target-chapters <n>]
  [--status outlining|active|paused|completed] [--lang en|zh] [--json]
inkos book list [--json]
inkos book backup <book-id> [--list] [--json]
inkos book restore <book-id> <backup-id> [--json]
inkos book delete <book-id> [--force] [--json]
inkos work migrate [--source <path>] [--apply] [--json]
inkos work list [--profile <profile-id>] [--json]
inkos work show <work-id> [--json]
```

`book backup` без `--list` создаёт резервную копию; `book restore` перед восстановлением автоматически сохраняет текущее состояние в backup. `book delete` необратимо удаляет книгу, главы, truth files и snapshots — `--force` только пропускает подтверждение, не добавляйте его в обычные команды. `work migrate` без `--apply` — предварительный просмотр; `--apply` копирует legacy project, исходные папки сохраняются.

### Главы и состояния

```text
inkos write next [book-id] [--count <n>] [--words <n>]
  [--context <text> | --context-file <path>] [--json] [--quiet] [--notify]
inkos write resume [book-id] [chapter] [--json]
inkos write rewrite [book-id] <chapter> [--force] [--words <n>] [--brief <text>] [--json] [--notify]
inkos write sync [book-id] <chapter> [--brief <text>] [--json]
inkos review [book-id] [--json]
inkos status [book-id] [--chapters] [--json]
inkos chapter sync [book-id] [--json]
inkos chapter delete <book-id> [--chapter <n>] [--force] [--json]
inkos revise [book-id] [chapter] [--mode spot-fix|polish|rewrite|rework|anti-detect]
  [--brief <text>] [--json] [--notify]
inkos export [book-id] [--format txt|md|epub] [--output <path>] [--json]
inkos analytics [book-id] [--json]
inkos detect [book-id] [chapter] [--all] [--stats] [--json]
inkos auto [book-id] <target-chapter> [--words <n>] [--json] [--quiet] [--notify]
```

- `write rewrite` повторно генерирует указанную главу; это не восстановление после сбоя. Команда подтверждается перед перезаписью, `--force` пропускает подтверждение.
- `write sync` перестраивает truth/index из уже отредактированного текста, затем запускает аудит. Это не полный resume редакторской цепочки.
- `chapter sync` пересчитывает счётчик слов глав и обновляет index.
- `chapter delete` допускает удаление только последней главы и откатывает index/state; сделайте `book backup` заранее.
- `revise` — отдельная редактура существующей главы. Режимы: точечная правка `spot-fix`, полировка `polish`, переписывание `rewrite`, редактура по замечаниям `rework`, anti-detect `anti-detect`. Может вызывать модель.
- `auto` пишет до целевой главы, включая её; не применяйте, если требуется ручная проверка каждой главы.
- `export` формирует один файл, доступные форматы: TXT, Markdown, EPUB.

### Отдельные роли long-form

`agent run` вызывает одну роль и останавливается; это режим диагностики/сравнения, а не полный pipeline. Результат сохраняется в `.inkos/agent-runs/`.

```text
inkos agent run <role> --book-id <book-id> --chapter <n> [options]
roles: planner, composer, author (writer), auditor, reviser, settler, state-validator
options: --input-file <path> --observations-file <path> --settlement-file <path>
         --stage-context <text> --mode polish|rewrite|rework|anti-detect|spot-fix
         --words <n> --result-json
```

Примеры:

```powershell
node $cli agent run planner --book-id 'тихий-берег' --chapter 2 --result-json
node $cli agent run composer --book-id 'тихий-берег' --chapter 2 --result-json
node $cli agent run author --book-id 'тихий-берег' --chapter 2 --words 1800 --result-json
node $cli agent run auditor --book-id 'тихий-берег' --chapter 2 `
  --input-file 'C:\Projects\inkos-g4-workspace\works\тихий-берег\source\chapters\0002_Глава.md' --result-json
```

`composer` собирает и сохраняет контекст локально, обычно без model call. `auditor`, `author`, `planner`, `reviser`, `settler` и `state-validator` могут вызывать модели. `reviser` требует отчёт аудитора через `--observations-file`; `state-validator` использует результат settlement через `--settlement-file`. Файлы должны относиться именно к этой книге/главе. Отдельный `agent run` не записывает полный результат как завершённую главу и не запускает следующие роли автоматически. Не запускайте главу 2 автором, если глава 1/канон не готовы.

### Конфигурация модели

```text
inkos config show
inkos config show-models [--json]
inkos config set-model <agent> <model> [--provider <openai|anthropic|custom>]
  [--base-url <url>] [--api-key-env <env-name>] [--stream|--no-stream]
inkos config remove-model <agent>
inkos config list-models <service> [--api-key <key>] [--base-url <url>] [--json]
inkos config set <key> <value>
inkos config set-global --provider <provider> --base-url <url> --api-key <key> --model <model>
  [--temperature <n>] [--max-tokens <n>] [--thinking-budget <n>] [--api-format chat|responses] [--lang en|zh]
inkos config show-global
```

Known agent IDs include `architect`, `planner`, `composer`, `writer`, `auditor`, `reviser`, `state-validator`, `actor`, `radar`. `set-model` добавляет override; `remove-model` возвращает агента к default. После изменения сверьте `show-models`. `list-models` может обращаться к API провайдера. Не передавайте настоящий ключ прямо аргументом `--api-key`: он может попасть в историю shell/список процессов; используйте предусмотренную переменную окружения, когда это поддерживается.

Глобальные параметры можно передавать до команды, например `node $cli --model <id> write next ...`: `--service`, `--model`, `--api-key-env`, `--base-url`, `--api-format chat|responses|anthropic`, `--stream`, `--no-stream`. Это override только для текущего запуска и может переопределить ожидаемую конфигурацию ролей. Не применяйте его, если нужен назначенный каждой роли стек.

## 4. Полный каталог CLI

Справка на конкретную команду: `node $cli <команда> --help`; на подкоманду: `node $cli <группа> <подкоманда> --help`. Команды верхнего уровня текущего CLI:

| Команда | Назначение / варианты |
| --- | --- |
| `init [name] [--lang zh|en]` | Создать InkOS project в текущей папке или подкаталоге. |
| `config` | `set`, `set-global`, `show-global`, `show`, `set-model`, `remove-model`, `show-models`, `list-models`. |
| `book` | `create`, `update`, `list`, `delete`, `backup`, `restore`. |
| `work` | `migrate`, `list`, `show`. |
| `chapter` | `sync`, `delete`. |
| `write` | `next`, `resume`, `rewrite`, `sync`. |
| `auto` | Продолжать главы до целевого номера. |
| `review`, `status`, `analytics` (`stats`) | Читать сохранённые замечания, состояние и метрики. |
| `radar scan` | Обзор рыночных сигналов. |
| `up`, `down` | Запуск/остановка фонового daemon; `up --quiet`. |
| `doctor [--repair-node-runtime]` | Диагностика; с флагом исправляет Node pin-файлы. |
| `export` | TXT/MD/EPUB export книги. |
| `revise` | Редактура главы по режиму и brief. |
| `agent <instruction>` | Natural-language agent с tool-use; флаги `--book`, `--work`, `--session`, `--context`, `--context-file`, `--json`, `--quiet`. Может самостоятельно выбрать и выполнить несколько инструментов; для контролируемого полного long-form цикла предпочитайте `book create` и `write next`. |
| `agent run` | Один изолированный long-form агентский этап. |
| `update` | Обновление InkOS; перед применением проверьте источник/версию и сохраните работу. |
| `detect` | AIGC detection одной главы или `--all`, `--stats`. |
| `style import <file> [book-id]` | Компиляция референсного текста в style guide; `--name`, `--json`. |
| `import canon`, `import chapters` | Импорт канона из родительской книги или текстов; см. `--help`, может вызывать модели и менять Work. |
| `fanfic init`, `fanfic show`, `fanfic refresh` | Создание/обновление fanfic Work и просмотр источников; `init`/`refresh` требуют `--from`. |
| `short run`, `short revise` | Отдельный short-fiction workflow с собственными моделями/настройками длины. Не смешивайте его с long-form книгой. |
| `forecast create`, `forecast show`, `forecast select` | Создать, изучить и выбрать неписаную альтернативную ветку сюжета. `create` принимает `--divergence`, `--branches`, `--horizon`, `--model`, `--llm-base-url`, `--json`. |
| `translate init`, `translate run`, `translate export` | Отдельный переводческий pipeline; не является русским long-form writer workflow. |
| `studio [--port <port>] [--project <path>]` | Запуск Studio из CLI. |
| `interact [message...]` | Natural-language interaction; варианты `--message`, `--book`, `--work`, `--session`, `--json`. |
| `tui` | Терминальный UI. |

У всех семейств используйте `--help` для полного перечня параметров, типов и defaults именно установленной сборки. `inkos` без подкоманды запускает Studio; это не команда для написания главы.

Полные варианты вспомогательных семейств:

```text
inkos init [name] [--lang zh|en]
inkos radar scan [--json]
inkos up [--quiet]
inkos down
inkos doctor [--repair-node-runtime]
inkos update

inkos style import <file> [book-id] [--name <name>] [--json]

inkos import canon [target-book-id] --from <parent-book-id> [--json]
inkos import chapters [book-id] --from <file-or-directory> [--split <regex>]
  [--resume-from <n>] [--series] [--json]

inkos fanfic init --title <title> --from <path> [--mode <text>] [--genre <genre>]
  [--platform <platform>] [--target-chapters <n>] [--chapter-words <n>]
  [--lang zh|en] [--json]
inkos fanfic show [book-id] [--json]
inkos fanfic refresh [book-id] --from <path> [--json]

inkos short run --direction <text> [--reference <path>] [--story-id <id>]
  [--lang zh|en] [--chapters <n>] [--chars <n>] [--min-chapter-length-ratio <ratio>]
  [--llm-base-url <url>] [--model <id>] [--planner-model <id>] [--writer-model <id>]
  [--draft-review-model <id>] [--package-model <id>] [--cover-base-url <url>]
  [--cover-endpoint <url>] [--cover-model <id>] [--cover-size <size>]
  [--cover-api-key-env <name>] [--no-cover] [--json]
inkos short revise <story-id> --instruction <text> [--chars <n>] [--model <id>]
  [--chapters <comma-separated-numbers>] [--json]

inkos forecast create [book-id] --divergence <text> [--branches <n>] [--horizon <n>]
  [--model <id>] [--llm-base-url <url>] [--json]
inkos forecast show [book-id] <forecast-id> [--json]
inkos forecast select [book-id] <forecast-id> <branch-id> [--json]

inkos translate init --from <path> --source <lang|auto> --target <lang>
  [--title <title>] [--segment-max-chars <n>] [--json]
inkos translate run <work-id> [--batch-size <n>] [--max-tokens <n>] [--json]
inkos translate export <work-id> [--format md|txt|epub] [--output <path>] [--json]

inkos studio [--port <port>] [--project <path>]
inkos interact [message...] [--message <text>] [--book <id>] [--work <id>]
  [--session <id>] [--json]
inkos tui
```

`init --lang` задаёт язык нового проекта (`zh` по умолчанию или `en`); для long-form книг этого русского форка операционный/нарративный языки задаются отдельно константами создания книги. Переводческие команды — самостоятельная функция upstream и не нужны для генерации русской оригинальной прозы.

## 5. Работа с результатами и файлами

- Work-каталог находится в `works/<book-id>/`; исходные главы — `works/<book-id>/source/chapters/`.
- Runtime artifacts, контрольные точки и диагностика лежат в `.inkos/` внутри project root. Не чистите их, пока не завершили восстановление и не скопировали нужные отчёты.
- После неудачной команды проверьте консольный код `$LASTEXITCODE`, `status --chapters`, chapter index и `check-pipeline.ps1`. Появившийся Markdown-файл сам по себе не означает, что редактура, settlement, state validation и синхронизация завершились.
- Сохраняйте stdout/stderr платных запусков. Для OpenRouter расходы подтверждайте в billing/generation details; локальный tokenUsage не всегда совпадает с биллингом.
- Перед удалением/перезаписью: `book backup <id>`, затем `book backup <id> --list`; операции с `--force` выполняйте лишь после проверки точной книги/главы.

## 6. Форматирование и отладка

Посмотреть команды/версии, не изменяя книгу:

```powershell
node $cli --version
node $cli --help
node $cli write --help
node $cli agent run --help
```

Глобальные параметры ставьте перед подкомандой: `node $cli --model <id> write next ...`. Для PowerShell используйте backtick для переноса строки; не оставляйте пробел после backtick. После каждой платной команды немедленно сохраните `$LASTEXITCODE`, прежде чем выполнять другую команду.

Справка этой ветки отражает текущие команды, но текущий WIP не проверен новой сборкой. Если CLI и исходники разошлись, достоверная фактическая поверхность — `node $cli --help` из той сборки, которую вы запускаете; сообщите её версию и путь.
