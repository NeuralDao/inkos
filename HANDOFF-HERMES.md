# HANDOFF-HERMES

## Идентичность
- Checkout передачи: `C:\Projects\inkos-merge-custom-main` (последние команды разработки выполнялись здесь).
- Checkout, из которого реально запущен Studio/Core/CLI: `UNKNOWN` — на момент проверки процесса InkOS не обнаружено.
- Исходная ветка: `custom/main`; исходный HEAD: `26ac2076`.
- WIP-ветка: `wip/handoff-2026-11-02`; WIP-коммит: `abe80919b757c12baca4ef5b046a34f950cd31ba` (`wip: handoff before Codex limit`).
- Последний файл в `packages/core/dist`: 2026-11-02 19:03:09 +01:00.
- Последний файл в `packages/cli/dist`: 2026-11-02 19:03:20 +01:00.
- Последний файл в `packages/studio/dist`: 2026-11-02 19:02:30 +01:00.
- Полный `git status --porcelain` до handoff-артефактов: [handoff/status-before-commit.txt](handoff/status-before-commit.txt).

## Как запускается
- Сборка: из корня checkout `pnpm build`.
- Studio (известная команда): `pnpm --filter @actalk/inkos-studio dev`; переменная `INKOS_STUDIO_PORT` (значение не фиксировать).
- CLI запускается Node через `packages/cli/dist/index.js`.
- Последний использованный project root: `C:\Projects\inkos-g4-workspace`.
- Остальные переменные окружения для запуска: `UNKNOWN`.

## Сделано и проверено
- Пользователь сообщил: целевые тесты и сборка прошли `PASS` до последних изменений advisory post-audit; точные команды/вывод этих успешных запусков в текущей передаче не приложены.
- Ручной `write resume dogbook01 3` запускался пользователем; выполнение дошло до сохранения главы, обновления truth-файлов и post-audit.
- Ручная проверка `scripts/check-pipeline.ps1 -BookId dogbook01 -Chapter 3` после успешного восстановления показала все этапы `✓`; поздний повтор снова показал `Повторный аудит ✗`.
- В этом handoff-тёрне тесты, сборки, генерация/API не запускались.

## Сделано, но НЕ проверено
- Изменения по сохранению неполных/сомнительных заметок post-audit как advisory, без блокировки выпуска: `NOT RUN` после этих изменений.
- Новые тестовые ожидания для advisory post-audit: `NOT RUN` после этих изменений.
- Финальная сборка текущего WIP: `NOT RUN`.
- Запуск Studio из любого checkout: `NOT RUN`.

## В работе или сломано
- Post-audit всё ещё может повторно вызвать дорогую модель при `write resume`; сохранённый ответ пока не гарантированно переиспользуется: `packages/core/src/pipeline/runner.ts:1703-1738`.
- Некорректные доказательства повторного аудита должны становиться пометками для вычитки, но проверка и отображение предупреждений не завершены: `packages/core/src/agents/continuity.ts:30-95`, `packages/core/src/models/chapter.ts:13`.
- Текущий скрипт статуса может помечать advisory post-audit как блокирующий; его путь/строки в checkout передачи: `UNKNOWN`.
- Последний ручной запуск `write resume` завершился `CHAPTER_RESUME_REQUIRED`; затем таблица показывала `Повторный аудит ✗` при остальном `✓`.

## Решения, ожидающие владельца
- Неверифицированные заметки post-audit: A) сохранить как advisory с явной пометкой; B) отклонить весь отчёт. Рекомендация: A, без автоматического изменения статуса исходных замечаний.
- Реальный Studio checkout: A) подтвердить текущую папку процесса при следующем запуске; B) считать checkout передачи авторитетным. Рекомендация: A; сейчас runtime `UNKNOWN`.
- Модели/провайдеры активного стека и free-only routing: `UNKNOWN` без чтения текущего `inkos.json`.

## Следующая задача
- Цель: завершить advisory-поведение повторного аудита: сохранять ответ и сомнительные заметки для человека/LLM, не блокировать завершение главы и не запускать повторную платную генерацию при resume.
- Файлы: `packages/core/src/agents/continuity.ts`, `packages/core/src/models/chapter.ts`, `packages/core/src/pipeline/runner.ts`, тесты в `packages/core/src/__tests__/unicode-length.flow.test.ts`; локальный `scripts/check-pipeline.ps1` — если путь подтверждён.
- Приёмка: глава остаётся завершённой при недоступном/частично невалидном post-audit; замечания и причины сохранены, нерешённые исходные находки не объявлены устранёнными; повторный resume не вызывает модель без необходимости.
- Запрещено: тесты/сборки/платные API без отдельного запуска владельцем; менять `inkos.json`; переписывать `fork-docs/`; push/merge и изменение `custom/main`.

## Ловушки
- Есть несколько checkout’ов: `inkos-merge-custom-main` (`custom/main` на момент проверки), `inkos-auto-revision` (`feat/longform-auto-revision`), `inkos-auto-revision-test` (`test/auto-revision-pipeline`). Не путать их.
- Studio процесса сейчас нет; наличие свежих dist-файлов не доказывает, какой checkout был источником последнего запуска.
- Project root для книги отдельный: `C:\Projects\inkos-g4-workspace`; команды CLI надо выполнять из него.
- Текущий полный стек моделей и наличие free-only флага не проверялись и неизвестны; старые скриншоты и назначения могли устареть.
- `fork-docs/` имел изменения до handoff; они включаются в WIP-коммит как часть уже имеющейся незакоммиченной работы, но в этом handoff не редактировались.

