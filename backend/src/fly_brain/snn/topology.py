"""Neuron groups of the fly's mushroom-body circuit and their index ranges.

Indices are global so spike frames can be sent as flat lists of neuron ids,
matching the layout the web client draws. Group sizes come from the wiring
(hemibrain counts or the synthetic defaults).
"""

from __future__ import annotations

from dataclasses import dataclass

from .wiring import N_INPUT, Wiring

DT_MS = 0.5
DECIDE_MS = 100.0
BIN_MS = 5.0
STEPS_PER_BIN = int(BIN_MS / DT_MS)
DECIDE_STEPS = int(DECIDE_MS / DT_MS)
DOPAMINE_MS = 70.0
DOPAMINE_STEPS = int(DOPAMINE_MS / DT_MS)

GROUP_IDS = ("input", "kc", "mbon_hit", "mbon_stand", "pam", "ppl1")


@dataclass(frozen=True)
class Group:
    id: str
    start: int
    size: int

    @property
    def stop(self) -> int:
        return self.start + self.size

    @property
    def slice(self) -> slice:
        return slice(self.start, self.stop)


@dataclass(frozen=True)
class Topology:
    groups: tuple[Group, ...]

    @classmethod
    def from_wiring(cls, wiring: Wiring) -> Topology:
        sizes = (N_INPUT, wiring.n_kc, wiring.n_mbon[0], wiring.n_mbon[1], wiring.n_pam, wiring.n_ppl1)
        groups, start = [], 0
        for gid, size in zip(GROUP_IDS, sizes, strict=True):
            groups.append(Group(gid, start, size))
            start += size
        return cls(tuple(groups))

    def __getitem__(self, gid: str) -> Group:
        return next(g for g in self.groups if g.id == gid)

    @property
    def count(self) -> int:
        return self.groups[-1].stop

    def as_dict(self) -> dict:
        return {
            "count": self.count,
            "groups": [{"id": g.id, "start": g.start, "size": g.size} for g in self.groups],
            "binMs": BIN_MS,
        }
