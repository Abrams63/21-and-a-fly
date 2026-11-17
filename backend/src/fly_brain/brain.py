"""The live flies: one spiking mushroom body, one set of learned weights per fly.

Every fly at every table shares the wiring (input → KC → MBON) but has its own
KC→MBON weights, so what one player teaches their fly, or a reset, or a drink,
stays at that table. A fly is created from the pretrained weights the first
time it is seen.

An episode is one hand: any number of `decide` calls, then one `reward`. The
three-factor rule runs on `reward`, so the fly keeps learning while you play.
What the flies learned is saved next to the checkpoint (`save_flies`), so a
restart or redeploy does not send every fly back to school.
All methods are thread-safe (FastAPI calls them via `asyncio.to_thread`, Dash
from its own worker thread).
"""

from __future__ import annotations

import threading
from collections import OrderedDict, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import torch

from .snn import FlyNetwork, Modifiers, load_wiring, plasticity
from .snn.codec import encode
from .snn.wiring import Wiring
from .training import CHECKPOINT_FILE, all_states, load_into, save, train

Mode = Literal["pretrained", "naive"]
ACTIONS = ("hit", "stand")
LIVE_LEARNING_RATE = 0.05
MAX_OPEN_EPISODES = 512
#: Flies kept in memory; the least recently seen ones are forgotten first.
MAX_FLIES = 2000
PRETRAIN_HANDS = 400_000
FLIES_FILE = CHECKPOINT_FILE.with_name("flies.pt")


@dataclass
class Step:
    fly: str
    x: torch.Tensor  # KC eligibility trace [n_kc]
    action: int


@dataclass
class Fly:
    w_kc: torch.Tensor  # learned KC→MBON weights [n_kc, 2]
    mode: Mode
    episodes: int


class FlyBrain:
    def __init__(
        self, wiring: Wiring | None = None, checkpoint=CHECKPOINT_FILE, flies_file: Path | None = FLIES_FILE
    ) -> None:
        self._lock = threading.Lock()
        self.net = FlyNetwork(wiring or load_wiring())
        hands = load_into(self.net, checkpoint)
        if hands is None:
            print(f"No checkpoint for {self.net.wiring.source} wiring; pretraining {PRETRAIN_HANDS} hands...")
            trained = train(PRETRAIN_HANDS)
            self.net.w_kc = trained.w_kc
            save(self.net, PRETRAIN_HANDS, checkpoint)
            hands = PRETRAIN_HANDS
        self._pretrained_w = self.net.w_kc.clone()
        self._pretrained_hands = hands
        self.flies: OrderedDict[str, Fly] = OrderedDict()
        #: The fly that played last; the dashboard shows it.
        self.last_fly: str | None = None
        self.last_drunk = 0.0
        self._open: OrderedDict[str, list[Step]] = OrderedDict()
        self.rewards: deque[float] = deque(maxlen=2000)
        self.last_frames: list[list[int]] = []
        self._probe = self._probe_codes()
        self.flies_file = flies_file
        #: Hands learned since the flies were last saved.
        self.unsaved = 0
        self._load_flies()

    # ---- flies ------------------------------------------------------------

    def _new_fly(self, mode: Mode) -> Fly:
        if mode == "pretrained":
            return Fly(self._pretrained_w.clone(), "pretrained", self._pretrained_hands)
        net = self.net
        saved = net.w_kc
        net.reset_weights(seed=None)
        fly = Fly(net.w_kc, "naive", 0)
        net.w_kc = saved
        return fly

    def _fly(self, key: str) -> Fly:
        """The fly with this key, created from the pretrained weights if it is new. Call with the lock held."""
        fly = self.flies.get(key)
        if fly is None:
            fly = self.flies[key] = self._new_fly("pretrained")
            while len(self.flies) > MAX_FLIES:
                self.flies.popitem(last=False)
        self.flies.move_to_end(key)
        return fly

    def _use(self, key: str) -> Fly:
        """Loads a fly's weights into the network. Call with the lock held."""
        fly = self._fly(key)
        self.net.w_kc = fly.w_kc  # the same tensor: plasticity updates the fly in place
        self.last_fly = key
        return fly

    @staticmethod
    def _info(fly: Fly, source: str) -> dict:
        return {"source": "python", "mode": fly.mode, "episodes": fly.episodes, "wiring": source}

    # ---- what the game uses --------------------------------------------

    @property
    def topology(self) -> dict:
        return self.net.topology.as_dict()

    def info(self, fly: str | None = None) -> dict:
        """One fly's mode and experience; without a key, what a newly seated fly starts with."""
        with self._lock:
            if fly is None:
                return self._info(Fly(self._pretrained_w, "pretrained", self._pretrained_hands), self.net.wiring.source)
            return self._info(self._fly(fly), self.net.wiring.source)

    def decide(
        self, fly: str, episode: str, player_sum: int, dealer_card: int, usable_ace: bool, drunk: float = 0.0
    ) -> dict:
        rates = encode(torch.tensor([player_sum]), torch.tensor([dealer_card]), torch.tensor([int(usable_ace)]))
        drunk = min(max(float(drunk), 0.0), 1.0)
        with self._lock:
            self._use(fly)
            result = self.net.simulate(rates, Modifiers(drunk), record=True)
            action = int(result.actions[0])
            steps = self._open.setdefault(episode, [])
            steps.append(Step(fly, plasticity.eligibility(result.kc_counts)[0], action))
            self._open.move_to_end(episode)
            while len(self._open) > MAX_OPEN_EPISODES:
                self._open.popitem(last=False)
            self.last_frames = result.frames or []
            self.last_drunk = drunk
        hz = (result.mbon_rates[0] / 0.1).round().int().tolist()
        return {
            "action": ACTIONS[action],
            "frames": result.frames,
            "mbon": {"hit": hz[0], "stand": hz[1]},
        }

    def reward(self, fly: str, episode: str, reward: float) -> dict:
        kind = "pam" if reward > 0 else "ppl1" if reward < 0 else "none"
        with self._lock:
            # Steps belong to the fly that took them, even if the table has a new fly by now.
            steps = [s for s in self._open.pop(episode, []) if s.fly == fly]
            learner = self._use(fly)
            if steps:
                x = torch.stack([s.x for s in steps])
                actions = torch.tensor([s.action for s in steps])
                plasticity.apply(
                    learner.w_kc,
                    self.net.kc_pool,
                    x,
                    actions,
                    torch.full((len(steps),), float(reward)),
                    lr=LIVE_LEARNING_RATE / len(steps),
                )
                learner.episodes += 1
                self.unsaved += 1
                self.rewards.append(float(reward))
            frames = self.net.dopamine_frames(kind)
            info = self._info(learner, self.net.wiring.source)
        return {"kind": kind, "frames": frames, "info": info}

    def reset(self, fly: str, mode: Mode) -> dict:
        """Gives this table a fresh fly: pretrained, or naive (random weights)."""
        with self._lock:
            for episode, steps in list(self._open.items()):
                if any(s.fly == fly for s in steps):
                    del self._open[episode]
            new = self.flies[fly] = self._new_fly(mode)
            self.flies.move_to_end(fly)
            while len(self.flies) > MAX_FLIES:
                self.flies.popitem(last=False)
            self.unsaved += 1
            if self.last_fly == fly:
                self.net.w_kc = new.w_kc
            return self._info(new, self.net.wiring.source)

    # ---- saving the flies ------------------------------------------------

    def save_flies(self) -> int:
        """Writes every fly to `flies_file` (atomically); returns how many. No-op without a file."""
        if self.flies_file is None:
            return 0
        with self._lock:
            data = {
                "source": self.net.wiring.source,
                "n_kc": self.net.n_kc,
                "flies": {k: (f.w_kc.clone(), f.mode, f.episodes) for k, f in self.flies.items()},
            }
            self.unsaved = 0
        path = self.flies_file
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        torch.save(data, tmp)
        tmp.replace(path)
        return len(data["flies"])

    def _load_flies(self) -> None:
        path = self.flies_file
        if path is None or not path.exists():
            return
        try:
            data = torch.load(path, weights_only=True)
        except Exception as error:  # noqa: BLE001 - a torn or foreign file must not keep the brain from starting
            print(f"Ignoring {path}: {error}")
            return
        if data.get("source") != self.net.wiring.source or data.get("n_kc") != self.net.n_kc:
            print(f"Ignoring {path}: saved for another wiring")
            return
        for key, (w_kc, mode, episodes) in list(data["flies"].items())[-MAX_FLIES:]:
            self.flies[key] = Fly(w_kc, mode, int(episodes))
        print(f"Loaded {len(self.flies)} flies from {path}")

    # ---- what the dashboard uses ---------------------------------------

    def _probe_codes(self) -> torch.Tensor:
        """Sober KC codes of every observation, averaged over a few runs: [360, n_kc]."""
        ps, dc, ua = all_states()
        runs = [plasticity.eligibility(self.net.simulate(encode(ps, dc, ua)).kc_counts) for _ in range(3)]
        return torch.stack(runs).mean(dim=0)

    def policy(self) -> torch.Tensor:
        """Q(stand) − Q(hit) of the last fly that played, for [player sum 4..21, dealer 1..10, usable ace 0/1]."""
        with self._lock:
            q = self.net.values(self._probe)
        return (q[:, 1] - q[:, 0]).view(18, 10, 2)

    def weights(self) -> torch.Tensor:
        with self._lock:
            return (self.net.w_kc * self.net.kc_pool).clone()

    def snapshot(self) -> dict:
        with self._lock:
            last = self.flies.get(self.last_fly) if self.last_fly else None
            fly = last or Fly(self._pretrained_w, "pretrained", self._pretrained_hands)
            return {
                "rewards": list(self.rewards),
                "frames": list(self.last_frames),
                "info": self._info(fly, self.net.wiring.source),
                "flies": len(self.flies),
                "drunk": self.last_drunk,
            }
