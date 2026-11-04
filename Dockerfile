FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TF_CPP_MIN_LOG_LEVEL=2 \
    NO_ALBUMENTATIONS_UPDATE=1 \
    HF_HOME=/data/huggingface

RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN python -m pip install --no-cache-dir '.[api]'

EXPOSE 8000
CMD ["sh", "-c", "xdfdet-api --host 0.0.0.0 --port ${PORT:-8000}"]
