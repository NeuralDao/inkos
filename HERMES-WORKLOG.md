# HERMES WORKLOG — InkOS RU fork

**Владелец документа:** Hermes (разработка передана 2026-11-03 на время исчерпания недельного лимита Codex).
**Правило подписи:** каждая запись помечается `[Hermes]` или `[Codex]` в заголовке; чужие записи не переписываются, только добавляются новые.
**Правило факта:** утверждение без команды/пути/лога не считается проверенным; статусы `PASS / FAIL / NOT RUN` обязательны.
**Чужие документы:** `HANDOFF-HERMES.md` (Codex) и `fork-docs/` не редактирую; свои записи веду здесь.

---

## 1. Состояние на 2026-11-03

| Параметр | Значение |
|---|---|
| Checkout разработки | `C:\Projects\inkos-merge-custom-main` |
| Ветка | `wip/handoff-2026-11-02` @ `785fba84` |
| База | `custom/main` @ `26ac2076` (совпадает с origin, push не делался) |
| Дерево | чистое |
| Сборка `dist` | пересобрана 2026-11-03 15:01, `dist` новее `src` во всех трёх пакетах |
| Веток-воркдеревьев | 8, авторитетный runtime checkout — `UNKNOWN` |
| Конфиг моделей | применён 2026-11-02 14:53, бэкап `inkos.json.bak-20261102-145320` |
| Аккаунт OpenRouter | израсходовано $2.5517 из $10; лимит ключа $50 |

## 2. Что уже установлено (проверено, не гипотезы)

1. **Reasoning доминирует в расходе:** 66,7% всех completion-токенов (1 367 124 из 2 050 396) по 451 сверенному вызову. По моделям: `gpt-oss-20b` 99,5%, `deepseek-v4.1-flash` 77,2%, `glm-5.3-flash` 74,4%, `luna` 28,2%, `sol` 5,7%, `haiku` 0%.
2. **Отказы:** 127 из 505 (25%). Из них 47 — `400 Reasoning is mandatory for this endpoint and cannot be disabled`, во всех 47 в `model-request-prepared` нет ни одного reasoning-поля.
3. **Причина 400:** `applyDefaultReasoningPolicy()` (`agent/pi-stream.ts:319`) покрывает `reasoning_effort:"none"`, `reasoning.effort:"none"`, `thinking.type:"disabled"`, но не `reasoning.enabled:false` (формат OpenRouter). Тестов у функции нет.
4. **Подмена:** политика заменяет «выключено» на `low` для reasoning-моделей, поэтому ноль недостижим, а явный `reasoning:false` обходит политику и воспроизводит 400.
5. **Потери:** $0.1210 из $1.0841 (11,2%) ушло на выброшенные ответы; худшие — 81 415 output-токенов (≈81 386 reasoning) на `gpt-oss-20b` и 35 778 на `deepseek-v4.1-flash`.
6. **Потери по ролям:** `continuity-auditor` — 36% его стоимости в мусор, `state-validator` — 37%.
7. **Generation ID сохраняются в event log** — значит биллинг раскладывается по ролям и моделям; перечисления через API нет (`/activity` 403, `/generations` 404), только поштучно `/api/v1/generation?id=`.

Артефакты: `billing-forensics-2026-11-03.md`, `billing-reconcile-2026-11-03.csv` (в `C:\Projects\inkos-g4-workspace`).

## 3. План

### Фаза 0 — верификация принятого кода (без изменений)
Цель: убедиться, что WIP Codex рабочий, прежде чем добавлять своё.
- `pnpm --filter @actalk/inkos-core exec vitest run src/__tests__/chapter-checkpoint.test.ts src/__tests__/unicode-length.flow.test.ts`
- `pnpm --filter @actalk/inkos-core typecheck`, `... inkos-cli typecheck`
- `pnpm build` → `dist` должен стать новее `src`
Критерий: PASS по всем трём пунктам. При FAIL — сначала разбор, потом правки.
Статус: **NOT RUN** (нужно разрешение владельца на сборку/тесты).

### Фаза 1 — закрыть недоделанное Codex
Задача из его handoff: advisory-политика post-audit и `write resume`.
- Статическая сверка: `continuity.ts:30-95`, `models/chapter.ts:13`, `runner.ts:1676-1803`, `pipeline/chapter-checkpoint.ts`.
- Офлайн-тесты на: неполный post-audit не блокирует главу; resume не делает лишний платный вызов; сохранённый ответ аудита переиспользуется.
Критерий: тесты PASS, поведение описано в worklog.

### Фаза 2 — M4b: контроль reasoning (главная ценность)
- Убрать молчаливую подмену; «не задано» и «выключено» → поле отсутствует.
- Покрыть все четыре формы выключения, включая `reasoning.enabled:false`.
- `AgentLLMOverrideSchema.reasoning`: `boolean | "minimal"|"low"|"medium"|"high"`.
- Регрессионные тесты на 4 payload-формы + assert в `model-request-prepared`.
Критерий: 0 отказов `Reasoning is mandatory`; reasoning у auditor/state-validator <10%; в логе видно заданное значение.

### Фаза 3 — `config explain` (наблюдаемость)
`inkos config show --effective --role <r> [--json]`: модель, reasoning, бюджет, `maxTokens`, `contextWindow`, источник каждого значения. Read-only.
Критерий: вывод совпадает с `buildLLMClient` на трёх фикстурах.

### Фаза 4 — измеряемый гейт
10 глав на замороженном стеке: ≥9 без терминальных отказов, длина 2200–2600, стоимость принятой главы < $0.05, инварианты канона, ноль 400 по reasoning.

## 4. Журнал

### 2026-11-03 — [Hermes] приёмка передачи и постановка плана
- Принят `HANDOFF-HERMES.md` и патч Codex; `git apply --check` к `custom/main` — PASS; расхождения зафиксированы в `hermes-acceptance-2026-11-03.md`.
- Собран биллинг по 5 воркспейсам и API OpenRouter; выводы — §2 выше.
- Документация Hermes начинается с этого файла.
- Ничего не собиралось и не запускалось: тесты, build, Studio, платные вызовы — **NOT RUN**.

### 2026-11-03 — [Hermes] Фаза 0: PASS
Владелец разрешил локальные действия, ограниченные платные вызовы low-tier моделей и до двух субагентов на той же модели. План вынесен в `HERMES-PLAN.md` (меняется только при изменении плана).

Выполнено в `C:\Projects\inkos-merge-custom-main`, окружение Node 24.22.1 / pnpm 12.16.1:

| Проверка | Команда | Результат |
|---|---|---|
| Целевые тесты | `pnpm --filter @actalk/inkos-core exec vitest run src/__tests__/chapter-checkpoint.test.ts src/__tests__/unicode-length.flow.test.ts` | **PASS**: 2 файла, **34 теста**, 49,15 с |
| Typecheck Core | `pnpm --filter @actalk/inkos-core typecheck` | **PASS** (exit 0) |
| Typecheck CLI | `pnpm --filter @actalk/inkos typecheck` | **PASS** (exit 0) |
| Typecheck Studio | `pnpm --filter @actalk/inkos-studio typecheck` | **PASS** (exit 0) |
| Сборка | `pnpm build` | **PASS** (exit 0), Studio Vite 50,21 с, предупреждение о chunk >500 kB |
| Свежесть `dist` | сравнение mtime `src` vs `dist` | **PASS**: core/cli/studio `dist` 15:00–15:01 новее `src` |

Поправка к прежним записям и документам: пакет CLI называется **`@actalk/inkos`**, не `@actalk/inkos-cli`. Фильтр `--filter @actalk/inkos-cli` молча не находит проектов и возвращает exit 0 — это ловушка для будущих проверок.

Наблюдение для Фазы 1: сценарии advisory/resume **уже покрыты** в `unicode-length.flow.test.ts` — «keeps the accepted revision and records an unavailable post-audit without retrying», «continues from a failed initial audit without regenerating the draft», «saves the revision and canon when post-audit fails during resume», «refuses to resume after the saved chapter was edited by the user», «reuses the revision when settlement of that revision fails». Значит Фаза 1 сокращается до статической сверки и проверки пробелов, а не до написания новых тестов с нуля.

Платные вызовы, Studio и субагенты в Фазе 0 **не использовались**.

### 2026-11-03 — [Hermes] Фаза 1: PASS

Статическая сверка advisory-политики post-audit и checkpoint/resume. Изменён один тестовый файл, продакшн-код не менялся.

**Что подтверждено чтением кода**
- `continuity.ts:56-108` (`compareRevision`) не бросает исключение на сомнительные данные: неподтверждённая цитата, отсутствующая оценка, неизвестный/повторный `findingId` и неверифицированное новое замечание превращаются в `warnings` с кодами `POST_AUDIT_FINDING_UNVERIFIED`, `POST_AUDIT_FINDING_MISSING`, `POST_AUDIT_EVIDENCE_UNVERIFIED`. Совпавшие по тексту цитаты нормализуются через `exactRevisionEvidence`.
- `runner.ts:1685-1749`: на успехе `warnings` становятся наблюдениями с `assessment:"unavailable"` и русской пометкой «Неподтверждённое замечание повторного аудита», `reason = "revised-text-accepted; post-audit-needs-review"`; на исключении — `POST_REVISION_AUDIT_UNAVAILABLE` и `reason = "...post-audit-unavailable"`. Ошибки безопасности resume (`isChapterResumeSafetyError`) пробрасываются, а не глотаются.
- `compareRevision` вызывается с `disableRetries: true` — автоматического повторного платного вызова нет, это и проверяют существующие тесты.
- `runner.ts:1785-1787`: `pipelineIncomplete` **не включает** post-audit. Недоступный повторный аудит не блокирует главу: текст сохраняется, глава считается записанной. `CHAPTER_RESUME_REQUIRED` возникает только из-за недоступного первичного аудита, незавершённой ревизии или расхождения состояния.
- `chapter-checkpoint.ts` + `runner.ts:1676-1750`: стадия `post-audit` пишется в checkpoint после `audit` + `revision` + `state-validation`; при resume переиспользуется, при несовпадении `content` бросается явная ошибка; правка главы пользователем блокирует resume (`CHAPTER_RESUME_CHAPTER_CHANGED`).

**Пробел, который закрыт**
Единственный непокрытый шов — преобразование `warnings` в наблюдения на уровне Runner. Добавлен тест `keeps an unverified post-audit finding as a warning note without blocking the chapter` (`packages/core/src/__tests__/unicode-length.flow.test.ts`): глава записывается, `reason = post-audit-needs-review`, наблюдение `POST_AUDIT_FINDING_UNVERIFIED` сохранено с `assessment:"unavailable"`, ни одна оценка не повышена до `resolved`, `compareRevision` вызван один раз.

**Проверки**

| Команда | Результат |
|---|---|
| `vitest run src/__tests__/unicode-length.flow.test.ts -t "unverified post-audit"` | **PASS** (1 тест) |
| `vitest run src/__tests__/unicode-length.flow.test.ts` | **PASS**: 31 тест (было 30) |
| `pnpm --filter @actalk/inkos-core typecheck` | **PASS** (exit 0) |

**Дефекты, зафиксированные, но не исправленные** (вне объёма Фазы 1)
1. `continuity.ts:92` — сообщение `POST_AUDIT_FINDING_MISSING` жёстко русское («Оценка не предоставлена.») независимо от языка книги; остальные сообщения локализованы.
2. `runner.ts:1723-1726` — сводка предупреждений тоже только на русском. Для RU-форка это не боль, но при будущей мультиязычности — дефект.
3. `runner.ts:1677` — несовпадение `post-audit` checkpoint с текстом ревизии бросает обычный `Error` без кода; для диагностики лучше типизированный код.

Фаза 1 закрыта. Продакшн-код не изменялся, поэтому сборка не перезапускалась: `dist` от 15:01 соответствует исходникам.

### 2026-11-03 — [Hermes] Фаза 2 (M4b): код и офлайн-проверки PASS, живой прогон 9/9 PASS

**Изменения (uncommitted, 5 файлов + 2 новых)**
| Файл | Что |
|---|---|
| `packages/core/src/llm/reasoning.ts` (new) | `REASONING_LEVELS`, `ReasoningPreference`, `reasoningActivation()`, `reasoningLevelOf()`; семантика: `undefined`/`false` → директива не отправляется, уровень → отправляется |
| `packages/core/src/models/project.ts` | `ReasoningPreferenceSchema = boolean \| minimal\|low\|medium\|high`; применён в `LLMConfigSchema.reasoning` и `AgentLLMOverrideSchema.reasoning` |
| `packages/core/src/llm/provider.ts` | `defaults.reasoning` расширен до `ReasoningPreference`, добавлен `defaults.reasoningLevel`; `piModel.reasoning` = `reasoningActivation(...)` |
| `packages/core/src/agent/worker-agent.ts` | активация через `reasoningActivation`; уровень передаётся в structured-запрос (`reasoning: client.defaults.reasoningLevel`) |
| `packages/core/src/agent/pi-stream.ts` | `applyDefaultReasoningPolicy` (подмена `none → low`) удалена; новая `stripReasoningDisable()` удаляет **все пять** форм выключения: `reasoning_effort`, `reasoning.effort`, `reasoning.enabled`, `thinking.type`, `enable_thinking`; вызов безусловный |
| `packages/core/src/__tests__/reasoning-policy.test.ts` (new) | 12 тестов: пять форм выключения, отсутствие подмены на `low`, сохранение явного уровня и `thinking.enabled`, схема, деривация активации/уровня |

**Офлайн-проверки**
- `reasoning-policy.test.ts` — **PASS 12/12**.
- `unicode-length.flow.test.ts` — **PASS 31/31** (с тестом Фазы 1).
- `worker-agent`, `pi-stream`, `effective-llm-config`, `openrouter-free-responses` — **89 PASS / 3 FAIL**; три FAIL **предсуществующие** (проверено `git stash` на чистом дереве: те же 3).
- `stream-contract.flow.test.ts` — **8 FAIL, все предсуществующие** (baseline без моих изменений даёт те же 8; сравнение по именам тестов). Причина: тесты кодируют старую политику повторов, а Codex ввёл `emptyRetries=0`/`disableRetries`; также изменены коды ошибок пустого ответа. **Тесты устарели, не код.**
- `pnpm --filter @actalk/inkos-core typecheck` — **PASS**; `pnpm build` — **PASS**, `dist` пересобран.

**Драй-ран обязателен и выполнен**: локальный stub (`scripts/hermes-smoke-stub.mjs`, порт 45999) + `scripts/hermes-agent-smoke.mjs --service custom --base-url http://127.0.0.1:45999/v1 --api chat --no-stream --model stub --no-overrides` → 9/9 PASS, `disableSent=0`. Драй-ран поймал две ошибки самого харнесса (TypeBox через `require`, `modelOverrides` не на верхнем уровне конфига) до платных вызовов.

**Живые вызовы (low tier, по одному на роль)**
- Полный прогон: **9/9 PASS**, у каждой роли ровно **1 запрос**, `disableSent=0`, ни одного `400`.
- Фактические модели — текущий `inkos.json` (см. ниже), не мой предложенный стек.
- Уровень reasoning проверен отдельно: `--level-role state-validator --level low` → `reasoningLevel="low"`, `activation=true`, на проводе `reasoning: {effort:"low",summary:"auto"}`, вызов PASS. Значит настройка per-agent доходит до запроса.

**Наблюдение (важно): изменённый владельцем конфиг**
Мой стек от 2026-11-02 14:53 больше не действует: файл `inkos.json` изменён 2026-11-03 13:20 (и есть отдельный бэкап `inkos.json.bak-20261102-155510`). Сейчас: architect/composer/writer/reviser — `deepseek/deepseek-v4.1-flash-1017`, planner/state-validator `qwen/qwen3.7-flash`, auditor `qwen/qwen3-235b-a22b-2507`, actor/radar `nvidia/nemotron-3-ultra-550b-a55b:free`, база `qwen/qwen3.7-flash`, `reasoning` не задан нигде. Живой прогон шёл на этой конфигурации.

**Наблюдение: единичный 400**
В одном из прогонов (`state-validator`, первый запуск с неудавшейся инъекцией уровня) провайдер вернул `400 tool_calls[0].function.name must be a non-empty string (got empty string)`. При повторе того же вызова — PASS. Воспроизводимость не установлена; требует отдельного внимания при живой проверке книги (может быть связано с `tool_choice: required` и поведением qwen3.7-flash).

**Не сделано:** коммит; живая проверка полного конвейера книги; решение о значениях `reasoning` в конфиге (это M4c).

### 2026-11-03 — [Hermes] Актуализация тестов и новый стек

**Тесты приведены к новой политике повторов**
`packages/core/src/__tests__/stream-contract.flow.test.ts` — было 8 FAIL, стало **38/38 PASS**. Изменения смысла, не подгонка:
- «carries the required result tool through the real Pi {chat,responses,anthropic} boundary»: фикстура больше не отдаёт пустой первый ответ; проверяется **один** запрос вместо двух (retry по пустому ответу отключён), ассерты на `tool_choice`/лимиты сохранены.
- «ends an exhausted output-limit response…»: код ошибки `MODEL_EMPTY_RESPONSE` → `MODEL_OUTPUT_LIMIT`, `requests` 2 → 1; тест переименован по фактическому поведению.
- «enforces required tool selection…»: вместо «третий запрос вернёт tool» — переключаемый режим ответа; проверяется, что обычный текст не принимается, ошибка `MODEL_REQUIRED_TOOL_MISSING`, и что `tool_choice` доходит до провода. Число запросов приведено к фактическому (3 на весь тест, по одному на вызов).

**Полный прогон Core (983 теста): 959 PASS / 19 FAIL / 6 SKIP.**
Все 19 — **предсуществующие**: сверено `git stash -u` на чистом дереве по всем затронутым файлам (`provider`, `turn-completion`, `service-resolver*`, `narrative-language`, `pi-stream`, `skill-agent-tool`, `source-selection`, `longform-harness`, `legacy-migration`, `fanfic-canon`, `chapter-review-scope`) — наборы падений совпадают один в один. Мои изменения новых падений не дают.

Список предсуществующих падений для будущего триажа (не мои и не про reasoning):
`narrative-language` ×3 (не отклоняется невалидный `narrativeLanguage`), `use_skill` ×2 (symlink на Windows), `resolveServiceModel` ×3, `guardedPiNonStreaming` ×3, `turn-completion` ×2, `provider` ×1 (retry reasoning-only), `longform-harness` ×1, `legacy-migration` ×1, `fanfic-canon` ×1, `source-selection` ×1, `chapter-review-scope` ×1, `pi-stream` ×3 в полном прогоне (в изолированном — PASS, межфайловая нестабильность).

**Стек заменён (по разрешению владельца)**
Бэкап: `inkos.json.bak-hermes-20261103-154627`. База и `defaultModel` — `qwen/qwen3-30b-a3b-instruct-2507`.

| Роль | Модель | maxTokens | ctx |
|---|---|---|---|
| architect | `qwen/qwen3-30b-a3b-instruct-2507` | 16384 | 262144 |
| planner | `qwen/qwen3.7-flash` | 8192 | 1000000 |
| composer | `mistralai/mistral-nemo` | 8192 | 131072 |
| writer | `openai/gpt-6-luna:floor` | 32768 | 1050000 |
| auditor | `qwen/qwen3-30b-a3b-instruct-2507` | 12288 | 262144 |
| reviser | `anthropic/claude-haiku-5.5` | 16384 | 1000000 |
| state-validator | `qwen/qwen3-30b-a3b-instruct-2507:floor` | 8192 | 262144 |
| actor | `meta-llama/llama-3.1-8b-instruct:floor` | 4096 | 131072 |
| radar | `mistralai/ministral-3b-2512:floor` | 4096 | 131072 |

`reasoning` не задан нигде: политика — «не запрашиваем», директива в запрос не уходит. Значения уровней — предмет M4c.

**Живая проверка стека:** `node scripts/hermes-agent-smoke.mjs < /dev/null` → **9/9 PASS**, по одному запросу на роль, `disableSent=0`.
Первый выбор для auditor — `inception/mercury-2.5` — дал `MODEL_EMPTY_RESPONSE` дважды подряд (пустой ответ без текста и tool call). По правилу владельца («один повтор после исправления») заменён на `qwen3-30b-a3b-instruct-2507`, после чего PASS. Mercury остаётся кандидатом на прозу/аудит в реальных главах, но на тривиальном smoke-промпте нестабилен.

### 2026-11-03 — [Hermes] M4b.1: фолбэк на 400 по reasoning

**Зачем:** при явном уровне reasoning конкретный endpoint может отвергнуть запрос (`400 … reasoning/thinking …`), и глава падала. Теперь — один ограниченный повтор без reasoning-полей вместо отказа. Повтор дешёвый по своей природе: 400 — отклонённый запрос, completion не тарифицируется.

**Изменения**
| Файл | Что |
|---|---|
| `llm/reasoning.ts` | `isReasoningRejection()`: распознаёт 400 по тексту **или** по числовому `status/statusCode/code` и требует наличия reasoning-маркера; голый 400 без маркера не считается |
| `agent/pi-stream.ts` | `stripReasoningFields()` — снимает и директивы, и **уровни**; non-stream транспорт теперь сам пишет `reasoning_effort`, если уровень задан (раньше молча игнорировал) |
| `agent/worker-agent.ts` | структурированный воркер собирается фабрикой; после первого `prompt` при reasoning-400 — evidence `model-reasoning-rejected`, сброс `modelTurns`, повтор **один раз** со снятыми полями; терминальные ошибки несут `reasoningRetryAttempted` |

**Тесты:** `reasoning-fallback.test.ts` — 5 тестов на локальном HTTP-stub: 400+reasoning → 2 запроса, первый с уровнем, второй без; 400 без маркера → 1 запрос, ошибка пробрасывается; 400+reasoning дважды → 2 запроса и `reasoningRetryAttempted: true`; классификация; полная очистка полей. Вместе с `reasoning-policy.test.ts` — **17/17 PASS**.

**Регрессии:** `worker-agent`, `stream-contract`, `pi-stream`, `unicode-length`, `openrouter-free-responses` — 124 PASS / 3 FAIL; те же 3 предсуществующие. Typecheck PASS, `pnpm build` PASS, живой smoke после сборки снова **9/9**.

**Вне плана:** автомаршрутизация `openrouter/auto`/`free` не внедряется (записано в `HERMES-PLAN.md`).

### 2026-11-03 — [Hermes] Первая реальная глава на новом стеке

**Прогон.** `dogbook01` («Собачьи истории», ru, target 10 глав, было 3). Сначала `write next` отказал: `CHAPTER_RESUME_REQUIRED` на главе 3 (незавершённая операция с прошлого прогона). Выполнен `write resume dogbook01` — глава 3 дописана до 2832 слов (`ru_words`, repair применён). Затем `write next dogbook01 --words 2500` → глава 4 «Последний сезон».

**Цифры.** Эпизод `episode-a6640608`, 4 мин 46 с, **7 вызовов, 0 отказов**, 0 срабатываний reasoning-фолбэка, только предупреждение `POST_AUDIT_FINDING_UNVERIFIED` (не блокирует, по дизайну). Стоимость по прайсу каталога: **$0.0361** (порог гейта $0.05). Разбивка: `qwen3-30b-instruct` 2×$0.0108, `gpt-6-luna:floor` 2×$0.0117, `haiku-5.5` $0.0086, `qwen3-30b:floor` $0.0036, `qwen3.7-flash` $0.0014.
Два предыдущих эпизода `failed` (15:31 и 15:32) — мои попытки: `stdin is not a tty` и отказ `CHAPTER_RESUME_REQUIRED`; денег не потрачено.

**Дефект длины.** Запрошено 2500 слов, записано **2033** (`ru_words`, 12 637 знаков). Repair не сработал: `chapterLengthDelivery` проверяет только явные `min/max`, а `--words` задаёт лишь цель. Класс проблемы тот же, что у «пепла-над-стапелем» (глава 1 — 1050 слов).

**Дефект постаудита.** Аудитор вынес «полностью соответствует», ревизор в том же прогоне выдал три находки, **противоречащие памятке главы** (требовал, чтобы Мухтар начал жить по своему совету и Гроза немедленно изменилась — памятка прямо запрещала это в главе 4), затем пометил их «addressed» без изменения текста. Итог: шум в наблюдениях, ложное «исправлено». Требует разбора в M4c/качестве.

**Литературный разбор** записан в отчёте владельцу: сильная сенсорика и POV собаки, но грамматическая ошибка «Старый овчарка» (строка 123), 30 обращений к запаху на 2000 слов, средняя длина предложения 10 слов, тезис «дом — не место» сформулирован дважды (строки 131 и 139).

### 2026-11-03 — [Hermes] stdin-guard, `--json` и внешний писатель в «Пепле»

**Исправлено.** `packages/cli/src/utils.ts`: `resolveContext` больше не падает, если stdin — не TTY и не читаемый поток (закрытый handle, фоновая задача). Чтение обёрнуто в `try/catch`, ошибка трактуется как «контекст не передан»; раньше исключение убивало процесс до первого запроса. Проверено: `write next «пепел-над-стапелем» --json < /dev/null` доходит до доменной ошибки, а не до падения транспорта.

**Отозвано.** Правка «в `--json` перенаправлять `log()` в stderr» откатана: она ломала существующий контракт (JSON-ошибка уезжала в stderr). Проверено фактически: `stdout` при `--json` **уже чистый** (`STDOUT_PURE_JSON`), прогресс идёт в stderr через `createStderrSink`. Мой более ранний вывод «`--json` не парсится» был ошибкой измерения — я сливал потоки через `2>&1`.

**Уточнение диагноза `stdin is not a tty`.** Это не дефект InkOS. Воспроизведено минимально: `node -e "console.log(1)"`, запущенный как фоновая задача этого окружения, умирает на старте с тем же сообщением. То есть фоновые задания Hermes на этом хосте не дают валидного консольного handle. Рабочий способ — только foreground-запуск (глава 4 шла 4 мин 46 с и уложилась). Guard в `resolveContext` оставлен как страховка для CI, где stdin бывает закрыт.

**Новая находка.** В «пепел-над-стапелем» существует глава 6 (`0006_Зимний_лист.md`, записана 17:09) и запись в `index.json`, но операция над ней не завершена: `write next` отвечает `CHAPTER_RESUME_REQUIRED`. Эпизод `episode-42ef7157` (pid 5756, 16:03:58→16:09:25, статус `failed`) — **не мой прогон**: я в это время работал с `dogbook01`. Кто запускал — не установлено. Дополнительно: `book.json.targetChapters = 5`, а глав шесть.

**Проверки.** `pnpm --filter @actalk/inkos typecheck` PASS, `pnpm build` PASS, CLI-тесты `cli.flow`, `runtime-requirements`, `daemon` — 8/8 PASS.

### 2026-11-03 — [Hermes] Документация и передача сессии

Создан `HERMES-HANDOFF-2026-11-03.md`: состояние ветки и дерева, перечень изменений по коду, таблица проверок PASS/FAIL/NOT RUN, подтверждённые дефекты, ограничения среды, замороженный стек, порядок следующих шагов и команды проверки для PowerShell.

**Правка плана (причина):** в `HERMES-PLAN.md` добавлена Фаза 2b — M4b.1, потому что фолбэк при 400 по reasoning был согласован владельцем отдельным решением и выполнен сверх первоначальных Фаз 2–3. Там же зафиксирован промежуточный результат Фазы 4: одна глава, 0 отказов, $0.0361, недобор длины.

Журнал, план и handoff — единственные документы, которые Hermes ведёт сам; `fork-docs/` и `AGENTS.md` не тронуты.

### 2026-11-03 — [Hermes] M4c: аудит больше не теряется из-за одной битой ссылки

**Уточнение предыдущей записи (важно).** Глава 6 «Зимнего листа» — не «осиротевший артефакт»: её произвёл тот же эпизод `episode-42ef7157` (operationId `37b9c948-2476-440f-b4e4-737a7803501c`, старт 16:03:58). По checkpoint `.inkos/chapter-runs/…/chapter-0006-*.json` стадии: plan/context/draft — `completed`, **audit — `failed`**, revision — `skipped`, settlement и state-validation — `completed`, persisted — `incomplete`. То есть `incompleteStages = ["audit"]`, а не «незавершённая запись»; `createdAt` главы 16:09:23 — это финальный шаг той же операции. Две другие неудачные попытки того же времени (pid 13068, 12916) — `locked by active write` и `CHAPTER_RESUME_REQUIRED` для главы 7. Владельцем подтверждено: это тестовые книги, спасать данные не нужно.

**Корневая причина (детерминированная, не «не повезло с моделью»).** Аудитор в автоматическом режиме запускается как `disableRetries: true` (`runner.ts:1495`), а `disableRetries` жёстко задавал `maxResultTurns = 1` (`worker-agent.ts:449`). Один невалидный `sourceRefs` (ссылка на пустую строку) съедал единственную попытку, ошибка конвертировалась в `auditUnavailable`, ревизия пропускалась, глава персистилась без аудита. Хуже: при `disableRetries` транспорт — `singleAttemptStream`, который в принципе не умеет отправлять историю с tool-результатом (явный `throw "Unsupported tool history"` для `openai-responses`/anthropic), поэтому исправляющий ход был невозможен даже при увеличении бюджета.

**Изменено (6 файлов, минимальный дифф).**
- `agent/worker-agent.ts`: новый параметр `maxResultTurns`; `maxResultTurns = options.maxResultTurns ?? (disableRetries ? 1 : 3)`; для хода коррекции (`modelTurns > 1`) транспорт переключается на полный Pi-stream, потому что отклонённый tool-result надо передать модели.
- `agents/base.ts`: `maxResultTurns` в `submitStructured` и `submitSourcedReview`.
- `agents/continuity.ts`: `maxResultTurns` в опциях `auditChapter`, прокинут в `submitSourcedReview`.
- `pipeline/chapter-review.ts`: параметр `maxResultTurns` прокинут в аудитора.
- `pipeline/runner.ts`: аудит запускается с `maxResultTurns: 2` — ровно один исправляющий ход, стоимость ограничена.
- `__tests__/worker-agent.test.ts`: два теста — коррекция проходит через второй транспорт и возвращает валидный результат; без бюджета остаётся ровно один платный вызов.

**Проверено фактически.** Без правки оба новых теста падают (`WORKER_MODEL_ERROR`, 15/17 PASS после отката) — RED подтверждён. С правкой `worker-agent.test.ts` 17/17 PASS, `typecheck` PASS, `pnpm build` PASS. Целевой набор `stream-contract.flow + observation + reasoning-policy + reasoning-fallback + unicode-length` — 90/90 PASS. Полный Core-сьют: **965 PASS / 19 FAIL / 6 SKIP**; состав 19 падений совпадает с известными, новые не появились. Проверено `git stash` по `chapter-review-scope.flow`, `longform-harness.flow`, `source-selection.flow`, `legacy-migration.flow` — все четыре падают и без моих правок, то есть предсуществующие.

**Не сделано осознанно.** Ревизор (`disableRetries: !!autoFindings`) оставлен как есть: его «addressed» при незатронутом диапазоне (finding-5 «утреник», строка 1 против правки строк 263–271) — отдельный дефект декларации, а не бюджет ходов. Разбирать отдельной задачей.


**Живая проверка (2026-11-03, 18:10–18:16).**
1. Изолированный пробник на реальном провайдере (`openrouter`, `apiFormat: responses`, `deepseek-v4.1-flash-1017`): инструмент с `validate`, отвергающим первое значение как `REVIEW_SOURCE_REQUIRED`. Результат — первая отправка отклонена, вторая принята (`{"value":"ok"}`, 2 проверки, 3,6 с). То есть отклонённый tool-result реально доходит до модели и она исправляется.
2. Живая глава 5 на тестовой книге `dogbook01` (`write next --count 1 --json`, 5 мин 37 с, exit 0): 3015 слов, `draft/audit/settlement/state-validation` — `completed`, `revision` — `skipped` (`no-actionable-findings`), `persisted` — `completed`. Аудит прошёл с первой попытки (51 849 токенов аудитора) — штатный путь `singleAttemptStream` не сломан. Отдельно в том же прогоне settlement получил `WORKER_SCHEMA_INVALID` и **исправился следующим ходом** (события 37 → 38 → успех), то есть механизм коррекции работает не только на тестах.

**Что пока не доказано живьём.** Коррекция именно в *аудите* на реальной главе не наблюдалась: аудитор сдал с первого раза. Механизм доказан изолированно и на settlement; отдельный искусственный отказ аудита в живом прогоне не создавался.

## 5. Открытые вопросы к владельцу



1. ~~Разрешение на `pnpm build` и целевые тесты~~ — получено 2026-11-03, Фаза 0 выполнена.
2. Какой checkout считается авторитетным runtime — влияет на то, где собирать.
3. Нужно ли переносить `HERMES-WORKLOG.md` и `HERMES-PLAN.md` в git (сейчас untracked) или оставить локально.

## 6. Технический саморемонт результата (2026-11-04)

**Задача.** Ошибки валидации не должны требовать точечной правки промптов каждого агента и не должны ронять стадию: валидатор возвращает результат модели вместе с диагностикой, модель исправляет его в пределах бюджета.

**Модуль `agent/result-repair.ts` — единственное место политики.**
- `classifyResultFailure(code)`: `WORKER_SCHEMA_INVALID`, `WORKER_DOMAIN_INVALID`, `REVIEW_*` → `correctable`; `MODEL_EMPTY_RESPONSE`, `MODEL_OUTPUT_LIMIT`, `WORKER_MODEL_ERROR`, `WORKER_RESPONSE_ARCHIVE_FAILED`, `CHAPTER_REPLAY_FAILURE` → `transient`; незарегистрированный код → `fatal` (не маскировать незнакомый дефект повтором).
- `createRepairBudget(policy)`: бюджет ходов на стадию (`maxRepairs`), запрет второго ремонта одной и той же сигнатуры (`maxRepairsPerSignature`, по умолчанию 1) — защита от зацикливания на одной ошибке.
- `repairSignature(code, message)` — FNV-хеш кода и текста ошибки; `repairDiagnostic()` ограничивает диагностику 800 символами.

**Проводка.** `WorkerAgentOptions.repair` → бюджет инкрементирует `allowedResultTurns` в `worker-agent.ts`; хук стоит на обоих путях отказа (`WORKER_SCHEMA_INVALID` в `prepareArguments`, доменная ошибка `validate`). Каждое решение пишется в evidence как `worker-repair-granted` / `worker-repair-refused` с причиной (`granted | budget-exhausted | repeated | unrepairable`). Опция проброшена через `base.submitStructured`, `base.submitSourcedReview`, `continuity.auditChapter`, `chapter-review.reviewChapterDraft`; автоаудит в `runner.ts` использует `DEFAULT_REPAIR_POLICY` вместо жёсткого `maxResultTurns: 2`.

**Проверено фактически.** `result-repair.test.ts` — 8 PASS (классификация, стабильная сигнатура, исчерпание бюджета, повтор, неремонтируемый класс, обрезка диагностики). `worker-agent.test.ts` — 20 PASS, включая три новых: ремонт корректен и идёт через полный транспорт; повтор той же ошибки прекращает ремонт; `MODEL_EMPTY_RESPONSE` не получает хода. RED подтверждён: при отключённом бюджете оба положительных теста падают. Полный Core-сьют — **976 PASS / 19 FAIL / 6 SKIP**, состав падений прежний (предсуществующие). `typecheck` и `pnpm build` — PASS.

**Открыто.** Дефект 3 (ложный `addressed` ревизора) сознательно не покрыт ремонтом: это проверка факта, а не формата — нужен детерминированный контроль пересечения цитаты с заменённым диапазоном.
