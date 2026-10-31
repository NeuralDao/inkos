# G1 — полный Architect foundation smoke

**Назначение:** один воспроизводимый прогон реального `ArchitectAgent.generateFoundation()` на одном фиксированном OpenRouter `:free` ID. Проверяются все четыре обязательных structured stages: outline → details → cast index → character cards. Это диагностический harness, не новый runtime и не постоянная конфигурация InkOS.

## Исходная точка

Код для эксперимента — PR #15, проверенный локальный Core build на code baseline:

- PR: https://github.com/NeuralDao/inkos/pull/15
- Code baseline: `ee4c57e496db561b3d0ad9675d604a886e950941`
- Локальные проверки по сообщению пользователя: targeted Vitest 10/10 PASS, Core typecheck PASS, Core build PASS.
- Ветка PR #15 остаётся Draft / NOT MERGED.

Harness находится в отдельной ветке от `custom/main`, потому что это диагностический инструмент, а не часть reasoning fix. Он импортирует локальный `packages/core/dist` и намеренно требует, чтобы локальный checkout был на `ee4c57e` или на более позднем docs-only коммите без изменений Core source. Перед запуском dist должен быть собран из этого проверенного кода. Скрипт проверяет наличие reasoning-fix fingerprint, но не может криптографически доказать происхождение всех файлов `dist`.

## Что делает скрипт

`scripts/g1/architect-foundation-smoke.mjs`

- Загружает Studio-конфигурацию через `loadProjectConfig(projectRoot, { consumer: "studio" })`; API key читается в память и никогда не выводится.
- Разрешает только официальный OpenRouter endpoint, `apiFormat=responses`, бесплатную базовую модель и один из трёх точных candidate IDs.
- Устанавливает `INKOS_OPENROUTER_FREE_ONLY=1` только в дочернем Node-процессе.
- Создаёт `PipelineRunner` с единственным временным `modelOverrides.architect` в памяти. Существующие `inkos.json` и постоянные overrides не меняются.
- Использует профиль `longform-novel` и его обязательные skills.
- Извлекает неизменный R3 v1.0 brief из `fork-docs/BENCHMARK_LONGFORM.md` и записывает SHA-256 brief в отчёт.
- Создаёт только случайный in-memory `BookConfig` (`language=en`, `narrativeLanguage=ru`). Вызывает непосредственно `ArchitectAgent.generateFoundation()`.
- Не вызывает `prepareDraftBook`, `initBook`, `writeFoundationFiles` и не создаёт Work, manifest, Foundation или другие файлы рабочего пространства.
- Через `withExecutionEvidence` и trajectory capture записывает model-call start/prepared/completed/retry, фактические model/provider/API, tool calls, usage, validation errors и применённые skills. Содержимое исходных prompt/context и API key в отчёт не попадает; аргументы четырёх synthetic tool calls и итоговая Foundation включаются для анализа.
- Отдельно оценивает полноту Foundation и приблизительную долю кириллицы. Это диагностические признаки, не литературная оценка.

Опциональный JSON report можно записать только за пределами репозитория и Studio workspace. Без `--output` JSON печатается в stdout.

## Важное ограничение: язык Architect

Текущий `ArchitectAgent.generateFoundation()` выбирает язык промпта по `BookConfig.language` и для `language="en"` явно требует английский результат. Он не использует `narrativeLanguage`. При контракте R3 (`language="en"`, `narrativeLanguage="ru"`) этот прогон проверяет четыре этапа, tool calling и структурную согласованность, но **не квалифицирует русскоязычную Foundation**. В отчёт включено предупреждение и грубая языковая эвристика.

Перед литературным сравнением русской прозы нужен отдельный узкий фикс языкового контракта Architect и его offline-тесты. Этот harness не меняет prompts или Core.

## Результаты базового smoke до полного Architect

Все три модели прошли одинаковый короткий synthetic `submit_foundation_cast_index` fixture: Anna (major), Pavel (minor), Irina (minor).

| Модель | Результат | Prompt / completion / total |
| --- | --- | ---: |
| `nvidia/nemotron-3.5-super-vl:free` | PASS | 470 / 125 / 595 |
| `xingchen-agi/xing4.0-29b-a4b:free` | PASS | 404 / 122 / 526 |
| `cohere/north-mini-code:free` | PASS | 190 / 305 / 495 |

Стоимость в предоставленных выводах отсутствует. Немotron 3 Ultra ранее вернул `MODEL_REQUIRED_TOOL_MISSING`; Gemma 4 получила upstream 429. Эти результаты не заменяют полный Architect test.

## Windows / PowerShell

Скачать скрипт в постоянную папку вне репозитория:

```powershell
$toolDir = "C:\Projects\inkos-review-artifacts\g1-architect-smoke"
New-Item -ItemType Directory -Force $toolDir | Out-Null
Invoke-WebRequest `
  -Uri "https://raw.githubusercontent.com/NeuralDao/inkos/feat/g1-architect-foundation-smoke/scripts/g1/architect-foundation-smoke.mjs" `
  -OutFile (Join-Path $toolDir "architect-foundation-smoke.mjs")
```

Запустить сначала безопасный preflight без LLM API:

```powershell
node C:\Projects\inkos-review-artifacts\g1-architect-smoke\architect-foundation-smoke.mjs `
  --repo-root C:\Projects\inkos `
  --project-root C:\Projects\inkos-workspace `
  --model nvidia/nemotron-3.5-super-vl:free
```

По умолчанию API не вызывается. Preflight проверяет конфигурацию, source baseline, dist fingerprint, разрешение override и профиль. Для каждого кандидата запускается отдельный процесс и один полный Architect foundation.

**Live-вызов требует отдельного разрешения пользователя.** Только после него добавить `--run --confirm-live-llm` и путь отчёта вне рабочих каталогов:

```powershell
node C:\Projects\inkos-review-artifacts\g1-architect-smoke\architect-foundation-smoke.mjs `
  --repo-root C:\Projects\inkos `
  --project-root C:\Projects\inkos-workspace `
  --model nvidia/nemotron-3.5-super-vl:free `
  --run --confirm-live-llm `
  --output C:\Projects\inkos-review-artifacts\g1-architect-smoke\nemotron-super-vl.json
```

Повторить с тем же brief и параметрами для Xing4.0 и Cohere North Mini Code. Скрипт не перебирает модели автоматически и не делает циклических запусков. При FAIL отчёт сохраняет пройденные стадии, ошибки и usage. Фактическую стоимость сверять отдельно с OpenRouter Activity.

## Безопасность и статус проверок

- Синтетический R3 fixture — единственный передаваемый модели материал.
- `modelOverrides` — только in-memory; Studio config и `inkos.json` не изменяются.
- Нет Work/Foundation writes. JSON report — только по явному `--output` и только вне repo/workspace.
- Никаких fallback на платные модели; `INKOS_OPENROUTER_FREE_ONLY=1`.
- Ветка скрипта основана на `custom/main@05a0f0dbbcd0a85f49c731ac1357083ab6b9d10a`; Core source не изменяется.
- ChatGPT не запускал install, build, tests, typecheck, lint, Studio, CI или live API. Синтаксическая проверка скрипта также **NOT RUN**.
