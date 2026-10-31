# G1 free — подготовленный пакет интеграции (31.10.2026)

**Статус: ПАТЧИ ПОДГОТОВЛЕНЫ, В КОДЕ НЕ ПРИМЕНЕНЫ.** Это документация для передачи задачи локальному Codex на Windows, а не отчёт о выполненном PR, тестах или реальном G1.

**Точная исходная база анализа:** `custom/main@1893136656ff94bb21d8fe2076ba599d819f71ec`. Новые документационные коммиты не меняют базовых исходников; перед применением Codex обязан самостоятельно сверить актуальный HEAD и diff. Сам patch-пакет предоставляется пользователю как вложение в текущем чате, **не публикуется в публичном GitHub**.

## Цель

Запустить реальную бесплатную проверку longform InkOS через `openrouter/free` (3 первые главы «Последней ведомости»), сохранив стандартную архитектуру агентов, без платных переключений и незапрошенных вызовов API. Стандарт G1 и литературный brief — [BENCHMARK_LONGFORM.md](./BENCHMARK_LONGFORM.md).

## Два последовательных патча

| Этап | Затронутые исходники/тесты | Назначение | Контрольная сумма SHA-256 |
| --- | --- | --- | --- |
| 01 — `safe-fallback` | `llm/providers/endpoints/openrouter.ts`, `__tests__/effective-llm-config.test.ts` | Сменить автоматический default `openrouter/auto` на `openrouter/free`; явная модельная карточка с 200K контекста и консервативным внутренним лимитом выхода 8192, обновить старое ожидание теста | `c47f12aa97ee2b59c35077d8f70593ac5edd3dd6086200097049cd625f087aaa` |
| 02 — `chat-transport` | те же два файла плюс `__tests__/pi-stream.test.ts` | Для штатного сервиса OpenRouter заменить `openai-responses` на `openai-completions`; проверить правильный `tool_choice=required` в локальном `stream=false/true` тесте OpenRouter (не `custom`) | `78e08f973272ecee4783cac480cc5ef18f76851bac0aa3b9b7233a52fe94007b` |

**Основание 02:** `guardedPiNonStreaming()` обслуживает явно только `openai-completions`, а при `openai-responses` возвращается к streaming. Стандартный OpenRouter поддерживает Chat Completions с инструментами. При этом смена транспорта глобально влияет на все модели сервиса `openrouter`; проверить отдельно и не объявлять её доказанно безопасной до локального теста и live preflight.

## Статическая подготовка и ограничения

- Сверены `openrouter.ts`, `effective-llm-config.ts`, `provider.ts`, `pi-stream.ts`, `worker-agent.ts` и связанные тесты на указанном исходном коммите.
- Выполнен **только** `git apply --check` в синтетическом дереве из точных изученных фрагментов и последовательное применение патчей там; это **не** проверка полной локальной копии.
- **NOT RUN:** Vitest, TypeScript typecheck, build, Studio, Codex, реальный OpenRouter и платный API; PR с кодом не создан.
- Fallback `openrouter/free` не защищает от **явно** настроенного `openrouter/auto`, платного `llm.model` или `modelOverrides`. Перед G1 проверить фактический `BookConfig`/service и все override-модели; по возможности ограничить расход на стороне OpenRouter и после smoke проверить Activity.
- Бесплатный маршрутизатор выбирает модели динамически; литературная G1 — исследование системы, не контролируемое сравнение моделей. Зафиксировать доступный фактический ID исполнителя либо `UNKNOWN`, usage, число попыток и технические ошибки.
- После локального ревью Codex — **только по отдельному разрешению** точечные Vitest, Core typecheck, затем разрешённый живой structured smoke и три главы. Не запускать `pnpm install`, полный suite или платные вызовы автоматически.

**Следующее действие:** на Windows передать Codex оба приложенных patch-файла и README с заданием проверить ветку и чистоту дерева, применить 01→02, провести статическое ревью. PR на `custom/main` открыть только после проверки и по разрешению пользователя, merge отдельно. В случае ошибки вернуться с точным минимальным diff/FAIL.

**Публичные источники:** [free router](https://openrouter.ai/openrouter/free), [free-model quota](https://openrouter.ai/collections/free-models), [tool-calling](https://openrouter.ai/blog/tutorials/tool-calling/).