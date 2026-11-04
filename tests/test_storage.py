from types import SimpleNamespace

from xdfdet.storage import delete_analysis, list_analyses, save_analysis


class FakeBucket:
    def __init__(self):
        self.uploads = {}
        self.removed = []

    def upload(self, path, data, file_options):
        self.uploads[path] = (data, file_options)

    def remove(self, paths):
        self.removed.extend(paths)

    def create_signed_url(self, path, expires_in):
        return {"signedURL": f"https://storage.example/{path}?ttl={expires_in}"}


class FakeQuery:
    def __init__(self, client):
        self.client = client
        self.filters = {}
        self.operation = None
        self.payload = None

    def insert(self, payload):
        self.operation = "insert"
        self.payload = payload
        return self

    def select(self, columns, count=None):
        self.operation = "select"
        return self

    def eq(self, field, value):
        self.filters[field] = value
        return self

    def order(self, field, desc):
        return self

    def range(self, start, end):
        self.client.range_values = (start, end)
        return self

    def limit(self, size):
        return self

    def delete(self):
        self.operation = "delete"
        return self

    def execute(self):
        if self.operation == "insert":
            self.client.inserted = self.payload
            return SimpleNamespace(data=[{"created_at": "2026-11-04T00:00:00+00:00"}])
        if self.operation == "delete":
            self.client.deleted_filters = self.filters
            return SimpleNamespace(data=[])
        if self.operation == "select":
            self.client.selected_filters = self.filters
            return SimpleNamespace(data=self.client.rows, count=len(self.client.rows))
        raise AssertionError("Unexpected database operation")


class FakeClient:
    def __init__(self):
        self.bucket = FakeBucket()
        self.storage = SimpleNamespace(from_=lambda name: self.bucket)
        self.rows = []

    def table(self, name):
        assert name == "analyses"
        return FakeQuery(self)


def test_save_analysis_uploads_video_heatmap_and_owner_metadata(tmp_path):
    video = tmp_path / "input.mp4"
    video.write_bytes(b"video")
    client = FakeClient()

    saved = save_analysis(
        client,
        "owner-id",
        str(video),
        "aug-cutout-black",
        {"real_probability": 0.75, "verdict": "real", "regions": {"jaw": 42.0}},
        b"png",
    )

    video_path = client.inserted["video_path"]
    gradcam_path = client.inserted["gradcam_path"]
    assert video_path.startswith("owner-id/") and video_path.endswith(".mp4")
    assert gradcam_path.startswith("owner-id/") and gradcam_path.endswith(".png")
    assert client.bucket.uploads[video_path][0] == b"video"
    assert client.bucket.uploads[gradcam_path][0] == b"png"
    assert client.inserted["user_id"] == "owner-id"
    assert client.inserted["regions"] == {"jaw": 42.0}
    assert saved["created_at"] == "2026-11-04T00:00:00+00:00"


def test_list_analyses_creates_short_lived_private_links(monkeypatch):
    monkeypatch.setenv("SUPABASE_REGION", "ap-south-1")
    client = FakeClient()
    client.rows = [{
        "id": "analysis-id",
        "created_at": "2026-11-04T00:00:00+00:00",
        "model": "aug-cutout-black",
        "real_probability": 0.75,
        "verdict": "real",
        "video_path": "owner-id/video.mp4",
        "gradcam_path": "owner-id/heatmap.png",
        "regions": {"jaw": 42.0},
    }]

    result = list_analyses(client, "owner-id", offset=20, limit=10)

    assert result["total"] == 1
    assert result["has_more"] is False
    assert result["items"][0]["video_url"].startswith("https://storage.example/")
    assert result["items"][0]["gradcam_url"].endswith("ttl=600")
    assert client.range_values == (20, 29)
    assert client.selected_filters == {"user_id": "owner-id"}


def test_delete_analysis_removes_only_the_selected_user_record():
    client = FakeClient()
    client.rows = [{
        "id": "analysis-id",
        "video_path": "owner-id/video.mp4",
        "gradcam_path": "owner-id/heatmap.png",
    }]

    delete_analysis(client, "owner-id", "analysis-id")

    assert client.bucket.removed == ["owner-id/video.mp4", "owner-id/heatmap.png"]
    assert client.deleted_filters == {"id": "analysis-id", "user_id": "owner-id"}
