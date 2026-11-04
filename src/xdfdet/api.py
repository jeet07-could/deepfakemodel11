"""HTTP API for xdfdet video predictions."""

import base64
import os
import tempfile
from pathlib import Path

import cv2
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from .config import CONFIGS
from .inference import DEFAULT_MODEL, predict_video
from .storage import (
    DEFAULT_BUCKET,
    authenticate_user,
    create_storage_client,
    delete_analysis,
    list_analyses,
    save_analysis,
)

MAX_UPLOAD_BYTES = 100 * 1024 * 1024
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
RELEASED_MODELS = frozenset(CONFIGS) - {"aug-intense"}
DEFAULT_CORS_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
STATIC_DIR = Path(__file__).with_name("static")


def create_app(allow_origins: list[str] | None = None,
               max_upload_bytes: int = MAX_UPLOAD_BYTES) -> FastAPI:
    app = FastAPI(title="xdfdet API", version="1.0.0")
    cors_origins = allow_origins
    if cors_origins is None:
        configured_origins = os.environ.get("XDFDET_CORS_ORIGINS")
        cors_origins = (
            [origin.strip() for origin in configured_origins.split(",") if origin.strip()]
            if configured_origins
            else DEFAULT_CORS_ORIGINS
        )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_methods=["DELETE", "GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )

    def current_user(
        authorization: str | None = Header(default=None),
        client=Depends(create_storage_client),
    ) -> str:
        scheme, _, token = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise HTTPException(status_code=401, detail="Sign in to use video analysis")
        return authenticate_user(client, token)

    @app.get("/health")
    def health():
        configured = bool(
            os.environ.get("SUPABASE_URL")
            and os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        )
        return {"status": "ok", "storage_configured": configured}

    @app.get("/models")
    def models():
        return {"default": DEFAULT_MODEL, "models": sorted(RELEASED_MODELS)}

    @app.get("/storage-info")
    def storage_info(_user_id: str = Depends(current_user)):
        return {
            "provider": "Supabase",
            "region": os.environ.get("SUPABASE_REGION"),
            "bucket": DEFAULT_BUCKET,
            "database_table": "public.analyses",
            "retention": "until manually deleted",
            "signed_url_ttl_seconds": 600,
        }

    @app.get("/", include_in_schema=False)
    def frontend():
        return FileResponse(STATIC_DIR / "index.html")

    @app.post("/predict")
    async def predict(
        file: UploadFile = File(...),
        model: str = Form(DEFAULT_MODEL),
        include_gradcam: bool = Form(False),
        user_id: str = Depends(current_user),
        client=Depends(create_storage_client),
    ):
        if model not in RELEASED_MODELS:
            raise HTTPException(status_code=422, detail="Unknown or unavailable model")

        suffix = Path(file.filename or "").suffix.lower()
        if suffix not in ALLOWED_EXTENSIONS:
            raise HTTPException(status_code=415, detail="Upload a supported video file")

        descriptor, temp_name = tempfile.mkstemp(suffix=suffix)
        try:
            total_bytes = 0
            with os.fdopen(descriptor, "wb") as destination:
                while chunk := await file.read(1024 * 1024):
                    total_bytes += len(chunk)
                    if total_bytes > max_upload_bytes:
                        raise HTTPException(status_code=413, detail="Video exceeds the upload limit")
                    destination.write(chunk)
            if total_bytes == 0:
                raise HTTPException(status_code=422, detail="Uploaded video is empty")

            try:
                result, gradcam_image = await run_in_threadpool(
                    predict_video, temp_name, model, include_gradcam
                )
            except ValueError as error:
                raise HTTPException(
                    status_code=422,
                    detail="Video could not be decoded or no face was detected",
                ) from error

            gradcam_png = None
            if gradcam_image is not None:
                encoded, png = cv2.imencode(".png", cv2.cvtColor(gradcam_image, cv2.COLOR_RGB2BGR))
                if not encoded:
                    raise RuntimeError("Could not encode the Grad-CAM image")
                gradcam_png = png.tobytes()
                result["gradcam"] = "data:image/png;base64," + base64.b64encode(gradcam_png).decode("ascii")
            saved = await run_in_threadpool(
                save_analysis, client, user_id, temp_name, model, result, gradcam_png
            )
            result.update({"analysis_id": saved["id"], "created_at": saved["created_at"]})
            return result
        finally:
            Path(temp_name).unlink(missing_ok=True)
            await file.close()

    @app.get("/history")
    def history(
        offset: int = Query(default=0, ge=0),
        limit: int = Query(default=50, ge=1, le=100),
        user_id: str = Depends(current_user),
        client=Depends(create_storage_client),
    ):
        return list_analyses(client, user_id, offset, limit)

    @app.delete("/history/{analysis_id}", status_code=204)
    def remove_history(
        analysis_id: str,
        user_id: str = Depends(current_user),
        client=Depends(create_storage_client),
    ):
        delete_analysis(client, user_id, analysis_id)

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


app = create_app()


def main(argv=None):
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="Run the xdfdet HTTP API")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default: localhost only)")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--allow-origin",
        action="append",
        dest="allow_origins",
        help="frontend origin allowed by CORS; may be supplied more than once",
    )
    args = parser.parse_args(argv)
    uvicorn.run(create_app(allow_origins=args.allow_origins), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
