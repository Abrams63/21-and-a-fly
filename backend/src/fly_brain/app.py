"""FastAPI service: the fly's PyTorch brain over WebSocket, REST, and a Dash dashboard.

WS    /ws/brain          decide / reward / reset, per fly (used by the Bun game server)
GET   /health
GET   /brain             what a new fly starts with + flies in memory
GET   /brain/topology    neuron groups for the spike display
GET   /dash/             Plotly Dash dashboard
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Callable
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from a2wsgi import WSGIMiddleware
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import RedirectResponse
from pydantic import ValidationError

from .brain import FlyBrain
from .dashboard import create_dash
from .schemas import (
    Ack,
    BrainState,
    DecideRequest,
    DecisionMessage,
    ErrorMessage,
    Hello,
    ReinforcementMessage,
    ResetRequest,
    RewardRequest,
    Topology,
    request_adapter,
)

logger = logging.getLogger(__name__)

LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}
#: How often the flies are written to disk while they learn.
SAVE_EVERY_S = 60


def _local_origin(origin: str | None) -> bool:
    """Browsers can open WebSockets to localhost from any site; only accept local pages (or no Origin, e.g. Bun)."""
    return origin is None or urlparse(origin).hostname in LOCAL_HOSTS


def _handle(brain: FlyBrain, req) -> str:
    match req:
        case DecideRequest(observation=obs):
            out = brain.decide(req.fly, req.episode, obs.player_sum, obs.dealer_card, obs.usable_ace, req.drunk)
            msg = DecisionMessage(id=req.id, **out)
        case RewardRequest():
            out = brain.reward(req.fly, req.episode, req.reward)
            msg = ReinforcementMessage(id=req.id, **out)
        case ResetRequest():
            msg = Ack(id=req.id, info=brain.reset(req.fly, req.mode))
    return msg.model_dump_json(by_alias=True)


def create_app(brain_factory: Callable[[], FlyBrain] = FlyBrain) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        brain = app.state.brain = await asyncio.to_thread(brain_factory)

        async def autosave() -> None:
            while True:
                await asyncio.sleep(SAVE_EVERY_S)
                if brain.unsaved:
                    try:
                        await asyncio.to_thread(brain.save_flies)
                    except Exception:
                        logger.exception("saving the flies failed")

        saver = asyncio.create_task(autosave())
        try:
            yield
        finally:
            saver.cancel()
            if brain.unsaved:  # a redeploy stops the service with SIGTERM: keep what was learned since the last save
                await asyncio.to_thread(brain.save_flies)

    app = FastAPI(title="Fly brain", lifespan=lifespan)

    def brain_of(request: Request | WebSocket) -> FlyBrain:
        return request.app.state.brain

    @app.get("/", include_in_schema=False)
    async def root() -> RedirectResponse:
        return RedirectResponse("/dash/")

    @app.get("/health")
    async def health() -> dict:
        return {"ok": True}

    @app.get("/brain", response_model=BrainState, response_model_by_alias=True)
    async def brain_state(request: Request):
        brain = brain_of(request)
        return BrainState(info=brain.info(), flies=len(brain.flies))

    @app.get("/brain/topology", response_model=Topology, response_model_by_alias=True)
    async def topology(request: Request):
        return Topology.model_validate(brain_of(request).topology)

    @app.websocket("/ws/brain")
    async def ws_brain(socket: WebSocket) -> None:
        if not _local_origin(socket.headers.get("origin")):
            await socket.close(code=1008)
            return
        await socket.accept()
        brain = brain_of(socket)
        hello = Hello(topology=Topology.model_validate(brain.topology), info=brain.info())
        await socket.send_text(hello.model_dump_json(by_alias=True))
        try:
            while True:
                raw = await socket.receive_text()
                try:
                    req = request_adapter.validate_json(raw)
                except ValidationError as error:
                    issue = error.errors()[0]
                    where = ".".join(map(str, issue["loc"]))
                    await socket.send_text(
                        ErrorMessage(message=f"bad request: {where}: {issue['msg']}").model_dump_json(by_alias=True)
                    )
                    continue
                try:
                    reply = await asyncio.to_thread(_handle, brain, req)
                except Exception as error:  # keep the socket alive; Bun falls back per request
                    logger.exception("brain request %s failed", req.type)
                    reply = ErrorMessage(id=req.id, message=str(error)).model_dump_json(by_alias=True)
                await socket.send_text(reply)
        except WebSocketDisconnect:
            pass

    dash_app = create_dash(lambda: app.state.brain)
    app.mount("/dash", WSGIMiddleware(dash_app.server))
    return app


def main() -> None:
    import socket

    import uvicorn

    # Loopback by default; a container sets FLY_BRAIN_HOST="::" (every IPv4 and IPv6 interface).
    host = os.environ.get("FLY_BRAIN_HOST", "127.0.0.1")
    port = int(os.environ.get("FLY_BRAIN_PORT") or os.environ.get("PORT") or "8000")
    server = uvicorn.Server(uvicorn.Config(create_app(), host=host, port=port))
    if host == "::" and socket.has_dualstack_ipv6():
        # asyncio binds "::" as IPv6-only; open one socket for both families instead,
        # since health checks and private networking may arrive over either.
        sock = socket.create_server(("::", port), family=socket.AF_INET6, dualstack_ipv6=True)
        server.run(sockets=[sock])
    else:
        server.run()
