# Studio G4: модельный стек и чистое рабочее пространство

**Дата решения:** 1 ноября 2026 г.
**Цель:** отладить создание книги и последовательное написание через Studio на фиксированном недорогом стеке. Это технический прогон; качество моделей ещё не принято как литературный стандарт.

## Правило бюджета и маршрутизации

Потолок считается как простое среднее цены входа и выхода за 1 млн токенов: `(input + output) / 2 <= $0.10`. Цены взяты из каталога OpenRouter API на дату фиксации и могут меняться из-за тарифов провайдера и скидок. Auto Exacto включается OpenRouter на запросах с `tools`; `:floor` снят со всех ролей, поскольку он сортирует по цене и отключает этот механизм. Состав модели фиксированный — `openrouter/free` не используется.

| Роль | Модель | Вход / выход за 1M | Среднее | Контекст / максимум вывода |
|---|---|---:|---:|---:|
| Studio coordinator (default) | `openai/gpt-oss-120b` | $0.015 / $0.054 | $0.0345 | 131K / 65,536 |
| Architect | `z-ai/glm-5.3-flash` | $0.0285 / $0.0923 | $0.0604 | 1,048K / 131,072 |
| Planner | `qwen/qwen3.7-flash` | $0.03 / $0.13 | $0.08 | 1,000K / 65,536 |
| Composer | `mistralai/mistral-nemo` | $0.029 / $0.03 | $0.0295 | 131K / 16,384 |
| Writer | `inclusionai/ling-3.0-flash` | $0.021 / $0.063 | $0.042 | 262K / 32,768 |
| Auditor | `inception/mercury-2.5` | $0.04 / $0.15 | $0.095 | 260K / 65,536 |
| Reviser | `google/gemma-3-12b-it` | $0.05 / $0.15 | $0.10 | 131K / 16,384 |
| State validator | `openai/gpt-oss-20b` | $0.03 / $0.13 | $0.08 | 131K / configured 65,536 |
| Actor | `meta-llama/llama-3.1-8b-instruct` | $0.05 / $0.08 | $0.065 | 131K / 117,964 |
| Radar | `mistralai/ministral-3b-2512` | $0.10 / $0.10 | $0.10 | 131K / 104,857 |

Все десять назначений различны, поддерживают `tools` и `tool_choice` в каталоге на дату проверки. Разные Model ID нужны, чтобы отличать роли в биллинге.

Для G4 Architect в `modelOverrides` задано `reasoning: true`: GLM 5.3 Flash отсутствует в локальном каталоге Pi, но фактический OpenRouter вызов вернул 8192 native reasoning tokens и исчерпал установленный в Architect hard cap 8192 без tool call. InkOS нормализует неявное `reasoning.effort=none` в `low` для таких явно помеченных моделей. Сам hard cap 8192 пока не менялся; повторная проверка после изменения reasoning **NOT RUN**.

## Известные ограничения до прогона

- Состав подобран по тарифу и поддержке tool calls, а не по литературной оценке. Writer, Reviser и вспомогательные агенты ещё требуют сравнения по реальным главам.
- `GPT-OSS-20B` возвращён только в State validator с `maxTokens=65536` и окном 131K: прошлый отказ достигал меньшего лимита вывода. Это проверяемая гипотеза, не подтверждённое исправление; если модель снова оборвётся, роль нужно заменить.
- `Mistral Nemo` ограничен максимумом 16K вывода; его роль Composer отвечает за упаковку контекста, а не за финальную главу.
- На OpenRouter для Mercury 2.5 отображалась доступность 97.76% за последние три дня. Сбой аудитора надо фиксировать отдельно; повторный платный запуск без решения не делать.
- Auto Exacto улучшает выбор провайдера для tool calls, но не исправляет ошибки модели или ограничения её выходного окна.
- Studio coordinator назначен на `gpt-oss-120b`, а не на случайный `openrouter/free` или Nemotron endpoint с конфликтом обязательного reasoning.
- Первый G4 запуск: coordinator прошёл; Architect GLM через Crusoe дважды израсходовал 8192 completion tokens целиком на reasoning и завершился `finish_reason=length` без structured output. Два вызова списали суммарно $0.0086942. Draft Work и candidate artifacts сохранены; не повторять до применения явного `reasoning: true` для Architect и перезапуска dev-сервера.

## Чистый запуск

- Архив исходной книги: `C:\Projects\inkos-workspace-archive\inkos-g3-20261101`.
- Новый пустой проект для Studio: `C:\Projects\inkos-g4-workspace`.
- В новый проект перенесены только конфигурация стека, `.env`, brief R3 и файлы версии Node. Папка `works` пуста. Старый G3 workspace оставлен без изменений.
- Сборка, тесты, сервер Studio и генерации не запускались. Студийный прогон остаётся ручным.

## Источники

- [OpenRouter Auto Exacto](https://openrouter.ai/blog/announcements/auto-exacto/) — качественная маршрутизация tool-call запросов включена по умолчанию; `:floor` выбирает по цене и отключает её.
- [OpenRouter: GPT-OSS-120B](https://openrouter.ai/openai/gpt-oss-120b) — tool calls и структурированный вывод; модель доступна через несколько провайдеров.
- [OpenRouter: Qwen3.7 Flash](https://openrouter.ai/qwen/qwen3.7-flash) — тариф, окно и tool calling.
- [OpenRouter: Ling 3.0 Flash](https://openrouter.ai/inclusionai/ling-3.0-flash) — тариф, окно, tool calling и доступность.
- [OpenRouter: Mercury 2.5](https://openrouter.ai/inception/mercury-2.5) — тариф, окно и structured tool calls.
