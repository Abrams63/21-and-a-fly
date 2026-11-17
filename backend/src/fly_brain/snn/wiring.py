"""Where the fly's wiring comes from: the hemibrain connectome, or a synthetic stand-in.

A `Wiring` carries only what the simulator needs:

* `w_in`   [N_INPUT, n_kc]  projection-neuron → Kenyon-cell drive, one row per game channel
* `kc_pool` [n_kc, 2]       how strongly each KC reaches the "hit" and "stand" MBON pools (0..1)
* sizes of the MBON pools and dopamine clusters, for the read-out and the display

`fly-connectome` (see `fly_brain.connectome`) downloads the hemibrain data and
writes `data/hemibrain_mb.npz`; without that file the synthetic wiring is used.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import torch

N_INPUT = 30
KC_FAN_IN = 7
W_IN = 0.55  # drive per synthetic PN→KC connection: one active input rarely fires a KC, two do

DATA_DIR = Path(__file__).resolve().parents[3] / "data"
HEMIBRAIN_FILE = DATA_DIR / "hemibrain_mb.npz"


@dataclass
class Wiring:
    source: str
    w_in: torch.Tensor
    kc_pool: torch.Tensor
    n_mbon: tuple[int, int]  # (hit, stand)
    n_pam: int
    n_ppl1: int
    meta: dict = field(default_factory=dict)

    @property
    def n_kc(self) -> int:
        return self.w_in.shape[1]


def synthetic(seed: int = 21, n_kc: int = 2000) -> Wiring:
    """Random sparse PN→KC wiring (each KC samples 7 channels), every KC reaches both pools."""
    gen = torch.Generator().manual_seed(seed)
    picks = torch.rand(n_kc, N_INPUT, generator=gen).argsort(dim=1)[:, :KC_FAN_IN]
    w_in = torch.zeros(N_INPUT, n_kc)
    w_in[picks.T.flatten(), torch.arange(n_kc).repeat(KC_FAN_IN)] = W_IN
    return Wiring(
        source="synthetic",
        w_in=w_in,
        kc_pool=torch.ones(n_kc, 2),
        n_mbon=(16, 16),
        n_pam=10,
        n_ppl1=10,
    )


def from_counts(
    pn_kc: np.ndarray,
    kc_mbon_pool: np.ndarray,
    n_mbon: tuple[int, int],
    n_pam: int,
    n_ppl1: int,
    meta: dict,
) -> Wiring:
    """Turns raw synapse counts into simulator weights.

    pn_kc        [N_INPUT, n_kc] synapses from each channel's projection neurons onto each KC
    kc_mbon_pool [n_kc, 2]       synapses from each KC onto the hit / stand MBON pools
    """
    pn_kc = pn_kc.astype(np.float32)
    # Each KC gets the same total drive as a synthetic KC, split by its real synapse counts,
    # so the simulator keeps the same operating point (sparse KC coding).
    totals = pn_kc.sum(axis=0, keepdims=True)
    w_in = np.divide(pn_kc, totals, out=np.zeros_like(pn_kc), where=totals > 0) * (KC_FAN_IN * W_IN)
    # A KC with a single strong input should still need a partner to fire.
    w_in = np.minimum(w_in, 0.8)

    pool = kc_mbon_pool.astype(np.float32)
    scale = np.percentile(pool[pool > 0], 95) if (pool > 0).any() else 1.0
    kc_pool = np.clip(pool / scale, 0.0, 1.0)

    return Wiring(
        source="hemibrain",
        w_in=torch.from_numpy(w_in),
        kc_pool=torch.from_numpy(kc_pool),
        n_mbon=n_mbon,
        n_pam=n_pam,
        n_ppl1=n_ppl1,
        meta=meta,
    )


def save_hemibrain(path: Path, pn_kc: np.ndarray, kc_mbon_pool: np.ndarray, meta: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, pn_kc=pn_kc, kc_mbon_pool=kc_mbon_pool, meta=json.dumps(meta))


def load(path: Path = HEMIBRAIN_FILE) -> Wiring:
    """Hemibrain wiring if it has been downloaded, synthetic otherwise."""
    if not path.exists():
        return synthetic()
    with np.load(path) as data:
        meta = json.loads(str(data["meta"]))
        return from_counts(
            data["pn_kc"],
            data["kc_mbon_pool"],
            n_mbon=tuple(meta["n_mbon"]),
            n_pam=meta["n_pam"],
            n_ppl1=meta["n_ppl1"],
            meta=meta,
        )
