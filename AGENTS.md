# AGENTS.md — NeuralDao/inkos

## Project

- Personal fork of `Narcooo/inkos`, focused on original, high-quality Russian-language serial fiction.
- Main goals: literary quality, reader engagement, manageable token costs, and future publishing to Author.Today / Boosty.
- Version 2.0 is under development; v1.8 is the latest released baseline. Do not assume their behavior is identical.
- Do not develop the translation pipeline unless explicitly requested.
- Prefer small, practical changes. Avoid speculative architecture, unnecessary abstractions, and unrelated refactoring.

## Repository and context

- Repository: `NeuralDao/inkos`.
- Target development branch: `custom/main`.
- Keep `master` and `upstream-main` clean as upstream tracking baselines.
- Before editing, inspect the actual branch, HEAD, working-tree status, and relevant source files.
- If the cloud checkout is not based on `custom/main`, stop and report it. Do not switch branches without approval.
- GitHub and the user's local Windows checkout may differ.
- Read `fork-docs/CURRENT_STATE.md` and `fork-docs/WORKFLOW.md` before implementation.
- Read `ROADMAP.md`, `DECISIONS.md`, `ARCHITECTURE.md`, and `LANGUAGE_AUDIT.md` only when relevant. Source code takes precedence over documentation.

## Roles and authorization

- The user controls goals, scope, budget, integration, publishing, and risky actions.
- ChatGPT performs architecture analysis, task planning, documentation maintenance, and independent code review.
- Codex implements approved code changes and provides diffs for review.
- Default to read-only investigation unless the user has authorized implementation.
- An approved task authorizes only changes needed within its stated scope, including narrow corrections.
- Do not start adjacent features, cleanup projects, migrations, or major refactoring without approval.
- Do not modify `fork-docs/`; ChatGPT maintains it.
- Do not modify this `AGENTS.md` without explicit approval.
- Never push, merge, rebase, force-push, publish, or modify protected tracking branches without explicit authorization.
- Create commits or pull requests only when requested.

## Development environment

- Primary target: native Windows and PowerShell (`pwsh`).
- Provide Windows-compatible commands, paths, and validation instructions.
- Prefer cross-platform implementations.
- Use WSL2/Linux for runtime requirements only when genuinely necessary and no reasonable native alternative exists.
- Cloud Linux may be used for scoped code editing and static inspection, but it does not establish Windows compatibility.
- Never claim the user's local environment is working based on cloud-only results.

## Execution and resource limits

Unless specifically authorized for the current task, DO NOT run:

- Dependency installation or updates: `pnpm install`, `pnpm add`, `npm install`, or equivalents.
- Builds, tests, lint, typecheck, E2E, Studio, or development servers.
- Repeated diagnostic loops or broad exploratory verification.
- Paid LLM/API calls, generation experiments, or external publishing.
- Destructive Git or filesystem operations.

Allowed by default:

- Reading source and configuration files.
- Inspecting Git status, diffs, and relevant history.
- Static reasoning and reviewing changes.
- Writing tests within an approved implementation task, without running them.
- Suggesting precise local validation commands for the user.

If a prohibited operation becomes necessary, explain why and request approval for that specific operation. Do not treat availability of a cloud environment as permission to run checks.

## Implementation standards

- Make the smallest coherent change that satisfies the task.
- Preserve existing behavior and compatibility unless the task explicitly changes them.
- Reuse existing mechanisms before introducing new abstractions or dependencies.
- Preserve existing uncommitted user changes.
- Do not fabricate test results, modify lockfiles speculatively, or suppress errors to create apparent success.
- Do not expose secrets, API keys, private manuscripts, or personal project data in public GitHub.

## Language-specific constraints

- Preserve InkOS's existing English and Chinese operational pipelines.
- Do not translate built-in Skills, internal prompts, JSON schemas, or canonical state formats into Russian.
- Russian narrative output must be handled through explicitly scoped contracts, not global prompt overrides.
- Never introduce conflicting language instructions for the same output artifact.
- Do not assume that Russian word counting works through existing English or Chinese metrics.
- Follow `fork-docs/LANGUAGE_AUDIT.md` for language-related work.

## Completion report

Report in Russian:

1. What changed and why.
2. Files changed and the diff or commit reference.
3. Risks, assumptions, and remaining limitations.
4. Checks actually performed, with PASS/FAIL or NOT RUN.
5. Minimal Windows/PowerShell commands for user-side verification.

Do not claim that unexecuted checks passed.

ChatGPT independently reviews the result as ACCEPT, REVISE, or REJECT. Technical acceptance does not authorize merging or publishing.
