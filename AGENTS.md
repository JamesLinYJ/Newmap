# AGENTS.md

## Purpose

This repository follows a unified file-header and commenting convention so that API, runtime, frontend, and tests read like one system instead of several unrelated code styles.

This document is the working standard for future edits.

## File Header Standard

Every non-trivial source file should start with a file header modeled after `apps/api/src/api_app/main.py`.

Python files use `#`.

TypeScript / TSX files use `//`.

Recommended template:

```text
# +-------------------------------------------------------------------------
#
#   地理智能平台 - 模块中文名称
#
#   文件:       file_name.py
#
#   日期:       YYYY年MM月DD日
#   作者:       Author Name
# --------------------------------------------------------------------------
```

TS / TSX uses the same structure with `//`.

## Commenting Rules

Comments should explain responsibility, intent, and boundary conditions.

Do:

- Add a short module-level header to describe the file’s role.
- Add a two-line comment block before important classes, helpers, fixtures, and stateful functions.
- For critical-path source files, explain state ownership, event semantics, approval boundaries, and recovery behavior instead of only restating names.
- Explain why a piece of logic exists, especially around runtime state, fallback boundaries, testing isolation, and UI state derivation.
- Prefer domain wording such as “运行时配置编辑态”, “测试数据库地址解析”, “fallback 硬边界判定”.

Do not:

- Repeat obvious syntax or restate line-by-line assignments.
- Fill product UI text with engineering commentary.
- Add comments to every tiny helper if the name already makes the behavior obvious.
- Hide business or runtime decisions inside code without a nearby comment explaining the rule.

## Backend Notes

- Runtime, store, API, and persistence code should document the single source of truth for state.
- If fallback exists, comments must state exactly when it is allowed and when it is forbidden.
- Test fixtures must document environment assumptions, especially database and service dependencies.

## Agent Context Standard

- `AgentStateModel` is the execution snapshot for a single run.
- `runtime/conversations` 下按 session/thread/run 分片的 JSON、JSONL 和 Markdown 是运行历史事实源；Postgres 不保存这些运行历史。
- `event_msg` is the real-time narrative and replay log for UI/SSE.
- `context_entry` and `compacted` records are persisted session facts; concrete historical facts must enter an Agent turn only through visible compaction or explicit context tools.
- Do not scan historical runs or event logs inside Agent runtime to improvise prompt context.
- Do not inject concrete historical context entries into the supervisor prompt by default. The prompt may state that indexed context exists, but the Agent must call `list_context_references` or `search_thread_context` before using previous-turn facts.
- Thread context should feel like an auditable session log, not hidden omniscience: no auto-revealed previous summaries, artifact names, coordinates, layer keys, or references unless the current user request explicitly asks to continue or reuse them.
- Do not backfill or silently recover old context payload shapes. If the canonical context schema changes before release, run `npm run reset:conversations` explicitly.
- Guardrail tripwires mean the final result failed a delivery boundary. Surface the concrete guardrail reason and stop at the configured repair limit.
- Do not hide model, tool, schema, or guardrail failures behind fallback success text, synthetic artifacts, or compatibility hacks.
- When adding context entries, store executable references explicitly: `referenceId`, `artifactId`, `collectionRef`, or `layerKey`.
- Current-run data must never be injected into that same run as historical thread context.
- Tool-derived scalar values, coordinates, bbox, variable names, statistics, and time indices must flow through `valueRef` in the runtime blackboard; later tools resolve the reference themselves and must fail on unknown refs instead of asking the model to copy raw values.

## Meteorological Data Standard

- NetCDF / GRIB / HDF5 / GeoTIFF / radar analysis belongs to the meteorological service, not to external desktop GIS runtimes.
- `xarray` is the source of truth for scientific semantics: variables, dimensions, time, level, units, missing values, and statistics.
- `rasterio/GDAL` is the raster map execution layer: CRS, bounds, subdatasets, reprojection, downsampling, and PNG rendering.
- Short-term nowcast logic belongs in `gis_meteorology.nowcast` domain services and `tool_registry.nowcast_tools` adapters; do not put nowcast algorithms in Agent prompts or registry glue.
- Inspect metadata must state whether each variable is analysis-ready and map-ready; execution must route from those facts and fail clearly when a backend is unavailable.
- Tool chains must pass `variable_ref`, `time_index_ref`, `level_index_ref`, `bbox_ref`, and `threshold_ref` rather than raw values when a previous tool produced a reference.
- Nowcast tool chains must pass `sequence_ref`, `nowcast_analysis_ref`, `forecast_text_ref`, and `nowcast_map_candidate_ref`; districts, locations, variables, time steps and movement trends must come from NC data, boundaries, geocoding and spatial statistics.
- Nowcast text may use a large model for expression, but facts must be deterministic and schema-validated. Missing products, boundaries, locations, model config or invalid model output must fail or request clarification instead of returning a fabricated forecast.
- DOCX meteorological interpretation reports must consume an explicit large-model interpretation reference (`interpretation_ref`) produced by the meteorological interpretation tool; metadata-only template reports or hand-copied long interpretation text must fail instead of pretending to be model analysis.
- External desktop-GIS runtime packages, routes, containers, model files, and approval assumptions are not part of this version. Do not reintroduce compatibility code for removed runtimes.

## Frontend Notes

- State comments should explain whether data is:
  - prop-derived
  - user-edited local state
  - memoized view state
  - debug-only diagnostic state
- When avoiding `useEffect` synchronization, add a short note describing the alternative pattern.
- Transcript and debug UI comments should focus on factual state flow, not implementation vanity.

## Test Files

- Test files should have the same file header style.
- Add short comments before fixtures, builders, and scenario-heavy tests.
- When a test intentionally verifies a policy change, say so directly in the comment.

## Scope Expectation

This standard applies first to:

- API entrypoints and platform services
- runtime / agent orchestration files
- major frontend panels and debug pages
- shared test fixtures
- integration tests with behavior semantics

For very small utility files, lightweight comments are acceptable if a full header would add more noise than value.

## Source Review Standard

- `apps/api` and `packages/agent-core` should clearly mark the single source of truth for run state, approvals, artifacts, and runtime config.
- `apps/web` should distinguish transcript derivation, local editing state, and server-derived state so UI does not look like it is inventing progress.
- `packages/gis-*` and `packages/tool-registry` should document where remote calls are optional, where artifacts are persisted, and which tools are approval-sensitive.
- `tests/*` should state whether they are pure unit tests, DB-backed tests, or full API lifecycle tests.

## Memory System Standard

- The repository instruction entrypoint is `AGENTS.md`, but GeoForge product runtime must keep instruction loading disabled unless `instructionMemoryEnabled` is explicitly set. This file is for development agents and repo maintainers, not hidden product prompt injection.
- `MEMORY.md` is only a long-term memory index. It must contain short links or hooks and must never contain full memory body text.
- Long-term memory body text must live in standalone Markdown topic files with Zod-validated frontmatter: `name`, `description`, `type`, and optional `paths`.
- Memory `type` is restricted to `user`, `feedback`, `project`, or `reference`.
- Private memory belongs in the user-private memory directory. Team memory belongs in the project shared memory directory. Sensitive personal data must not be written to team memory.
- Do not save code structure, file paths, Git history, temporary task state, tool result logs, artifact names, or facts that can be derived from the current repository, runtime store, layer catalog, or configuration.
- Memory records can become stale. If a memory mentions files, functions, flags, configuration, layers, tools, or data products, verify the current state before using it.
- Automatic memory extraction must run in a restricted fork that can only read, search, write, and delete memory. It must not edit business source files or call GIS, meteorology, export, import, or other side-effect tools.
- Historical run logs, event logs, and transcript files must not be scanned by runtime and silently injected into prompts. Previous facts enter a turn only through visible session memory, compaction, or explicit context/memory tools.

## Tool Module Standard

- New tools must enter the platform as explicit in-repo `ToolProvider` modules with a `ToolManifest`; do not hide tools in ad hoc registry side effects.
- Tool providers are loaded only from explicit allowlists such as `ENABLED_TOOL_PROVIDERS`; installed or merged code is not automatically enabled.
- Tool handlers should be thin adapters around domain services. Business algorithms belong in domain packages or service modules, not in registry glue.
- Every tool definition must pass `validate_tool_definition()` before it is exposed to Agent runtime or DebugPage.
- Tool modules must follow `docs/tool-integration-standard.md`, including naming, parameter metadata, valueRef flow, artifact persistence, provenance, approval and error rules.
- Different teams may develop tools independently, but merge review must include provider contract tests and descriptor tests so UI, Agent and runtime behavior stay unified.
