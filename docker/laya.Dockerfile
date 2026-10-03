# syntax=docker/dockerfile:1.7
# Laya, the local decision model (SPEC 5.12), on PyTorch CPU for Linux, Windows and Intel Macs, or on
# CUDA when `make up` finds an NVIDIA GPU (TORCH_INDEX and LAYA_DEVICE).
# Serves laya-serve's /v1/systemone on port 8000 of the compose network only; majhi's server
# starts the container on the first question and stops it when idle. Weights download on first use
# into the laya-cache volume.
FROM python:3.11-slim-bookworm

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TORCH_DISABLE_NATIVE_JIT=1 \
    TOKENIZERS_PARALLELISM=false \
    USE_TF=0 \
    USE_TORCH=1 \
    HF_HOME=/home/laya/.cache/huggingface \
    LAYA_HOST=0.0.0.0 \
    LAYA_PORT=8000 \
    LAYA_PRELOAD=0 \
    LAYA_MODELS=english \
    LAYA_THREADS=4 \
    OMP_NUM_THREADS=4

ARG TORCH_VERSION=2.14.0
ARG LAYA_VERSION=0.3.22
# PyTorch's CPU wheels, or its CUDA ones (https://download.pytorch.org/whl/cu130 from `make up`, which
# has them for amd64 and arm64).
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install "torch==${TORCH_VERSION}" --index-url "${TORCH_INDEX}" \
    && pip install "laya[serve]==${LAYA_VERSION}" \
    && pip check

# laya-serve's device. `cuda` falls back to the CPU when the container has no GPU.
ARG LAYA_DEVICE=cpu
ENV LAYA_DEVICE=${LAYA_DEVICE}

RUN groupadd --gid 10001 laya \
    && useradd --uid 10001 --gid laya --create-home laya \
    && mkdir -p /home/laya/.cache/huggingface \
    && chown -R laya:laya /home/laya/.cache
USER laya
WORKDIR /home/laya
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=2m --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"
CMD ["laya-serve"]
