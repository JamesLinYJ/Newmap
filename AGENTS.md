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
- Agent 会话 JSONL 日志是 thread、run、event、context index 的事实源；Postgres 不保存这些运行历史。
- `event_msg` is the real-time narrative and replay log for UI/SSE.
- `context_entry` and `compacted` records are the only backend facts used to assemble Agent prompt context.
- Do not scan historical runs or event logs inside Agent runtime to improvise prompt context.
- Do not backfill or silently recover old context payload shapes. If the canonical context schema changes before release, reset development data and `runtime/sessions` explicitly.
- Guardrail tripwires mean the final result failed a delivery boundary. Surface the concrete guardrail reason and stop at the configured repair limit.
- Do not hide model, tool, schema, or guardrail failures behind fallback success text, synthetic artifacts, or compatibility hacks.
- When adding context entries, store executable references explicitly: `referenceId`, `artifactId`, `collectionRef`, or `layerKey`.
- Current-run data must never be injected into that same run as historical thread context.
- Tool-derived scalar values, coordinates, bbox, variable names, statistics, and time indices must flow through `valueRef` in the runtime blackboard; later tools resolve the reference themselves and must fail on unknown refs instead of asking the model to copy raw values.

## Meteorological Data Standard

- NetCDF / GRIB / HDF5 / GeoTIFF / radar analysis belongs to the meteorological service, not to external desktop GIS runtimes.
- `xarray` is the source of truth for scientific semantics: variables, dimensions, time, level, units, missing values, and statistics.
- `rasterio/GDAL` is the raster map execution layer: CRS, bounds, subdatasets, reprojection, downsampling, and PNG rendering.
- Inspect metadata must state whether each variable is analysis-ready and map-ready; execution must route from those facts and fail clearly when a backend is unavailable.
- Tool chains must pass `variable_ref`, `time_index_ref`, `level_index_ref`, `bbox_ref`, and `threshold_ref` rather than raw values when a previous tool produced a reference.
- DOCX meteorological interpretation reports must include explicit large-model interpretation text (`llm_interpretation`); metadata-only template reports must fail instead of pretending to be model analysis.
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
