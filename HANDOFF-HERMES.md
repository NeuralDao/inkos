# HANDOFF-HERMES

## Идентичность
- Checkout передачи: `C:\Projects\inkos-merge-custom-main`; ветка `wip/handoff-2026-11-02`.
- Checkout, из которого реально запущен Studio/Core/CLI: `UNKNOWN` — активного процесса InkOS не обнаружено.
- База ветки: `custom/main`, HEAD `26ac2076`.
- Базовый WIP-коммит: `abe80919b757c12baca4ef5b046a34f950cd31ba`; последующие handoff-коммиты и актуальный HEAD см. `git log --oneline`.
- Последний файл в `packages/core/dist`: 2026-11-02 19:03:09 +01:00.
- Последний файл в `packages/cli/dist`: 2026-11-02 19:03:20 +01:00.
- Последний файл в `packages/studio/dist`: 2026-11-02 19:02:30 +01:00.
- Полный `git status --porcelain` до первоначального handoff: [handoff/status-before-commit.txt](handoff/status-before-commit.txt).
- Патч handoff-ветки относительно `custom/main`, без включения самого patch-файла: `handoff/wip-2026-11-02.patch`.

## Как запускается
- Сборка из корня checkout: `pnpm build`.
- Studio: `pnpm --filter @actalk/inkos-studio dev`; используется `INKOS_STUDIO_PORT`.
- CLI: Node через `packages/cli/dist/index.js`; типовая переменная `$cli` задана в playbook.
- Project root рабочего Work: `C:\Projects\inkos-g4-workspace`.
- Остальные переменные окружения и фактические значения: `UNKNOWN`.

## Сделано и проверено
- До последних изменений advisory post-audit пользователь сообщал о проходе тестов и сборки `PASS`; точный вывод в handoff не приложен.
- Ручные `write resume dogbook01 3` и `scripts/check-pipeline.ps1 -BookId dogbook01 -Chapter 3` выполнялись пользователем; checkpoint и текст главы сохранялись. В последовательных ручных прогонах встречались недоступный/неподтверждённый повторный аудит.
- Для CLI-playbook прочитаны `inkos --help`, `inkos config --help`, `inkos book --help`, `inkos work --help`, `inkos write --help`; параметры остальных групп сверены по определениям CLI-команд.
- `git diff --check` проходил после предыдущего обновления документации `write resume`.
- Текущие тесты, сборки, Studio, платные модели и генерация в handoff-сессиях не запускались.

## Сделано, но НЕ проверено
- Механизм advisory для неполного/сомнительного post-audit: `NOT RUN` после последних изменений.
- Повторное локальное использование сохранённого post-audit ответа и отсутствие сетевого вызова при resume: `NOT RUN` на текущем коде.
- CLI-playbook сверён статически с исходниками и частью `--help`, но примеры не исполнялись: `NOT RUN`.
- Текущая сборка Core/CLI/Studio после последних source/doc изменений: `NOT RUN`.
- Полный платный сквозной прогон: `NOT RUN`.

## В работе или сломано
- Поведение resume после сбоя/неполного ответа повторного аудитора не подтверждено на текущих изменениях. См. `packages/core/src/pipeline/runner.ts:1676-1803`.
- Преобразование неполных или недоказанных оценок post-audit в advisory-заметки требует тестов и сверки представления. См. `packages/core/src/agents/continuity.ts:30-95`, `packages/core/src/models/chapter.ts:13`.
- `C:\Projects\inkos-g4-workspace\scripts\check-pipeline.ps1` может трактовать недоступный post-audit как блокер; поведение после advisory-политики не проверено.
- CLI-playbook описывает ветку WIP; установленный у пользователя CLI может быть собран из другого checkout или более старых исходников.

## Решения, ожидающие владельца
- Источник реально запущенного Studio/Core/CLI: A) проверить командную строку процесса при запуске; B) считать этот checkout источником. Рекомендация: A; сейчас фактический runtime checkout `UNKNOWN`.
- Актуальный стек моделей и free-only routing: `UNKNOWN` без чтения рабочего `inkos.json`; рекомендация — сверить локально перед платным запуском.
- Состояние `check-pipeline.ps1`: A) синхронизировать его индикатор post-audit с advisory-политикой; B) оставить как строгую проверку артефактов, отдельно пояснив предупреждение. Рекомендация: A, если цель таблицы — показать блокирующую готовность главы.

## Следующая задача
- Цель: завершить и проверить безопасную advisory-обработку повторного аудита и восстановление главы через `write resume`.
- Файлы: `packages/core/src/agents/continuity.ts`, `packages/core/src/models/chapter.ts`, `packages/core/src/pipeline/runner.ts`, `packages/core/src/__tests__/unicode-length.flow.test.ts`; локальный workspace script — после сверки его версии.
- Приёмка: текст Ревизора остаётся принятым после технической проверки; повторный аудит сохраняет только проверенные заметки, сомнительные помечает как непроверенные; сбой/плохая схема post-audit сама по себе не блокирует главу; повторный resume не делает лишний платный вызов; статусная таблица согласована с этой политикой.
- Ограничения: пользователь сам запускает тесты/сборки и платные команды; не менять `inkos.json`; не push/merge; не менять `custom/main`.

## Ловушки
- Несколько checkout’ов: `inkos-merge-custom-main`, `inkos-auto-revision` (`feat/longform-auto-revision`), `inkos-auto-revision-test` (`test/auto-revision-pipeline`). Не смешивать их.
- Нет активного процесса InkOS; свежий `dist` сам по себе не доказывает, откуда запускался Studio.
- Work workspace отделён от репозитория исходников: команды книги запускаются из `C:\Projects\inkos-g4-workspace`.
- Длинный прогон `write next --count N` может писать несколько глав подряд; для ручного контроля указывать `--count 1`.
- `write resume` продолжает сохранённую главу; `write sync` только перестраивает состояние/аудирует; `write rewrite` заново генерирует главу.
- Для `book create` длинной формы в этой ветке языки фиксированы: операционный `en`, проза `ru`; CLI-флагов `--lang`/`--narrative-lang` у create нет.
- Повторный `book create` с тем же ID при неполной директории может удалить черновой Work; сначала проверить ID и backup.
- Полный стек моделей и free-only флаг не проверялись; не доверять старым скриншотам конфигурации.
- `fork-docs/` обновлялся по отдельному запросу владельца; передача включает `CLI_PLAYBOOK.md` и обновлённый статус. Не считать документацию подтверждением непрогнанных примеров.
