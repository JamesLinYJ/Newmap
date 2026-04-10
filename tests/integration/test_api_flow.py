import time

from fastapi.testclient import TestClient

from api_app.main import app


def test_api_run_flow_completes():
    with TestClient(app) as client:
        session = client.post("/api/v1/sessions").json()
        run = client.post(
            "/api/v1/chat",
            json={"sessionId": session["id"], "query": "查询巴黎地铁站 1 公里范围内的医院", "provider": "demo"},
        ).json()

        for _ in range(30):
            current = client.get(f"/api/v1/analysis/{run['id']}").json()
            if current["status"] in {"completed", "clarification_needed", "failed"}:
                break
            time.sleep(0.1)
        else:
            raise AssertionError("analysis did not finish in time")

        assert current["status"] == "completed"
        artifacts = client.get(f"/api/v1/analysis/{run['id']}/artifacts").json()
        assert artifacts


def test_geocode_and_provider_endpoints():
    with TestClient(app) as client:
        providers = client.get("/api/v1/providers").json()
        assert any(item["provider"] == "demo" for item in providers)

        geocode = client.get("/api/v1/geocode", params={"q": "巴黎"}).json()
        assert geocode["matches"]


def test_qgis_model_listing_endpoint():
    with TestClient(app) as client:
        payload = client.get("/api/v1/qgis/models").json()
        assert "buffer_and_intersect" in payload["models"]
