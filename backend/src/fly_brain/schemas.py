"""Messages on WS /ws/brain and the REST bodies, camelCase on the wire.

Bun → Python: every request carries an `id`; the reply echoes it.
Python → Bun: `hello` on connect, `info` whenever the brain changes from elsewhere
(REST, dashboard, another Bun process).
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


class DecideRequest(Wire):
    type: Literal["decide"]
    id: int
    episode: str = Field(max_length=200)
    observation: Observation


class RewardRequest(Wire):
    type: Literal["reward"]
    id: int
    episode: str = Field(max_length=200)
    reward: float = Field(ge=-1, le=1)


class ResetRequest(Wire):
    type: Literal["reset"]
    id: int
    mode: Mode


class SetDrunkRequest(Wire):
    type: Literal["set_drunk"]
    id: int
    value: float = Field(ge=0, le=1)


Request = Annotated[
    DecideRequest | RewardRequest | ResetRequest | SetDrunkRequest,
    Field(discriminator="type"),
]
request_adapter: TypeAdapter[Request] = TypeAdapter(Request)


# ---- Python → Bun --------------------------------------------------------


class Hello(Wire):
    type: Literal["hello"] = "hello"
    topology: Topology
    info: Info
    drunk: float


class InfoMessage(Wire):
    type: Literal["info"] = "info"
    info: Info
    drunk: float


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
    drunk: float


class ErrorMessage(Wire):
    type: Literal["error"] = "error"
    id: int | None = None
    message: str


# ---- REST ----------------------------------------------------------------


class ResetBody(Wire):
    mode: Mode


class ModifiersBody(Wire):
    drunk: float = Field(ge=0, le=1)


class BrainState(Wire):
    info: Info
    drunk: float
