from types import SimpleNamespace

from fastapi.testclient import TestClient

from xdfdet.api import create_app
from xdfdet.storage import create_storage_client

USER_ID = "00000000-0000-0000-0000-000000000001"


class FakeClient:
    class Auth:
        @staticmethod
        def get_user(token):
            if token != "valid-access-token":
                return SimpleNamespace(user=None)
            return SimpleNamespace(user=SimpleNamespace(id=USER_ID))

    auth = Auth()


def make_client(max_upload_bytes=100 * 1024 * 1024):
    app = create_app(max_upload_bytes=max_upload_bytes)
    app.dependency_overrides[create_storage_client] = lambda: FakeClient()
    return TestClient(app)


def test_health():
    response = TestClient(create_app()).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "storage_configured": False}


def test_frontend_and_model_list_are_served():
    client = TestClient(create_app())
    page = client.get("/")
    assert page.status_code == 200
    assert "Deep Fake" in page.text
    assert client.get("/static/styles.css").status_code == 200
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/static/config.js").status_code == 200

    models = client.get("/models")
    assert models.status_code == 200
    assert models.json()["default"] == "aug-cutout-black"
    assert "aug-intense" not in models.json()["models"]


def test_cors_allows_the_configured_vercel_origin():
    client = TestClient(create_app(allow_origins=["https://deepfake.example"]))
    response = client.options(
        "/predict",
        headers={
            "Origin": "https://deepfake.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://deepfake.example"
    assert "DELETE" in response.headers["access-control-allow-methods"]


def test_predict_upload_is_authenticated_and_persisted(monkeypatch):
    def fake_predict(path, model, include_gradcam):
        assert path.endswith(".mp4")
        assert model == "aug-cutout-black"
        assert include_gradcam is False
        return {"model": model, "real_probability": 0.75, "verdict": "real"}, None

    def fake_save(client, user_id, path, model, result, gradcam_png):
        assert user_id == USER_ID
        assert model == "aug-cutout-black"
        assert gradcam_png is None
        return {"id": "analysis-1", "created_at": "2026-11-04T00:00:00+00:00"}

    monkeypatch.setattr("xdfdet.api.predict_video", fake_predict)
    monkeypatch.setattr("xdfdet.api.save_analysis", fake_save)
    client = make_client()
    response = client.post(
        "/predict",
        headers={"Authorization": "Bearer valid-access-token"},
        files={"file": ("sample.mp4", b"video data", "video/mp4")},
        data={"model": "aug-cutout-black"},
    )
    assert response.status_code == 200
    assert response.json() == {
        "model": "aug-cutout-black",
        "real_probability": 0.75,
        "verdict": "real",
        "analysis_id": "analysis-1",
        "created_at": "2026-11-04T00:00:00+00:00",
    }


def test_predict_requires_an_authenticated_account():
    response = make_client().post(
        "/predict",
        files={"file": ("sample.mp4", b"video data", "video/mp4")},
    )
    assert response.status_code == 401


def test_invalid_access_token_is_rejected():
    response = make_client().get(
        "/history",
        headers={"Authorization": "Bearer invalid-access-token"},
    )
    assert response.status_code == 401


def test_storage_info_is_available_to_signed_in_users(monkeypatch):
    monkeypatch.setenv("SUPABASE_REGION", "ap-south-1")
    response = make_client().get(
        "/storage-info",
        headers={"Authorization": "Bearer valid-access-token"},
    )
    assert response.status_code == 200
    assert response.json() == {
        "provider": "Supabase",
        "region": "ap-south-1",
        "bucket": "deepfake-videos",
        "database_table": "public.analyses",
        "retention": "until manually deleted",
        "signed_url_ttl_seconds": 600,
    }


def test_predict_rejects_unavailable_model():
    response = make_client().post(
        "/predict",
        headers={"Authorization": "Bearer valid-access-token"},
        files={"file": ("sample.mp4", b"video data", "video/mp4")},
        data={"model": "aug-intense"},
    )
    assert response.status_code == 422


def test_predict_rejects_oversized_upload():
    response = make_client(max_upload_bytes=4).post(
        "/predict",
        headers={"Authorization": "Bearer valid-access-token"},
        files={"file": ("sample.mp4", b"12345", "video/mp4")},
    )
    assert response.status_code == 413


def test_history_is_authenticated_and_paginated(monkeypatch):
    response = TestClient(create_app()).get("/history")
    assert response.status_code == 503

    def fake_list(client, user_id, offset, limit):
        assert user_id == USER_ID
        assert offset == 25
        assert limit == 10
        return {"items": [], "total": 0, "has_more": False}

    monkeypatch.setattr("xdfdet.api.list_analyses", fake_list)
    response = make_client().get(
        "/history?offset=25&limit=10",
        headers={"Authorization": "Bearer valid-access-token"},
    )
    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0, "has_more": False}
