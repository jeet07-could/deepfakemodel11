"""Supabase authentication and private analysis storage."""

import os
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException
from postgrest.exceptions import APIError
from storage3.exceptions import StorageException

DEFAULT_BUCKET = "deepfake-videos"
SIGNED_URL_TTL_SECONDS = 600


def create_storage_client():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise HTTPException(
            status_code=503,
            detail="Persistent storage is not configured on the inference server",
        )

    from supabase import create_client

    return create_client(url, key)


def authenticate_user(client, access_token: str | None) -> str:
    if not access_token or not access_token.strip():
        raise HTTPException(status_code=401, detail="Sign in to use video analysis")
    from supabase_auth.errors import AuthApiError

    try:
        response = client.auth.get_user(access_token.strip())
    except AuthApiError as error:
        raise HTTPException(status_code=401, detail="Your session is invalid or expired") from error
    if response.user is None:
        raise HTTPException(status_code=401, detail="Your session is invalid or expired")
    return str(response.user.id)


def _bucket(client):
    return client.storage.from_(DEFAULT_BUCKET)


def save_analysis(client, user_id: str, video_path: str, model: str, result: dict,
                  gradcam_png: bytes | None = None) -> dict:
    analysis_id = str(uuid4())
    suffix = Path(video_path).suffix.lower()
    object_path = f"{user_id}/{analysis_id}{suffix}"
    content_types = {
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".avi": "video/x-msvideo",
        ".mkv": "video/x-matroska",
        ".webm": "video/webm",
    }

    bucket = _bucket(client)
    bucket.upload(
        object_path,
        Path(video_path).read_bytes(),
        file_options={
            "content-type": content_types.get(suffix, "application/octet-stream"),
            "upsert": "false",
        },
    )
    gradcam_path = f"{user_id}/{analysis_id}.png" if gradcam_png is not None else None
    try:
        if gradcam_path is not None:
            bucket.upload(
                gradcam_path,
                gradcam_png,
                file_options={"content-type": "image/png", "upsert": "false"},
            )
    except StorageException:
        bucket.remove([object_path])
        raise
    try:
        rows = client.table("analyses").insert({
            "id": analysis_id,
            "user_id": user_id,
            "video_path": object_path,
            "model": model,
            "real_probability": result["real_probability"],
            "verdict": result["verdict"],
            "regions": result.get("regions", {}),
            "gradcam_path": gradcam_path,
        }).execute().data
    except APIError:
        bucket.remove([path for path in (object_path, gradcam_path) if path is not None])
        raise

    if not rows:
        bucket.remove([path for path in (object_path, gradcam_path) if path is not None])
        raise RuntimeError("The database did not return the saved analysis")
    return {"id": analysis_id, "created_at": rows[0]["created_at"]}


def list_analyses(client, user_id: str, offset: int = 0, limit: int = 100) -> dict:
    response = (
        client.table("analyses")
        .select("id,created_at,model,real_probability,verdict,video_path,gradcam_path,regions", count="exact")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .range(offset, offset + limit - 1)
        .execute()
    )
    rows = response.data
    result = []
    for row in rows:
        bucket = _bucket(client)
        signed = bucket.create_signed_url(row["video_path"], SIGNED_URL_TTL_SECONDS)
        gradcam_url = None
        if row["gradcam_path"]:
            gradcam_signed = bucket.create_signed_url(row["gradcam_path"], SIGNED_URL_TTL_SECONDS)
            gradcam_url = gradcam_signed.get("signedURL") or gradcam_signed.get("signedUrl")
        result.append({
            "id": row["id"],
            "created_at": row["created_at"],
            "model": row["model"],
            "real_probability": row["real_probability"],
            "verdict": row["verdict"],
            "video_url": signed.get("signedURL") or signed.get("signedUrl"),
            "gradcam_url": gradcam_url,
            "regions": row["regions"] or {},
        })
    total = response.count or 0
    return {"items": result, "total": total, "has_more": offset + len(result) < total}


def delete_analysis(client, user_id: str, analysis_id: str) -> None:
    rows = (
        client.table("analyses")
        .select("id,video_path,gradcam_path")
        .eq("id", analysis_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
        .data
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Analysis not found")
    paths = [rows[0]["video_path"]]
    if rows[0]["gradcam_path"]:
        paths.append(rows[0]["gradcam_path"])
    _bucket(client).remove(paths)
    client.table("analyses").delete().eq("id", analysis_id).eq("user_id", user_id).execute()
