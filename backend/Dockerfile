# Fly brain: FastAPI + PyTorch (CPU) spiking network.
FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Dependencies first, so code changes don't reinstall torch.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --locked --no-dev --no-install-project
COPY src ./src
RUN uv sync --locked --no-dev
COPY start.sh ./

# Listen on every interface (IPv4 and IPv6, for Railway private networking).
# Connectome and trained weights live under /data: mount a volume there to keep them across deploys.
ENV PATH="/app/.venv/bin:$PATH" \
    FLY_BRAIN_HOST="::" \
    FLY_BRAIN_DATA_DIR=/data/connectome \
    FLY_BRAIN_CHECKPOINT_DIR=/data/checkpoints

EXPOSE 8000
CMD ["sh", "/app/start.sh"]
