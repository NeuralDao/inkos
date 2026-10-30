# R6(a) / P1.M — кандидаты мультимодельного стека перед G1

**Дата проверки:** 30 октября 2026. **Статус:** аналитический shortlist подготовлен; **ни один кандидат не испытывался в InkOS через платный API**, художественный результат и стоимость G1 неизвестны. **Кодовая база:** NeuralDao/inkos custom/main@6a331c04280d98b9b42c468e45e071b0011085f0, последний интегрированный кодовой merge 24bdd47c; локальный P1.2b не изучался. Цель: недорогая оригинальная русская проза в штатном longform-novel, на [пятиглавном литературном задании](./BENCHMARK_LONGFORM.md). Не начинать платные тесты без отдельного разрешения пользователя.

## Краткий вывод

**Не разрабатывать новый роутер.** В InkOS есть OpenRouter endpoint и ProjectConfig.modelOverrides, Studio передаёт их в PipelineRunner. Для G1 разумно сначала проверить три независимых семейства моделей: **Qwen3.5 397B A17B как Writer, DeepSeek V3.2 как Auditor и базовая служебная модель, MiniMax M2.5 как Reviser**. Это **кандидат стека, не эталон**. После успешного preflight и G1 сохранить реально проверенную конфигурацию как baseline v1, включая конкретный endpoint/provider, параметры, даты и стоимость. **Kimi K2.5** — альтернативный кандидат на замену Writer или Reviser при проблемах с качеством или structured tools, а не четвёртая обязательная модель.

Не утверждать, что какая-либо модель пишет по-русски качественнее других: художественных сравнений на одинаковом задании нет. Разные семьи снижают вероятность общих ошибок как гипотеза, но не гарантируют независимости аудитора.

## Публичные модели и стоимость (динамические ориентиры, USD за 1 млн входных/выходных токенов)

| OpenRouter model ID | Кандидатная роль | Публичный ориентир input / output, USD/M | Контекст | Что подтверждено и что не подтверждено |
| --- | --- | --- | --- | --- |
| [qwen/qwen3.5-397b-a17b](https://openrouter.ai/qwen/qwen3.5-397b-a17b) | **Writer**; при необходимости Architect | около **0.39 / 2.34**; у разных providers может отличаться | ~262K | Есть модель с открытыми весами, API tool calling и маршруты с поддержкой tools; **не проверено** обязательное единственное tool-call, качество русской прозы и цена конкретного endpoint |
| [deepseek/deepseek-v3.2](https://openrouter.ai/deepseek/deepseek-v3.2) | **ContinuityAuditor**, Architect/Planner/Composer и служебные агенты по умолчанию | от **0.21 / 0.31** при опубликованных скидках; тарифы меняются | ~164K | Есть tool-support только у части обслуживающих providers; **не проверено** качество фактического аудита, structured result и совместимость reasoning |
| [minimax/minimax-m2.5](https://openrouter.ai/minimax/minimax-m2.5) | **Reviser** | около **0.27 / 0.95** | ~205K | Карточка заявляет tools/tool_choice; **не проверены** сохранение русских имён и локальных границ правки, корректность JSON tool-параметров и действующая провайдерская цена |
| [moonshotai/kimi-k2.5](https://openrouter.ai/moonshotai/kimi-k2.5) | **Резерв** Writer/Reviser при подтверждённых проблемах | около **0.45 / 2.25** | ~262K | Открытые веса и tool calling; модель требует особого внимания к thinking/температуре и стоимости вывода; **не проверено** поведение в InkOS |

**Достоверность цен:** это публичные тарифы на доступных карточках при изучении 30.10.2026, **не оферта и не показания счёта**. Публикуемые скидки, cache hit, выбранный serving-provider, платформа и цена могут измениться. Карточки одного ID в разные моменты показывали слегка отличающиеся цены и разную поддержку JSON schema в зависимости от endpoint; перед G1 нужно открыть актуальную карточку/Endpoints API и зафиксировать реальный маршрут и цену. Считать стоимость как сумму фактических input/output/cached tokens **каждого** вызова, включая retries. Стоимость «3 × 1350 русских слов» заранее по числу слов **не вычисляется**: Architect, prompts, tools, Settler, ревизии и повторная передача контекста часто важнее одного финального вывода.

**Права на веса:** опубликованы веса [Qwen3.5 Apache-2.0](https://huggingface.co/Qwen/Qwen3.5-397B-A17B), [DeepSeek V3.2 MIT](https://huggingface.co/deepseek-ai/DeepSeek-V3.2), [MiniMax M2.5 Modified-MIT](https://huggingface.co/MiniMaxAI/MiniMax-M2.5) и [Kimi K2.5 Modified-MIT](https://huggingface.co/moonshotai/Kimi-K2.5). «Открытые веса» ≠ одинаковые лицензии или условия публикации/хостинга; Modified-MIT и правила выбранного API provider отдельно прочитать перед коммерческим использованием. Это не юридическое заключение.

## Фактически обнаруженный маршрут InkOS

- **Модельные назначения уже существуют:** packages/core/src/models/project.ts — ProjectConfigSchema.modelOverrides со строковым model ID либо AgentLLMOverride {model, provider?, baseUrl?, apiKeyEnv?, stream?}; Studio buildPipelineConfig передаёт overrides; PipelineRunner.resolveOverride/agentCtxFor выбирает клиента и имя модели. Отдельного router service **не требуется**.
- **OpenRouter уже предусмотрен:** packages/core/src/llm/providers/endpoints/openrouter.ts — baseUrl https://openrouter.ai/api/v1. Вписанные в статический bank ID **не обязаны быть актуальными**; тест effective-llm-config подтверждает, что явно указанный OpenRouter ID вне bank сохраняется. Не использовать openrouter/auto для зафиксированного baseline: точный model ID обязателен.
- **Ограничение параметров:** per-agent schema **не содержит** temperature, thinkingBudget, apiFormat и extra. Строковый override меняет **только model ID**, наследуя client и настройки базовой модели. При отдельном baseUrl создаётся новый клиент, тоже с temperature/thinkingBudget/apiFormat базового LLMConfig. В первом G1 можно оставить общие умеренные параметры, **если** реальные модели поддерживают их; не делать наугад большой рефакторинг ради независимых температур.
- **Потенциальная ошибка метаданных для override:** packages/core/src/agent/worker-agent.ts:49 workerModel при смене ID копирует базовый PiModel и заменяет id/name, оставляя contextWindow, maxTokens, reasoning, compatibility и остальное от базовой модели. Значит фактический API model ID меняется, но лимиты/возможности могут оставаться **неактуальными**; проверять особенно перед Qwen Writer. Клиенты per-baseUrl кэшируются по endpoint/key/stream/format, а не model ID. Это **статический риск**, не доказанный сбой.
- **Обязательные структурированные tools:** runWorkerAgentTool посылает **одну result-tool** и toolChoice="required", проверяет payload через schema, допускает до **3 turns** до ошибки. **Поддержка tools в OpenRouter-каталоге не доказывает**, что конкретный host выполнит именно этот контракт; при недостаточной поддержке tool может игнорироваться, появиться 404, невалидные аргументы либо текст вместо tool-call. Все критические фазы проверять настоящий API-preflight **до покупки глав**.
- **Служебные имена действительно различаются:** в Runner встречаются "architect", "planner", "composer", "writer", "auditor", "reviser", "state-validator" и "stateValidator". Нельзя произвольно добавить ключ "settler" и ожидать отдельной модели: Writer вызывает settleChapterState под контекстом **writer** (в т.ч. при ревизии), StateValidator может использовать обе формы ключа. Для G1 документировать, какие ключи действительно использованы, и не назначать лишние overrides.
- **Сохранение и тарификация:** в model response есть usage; проект собирает token usage, но **реальные списания роутера и cache/pricing не выводятся из имени модели или одних token counts**. Сверять с кабинетом роутера; не класть платёжные данные и секреты в публичный GitHub.

Ссылки на точный кодовый срез: [project.ts](https://github.com/NeuralDao/inkos/blob/6a331c04280d98b9b42c468e45e071b0011085f0/packages/core/src/models/project.ts), [runner.ts](https://github.com/NeuralDao/inkos/blob/6a331c04280d98b9b42c468e45e071b0011085f0/packages/core/src/pipeline/runner.ts), [worker-agent.ts](https://github.com/NeuralDao/inkos/blob/6a331c04280d98b9b42c468e45e071b0011085f0/packages/core/src/agent/worker-agent.ts), [openrouter.ts](https://github.com/NeuralDao/inkos/blob/6a331c04280d98b9b42c468e45e071b0011085f0/packages/core/src/llm/providers/endpoints/openrouter.ts), [Studio server.ts](https://github.com/NeuralDao/inkos/blob/6a331c04280d98b9b42c468e45e071b0011085f0/packages/studio/src/api/server.ts).

## Минимальная кандидатная конфигурация (не активировать)

Для испытания после технических исправлений и согласования API:

| Фаза/ключ override | Кандидатный model ID | Причина |
| --- | --- | --- |
| Базовая модель: Architect, Planner, Composer, Auditor, StateValidator и остальные без override | deepseek/deepseek-v3.2 | Дешёвые служебные ответы и проверка фактов. Для аудитора это **отдельное семейство** от Writer |
| writer | qwen/qwen3.5-397b-a17b | Проверить качество русской сцены, диалогов и объём 1350 слов; **Settler пока остаётся на этой же модели** |
| reviser | minimax/minimax-m2.5 | Независимое семейство для правки русского, защита RiverLine и неприкосновенных сегментов |
| запасная ручная замена writer/reviser, но не автоматический fallback | moonshotai/kimi-k2.5 | Только если базовый кандидат не проходит tool контракт или литературный минимум |

Пока **не добавлять** отдельные ключи для Composer/Planner/Settler и не создавать новые классы моделей. Первую базовую модель можно сравнить с одним и тем же семейным стеком как диагностическую одно-модельную baseline **при доступном бюджете и после основного G1**, не превращать это в обязательный дополнительный прогон рассказа.

## Что должно быть сделано перед G1 (точка решения P1.M)

1. **До Codex:** дождаться независимого ревью текущей P1.2b; не вмешиваться в неё. P1.3a/b обязаны дать корректную русскую длину, заголовки и EPUB; R6 — не разрешение на параллельный рефакторинг.
2. **Точечная задача Codex P1.M по отдельному разрешению:** проверить штатный набор overrides для двух новых model ID на одном OpenRouter endpoint, правильный PiModel для каждой модели (contextWindow/output/compatibility), отсутствие скрытого ZH/неверного reasoning, корректность retry/usage; поддержка отдельных temperature/thinkingBudget **только если** без неё нет жизнеспособной конфигурации. Добавить минимальные deterministic mock/fake-API tests, без нового proxy и новых зависимостей.
3. **Условия настоящего платного preflight G1:** пользователь отдельно утверждает провайдера/OpenRouter account, model ID, выбранные provider endpoints/ограничения данных, потолок затрат. Каждой критической вызываемой роли (Writer/Auditor/Reviser/Settler) дать короткий реалистичный structured вызов с валидными аргументами/русским содержимым и требуемым tool call; при первом FAIL **остановить** дальнейший платный план. Это **часть G1**, не новая самостоятельная платная кампания.
4. **Только после preflight:** G1 — 3 русские главы по [R3 v1.0](./BENCHMARK_LONGFORM.md), оценка [R2](./RESEARCH_RU_RUBRIC.md) и [R4](./BENCHMARK_LONGFORM.md). Записать версию InkOS, точный ID моделей, фактическую конфигурацию и цены; только **проверенный результат** назвать baseline v1.
5. **Дальнейшая оптимизация R6(b):** после G1 по трассам выяснить, сколько стоят Writer.settle(), контекст/вызовы и аудитор/ревизия; лишь по этим данным решать о разделении Settler и per-agent параметрах, не раньше.

**Отдельное замечание:** поскольку OpenRouter может маршрутизировать один ID к нескольким hosting-провайдерам, для идеальной воспроизводимости полезна привязка к одному endpoint, но в текущей схеме overrides нельзя считать её автоматически реализованной. Достаточно сохранить фактический serving-provider из публичных endpoint-данных/доступных логов; делать provider-pinning в коде только если перемены хостинга реально мешают тесту. [OpenRouter routing changes, 28.10.2026](https://openrouter.ai/blog/announcements/how-we-rebuilt-provider-routing/), [tool calling FAQ](https://openrouter.ai/blog/tutorials/tool-calling/).

## Что не подтверждено

У нас **нет** доступа к фактическим настройкам OpenRouter пользователя, списаниям, latency и текущей локальной ветке P1.2b. Не проверялись конкретные provider endpoint параметры, сохранение reasoning/tool-calls на Pi/Stream, качество русской художественной прозы, аудит, роль Reviser, стабильность инструмента и вероятность ретраев. Цены из каталога не обещают доступности в аккаунте или конкретном регионе. Это **исследование выбора кандидатов**, а не технический ACCEPT реализации P1.M.

**Выход R6(a):** короткий shortlist/архитектурная проверка подготовлены; **аналитическая часть завершена**, live preflight и кодовая P1.M впереди. **R6(b) не начинать до замеров G1.**
