"""Shared video prediction pipeline for the CLI and HTTP API."""

import threading
from functools import lru_cache
from pathlib import Path

import numpy as np

DEFAULT_MODEL = "aug-cutout-black"
_INFERENCE_LOCK = threading.Lock()


@lru_cache(maxsize=1)
def _load_model(model_name):
    from .model import load_model

    return load_model(model_name)


def predict_video(video_path: str | Path, model_name: str = DEFAULT_MODEL,
                  include_gradcam: bool = False) -> tuple[dict, np.ndarray | None]:
    from .explain import overlay, region_scores, video_gradcam
    from .landmarks import landmarks
    from .video import crop_faces, frame_indices, normalize

    crops = crop_faces(video_path)
    frames = [crops[i] for i in frame_indices(len(crops))]
    sequence = np.stack([normalize(frame) for frame in frames])

    with _INFERENCE_LOCK:
        model = _load_model(model_name)
        score = float(model.predict(sequence[None], verbose=0).mean())
        result = {
            "model": model_name,
            "real_probability": round(score, 4),
            "verdict": "real" if score >= 0.5 else "fake",
        }
        gradcam_image = None
        if include_gradcam:
            cam = video_gradcam(model, sequence)
            mid = frames[len(frames) // 2]
            gradcam_image = overlay(mid, cam)
            points = landmarks(mid)
            if points is not None:
                result["regions"] = {key: round(value, 1)
                                     for key, value in region_scores(cam, points).items()}

    return result, gradcam_image
