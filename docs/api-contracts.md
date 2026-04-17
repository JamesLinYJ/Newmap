# API Contracts

## Sessions

- `POST /api/v1/sessions`
- `GET /api/v1/sessions/{id}`
- `GET /api/v1/sessions/{id}/runs`
- `GET /api/v1/system/components`

## Analysis

- `POST /api/v1/chat`
- `POST /api/v1/analysis/run`
- `GET /api/v1/analysis/{run_id}`
- `GET /api/v1/analysis/{run_id}/events`
- `GET /api/v1/analysis/{run_id}/artifacts`
- `POST /api/v2/threads`
- `GET /api/v2/threads/{thread_id}`
- `POST /api/v2/threads/{thread_id}/runs`
- `GET /api/v2/runs/{run_id}`
- `GET /api/v2/runs/{run_id}/events`
- `POST /api/v2/runs/{run_id}/approvals/{approval_id}`
- `GET /api/v1/qgis/models`
- `POST /api/v1/qgis/process`
- `POST /api/v1/qgis/models/run`

## Layers

- `GET /api/v1/layers`
- `POST /api/v1/layers/register`
- `GET /api/v1/geocode?q=...`
- `GET /api/v1/reverse-geocode?lat=...&lng=...`
- `GET /api/v1/providers`

## Results

- `GET /api/v1/results/{artifact_id}/geojson`
- `GET /api/v1/results/{artifact_id}/metadata`
- `POST /api/v1/results/{artifact_id}/publish`
