"""Messages on WS /ws/brain and the REST bodies, camelCase on the wire.

Bun → Python: every request carries an `id`; the reply echoes it.
Python → Bun: `hello` on connect.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from pydantic.alias_generators import to_camel

Mode = Literal["pretrained", "naive"]
Frames = list[list[int]]


class Wire(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


# ---- shared ------------------------------------------------------------


class Observation(Wire):
    player_sum: int = Field(ge=4, le=21)
    dealer_card: int = Field(ge=1, le=10)
    usable_ace: bool


class Group(Wire):
    id: Literal["input", "kc", "mbon_hit", "mbon_stand", "pam", "ppl1"]
    start: int
    size: int


class Topology(Wire):
    count: int
    groups: list[Group]
    bin_ms: float


class Info(Wire):
    source: Literal["python"] = "python"
    mode: Mode
    episodes: int
    wiring: Literal["hemibrain", "synthetic"]


class Mbon(Wire):
    hit: int
    stand: int


# ---- Bun → Python --------------------------------------------------------

FlyKey = Annotated[str, Field(min_length=1, max_length=200)]


class DecideRequest(Wire):
    type: Literal["decide"]
    id: int
    fly: FlyKey
    episode: str = Field(max_length=200)
    observation: Observation
    drunk: float = Field(default=0, ge=0, le=1)


class RewardRequest(Wire):
    type: Literal["reward"]
    id: int
    fly: FlyKey
    episode: str = Field(max_length=200)
    reward: float = Field(ge=-1, le=1)


class ResetRequest(Wire):
    type: Literal["reset"]
    id: int
    fly: FlyKey
    mode: Mode


Request = Annotated[
    DecideRequest | RewardRequest | ResetRequest,
    Field(discriminator="type"),
]
request_adapter: TypeAdapter[Request] = TypeAdapter(Request)


# ---- Python → Bun --------------------------------------------------------


class Hello(Wire):
    type: Literal["hello"] = "hello"
    topology: Topology
    #: What a newly seated fly starts with.
    info: Info


class DecisionMessage(Wire):
    type: Literal["decision"] = "decision"
    id: int
    action: Literal["hit", "stand"]
    frames: Frames
    mbon: Mbon


class ReinforcementMessage(Wire):
    type: Literal["reinforcement"] = "reinforcement"
    id: int
    kind: Literal["pam", "ppl1", "none"]
    frames: Frames
    info: Info


class Ack(Wire):
    type: Literal["ack"] = "ack"
    id: int
    info: Info


class ErrorMessage(Wire):
    type: Literal["error"] = "error"
    id: int | None = None
    message: str


# ---- REST ----------------------------------------------------------------


class BrainState(Wire):
    #: What a newly seated fly starts with.
    info: Info
    #: Flies currently kept in memory.
    flies: int
