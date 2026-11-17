"""The live fly: one spiking mushroom body shared by every table.

An episode is one hand: any number of `decide` calls, then one `reward`. The
three-factor rule runs on `reward`, so the fly keeps learning while you play.
All methods are thread-safe (FastAPI calls them via `asyncio.to_thread`, Dash
from its own worker thread).
"""

from __future__ import annotations

import threading
from collections import OrderedDict, deque
from dataclasses import dataclass
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
PRETRAIN_HANDS = 400_000


@dataclass
class Step:
    x: torch.Tensor  # KC eligibility trace [n_kc]
    action: int


class FlyBrain:
    def __init__(self, wiring: Wiring | None = None, checkpoint=CHECKPOINT_FILE) -> None:
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
        self.mode: Mode = "pretrained"
        self.episodes = hands
        self.drunk = 0.0
        self._open: OrderedDict[str, list[Step]] = OrderedDict()
        self.rewards: deque[float] = deque(maxlen=2000)
        self.last_frames: list[list[int]] = []
        self._probe = self._probe_codes()

    # ---- what the game uses --------------------------------------------

    @property
    def topology(self) -> dict:
        return self.net.topology.as_dict()

    def info(self) -> dict:
        return {
            "source": "python",
            "mode": self.mode,
            "episodes": self.episodes,
            "wiring": self.net.wiring.source,
        }

    def decide(self, episode: str, player_sum: int, dealer_card: int, usable_ace: bool) -> dict:
        rates = encode(torch.tensor([player_sum]), torch.tensor([dealer_card]), torch.tensor([int(usable_ace)]))
        with self._lock:
            result = self.net.simulate(rates, Modifiers(self.drunk), record=True)
            action = int(result.actions[0])
            steps = self._open.setdefault(episode, [])
            steps.append(Step(plasticity.eligibility(result.kc_counts)[0], action))
            self._open.move_to_end(episode)
            while len(self._open) > MAX_OPEN_EPISODES:
                self._open.popitem(last=False)
            self.last_frames = result.frames or []
        hz = (result.mbon_rates[0] / 0.1).round().int().tolist()
        return {
            "action": ACTIONS[action],
            "frames": result.frames,
            "mbon": {"hit": hz[0], "stand": hz[1]},
        }

    def reward(self, episode: str, reward: float) -> dict:
        kind = "pam" if reward > 0 else "ppl1" if reward < 0 else "none"
        with self._lock:
            steps = self._open.pop(episode, [])
            if steps:
                x = torch.stack([s.x for s in steps])
                actions = torch.tensor([s.action for s in steps])
                plasticity.apply(
                    self.net.w_kc,
                    self.net.kc_pool,
                    x,
                    actions,
                    torch.full((len(steps),), float(reward)),
                    lr=LIVE_LEARNING_RATE / len(steps),
                )
                self.episodes += 1
                self.rewards.append(float(reward))
            frames = self.net.dopamine_frames(kind)
        return {"kind": kind, "frames": frames}

    def set_drunk(self, value: float) -> None:
        with self._lock:
            self.drunk = min(max(float(value), 0.0), 1.0)

    def reset(self, mode: Mode) -> None:
        with self._lock:
            self.mode = mode
            self._open.clear()
            self.rewards.clear()
            if mode == "pretrained":
                self.net.w_kc = self._pretrained_w.clone()
                self.episodes = self._pretrained_hands
            else:
                self.net.reset_weights(seed=None)
                self.episodes = 0

    # ---- what the dashboard uses ---------------------------------------

    def _probe_codes(self) -> torch.Tensor:
        """Sober KC codes of every observation, averaged over a few runs: [360, n_kc]."""
        ps, dc, ua = all_states()
        runs = [plasticity.eligibility(self.net.simulate(encode(ps, dc, ua)).kc_counts) for _ in range(3)]
        return torch.stack(runs).mean(dim=0)

    def policy(self) -> torch.Tensor:
        """Q(stand) − Q(hit) for [player sum 4..21, dealer 1..10, usable ace 0/1]."""
        with self._lock:
            q = self.net.values(self._probe)
        return (q[:, 1] - q[:, 0]).view(18, 10, 2)

    def weights(self) -> torch.Tensor:
        with self._lock:
            return (self.net.w_kc * self.net.kc_pool).clone()

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "rewards": list(self.rewards),
                "frames": list(self.last_frames),
                "info": self.info(),
                "drunk": self.drunk,
            }
