# HERMES HANDOFF — 2026-11-03

**Кому:** следующей сессии Hermes. **От:** Hermes, ветка `wip/handoff-2026-11-02`.
**Связанные документы:** `HERMES-PLAN.md` (план и разрешения), `HERMES-WORKLOG.md` (журнал, append-only, подписи `[Hermes]`/`[Codex]`).
**Не редактировать:** `fork-docs/` (ведёт ChatGPT), `AGENTS.md`, `HANDOFF-HERMES.md`.

---

## 1. Где мы находимся

| Параметр | Значение |
|---|---|
| Checkout разработки | `C:\Projects\inkos-merge-custom-main` |
| Ветка | `wip/handoff-2026-11-02` @ `785fba84` |
| База | `custom/main` @ `26ac2076` (push не делался) |
| Репозиторий только для чтения | `C:\Projects\inkos` (`fork-docs/`, 28 файлов) |
| Рабочий воркспейс данных | `C:\Projects\inkos-g4-workspace` (`inkos.json`, `works/`) |
| Коммиты | **нет**, всё в рабочем дереве |

`git status --short` на конец сессии:

```
 M packages/cli/src/utils.ts
 M packages/core/src/__tests__/stream-contract.flow.test.ts
 M packages/core/src/__tests__/unicode-length.flow.test.ts
 M packages/core/src/agent/pi-stream.ts
 M packages/core/src/agent/worker-agent.ts
 M packages/core/src/llm/provider.ts
 M packages/core/src/models/project.ts
?? HERMES-PLAN.md
?? HERMES-WORKLOG.md
?? packages/core/src/__tests__/reasoning-fallback.test.ts
?? packages/core/src/__tests__/reasoning-policy.test.ts
?? packages/core/src/llm/reasoning.ts
?? scripts/hermes-agent-smoke.mjs
?? scripts/hermes-smoke-stub.mjs
```

Diffstat по коду: 7 файлов, +126 / −83.

---

## 2. Что сделано (в порядке выполнения)

### 2.1 M4b — управление reasoning (Фаза 2)

- `llm/reasoning.ts` (новый): `REASONING_LEVELS`, `ReasoningLevel`, `ReasoningPreference`, `isReasoningLevel`, `reasoningActivation`, `reasoningLevelOf`.
- `models/project.ts`: `ReasoningPreferenceSchema = boolean | "minimal"|"low"|"medium"|"high"` в двух местах (глобальный `llm`, `AgentLLMOverrideSchema`).
- `llm/provider.ts`: `defaults.reasoning`, `defaults.reasoningLevel`.
- `agent/worker-agent.ts`: уровень уходит в structured-запрос только если задан; `undefined`/`false` — директивы нет, поле не отправляется.
- `agent/pi-stream.ts`: удалена молчаливая подмена `none → low`; `stripReasoningDisable()` снимает пять форм выключения (`reasoning_effort`, `reasoning.effort`, `reasoning.enabled`, `thinking.type`, `enable_thinking`).
- `__tests__/reasoning-policy.test.ts` (новый) — 12 тестов.

**Ключевое решение:** «не задано» и «выключено» = поля в запросе нет. Именно явный запрет (`reasoning: {enabled:false}`) вызывал 47 отказов `400 Reasoning is mandatory for this endpoint and cannot be disabled`.

### 2.2 M4b.1 — фолбэк при 400 по reasoning

- `llm/reasoning.ts`: `isReasoningRejection()` — 400 по тексту **или** по числовому `status/statusCode/code`, но обязательно вместе с reasoning-маркером. Голый 400 (`max_tokens is too large`) не считается.
- `agent/pi-stream.ts`: `stripReasoningFields()` снимает и директивы, и **уровни**; non-stream транспорт теперь сам пишет `reasoning_effort`, если уровень задан (раньше молча терял).
- `agent/worker-agent.ts`: воркер собирается фабрикой `buildAgent()`; при reasoning-400 — evidence `model-reasoning-rejected`, сброс `modelTurns`, **один** повтор без reasoning-полей; терминальная ошибка несёт `reasoningRetryAttempted`.
- `__tests__/reasoning-fallback.test.ts` (новый) — 5 тестов на локальном HTTP-stub.

### 2.3 Актуализация тестов Codex

`__tests__/stream-contract.flow.test.ts` кодировал старую политику «два дополнительных запроса при текстовом ответе»; приведён к политике одного запроса (8 FAIL → 38/38 PASS). `unicode-length.flow.test.ts` — добавлен advisory-тест постаудита (31 PASS).

### 2.4 Первая реальная глава

`dogbook01` («Собачьи истории», ru, target 10): `write resume` (глава 3 дописана до 2832 слов) → `write next --words 2500` → глава 4 «Последний сезон».
Метрики: `episode-a6640608`, 4 мин 46 с, 7 вызовов, **0 отказов**, стоимость **$0.0361**.

### 2.5 Документация и среда

- `HERMES-PLAN.md`: создан, добавлен раздел «Вне плана» (автомаршрутизация `openrouter/auto`/`free` не внедряется).
- `HERMES-WORKLOG.md`: создан, ведётся append-only.
- `scripts/hermes-agent-smoke.mjs` + `hermes-smoke-stub.mjs`: per-role smoke против реального OpenRouter и офлайн-stub на `127.0.0.1:45999`.

---

## 3. Состояние проверок

| Проверка | Результат |
|---|---|
| `reasoning-policy.test.ts` | 12/12 PASS |
| `reasoning-fallback.test.ts` | 5/5 PASS |
| `stream-contract.flow.test.ts` | 38/38 PASS |
| `unicode-length.flow.test.ts` | 31/31 PASS |
| `openrouter-free-responses.test.ts` | 4/4 PASS |
| `worker-agent` / `pi-stream` регрессии | PASS (3 предсуществующих падения в полном прогоне) |
| CLI `cli.flow` + `runtime-requirements` + `daemon` | 8/8 PASS |
| `pnpm --filter @actalk/inkos typecheck` | PASS |
| `pnpm build` | PASS |
| Живой smoke 9 ролей | 9/9 PASS, `disableSent=0` |
| Полный Core-сьют | 959 PASS / 19 FAIL / 6 SKIP — **все 19 предсуществующие** (проверено `git stash -u` по каждому файлу) |
| Литературная приёмка главы 4 | **REVISE** (не ACCEPT) |

`NOT RUN` — ничего из перечисленного выше; всё либо выполнено, либо помечено как предсуществующее.

---

## 4. Дефекты, подтверждённые фактами

1. **Недобор длины не блокирует главу.** Запрошено 2500 слов, записано 2033 (`ru_words`). `chapterLengthDelivery` проверяет только явные `min/max`; `--words` задаёт лишь цель. Владелец считает некритичным — **фикс отложен по его решению**.
2. **`REVIEW_SOURCE_RANGE_INVALID`.** В `works/пепел-над-стапелем/source/chapters/index.json` — 3 записи: аудитор ссылается на диапазон строк за пределы `governed-context` (948 строк, `endLine: 949`). Глава 5 осталась **без аудита**, статус `unavailable`, пайплайн прошёл дальше молча.
3. **Постаудит противоречит себе.** Глава 4: аудитор — «соответствует», ревизор выдал 3 находки **против памятки главы** и пометил их `addressed` без изменения текста. Причина не установлена.
4. **Prompt caching не работает.** 286 256 входных токенов за прогон, `cacheRead = 0` во всех 7 вызовах. На длинной книге — основная статья расходов.
5. **Локальная стоимость не считается.** `usage.cost = 0` во всех событиях; суммы считаются вручную по каталогу (`or-models.cache.json`).
6. **`--json` — дефекта нет** (проверено: `stdout` чистый). Ранний вывод был ошибкой измерения при слиянии потоков `2>&1`.
7. **19 предсуществующих падений**, значимые: `narrative-language` ×3 (невалидный `narrativeLanguage` не отклоняется), `turn-completion` ×2, `provider` retry ×1, `use_skill` ×2 (symlink на Windows), `pi-stream` ×3 только в полном прогоне (межфайловая нестабильность).

## 5. Открытый вопрос к владельцу (решается до прогонов)

В «пепел-над-стапелем» существует **глава 6** (`0006_Зимний_лист.md`, запись в `index.json`), но операция не завершена → `write next` отвечает `CHAPTER_RESUME_REQUIRED`. Эпизод `episode-42ef7157`, pid 5756, 16:03:58→16:09:25, `failed` — **не прогон Hermes**. Дополнительно `book.json.targetChapters = 5`, а глав шесть. До выяснения автора к книге не притрагиваться; вероятный путь — `write resume` или `chapter resync`.

---

## 6. Ограничения среды (проверено на живых прогонах)

1. **CLI запускать только в foreground.** Фоновые задачи этого окружения на Windows не дают валидного консольного handle: `node -e "console.log(1)"` в фоне падает с `stdin is not a tty`, в pty — с `stdout is not a tty`. Это не дефект InkOS. Глава укладывается в лимит 590 с; для серии — по одной главе за вызов.
2. Guard в `resolveContext` (`packages/cli/src/utils.ts`) оставлен: закрытый stdin трактуется как «контекст не передан». Правка нужна для CI, где stdin бывает закрыт.
3. Секреты: ключ OpenRouter в `C:\Users\vlad\.inkos\.env` и в конфиге Hermes. Никогда не печатать — в отчётах только `[REDACTED]`.
4. `inkos.json` меняется только по прямой просьбе. Бэкапы рядом: `inkos.json.bak-hermes-20261103-154627` и др.

## 7. Текущий стек (`C:\Projects\inkos-g4-workspace\inkos.json`)

| Роль | Модель | maxTokens | ctx |
|---|---|---|---|
| база `llm.model` | `qwen/qwen3-30b-a3b-instruct-2507` | — | — |
| architect | `qwen/qwen3-30b-a3b-instruct-2507` | 16384 | 262144 |
| planner | `qwen/qwen3.7-flash` | 8192 | 1000000 |
| composer | `mistralai/mistral-nemo` | 8192 | 131072 |
| writer | `openai/gpt-6-luna:floor` | 32768 | 1050000 |
| auditor | `qwen/qwen3-30b-a3b-instruct-2507` | 12288 | 262144 |
| reviser | `anthropic/claude-haiku-5.5` | 16384 | 1000000 |
| state-validator | `qwen/qwen3-30b-a3b-instruct-2507:floor` | 8192 | 262144 |
| actor | `meta-llama/llama-3.1-8b-instruct:floor` | 4096 | 131072 |
| radar | `mistralai/ministral-3b-2512:floor` | 4096 | 131072 |

`reasoning` не задан нигде — это осознанно. Стек **заморожен до конца гейта**; модели внутри книги не меняются.

---

## 8. Следующие шаги (в этом порядке)

1. **Выяснить автора прогона `42ef7157`** и закрыть главу 6 «Пепла» через `write resume`. Это же проверка восстановления после падения на живом случае.
2. **Фаза 3 — `config show --effective --role`**: модель, reasoning, бюджет, `maxTokens`, `contextWindow`, источник значения; критерий — совпадение с `buildLLMClient` на трёх фикстурах.
3. **Разбор постаудита** (дефект 3): доходит ли памятка до сверки, есть ли статус «не применимо», по какому тексту идёт сравнение.
4. **Кэш промптов** (дефект 4): замерить, растёт ли `cacheRead` при длинном неизменном префиксе; это главный рычаг стоимости.
5. **Гейт на 10 главах** (Фаза 4): ≥9 без терминальных отказов, длина 2200–2600, стоимость < $0.05, инварианты канона, ноль 400 по reasoning.
6. Только после этого — литературная приёмка на дорогих моделях. Владелец: если провалы сохранятся, разбирать семантические инструкции.

---

## 9. Команды для проверки (PowerShell, из `C:\Projects\inkos-merge-custom-main`)

```powershell
pnpm --filter @actalk/inkos exec vitest run src/__tests__/reasoning-policy.test.ts src/__tests__/reasoning-fallback.test.ts src/__tests__/stream-contract.flow.test.ts
pnpm --filter @actalk/inkos typecheck
pnpm build
cd C:\Projects\inkos-g4-workspace
node C:/Projects/inkos-merge-custom-main/packages/cli/dist/index.js write next dogbook01 --words 2500
```

Smoke против реального OpenRouter (платно, 9 вызовов low tier):

```powershell
cd C:\Projects\inkos-merge-custom-main
node scripts/hermes-agent-smoke.mjs
```

Офлайн-проверка транспорта без денег:

```powershell
node scripts/hermes-smoke-stub.mjs &
node scripts/hermes-agent-smoke.mjs --base-url http://127.0.0.1:45999/v1
```

---

## 10. Правила, которые нельзя нарушать

- Не менять модели внутри книги; смена стека — только между книгами.
- Не ослаблять схемы, не трогать `Value.Parse`, `preserveToolArgumentTypes`, immutable apply state delta.
- Не пушить, не мержить, не публиковать без явного разрешения.
- `fork-docs/` и `AGENTS.md` — не редактировать.
- Записи в журнал — append-only, с подписью `[Hermes]`.
- `PASS` ≠ литературный `ACCEPT`; `NOT RUN` ≠ `PASS`.
