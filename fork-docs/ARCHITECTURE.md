# Инвентаризация архитектуры InkOS 2.0

**Проверено:** 29.10.2026, `NeuralDao/inkos@custom/main`, исходный коммит `d05b455992fd377adcfac81e2fb68ea1898eb282` (изменения только в документации поверх кодового `2de9ac5`). Анализ выполнен чтением кода GitHub **без** сборки и запуска LLM.

## Релиз и кодовая база — не одно и то же

- Последний опубликованный GitHub Release upstream при проверке: **v1.8.0 от 17.08.2026** ([релиз](https://github.com/Narcooo/inkos/releases/tag/v1.8.0)).
- В `master` upstream и манифестах форка указана **2.0.0**, но это текущая версия **разработки**, не подтверждённый релиз 2.0.
- Сравнение `Narcooo/inkos v1.8.0...master` на дату проверки показывало **110 коммитов** после v1.8.0. Возможности и настройки 1.8 нельзя автоматически приписывать 2.0 и наоборот.

## Структура монорепозитория

| Часть | Где искать | Назначение |
| --- | --- | --- |
| Core | `packages/core/src/` | Схемы данных, LLM, агенты, контекст, хранилище, конвейеры |
| CLI / TUI | `packages/cli/src/` | `inkos init`, создание книги, написание, аудит, редактура, управление и терминальный интерфейс |
| Studio | `packages/studio/src/` | React/Vite-клиент, API-сервер и UI |
| Профессиональные Skills | `packages/core/skills/` | 19 каталогов Skills, в том числе `inkos-long-writing`, `inkos-story-review`, `inkos-story-deslop` |
| Запуск и CI | `package.json`, `pnpm-workspace.yaml`, `.github/workflows/` | Зависимости, сборка, проверки, публикация |

Node.js: `>=22.16.0` по манифесту. Локальная приоритетная среда форка — **Windows/pwsh**.

## Продолжительная генерация: проверенные точки входа

- `packages/cli/src/commands/init.ts` — инициализация рабочего проекта; `inkos.json` принадлежит **проекту книги**, не корню репозитория исходников.
- `packages/cli/src/commands/book.ts` — создание книги, включая `Architect` и исходные документы.
- `packages/core/src/harness/builtin-profiles.ts` — `longform-novel` с обязательным `inkos-long-writing` и рекомендованным `inkos-story-review`; есть профили других форматов.
- `packages/core/src/pipeline/runner.ts` — основной оркестратор: подготовка контекста/плана, `WriterAgent`, `ContinuityAuditor`, проверка/фиксация состояния, сохранение главы.
- `packages/core/src/agents/writer.ts` — творческая генерация главы и отдельная стадия расчёта изменений состояния.
- `packages/core/src/pipeline/chapter-review.ts` и `packages/core/src/agents/continuity.ts` — литературное ревью с наблюдениями и ссылками на строки/источники. В просмотренном пути `write next` аудит возвращает наблюдения; сам `reviewChapterDraft` не переписывает главу.
- `packages/core/src/agents/reviser.ts` — отдельные режимы `polish`, `rewrite`, `rework`, `anti-detect`, `spot-fix`.
- `packages/core/src/agents/detector.ts` — **внешнее определение AI-текста** (GPTZero/Originality/custom), **не литературный аудитор**. Прежнюю гипотезу о порогах «строгости аудитора» в этом файле отклонить.

Не переносить структуру генерации 1.8 на 2.0 без проверки: здесь используется общий агентский harness и версия профилей/Skills.

## Контекст, рукописи и источники

- `packages/core/src/harness/agent-context.ts`, `context-compiler.ts`, `contracts.ts`, `work-store.ts` — контекстная модель, профили и Work-манифесты.
- `packages/core/src/agents/base.ts` — подключение активированных Skills, авторского запроса, Work и компилятора контекста к агенту.
- `packages/core/src/retrieval/local-search.ts` — локальный индекс поиска на `node:sqlite` и FTS5, перестраиваемая проекция; исходники документов остаются авторитетными.
- `packages/core/src/state/` и `packages/core/src/pipeline/chapter-persistence.ts` — состояние и сохранение глав.
- `packages/core/src/harness/work-store.ts` — манифест `works/<work-id>/work.json`, исходные артефакты Work живут в рабочем проекте.
- `.gitignore` исключает `works/`, `books/`, `inkos.json`, `.inkos/` и секретные env-файлы; **не** копировать рукописи и пользовательские данные в публичный GitHub.

## Языки — подтверждённый системный пробел для цели форка

Сейчас валидаторы `packages/core/src/models/book.ts` и `project.ts` поддерживают только `zh` / `en`. Та же пара зашита в `packages/cli/src/localization.ts`, `packages/cli/src/commands/init.ts`, `packages/studio/src/lib/app-language.ts`, `packages/studio/src/pages/LanguageSelector.tsx`, а также в нескольких агентах.

**Важно:** `packages/core/src/utils/length-metrics.ts` считает `en_words` латинской регуляркой, а `zh_chars` — непробельными символами. В `packages/core/src/utils/source-text.ts` есть **другой** латинский счётчик `englishWords` для измерений исходного документа. Потребители метрик: `state/chapter-word-sync.ts`, `pipeline/runner.ts`, `pipeline/chapter-review.ts`, а также короткая проза в `agents/short-fiction.ts`. Проверить различия целей метрик и зависимости, не заменять все регулярки без разбора.

**Решение форка 29.10.2026:** оставить внутренний английский язык промптов, Skills, планов/карточек/JSON и вводить русский только для художественной читательской выдачи (в первую очередь структурированный Writer и Reviser). Для корректного подсчёта — отдельный Unicode-aware путь без ломки `en_words`/`zh_chars`; точная схема подлежит исследованию при реализации. Исторический патч v1.8 на `inferLanguage` включал кириллицу и позволял использовать `en` вместо случайного `zh`; в 2.0 такого модуля нет. Не переносить глобальную инъекцию `RU_SURFACE_CONTRACT`: Writer 2.0 использует `runWorkerAgentTool`, а не только `runWorkerAgent`. Подробности и критерии: [ROADMAP.md](./ROADMAP.md).

## Модели и бюджет

- `packages/core/src/models/project.ts` уже имеет `modelOverrides`: строка модели либо объект `AgentLLMOverride` с моделью, провайдером, baseUrl, apiKeyEnv и stream.
- `packages/core/src/pipeline/runner.ts` уже применяет per-agent overrides через `resolveOverride()` и `agentCtxFor()`. **Новый роутер с нуля не нужен.**
- `packages/core/src/llm/provider.ts` использует `@mariozechner/pi-ai`; `thinkingBudget` и `temperature` присутствуют в общей `LLMConfigSchema`, но per-agent-схема не имеет отдельных полей reasoning и temperature. Возможности провайдеров и реальное действие параметров требуют отдельной проверки.
- В конвейере учитываются `promptTokens`, `completionTokens`, `totalTokens`. Полнота учёта всех стадий и денежной стоимости **не проверялась**.

## Windows / сборка / тесты

- В `custom/main` коммит `2de9ac5` добавил `concurrently`, `cross-env`; в `packages/studio/package.json` по-прежнему `INKOS_PROJECT_ROOT=../..`, что непригодно как универсальный путь к проекту книги.
- В корневом `package.json` текущие pnpm-политики лежат в поле `pnpm`; совместимость с локальным pnpm 12 требует отдельной проверки/исправления.
- `.github/workflows/ci.yml` запускается для `master`, `main`, но не для `custom/main`; CI использует pnpm 9, и его прохождение на текущей ветке **не подтверждено**.
- В `core`, `cli`, `studio` присутствуют многочисленные unit и flow-тесты. Наличие тестов не равняется их успешному прохождению.

## Границы выводов

Это **статический обзор ключевых файлов**, а не полный аудит архитектуры, совместимости или литературного качества. Локальную копию, Windows-сборку, Studio, платные LLM и полный тестовый набор не запускали. Новую реализацию начинать только после отдельного согласования.
