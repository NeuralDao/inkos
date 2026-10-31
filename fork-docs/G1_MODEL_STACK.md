# G1 — OpenRouter: текущая стратегия выбора моделей

**АКТУАЛЬНОЕ УТОЧНЕНИЕ 31.10.2026 — reasoning fix и fixed-free qualification:** PR #15 прошёл статический review ACCEPT; пользователь сообщил целевой Vitest **10/10 PASS**, Core typecheck **PASS** и Core build **PASS** на code HEAD ee4c57e496db561b3d0ad9675d604a886e950941. Два fixed-ID smoke: Nemotron 3 Ultra — routing PASS / structured MODEL_REQUIRED_TOOL_MISSING; Gemma 4 — routing PASS / upstream 429 после retry budget. Ни одна из этих двух моделей пока не квалифицирована для Architect; детали ниже. PR #15 открыт и не объединён.

Фикс подготовлен в ветке `fix/g1-openrouter-reasoning-defaults`, [draft PR #15](https://github.com/NeuralDao/inkos/pull/15). Codex исправил два замечания (реальный выбор Chat Completions в тесте; удаление только точной формы `{effort:"none"}`). Повторный статический review ChatGPT: **ACCEPT по коду**. Пользовательский целевой Vitest: **10/10 PASS**; Core typecheck после исправления fetch mock — **PASS по сообщению пользователя**. Implementation commit `7f9bb2a0ed7aef11ab6432db419c5f4fe8a21dfb`; Codex correction commit `35eb7c28ddeb209857fb59380f5aa3144b23947a`; type fix `4f5aa4999eb3816d7dd701c55b6447ab35dee6f5`.

Ограничение: Pi Agent не различает неустановленный уровень и `thinkingLevel="off"` — оба представлены как `reasoning: undefined`. В текущей InkOS схеме нет отдельного поля `thinkingLevel`; явное отключение на уровне provider config остаётся доступным через `extra.reasoning: { effort: "none" }` и сохраняется. Не считать UI-level off гарантированно сохранённым, если такой интерфейс появится в будущем без отдельного контракта.

**Локальная проверка:** пользователь сообщил целевой Vitest openrouter-reasoning.test.ts **10/10 PASS**, Core pnpm exec tsc --noEmit **PASS** и pnpm --filter @actalk/inkos-core build **PASS** на ee4c57e496db561b3d0ad9675d604a886e950941. ChatGPT не запускал эти команды самостоятельно. Lint, E2E и полный Studio smoke — **NOT RUN**. Два live synthetic structured-tool smoke описаны ниже. Merge PR #15 — только по отдельному разрешению.

**РЕШЕНИЕ И ТЕСТЫ НА 31.10.2026 (ПРИОРИТЕТ НАД ОСТАЛЬНЫМ ТЕКСТОМ):** после реального отказа Foundation при динамическом `openrouter/free` пользователь **отказался от него как рабочего G1-стека**; отбираем **конкретные бесплатные `:free` IDs** и проверяем `modelOverrides` до новой книги. При `INKOS_OPENROUTER_FREE_ONLY=1`, `openai-responses`, `modelOverrides.architect` **in-memory routing PASS** для `xingchen-agi/xing4.0-29b-a4b:free` и `dots-studio/dots-3-note-preview:free`. Первые реальные синтетические вызовы `submit_foundation_cast_index` с **3 персонажами** у обоих закончились **одним WORKER_MODEL_ERROR** каждый, причины неизвестны. Затем **Xing4.0 успешно выполнил один короткий отдельный вызов с 2 персонажами**, вернул валидные `roles` при `maxTokens=2048`; это **частичная совместимость**, НЕ проверенная повторяемость и НЕ прохождение исходного 3-ролевого теста. Dots не доказан. **Сохранение Studio modelOverrides, Writer/Reviser и второй Foundation НЕ ЗАПУСКАЛИСЬ**. Прежние рекомендации ниже «G1 только на `openrouter/free`», «API ещё не было», «checkModel не исправлен» **устарели**, не применять. Новая точка входа: [G1_HANDOFF_2026-10-31.md](./G1_HANDOFF_2026-10-31.md).

## Новое испытание: Nemotron 3 Ultra fixed ID (31.10.2026)

Пользователь запустил synthetic harness на локальном Core из ee4c57e496db561b3d0ad9675d604a886e950941, с INKOS_OPENROUTER_FREE_ONLY=1, проектом Studio C:\Projects\inkos-workspace и временным in-memory modelOverrides.architect:

- Requested/resolved/PI model: nvidia/nemotron-3-ultra-550b-a55b:free.
- Preflight: **PASS** — service openrouter, openai-responses, официальный endpoint, ключ присутствует.
- Structured call: **FAIL** — MODEL_REQUIRED_TOOL_MISSING, stopReason=error, resultTool=submit_foundation_cast_index, attempts=1.
- Результат трёхперсонажного cast index не получен. usage=null; фактическая стоимость и serving model пока **UNKNOWN**.
- Это один логический вызов worker, а не три независимые попытки. По коду packages/core/src/agent/pi-stream.ts guardedPiStream делает один transport retry при отсутствии обязательного tool call; после повторного ответа без tool call локальный observeModelStream формирует MODEL_REQUIRED_TOOL_MISSING. Следовательно, attempts=1 в worker не является количеством HTTP-запросов; Activity должна подтвердить число фактических запросов (ожидается initial + один retry).
- Код ошибки **не является HTTP 400/429** и не доказывает, что модель вообще не умеет function calling. Он означает, что завершённый ответ не содержал требуемого tool call после исчерпания одного transport retry.
- usage=null не означает нулевой расход: runWorkerAgentTool вызывает onUsage только после успешного structured результата, а при ошибке выходит раньше подсчёта usage.
- Конфигурация inkos.json, сохранённые Studio overrides и существующий Work не изменялись; новая книга не создавалась. В запросе были только синтетические имена.

**Статус кандидата:** Nemotron 3 Ultra — **NOT QUALIFIED** для Architect по этому тесту (1 structured FAIL; routing PASS). Не повторять его автоматически. Сначала сверить OpenRouter Activity: фактический serving ID для каждого запроса, число запросов, input/output tokens и стоимость. Затем перейти к следующему кандидату — google/gemma-4-26b-a4b-it:free — с тем же synthetic fixture и теми же параметрами. Не назначать постоянные overrides и не начинать Foundation до завершения отбора.

## Новое испытание: Gemma 4 26B A4B fixed ID (31.10.2026)

Пользователь запустил тот же ограниченный synthetic Architect harness с in-memory modelOverrides.architect и точным ID google/gemma-4-26b-a4b-it:free:

- Requested/resolved/PI model: google/gemma-4-26b-a4b-it:free.
- Preflight: **PASS** — service openrouter, apiFormat responses, piApi openai-responses, API key присутствует.
- Structured submit_foundation_cast_index: **FAIL** — WORKER_MODEL_ERROR; causeChain: Error / code WORKER_MODEL_ERROR / message 429 Provider returned error; attempts=1; stopReason=error; usage=null.
- Это отказ провайдера до получения пригодного structured результата. Tool calling **NOT VERIFIED**; результат трёхперсонажного fixture не получен.
- В packages/core/src/llm/provider.ts на code HEAD ee4c57e реализован guardAssistantMessageStream с TRANSIENT_LLM_RETRIES=2. HTTP 429 без видимых stream events распознаётся как transient и повторяется с backoff 800 мс и 1600 мс; следовательно, при одинаковом 429 на каждом ответе один worker turn может содержать до трёх upstream HTTP requests. attempts=1 — один Agent model turn, не число HTTP-запросов. Точное число и serving provider подтвердить OpenRouter Activity.
- usage=null не означает нулевой расход: worker не вызывает onUsage для неуспешного structured результата. Токены и стоимость **UNKNOWN**.
- Не считать Gemma провалившей tool calling: текущий результат подтверждает только upstream 429 после исчерпания retry budget. Не повторять немедленно и не делать циклических smoke.
- Использовались только синтетические данные; persistent Studio overrides и старый Work не менялись.

**Статус кандидата:** Gemma 4 — **BLOCKED / NOT QUALIFIED** по причине provider availability/rate limit; способность выполнять tools не проверена. Вместе с Nemotron 3 Ultra (MODEL_REQUIRED_TOOL_MISSING после одного tool-missing retry) первая пара кандидатов не дала Architect PASS. Сначала сверить OpenRouter Activity для обоих IDs: фактический serving model/provider, число HTTP-запросов, input/output tokens и стоимость. Следующий кандидат по утверждённому порядку — nvidia/nemotron-3.5-super-vl:free. Использовать тот же fixture и один логический тест только после фиксации Activity; не менять persistent overrides и не создавать Foundation.

**Факт исполнения на 31.10.2026 (актуальнее исторических абзацев ниже):** интеграция OpenRouter Free [PR #13](https://github.com/NeuralDao/inkos/pull/13) **MERGED** в `custom/main` (`036f3b59`); fallback исправлен на `openrouter/free`, opt-in `INKOS_OPENROUTER_FREE_ONLY=1` реализован. Core Vitest 126 PASS на HEAD до последнего тестового typefix, Core typecheck PASS, Studio typecheck PASS по сообщению пользователя; Core и Studio локально собраны. **Один реальный synthetic preflight** в `New session`: `G1_PREFLIGHT_OK`, OpenRouter → NVIDIA Nemotron 3 Ultra (free), native **8 495 input / 31 output**, **$0.00**, HTTP 200, `tool_calls`, fallback не зафиксирован. Исторические утверждения ниже «API не выполнялся»/«fallback ещё не исправлен» устарели. `openrouter/free` динамический; реальный endpoint имеет **Training allowed**, NVIDIA предупреждает о логировании для улучшения продуктов. Перед передачей оригинального авторского материала требуется отдельное решение пользователя. Детали: [CURRENT_STATE.md](./CURRENT_STATE.md).

## Актуальное решение от 31.10.2026 — фиксированные бесплатные IDs

**G1 не должен зависеть от случайного исполнителя `openrouter/free`.** Пользователь выбрал стратегию назначать конкретные модели через существующий `modelOverrides`, а не адаптировать архитектуру InkOS к случайным ответам роутера. Динамический `openrouter/free` остаётся для разведочных проверок доступности, но не является рабочей baseline G1.

**Технический статус:** reasoning fix в [Draft PR #15](https://github.com/NeuralDao/inkos/pull/15), статический review ChatGPT ACCEPT; пользователь сообщил целевой Vitest 10/10 PASS и Core typecheck PASS. PR открыт, не объединён. Локальный build и live API после фикса не выполнялись.

**Наблюдение пользователя:** в динамических бесплатных тестах Nemotron пока выглядит наиболее стабильным семейством. Однако точный serving ID каждого запроса не зафиксирован, а `openrouter/free` может выбирать разных исполнителей. Первые литературные образцы выявили смешение языков и сценарное дробление на сцены; они не являются baseline и не доказывают качество конкретной модели.

### Кандидаты

| Приоритет | Точный ID | Публично заявленные возможности | Статус в InkOS |
| --- | --- | --- | --- |
| 1 | `nvidia/nemotron-3-ultra-550b-a55b:free` | 1M контекст; `tools` и `tool_choice`; без `response_format` | Ранее chat preflight был обслужен фактическим ID `nvidia/nemotron-3-ultra-550b-a55b-20260604:free`; direct fixed-ID structured worker не проверен |
| 2 | `nvidia/nemotron-3.5-super-vl:free` | 1M контекст; `tools`, `tool_choice`, JSON-schema `response_format` | Новый кандидат; реальный InkOS tool path и русский текст не проверены |
| 3 | `google/gemma-4-26b-a4b-it:free` | 262K контекст; native function calling; `tools`, `tool_choice`; `response_format` без JSON-schema enforcement | Preflight PASS; structured call завершился `WORKER_MODEL_ERROR` / `429 Provider returned error` после retry budget; tool compatibility NOT VERIFIED; проверить Activity, не повторять немедленно |
| 4 | `xingchen-agi/xing4.0-29b-a4b:free` | 262K контекст; заявлены tool calling и multi-step planning | Один PASS на 2 персонажах; 3-персонажный тест дал 429 Provider returned error; повторяемость не доказана |
| HOLD | `dots-studio/dots-3-note-preview:free` | 512K контекст; reasoning и agent workflows | Единственный structured вызов не прошёл; снятие с OpenRouter заявлено на 31.12.2026 |

Источники: [OpenRouter Free Models](https://openrouter.ai/collections/free-models), [Nemotron 3 Ultra](https://openrouter.ai/nvidia/nemotron-3-ultra-550b-a55b:free), [Nemotron 3.5 Super VL](https://openrouter.ai/nvidia/nemotron-3.5-super-vl:free), [Gemma 4 26B A4B](https://openrouter.ai/google/gemma-4-26b-a4b-it:free), [Xing4.0](https://openrouter.ai/xingchen-agi/xing4.0-29b-a4b:free), [Dots3-Note Preview](https://openrouter.ai/dots-studio/dots-3-note-preview:free). Публичные цены, доступность и карточки меняются; проверять перед запуском.

**Важное ограничение данных:** бесплатные NVIDIA endpoints предупреждают не отправлять confidential information: запросы логируются для безопасности и улучшения продуктов NVIDIA. До отдельного согласия пользователя проверять их только синтетическими данными; не отправлять авторский brief, рукопись, карточки персонажей и приватные артефакты. Цена $0 не отменяет этот риск.

### Протокол квалификации

1. Использовать один и тот же synthetic fixture `submit_foundation_cast_index`: Anna (major), Pavel (minor), Irina (minor).
2. Перед live smoke локально синхронизировать branch PR #15 и пересобрать Core `dist` именно из него: build на этой ветке ещё NOT RUN, а тестовый harness импортирует `packages/core/dist`. Проверять точные IDs через существующий `PipelineRunner.createAgentContext("architect")` + in-memory `modelOverrides.architect` + `runWorkerAgentTool()`; `service=openrouter`, официальный endpoint, `openai-responses`, `tool_choice=required`, `maxTokens=2048`, `temperature=0.8`.
3. Запускать только с `INKOS_OPENROUTER_FREE_ONLY=1`. Не отключать guard, не задавать paid fallback, не записывать overrides в `inkos.json`, не создавать Work.
4. Первый круг Nemotron 3 Ultra и Gemma 4 26B A4B выполнен: оба дали routing/preflight PASS, но structured Architect PASS не получен (Nemotron — MODEL_REQUIRED_TOOL_MISSING; Gemma — upstream 429). Следующий кандидат — Nemotron 3.5 Super VL; Xing4.0 повторять отдельно, если нужно подтвердить прежний результат.
5. Ограничение — один логический тест на модель; остановка при первом 400/429/timeout, без циклических повторов. Записывать requested model, фактический `response.model`/provider или `UNKNOWN`, tool call, stop reason, usage, число prepared requests и безопасную причину ошибки. Фактическую стоимость сверять по OpenRouter Activity.
6. Технический tool PASS не означает литературное качество. После него — отдельный одинаковый короткий творческий тест на русском, затем роль Reviser/Auditor. Для Writer, Reviser и независимых критиков учитывать разные семейства/разработчиков; не назначать роли только по названию или публичным бенчмаркам.
7. После отбора — проверить persistent Studio `modelOverrides` и readback. Новый Foundation и новый Work — только после отдельного решения пользователя.

**PR #14 не использовать для этого эксперимента:** его `qualify-openrouter-models.ps1` ориентирован на платные model IDs, отключает `INKOS_OPENROUTER_FREE_ONLY` и задаёт ненулевой `max_price`. Это отдельный Draft PR и другая задача.

## Исторический стек Selectel v0 (30.10.2026; не активировать)

**30.10.2026.** Исследовательское решение для будущего G1, **не** проверенная baseline и не разрешение на платные API, код или merge. Кодовый срез `custom/main@adb8c56d` (последний кодовой merge `24bdd47c`). Провайдер — **Selectel AI Router**. Точные API-алиасы и фактические цены из кабинета неизвестны. Изученная таблица Selectel `airouter-daily-price.pdf` датирована 12.10.2026.

**Инженерная актуализация (30.10.2026):** [P1.M1 / PR #7](https://github.com/NeuralDao/inkos/pull/7) исправила смешивание метаданных `PiModel`, кэш и перенос credentials; добавила явные `contextWindow/maxTokens`. [P1.M2 / PR #8](https://github.com/NeuralDao/inkos/pull/8) исправила недосчёт usage при structured correction turns (14 целевых Vitest и Core typecheck PASS по Codex). [P1.M3a / PR #9](https://github.com/NeuralDao/inkos/pull/9) унифицировала ключ StateValidator на генерации, ревизии и resync (обычный merge `06f40d1941e6f966c696e826b642c14662878934`; по Codex 2 целевых Vitest и Core typecheck PASS). [P1.M3b-1 / PR #10](https://github.com/NeuralDao/inkos/pull/10) добавила проверенный offline fake-API non-stream маршрут Writer/Settler/StateValidator с разными модельными overrides (обычный merge `17fecf821eb7c4be8041fa1eb159ff8c3959b8f0`; по Codex 1 целевой Vitest и Core typecheck PASS). [P1.M3b-2 / PR #11](https://github.com/NeuralDao/inkos/pull/11) подтвердила offline границу Composer → Writer при разных контекстных окнах: protected overflow при 32K → 4K и полная передача авторского текста при 16K → 32K (обычный merge `1c6a6c972be59e96b9db7cdc6f387ba703e01d0c`; по Codex 2 целевых Vitest и Core typecheck PASS). Скрытые transport retries по-прежнему нельзя считать по итоговой Pi history. Нижеследующие ссылки на более ранний код и описания проблем — **исторические срезы**; текущая инженерная точка входа — [CURRENT_STATE.md](./CURRENT_STATE.md). Реальные Selectel aliases, цены, лимиты, совместимость tool calling/reasoning и G1 по-прежнему не проверены.

## Целевой стек

| Этап | Кандидат модели Selectel | Input / output, ₽ за 1M токенов (с НДС; прайс 12.10) | Цель reasoning |
| --- | --- | --- | --- |
| Architect | DeepSeek V3.2 | 26,51 / 39,31 | Умеренный при необходимости для причинности |
| Planner | Qwen3 235B A22B Instruct 2507 | 11,11 / 44,44 | Без CoT, если модель поддерживает |
| Composer — только реальные LLM-вызовы | Qwen3 235B A22B Instruct 2507 | 11,11 / 44,44 | Минимальный |
| Writer | Qwen3.5 397B A17B | 49,52 / 297,10 | Не включать дополнительный дорогой CoT автоматически |
| Auditor и StateValidator | DeepSeek V3.2 | 26,51 / 39,31 | По сложности проверки |
| Reviser | MiniMax M2.5 | 34,28 / 120,62 | Минимальный достаточный |

**Граница G1:** Settler вызывается через контекст `writer` и наследует **Qwen3.5 397B**. Оставляем это как есть; назначение отдельной дешёвой модели для Settler **перенесено в P3**, после измерения расходов и качества, а не в P1.M. Несогласованность ключей `state-validator`/`stateValidator` в Runner устранена в P1.M3a; non-stream structured transport с двумя разными model aliases проверен offline в P1.M3b-1; реальный Selectel и stream/reasoning остаются непроверенными; контекст Composer → Writer с разными окнами проверен offline в P1.M3b-2 (сохранение protected данных и явный отказ на переполнение), но принудительное сжатие и полный end-to-end Runner flow не тестировались. Исторический риск наследования чужих метаданных `PiModel` устранён в P1.M1 для `modelOverrides`; параметры `thinkingBudget` остаются глобальными. Instruct сам по себе не гарантирует, что Selectel не тарифицирует reasoning.

**Резерв, не обязательный запуск:** Kimi K2.5 для Writer/Reviser при подтверждённом FAIL. Исторически использованная DeepSeek V4.1 Flash — ориентир по биллингу версии 1.8, **не** подтверждение совместимости/качества в версии 2.0.

## Температура: статическая сверка InkOS 2.0 и профиль G1 v0 (30.10.2026)

**Код:** `NeuralDao/inkos custom/main@c130a39edb1be38954247bc91f588e180b5f6cfd` (последний merge исходников `24bdd47c`). **Нет** ни Selectel-запросов, ни гарантии, что конкретный alias принимает эти параметры. Температура — sampling, а не reasoning и не доказательство качества. Таблица ниже показывает **встроенные per-call значения**; это **начальная гипотеза для сохранения baseline, не оптимальные числа для каждого модельного семейства**.

| Реальная операция G1 | Статически передаётся | Код и замечания |
| --- | ---: | --- |
| Architect: новая foundation (outline, details, cast index, cast cards) | **0.8** | `agents/architect.ts:69–77,264–332`; для импортированной foundation — 0.5, для фанфика — 0.7 (не наш G1) |
| Planner: chapter memo | **0.7** | `agents/planner.ts:142–154` |
| Composer: semantic source selection | **0.1** | `agents/composer.ts:468–488`; complete fast path **не вызывает LLM** |
| Composer: semantic-context-compiler / recompilation | **0.1** | `agents/semantic-context-compiler.ts:37–78` |
| Writer: `submit_chapter_draft` | **0.7**, или `temperatureOverride` | `agents/writer.ts:135–155`. Только creative phase |
| Writer: Settler `submit_runtime_state_delta` | **0.3** | `agents/writer.ts:313–327`; **тот же ключ модели `writer`, другая задача и температура** |
| ContinuityAuditor: обычная глава/предревизионный аудит | **0.3** | `agents/continuity.ts:89`, `pipeline/chapter-review.ts:61` |
| ContinuityAuditor: проверка после ревизии | **0.0** | `pipeline/runner.ts:1046–1056`; намеренно строже обычной проверки |
| Reviser: full rewrite, spot-fix plan, spot-fix replacements | **0.3** | `agents/reviser.ts:98–158` |
| StateValidator | **0.1** | `agents/state-validator.ts:71–86` |

**Текущие ограничения, которые должен знать координатор:**
- `models/project.ts:20–34`: `LLMConfig.temperature=0.7` по умолчанию, диапазон схемы **0–2**. `utils/effective-llm-config.ts:320–354` допускает `services[].temperature` и `INKOS_LLM_TEMPERATURE`, но это только **клиентское значение по умолчанию**. Практически все перечисленные агенты передают `temperature` явно, поэтому смена глобальных 0.7 их **не перенастроит**.
- `models/project.ts:78–84`: `AgentLLMOverrideSchema` не допускает `temperature` (как и per-agent `thinkingBudget`). Даже добавление поля в эту схему **само по себе недостаточно**: явные per-call параметры имеют приоритет. Более того, для Writer и Settler одним ролевым значением нельзя безопасно заменить одновременно 0.7 и 0.3.
- `pipeline/runner.ts:1337`: `...(temperatureOverride ? { temperatureOverride } : {})` **теряет корректный 0** при передаче Writer; `writer.ts:135` сам использует корректное `??`. Исправление понадобится только если будет запрошен Writer override `0`.
- `llm/provider.ts:516–532,1487–1492` реализует `clampTemperatureForModel()` для **обычного** `chatCompletion()` с lookup модельной карточки (например, фиксированная 1 у некоторых Kimi на их родном сервисе). Но `agent/worker-agent.ts:312–397` для `submitStructured` идёт напрямую через `guardedPiStream/guardedPiNonStreaming` в `agent/pi-stream.ts:32–145`, **минуя эту модельную проверку**. Именно structured tools составляют основные операции G1. `service-presets.ts` также экспортирует `clampTemperature()` по service range, но не подтверждено использование его на этом пути.
- `agent/pi-stream.ts:74–87` записывает в `model-request-prepared` stream/thinking/лимиты/tool_choice, **но не temperature**. Поэтому существующая execution evidence не доказывает эффективную температуру каждого запроса. `provider.ts:492–500` фильтрует reserved `temperature` для некоторых generic extras, однако `worker-agent.ts:391` добавляет `client.defaults.extra` в structured payload; проверять именно итоговый wire JSON, а не только входную настройку.
- **Точные требования Selectel-моделей не подтверждены** (допустимый диапазон, фиксированное значение, игнорирование поля или обязательное опущение). OpenAI-compatible API сам по себе не гарантирует поддержку всех sampling-параметров у каждого alias. Не подменять официальный Selectel AI Router сведениями об отдельном сервисе Selectel Dedicated Inference и не копировать требования родного Moonshot endpoint на Selectel без проверки.

**Решение для G1 (30.10.2026): оставить штатные per-call температуры InkOS 2.0.** Таблица выше нужна координатору для выбора совместимых моделей и последующей диагностики, **не** для введения независимых регулировок. В коде видна логика разделения творческих и служебных операций, но происхождение значений и наличие их экспериментальной калибровки **не подтверждены**. Глобальную температуру не использовать как способ менять их все.

**P1.M — только совместимость и воспроизводимость:** при офлайн-проверке мультимодельного маршрута убедиться, что текущая температура действительно передаётся в финальный structured-запрос, где это поддерживается, и что конкретный Selectel alias не требует другого значения или отсутствия поля. Если несовместимость подтверждена, предложить **точечный** безопасный фикс после согласования, без общего механизма operation-level overrides. Наличие `temperatureOverride=0` truthy-багa — известное ограничение **неиспользуемого в базовом G1 сценария**; не блокирует G1, пока не нужен именно такой override. Расширенная температурная телеметрия и сравнение температур — после реальных оснований, не обязательные требования G1. Не проводить платный перебор значений ради подбора «оптимума».

## Проверка служебных вызовов и стоимости ролей в P1.M (30.10.2026)

**Статическая сверка:** `custom/main@9d86f3b5b6af149a206c7a2c5ab04a0ceb1f82e3`, исходники после `24bdd47c` без изменений. **Не** проверено моками/платным API. Список служебных операций нужен для интерпретации расходов G1 и R6(b); **специальные новые сценарии оптимизации для P1.M не требуются**.

- **Writer** — `agents/writer.ts:142–195,313–327`: после `submit_chapter_draft` делает **второй** structured LLM-вызов `submit_runtime_state_delta` под тем же `AgentContext`/override-ключом `writer`. Это не «простой подсчёт»: извлекает/изменяет факты, hooks и состояние, что требует качества, но может быть дешевле творческой генерации. `countChapterLength()` вызывается **локально**, без LLM. В G1 Settler наследует **Qwen3.5 Writer**; альтернативная дешёвая модель — только идея P3.
- **Auditor/StateValidator** — `pipeline/runner.ts:1343–1409`, `pipeline/chapter-review.ts`, `agents/state-validator.ts:35–86`: в обычной главе есть отдельный аудит LLM и условная проверка состояния LLM; валидатор **пропускает** модель при полностью совпавших старом и новом state/hooks. Если нужна reconciliation, `pipeline/chapter-state-recovery.ts` ещё раз вызывает **Writer Settler** и валидатор. Не считать каждый вызов обязательным и не считать retry бесплатным.
- **Architect** — `agents/architect.ts:269–332`: новую foundation строит **четырьмя** последовательными structured LLM-вызовами на контексте `architect`: outline, details, cast index, character cards. Карточки создаёт **Architect, не Writer**. Отбор имён и карточки не нужно автоматически переносить на слабую модель без проверки фактического качества.
- **Reviser** — `agents/reviser.ts:98–158`: полный rewrite — один основной вызов, spot-fix без заранее выбранного фрагмента — **один вызов на выбор диапазонов + один на замену**; при явном `targetText` selection-call отсутствует. Оба вызова используют контекст `reviser`. Важен реальный output, не только подсчёт числа calls.
- **Planner/Composer** — Planner делает memo LLM; Composer может обойтись **без LLM на complete fast path**, но при большом контексте вызывает семантические селекторы и компрессор (возможны несколько вызовов). Число вызовов зависит от книги/бюджета.

**Граница P1.M:** в существующих mock/fake-API сценариях проверить реальную модель и параметры штатных вызовов (включая Writer draft/Settler, если тест покрывает главу). **Дефект последнего correction turn в `worker-agent.ts` устранён P1.M2**; отдельные transport retries без сохранившегося usage не восстановлены, реальный биллинг позже сверять в R6(b). Не требовать отдельной полной матрицы всех служебных операций и специальных попыток снизить стоимость. **Смена модели внутри Writer/Settler и другие тонкие назначения — идея P3, не критерий G1.**

## Почему такой выбор

Сначала качество русского текста, валидные структурированные вызовы и сохранение канона; среди подходящих моделей — минимальная стоимость **всех** input, cached input, output, reasoning, correction turns и повторов на **принятую главу**. Writer и полный Reviser имеют дорогой выход; Planner, Auditor, Settler и StateValidator много читают. Composer в основном работает локально. Не внедрять отдельный proxy и не вводить много новых ролей ради эксперимента.

## Исторические измерения — только обезличенные выводы

По личной выгрузке Selectel для InkOS 1.8 (28.10.2026, только DeepSeek V4.1 Flash), отнесённой пользователем к четырём главам: **99 запросов**, приблизительно **1,40 млн входных и 175 тыс. выходных токенов**, **22,8% входа кэшировано**, доля `reasoning_tokens` около **3,1% выхода**. Вход/выход ~8:1. В составе **наблюдаемых расходов** примерно 60,5% — обычный вход, 39,2% — выход. Фактическая сумма начислений примерно **вдвое** выше пересчёта тех же запросов по строке модели из PDF 12.10; причины расхождения неизвестны. **Суммы в рублях, идентификаторы, полные запросы и приватную выписку здесь не публикуем.**

CSV **не содержит меток агентов и глав**: нельзя утверждать, сколько стоил конкретный Writer/Settler, сколько было повторов и какова стоимость одной принятой главы. Это **историческая оценка нагрузки, не baseline G1**.

## Граница между исследованием и реализацией

**Оставшаяся P1.M (только после отдельного согласования):** после интегрированных P1.M1–P1.M3b-2 проверить точные Selectel aliases/transport, `toolChoice=required` на реальном провайдере, режимы stream/reasoning и границы наблюдаемости транспортных повторов; внести лишь необходимые исправления через Codex и точечные offline-тесты. Проверить счёт всех attempts против выписки Selectel без публикации приватных данных. Точечная корректировка reasoning — только при доказанной несовместимости; **отдельная модель Settler не входит в P1.M/G1 и остаётся идеей P3**. Допустимы более глубокие изменения при подтверждённой несовместимости.

**G1:** только после выполнения P1.2b → P1.3a/b → P1.M, локальных проверок и **отдельного пользовательского утверждения моделей, aliases, действующей цены, бюджета и лимита расходов**. Ограниченный paid tool-call preflight — затем три главы неизменного [R3](./BENCHMARK_LONGFORM.md), оценка [R2/R4](./RESEARCH_RU_RUBRIC.md). Сохранить реально проверенные настройки как **baseline v1**.

**Исследовательский статус:** R6(a) и R6(c) **завершены**. R6(b) — анализ реальных затрат по агентам **после G1**, не блокирует начало инженерной P1.M и не требует исследований сейчас. Подробности: [R6-модели](./RESEARCH_R6_MODELS.md), [R6-экономика](./RESEARCH_R6_TOKEN_ECONOMY.md).
