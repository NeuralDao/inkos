# G1 — OpenRouter: текущая стратегия выбора моделей

**АКТУАЛЬНОЕ УТОЧНЕНИЕ 31.10.2026 — reasoning fix и fixed-free qualification:** PR #15 прошёл статический review ACCEPT; пользователь сообщил целевой Vitest **10/10 PASS**, Core typecheck **PASS** и Core build **PASS** на code HEAD ee4c57e496db561b3d0ad9675d604a886e950941. На одном и том же трёхперсонажном `submit_foundation_cast_index` synthetic smoke теперь **3 PASS**: Nemotron 3.5 Super VL (470/125 tokens), Xing4.0 (404/122), Cohere North Mini Code (190/305). Все три вернули Anna major, Pavel minor, Irina minor; суммарно 1616 tokens. Nemotron 3 Ultra — MODEL_REQUIRED_TOOL_MISSING; Gemma 4 — upstream 429. Три PASS подтверждают базовую совместимость fixed IDs с обязательным structured tool call, но не полный `ArchitectAgent.generateFoundation()`, повторяемость или литературное качество. PR #15 открыт и не объединён.

Фикс подготовлен в ветке `fix/g1-openrouter-reasoning-defaults`, [draft PR #15](https://github.com/NeuralDao/inkos/pull/15). Codex исправил два замечания (реальный выбор Chat Completions в тесте; удаление только точной формы `{effort:"none"}`). Повторный статический review ChatGPT: **ACCEPT по коду**. Пользовательский целевой Vitest: **10/10 PASS**; Core typecheck после исправления fetch mock — **PASS по сообщению пользователя**. Implementation commit `7f9bb2a0ed7aef11ab6432db419c5f4fe8a21dfb`; Codex correction commit `35eb7c28ddeb209857fb59380f5aa3144b23947a`; type fix `4f5aa4999eb3816d7dd701c55b6447ab35dee6f5`.

Ограничение: Pi Agent не различает неустановленный уровень и `thinkingLevel="off"` — оба представлены как `reasoning: undefined`. В текущей InkOS схеме нет отдельного поля `thinkingLevel`; явное отключение на уровне provider config остаётся доступным через `extra.reasoning: { effort: "none" }` и сохраняется. Не считать UI-level off гарантированно сохранённым, если такой интерфейс появится в будущем без отдельного контракта.

**Локальная проверка:** пользователь сообщил целевой Vitest openrouter-reasoning.test.ts **10/10 PASS**, Core pnpm exec tsc --noEmit **PASS** и pnpm --filter @actalk/inkos-core build **PASS** на ee4c57e496db561b3d0ad9675d604a886e950941. ChatGPT не запускал эти команды самостоятельно. Lint, E2E и полный Studio smoke — **NOT RUN**. Пять live synthetic structured-tool smoke описаны ниже (три PASS, два FAIL/blocked). Merge PR #15 — только по отдельному разрешению.

**РЕШЕНИЕ И ТЕСТЫ НА 31.10.2026 (ПРИОРИТЕТ НАД ОСТАЛЬНЫМ ТЕКСТОМ):** после реального отказа Foundation при динамическом `openrouter/free` пользователь **отказался от него как рабочего G1-стека**; отбираем **конкретные бесплатные `:free` IDs** и проверяем `modelOverrides` до новой книги. При `INKOS_OPENROUTER_FREE_ONLY=1`, `openai-responses`, `modelOverrides.architect` **in-memory routing PASS** для `xingchen-agi/xing4.0-29b-a4b:free` и `dots-studio/dots-3-note-preview:free`. Первые реальные синтетические вызовы `submit_foundation_cast_index` с **3 персонажами** у обоих закончились **одним WORKER_MODEL_ERROR** каждый, причины неизвестны. Затем **Xing4.0 успешно выполнил один короткий отдельный вызов с 2 персонажами**, вернул валидные `roles` при `maxTokens=2048`; это **частичная совместимость**, НЕ проверенная повторяемость и НЕ прохождение исходного 3-ролевого теста. Dots не доказан. **Сохранение Studio modelOverrides, Writer/Reviser и второй Foundation НЕ ЗАПУСКАЛИСЬ**. Прежние рекомендации ниже «G1 только на `openrouter/free`», «API ещё не было», «checkModel не исправлен» **устарели**, не применять. Новая точка входа: [G1_HANDOFF_2026-10-31.md](./G1_HANDOFF_2026-10-31.md).

## Новое испытание: Nemotron 3 Ultra fixed ID (31.10.2026)

Пользователь запустил synthetic harness на локальном Core из ee4c57e496db561b3d0ad9675d604a886e950941, с INKOS_OPENROUTER_FREE_ONLY=1, проектом Studio C:\Projects\inkos-workspace и временным in-memory modelOverrides.architect:

- Requested/resolved/PI model: nvidia/nemotron-3-ultra-550b-a55b:free.
- Preflight: **PASS** — service openrouter, openai-responses, официальный endpoint, ключ присутствует.
- Structured call: **FAIL** — MODEL_REQUIRED_TOOL_MISSING, stopReason=error, resultTool=submit_foundation_cast_index, attempts=1.
- Результат трёхперсонажного cast index не получен. CSV Activity содержит две соседние записи, с высокой вероятностью соответствующие initial + tool-missing retry: `gen-1793479843-1bvpeVlPRj9ZZ4QiL1G5` (20:50:43.703) и `gen-1793479846-PlJJdLK83qw3WW3zhvGt` (20:50:46.484). Обе обслужены `Nvidia`, фактический serving ID `nvidia/nemotron-3-ultra-550b-a55b-20260604`, variant `free`; обе завершились `stop`, не `tool_calls`. На каждую: 470 prompt tokens; completion 194 и 176; reasoning 148 и 126. Итого по паре: 940 prompt / 370 completion / 274 reasoning; cost_total **$0.00**.
- Это один логический вызов worker, а не три независимые попытки. По коду packages/core/src/agent/pi-stream.ts guardedPiStream делает один transport retry при отсутствии обязательного tool call; после повторного ответа без tool call локальный observeModelStream формирует MODEL_REQUIRED_TOOL_MISSING. Следовательно, attempts=1 в worker не является количеством HTTP-запросов; Activity должна подтвердить число фактических запросов (ожидается initial + один retry).
- Код ошибки **не является HTTP 400/429** и не доказывает, что модель вообще не умеет function calling. Он означает, что завершённый ответ не содержал требуемого tool call после исчерпания одного transport retry.
- В более широкой Activity-выгрузке для этого serving ID есть 55 генераций: 30 с `tool_calls`, 19 с `stop`, 1 cancelled и 6 без finish reason; общий cost_total $0. Это показывает, что Nemotron 3 Ultra в других запросах вызывал инструменты, но не отменяет отказ именно на `submit_foundation_cast_index` с обязательным tool call. Общие 55 записей нельзя считать одним тестом или одной ролью.
- Конфигурация inkos.json, сохранённые Studio overrides и существующий Work не изменялись; новая книга не создавалась. В запросе были только синтетические имена.

**Статус кандидата:** Nemotron 3 Ultra — **NOT QUALIFIED** для Architect по точному трёхперсонажному `submit_foundation_cast_index` (routing PASS; две генерации завершились `stop` без tool call). При этом Activity подтверждает общее использование tools в других запросах (30/55); говорить о полной неспособности модели к function calling нельзя. Не повторять автоматически и не назначать постоянный override.

## Новое испытание: Gemma 4 26B A4B fixed ID (31.10.2026)

Пользователь запустил тот же ограниченный synthetic Architect harness с in-memory modelOverrides.architect и точным ID google/gemma-4-26b-a4b-it:free:

- Requested/resolved/PI model: google/gemma-4-26b-a4b-it:free.
- Preflight: **PASS** — service openrouter, apiFormat responses, piApi openai-responses, API key присутствует.
- Structured submit_foundation_cast_index: **FAIL** — WORKER_MODEL_ERROR; causeChain: Error / code WORKER_MODEL_ERROR / message 429 Provider returned error; attempts=1; stopReason=error; usage=null.
- Это отказ провайдера до получения пригодного structured результата. Tool calling **NOT VERIFIED**; результат трёхперсонажного fixture не получен.
- В packages/core/src/llm/provider.ts на code HEAD ee4c57e реализован guardAssistantMessageStream с TRANSIENT_LLM_RETRIES=2. HTTP 429 без видимых stream events распознаётся как transient и повторяется с backoff 800 мс и 1600 мс; следовательно, при одинаковом 429 на каждом ответе один worker turn может содержать до трёх upstream HTTP requests. attempts=1 — один Agent model turn, не число HTTP-запросов. Точное число и serving provider подтвердить OpenRouter Activity.
- usage=null не означает нулевой расход: worker не вызывает onUsage для неуспешного structured результата. Токены и стоимость **UNKNOWN**.
- CSV Activity (213 строк, 2026-10-31 14:02:35–20:50:46, API key `InkOS-G1`) не содержит ни одной записи с Gemma в `model_permaslug`. Поэтому он не подтверждает фактическое число HTTP-попыток, serving provider/model, usage или cost для этого 429. Код допускает до трёх upstream requests в одном worker turn (initial + два transient retry), но фактическое число из этой выгрузки **UNKNOWN**. Отсутствие generation row не доказывает $0 и не позволяет браковать tool calling. Не повторять немедленно и не делать циклических smoke.
- Использовались только синтетические данные; persistent Studio overrides и старый Work не менялись.

**Статус кандидата:** Gemma 4 — **BLOCKED / NOT QUALIFIED** по причине provider 429; способность выполнять tools не проверена. По Activity сверка для Gemma невозможна: generation rows отсутствуют. Первая пара кандидатов не дала Architect PASS. Следующий кандидат — Nemotron 3.5 Super VL, однако Activity уже содержит 47 генераций фактического serving ID `nvidia/nemotron-3.5-super-vl-20261015` (provider Nvidia): 35 завершились `tool_calls`, 12 — `length`, cost_total $0; суммарно 801 814 prompt / 116 247 completion / 103 716 reasoning tokens. CSV не содержит requested model ID, имён tools или task labels, поэтому неизвестно, относятся ли эти записи к fixed alias и к Architect fixture. Сначала сопоставить их с локальными harness/Studio logs; не запускать дублирующий smoke, если среди них уже есть тот же тест. Не менять persistent overrides и не создавать Foundation.

## Где находятся логи InkOS и что сохранил текущий smoke

- Studio text log: `<projectRoot>\inkos.log`; экран Studio **Logs** вызывает `GET /api/v1/logs`, который читает только последние 100 строк этого файла. Для проекта из текущего эксперимента путь ожидается `C:\Projects\inkos-workspace\inkos.log`. В проверенном `server.ts` endpoint только читает файл; он не создаёт и не заполняет его. Logger helper имеет stderr/JSONL sinks, но в direct harness их подключение к `inkos.log` не выполняется.
- Work execution history: `<projectRoot>\.inkos\harness.sqlite`; Studio Work Inspector показывает список Episodes и их events. API: `GET /api/v1/episodes?limit=100`, затем `GET /api/v1/episodes/:id`; UI: открыть Work → Execution history → выбрать Episode.
- Direct model smoke из текущего эксперимента вызвал `PipelineRunner.createAgentContext()` и `runWorkerAgentTool()` напрямую. Он не запускал `CreativeHarnessRuntime.startEpisode/executeAction`, не открывал Studio Work и не оборачивал вызов в `withExecutionEvidence`. Поэтому его подробные execution events не записаны в `harness.sqlite`; `recordExecutionEvidence()` без AsyncLocalStorage sink ничего не сохраняет. Доступны PowerShell output и OpenRouter Activity.
- Для следующих direct smoke оборачивать вызов в `withExecutionEvidence((type,payload) => evidence.push({type,payload}), () => runWorkerAgentTool(...))` и печатать `evidence` в конце. Это собирает `model-call-completed`, `model-call-retry` и assistant response/usage, не меняя исходники. Синтетические данные; перед передачей лога удалить ключи, headers и приватный prompt.

## Новое испытание: Nemotron 3.5 Super VL fixed ID (31.10.2026)

Пользователь запустил тот же ограниченный synthetic harness с in-memory `modelOverrides.architect` и точным ID `nvidia/nemotron-3.5-super-vl:free`:

- Preflight **PASS**: requested/resolved/PI model совпадают; `service=openrouter`, `apiFormat=responses`, `piApi=openai-responses`, API key присутствует.
- Structured `submit_foundation_cast_index`: **PASS**.
- Результат точно совпал с fixture: Anna (major), Pavel (minor), Irina (minor); лишних/пропущенных ролей нет.
- Usage: 470 prompt / 125 completion / 595 total tokens. Стоимость в данном выводе отсутствует; не приписывать этому запуску $0 без сопоставления с Activity.
- Это первый успешный полный structured tool smoke в текущей серии. Он подтверждает маршрутизацию фиксированного ID, вызов обязательного инструмента и корректную структуру результата на коротком fixture.
- **Ограничение репрезентативности:** harness вызывает `runWorkerAgentTool()` напрямую с минимальным англоязычным system prompt и синтетическим user message. Он использует `FoundationCastIndexToolSchema`, но не запускает `ArchitectAgent.generateFoundation()` и его реальные предыдущие этапы (outline/details), не проверяет полный foundation pipeline, качество планирования или прозу. Поэтому статус — `STRUCTURED TOOL SMOKE PASS`, а не полная квалификация Architect.
- Запуск не создаёт Studio Work/Episode: он не проходит через `CreativeHarnessRuntime.startEpisode/executeAction` и не устанавливает `withExecutionEvidence` sink. Его доступные записи — PowerShell stdout и OpenRouter Activity; отсутствие Episode/`inkos.log` не является признаком отсутствия запроса.
- Точный Activity row пока не сопоставлен: в выводе harness нет generation ID/временной метки, а CSV не содержит tool name/requested alias. Не связывать автоматически этот PASS с одной из 47 агрегированных Super VL записей.

**Статус кандидата:** Nemotron 3.5 Super VL — **STRUCTURED TOOL SMOKE PASS**; можно перевести в первый приоритет следующего этапа. До постоянного назначения роли Architect нужно проверить реальный `ArchitectAgent.generateFoundation()` на синтетическом `BookConfig` без вызова `writeFoundationFiles()`, с инструментированным `withExecutionEvidence` и проверкой всех четырёх structured stages. Повторяемость и литературное качество пока **NOT TESTED**.

## Повторное испытание: Xing4.0 29B A4B fixed ID (31.10.2026)

Пользователь повторил тот же трёхперсонажный synthetic `submit_foundation_cast_index` smoke с точным ID `xingchen-agi/xing4.0-29b-a4b:free`:

- Preflight **PASS**: requested/resolved/PI model совпадают; `service=openrouter`, `apiFormat=responses`, `piApi=openai-responses`, API key присутствует.
- Structured tool result **PASS**: Anna (major), Pavel (minor), Irina (minor) — точное совпадение с fixture.
- Usage: 404 prompt / 122 completion / 526 total tokens. Стоимость в предоставленном выводе отсутствует; не выводить её из более ранней Activity.
- Ранее тот же трёхперсонажный smoke завершился `429 Provider returned error`; новый PASS показывает, что прежний отказ не доказывал несовместимость tool calling. Пока подтверждён один успешный запуск на этом fixture; стабильность при повторных успешных вызовах не измерена.
- Более ранний двухперсонажный Xing smoke также был PASS (Anna/Pavel). Новый результат supersedes старое краткое резюме «Xing — только 2-role PASS, 3-role FAIL»: актуально — 2-role PASS и 3-role PASS после отдельного прежнего 429.

**Статус кандидата:** Xing4.0 — **STRUCTURED TOOL SMOKE PASS** на полном трёхперсонажном fixture; полный Architect pipeline, повторяемость и литературное качество не проверены.

## Новое испытание: Cohere North Mini Code fixed ID (31.10.2026)

Пользователь проверил точный ID `cohere/north-mini-code:free` тем же synthetic `submit_foundation_cast_index` harness:

- Preflight **PASS**: requested/resolved/PI model совпадают; `service=openrouter`, `apiFormat=responses`, `piApi=openai-responses`, API key присутствует.
- Structured tool result **PASS**: Anna (major), Pavel (minor), Irina (minor) — точное совпадение с fixture.
- Usage: 190 prompt / 305 completion / 495 total tokens. Стоимость в предоставленном выводе отсутствует; не выводить её из более ранней Activity.
- Это независимый от NVIDIA и Xing model family/provider candidate, успешно прошедший тот же базовый контракт. Это не доказывает его пригодность как Writer/Reviser и не сравнивает литературное качество.

**Статус кандидата:** Cohere North Mini Code — **STRUCTURED TOOL SMOKE PASS**; полный Architect pipeline, повторяемость и литературное качество не проверены.

**Сводка успешных smoke:** Super VL — 470/125 (595); Xing4.0 — 404/122 (526); Cohere North Mini Code — 190/305 (495). Всего 1616 tokens. Это сумма usage трёх отдельных smoke, не цена; в предоставленных выводах cost отсутствует.

## Сверка OpenRouter Activity CSV (31.10.2026)

Пользователь предоставил `openrouter_activity_2026-10-31 (1).csv`. Выгрузка содержит 213 строк за 14:02:35.153–20:50:46.484; все строки относятся к API key `InkOS-G1`, variant `free`, `cost_total=0`. Поля requested model ID, tool name и task label отсутствуют; `model_permaslug` показывает фактический serving model.

| Фактический serving model | Записей | `tool_calls` | Другие finish reasons | Cost |
| --- | ---: | ---: | --- | ---: |
| `nvidia/nemotron-3-ultra-550b-a55b-20260604` | 55 | 30 | 19 `stop`, 1 cancelled, 6 без finish reason | $0 |
| `nvidia/nemotron-3.5-super-vl-20261015` | 47 | 35 | 12 `length` | $0 |
| `nvidia/nemotron-3.5-lightning-20260807` | 48 | 40 | 6 `length`, 1 cancelled, 2 без finish reason | $0 |
| `cohere/north-mini-code-20260617` | 45 | 35 | 6 `stop`, 2 `length`, 1 `error`, 1 без finish reason, 1 cancelled | $0 |
| `liquid/lfm-2.5-2.6b-20260811` | 17 | 17 | — | $0 |
| `xingchen-agi/xing4.0-29b-a4b-20261015` | 1 | 1 | — | $0 |

**Интерпретация:** это агрегат разнородных вызовов, а не единый benchmark; проценты tool calls нельзя трактовать как pass rate Architect. Особенно важно сопоставить `tool_calls` Super VL с task logs, прежде чем запускать ещё один smoke. `finish_reason=length` — ограничение генерации по длине, а не доказательство tool failure.

**Факт исполнения на 31.10.2026 (актуальнее исторических абзацев ниже):** интеграция OpenRouter Free [PR #13](https://github.com/NeuralDao/inkos/pull/13) **MERGED** в `custom/main` (`036f3b59`); fallback исправлен на `openrouter/free`, opt-in `INKOS_OPENROUTER_FREE_ONLY=1` реализован. Core Vitest 126 PASS на HEAD до последнего тестового typefix, Core typecheck PASS, Studio typecheck PASS по сообщению пользователя; Core и Studio локально собраны. **Один реальный synthetic preflight** в `New session`: `G1_PREFLIGHT_OK`, OpenRouter → NVIDIA Nemotron 3 Ultra (free), native **8 495 input / 31 output**, **$0.00**, HTTP 200, `tool_calls`, fallback не зафиксирован. Исторические утверждения ниже «API не выполнялся»/«fallback ещё не исправлен» устарели. `openrouter/free` динамический; реальный endpoint имеет **Training allowed**, NVIDIA предупреждает о логировании для улучшения продуктов. Перед передачей оригинального авторского материала требуется отдельное решение пользователя. Детали: [CURRENT_STATE.md](./CURRENT_STATE.md).

## Актуальное решение от 31.10.2026 — фиксированные бесплатные IDs

**G1 не должен зависеть от случайного исполнителя `openrouter/free`.** Пользователь выбрал стратегию назначать конкретные модели через существующий `modelOverrides`, а не адаптировать архитектуру InkOS к случайным ответам роутера. Динамический `openrouter/free` остаётся для разведочных проверок доступности, но не является рабочей baseline G1.

**Технический статус:** reasoning fix в [Draft PR #15](https://github.com/NeuralDao/inkos/pull/15), статический review ChatGPT ACCEPT; пользователь сообщил целевой Vitest 10/10 PASS и Core typecheck PASS. PR открыт, не объединён. Локальный build и live API после фикса не выполнялись.

**Наблюдение пользователя:** три разных fixed ID прошли одинаковый базовый structured smoke. Это полезнее агрегированных `tool_calls` в Activity, но ещё не позволяет ранжировать модели по литературному качеству или полной Architect-работе. Динамический `openrouter/free` может выбирать разных исполнителей. Первые литературные образцы выявили смешение языков и сценарное дробление на сцены; они не являются baseline и не доказывают качество конкретной модели.

### Кандидаты

| Статус smoke | Точный ID | Результат на fixture | Что ещё не проверено |
| --- | --- | --- | --- |
| **PASS** | `nvidia/nemotron-3.5-super-vl:free` | 3 роли; 470/125 tokens | Полный Architect, repeatability, литературное качество |
| **PASS** | `xingchen-agi/xing4.0-29b-a4b:free` | 3 роли; 404/122 tokens; прежний 429 сменился успешным запуском | Полный Architect, repeatability, литературное качество |
| **PASS** | `cohere/north-mini-code:free` | 3 роли; 190/305 tokens | Полный Architect, repeatability, литературное качество |
| **FAIL** | `nvidia/nemotron-3-ultra-550b-a55b:free` | Preflight PASS; обязательный cast-index завершился `MODEL_REQUIRED_TOOL_MISSING` | Не исключает tool use на других задачах |
| **BLOCKED** | `google/gemma-4-26b-a4b-it:free` | Preflight PASS; structured request получил upstream 429 | Tool calling не проверен; Activity rows отсутствуют |
| **HOLD** | `dots-studio/dots-3-note-preview:free` | Положительного structured результата нет | Не тратить приоритетные попытки |

Источники: [OpenRouter Free Models](https://openrouter.ai/collections/free-models), [Nemotron 3 Ultra](https://openrouter.ai/nvidia/nemotron-3-ultra-550b-a55b:free), [Nemotron 3.5 Super VL](https://openrouter.ai/nvidia/nemotron-3.5-super-vl:free), [Gemma 4 26B A4B](https://openrouter.ai/google/gemma-4-26b-a4b-it:free), [Xing4.0](https://openrouter.ai/xingchen-agi/xing4.0-29b-a4b:free), [Dots3-Note Preview](https://openrouter.ai/dots-studio/dots-3-note-preview:free). Публичные цены, доступность и карточки меняются; проверять перед запуском.

**Важное ограничение данных:** бесплатные NVIDIA endpoints предупреждают не отправлять confidential information: запросы логируются для безопасности и улучшения продуктов NVIDIA. До отдельного согласия пользователя проверять их только синтетическими данными; не отправлять авторский brief, рукопись, карточки персонажей и приватные артефакты. Цена $0 не отменяет этот риск.

### Протокол квалификации

1. Использовать один и тот же synthetic fixture `submit_foundation_cast_index`: Anna (major), Pavel (minor), Irina (minor).
2. Перед live smoke локально синхронизировать branch PR #15 и пересобрать Core `dist` именно из него: build на этой ветке ещё NOT RUN, а тестовый harness импортирует `packages/core/dist`. Проверять точные IDs через существующий `PipelineRunner.createAgentContext("architect")` + in-memory `modelOverrides.architect` + `runWorkerAgentTool()`; `service=openrouter`, официальный endpoint, `openai-responses`, `tool_choice=required`, `maxTokens=2048`, `temperature=0.8`.
3. Запускать только с `INKOS_OPENROUTER_FREE_ONLY=1`. Не отключать guard, не задавать paid fallback, не записывать overrides в `inkos.json`, не создавать Work.
4. Текущий synthetic smoke: Super VL, Xing4.0 и Cohere North Mini Code — PASS на одинаковом fixture; Nemotron 3 Ultra — MODEL_REQUIRED_TOOL_MISSING; Gemma 4 — upstream 429. Следующий шаг — не новый model ID, а проверить репрезентативность: запустить полный `ArchitectAgent.generateFoundation()` на синтетическом `BookConfig` без записи Foundation-файлов, собрать execution evidence и проверить все четыре structured stages.
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
