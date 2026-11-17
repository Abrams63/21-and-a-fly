"""FastAPI service: the fly's PyTorch brain over WebSocket, REST, and a Dash dashboard.

WS    /ws/brain          decide / reward / reset / set_drunk (used by the Bun game server)
GET   /health
GET   /brain             info + drunk level
GET   /brain/topology    neuron groups for the spike display
POST  /brain/reset       {"mode": "pretrained" | "naive"}
PATCH /brain/modifiers   {"drunk": 0..1}
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
    InfoMessage,
    ModifiersBody,
    ReinforcementMessage,
    ResetBody,
    ResetRequest,
    RewardRequest,
    SetDrunkRequest,
    Topology,
    request_adapter,
)

logger = logging.getLogger(__name__)

LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}


def _local_origin(origin: str | None) -> bool:
    """Browsers can open WebSockets to localhost from any site; only accept local pages (or no Origin, e.g. Bun)."""
    return origin is None or urlparse(origin).hostname in LOCAL_HOSTS


def _handle(brain: FlyBrain, req) -> str:
    match req:
        case DecideRequest(observation=obs):
            out = brain.decide(req.episode, obs.player_sum, obs.dealer_card, obs.usable_ace)
            msg = DecisionMessage(id=req.id, **out)
        case RewardRequest():
            out = brain.reward(req.episode, req.reward)
            msg = ReinforcementMessage(id=req.id, info=brain.info(), **out)
        case ResetRequest():
            brain.reset(req.mode)
            msg = Ack(id=req.id, info=brain.info(), drunk=brain.drunk)
        case SetDrunkRequest():
            brain.set_drunk(req.value)
            msg = Ack(id=req.id, info=brain.info(), drunk=brain.drunk)
    return msg.model_dump_json(by_alias=True)


def create_app(brain_factory: Callable[[], FlyBrain] = FlyBrain) -> FastAPI:
    clients: set[WebSocket] = set()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.brain = await asyncio.to_thread(brain_factory)
        yield

    app = FastAPI(title="Fly brain", lifespan=lifespan)

    def brain_of(request: Request | WebSocket) -> FlyBrain:
        return request.app.state.brain

    async def broadcast_info(brain: FlyBrain, skip: WebSocket | None = None) -> None:
        text = InfoMessage(info=brain.info(), drunk=brain.drunk).model_dump_json(by_alias=True)
        for client in list(clients):
            if client is not skip:
                try:
                    await client.send_text(text)
                except (WebSocketDisconnect, RuntimeError):  # closed while we were sending
                    clients.discard(client)

    @app.get("/", include_in_schema=False)
    async def root() -> RedirectResponse:
        return RedirectResponse("/dash/")

    @app.get("/health")
    async def health() -> dict:
        return {"ok": True}

    @app.get("/brain", response_model=BrainState, response_model_by_alias=True)
    async def brain_state(request: Request):
        brain = brain_of(request)
        return BrainState(info=brain.info(), drunk=brain.drunk)

    @app.get("/brain/topology", response_model=Topology, response_model_by_alias=True)
    async def topology(request: Request):
        return Topology.model_validate(brain_of(request).topology)

    @app.post("/brain/reset", response_model=BrainState, response_model_by_alias=True)
    async def reset(body: ResetBody, request: Request):
        brain = brain_of(request)
        await asyncio.to_thread(brain.reset, body.mode)
        await broadcast_info(brain)
        return BrainState(info=brain.info(), drunk=brain.drunk)

    @app.patch("/brain/modifiers", response_model=BrainState, response_model_by_alias=True)
    async def modifiers(body: ModifiersBody, request: Request):
        brain = brain_of(request)
        brain.set_drunk(body.drunk)
        await broadcast_info(brain)
        return BrainState(info=brain.info(), drunk=brain.drunk)

    @app.websocket("/ws/brain")
    async def ws_brain(socket: WebSocket) -> None:
        if not _local_origin(socket.headers.get("origin")):
            await socket.close(code=1008)
            return
        await socket.accept()
        brain = brain_of(socket)
        clients.add(socket)
        hello = Hello(topology=Topology.model_validate(brain.topology), info=brain.info(), drunk=brain.drunk)
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
                if isinstance(req, (ResetRequest, SetDrunkRequest)):
                    await broadcast_info(brain, skip=socket)
        except WebSocketDisconnect:
            pass
        finally:
            clients.discard(socket)

    dash_app = create_dash(lambda: app.state.brain)
    app.mount("/dash", WSGIMiddleware(dash_app.server))
    return app


def main() -> None:
    import uvicorn

    port = int(os.environ.get("FLY_BRAIN_PORT", "8000"))
    uvicorn.run(create_app(), host="127.0.0.1", port=port)
