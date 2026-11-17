"""Vectorised leaky integrate-and-fire model of the fly's mushroom body.

input (Poisson, one channel per glomerulus) → Kenyon cells (LIF, APL feedback inhibition)
                                            → two MBON pools, "hit" and "stand" (LIF, mutual inhibition)

PN→KC drive and which KCs reach which MBON pool come from the `Wiring`
(hemibrain or synthetic). Only the KC→MBON weights learn (three-factor rule in
`plasticity.py`), as in the real mushroom body. Everything runs batched on torch,
so offline training plays thousands of hands in parallel; a live decision is the
same code with B=1.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import torch

from . import plasticity
from .topology import DECIDE_STEPS, DOPAMINE_STEPS, DT_MS, STEPS_PER_BIN, Topology
from .wiring import N_INPUT, Wiring

DT = DT_MS / 1000.0

# Kenyon cells
TAU_KC_MS = 10.0
REFRACTORY_STEPS = 4  # 2 ms
G_APL = 8.0  # global feedback inhibition (GABAergic APL neuron): ~10% of KCs active
TAU_APL_MS = 5.0
KC_NOISE = 0.03

# MBON read-out
TAU_MBON_MS = 15.0
I0_MBON = 0.045  # baseline drive, ~30 Hz
G_MBON = 0.08  # how strongly the learned value difference biases the pools
TAU_Q_MS = 10.0
MBON_NOISE = 0.03

# Dopamine neurons
DAN_BACKGROUND_HZ = 2.0
DAN_PULSE = 0.35
TAU_DAN_PULSE_MS = 20.0


TRANSMISSION_LOSS = 0.85
READOUT_NOISE = 25.0


@dataclass(frozen=True)
class Modifiers:
    """'Alcohol': more GABA, less excitation, noisier and faster membranes."""

    drunk: float = 0.0

    @property
    def excitation(self) -> float:
        return 1.0 - 0.4 * self.drunk

    @property
    def inhibition(self) -> float:
        return 1.0 + 0.5 * self.drunk

    @property
    def noise(self) -> float:
        return 1.0 + 5.0 * self.drunk

    @property
    def tau_scale(self) -> float:
        return 1.0 - 0.3 * self.drunk

    @property
    def transmission(self) -> float:
        """KC → MBON synaptic efficacy: what the fly learned reaches the read-out less clearly."""
        return 1.0 - TRANSMISSION_LOSS * self.drunk

    @property
    def readout_noise(self) -> float:
        return 1.0 + READOUT_NOISE * self.drunk


@dataclass
class SimResult:
    kc_counts: torch.Tensor  # [B, n_kc]
    mbon_rates: torch.Tensor  # [B, 2] mean spikes per MBON in the hit / stand pool
    frames: list[list[int]] | None = field(default=None)  # spike frames of batch item 0

    @property
    def actions(self) -> torch.Tensor:
        """0 = hit, 1 = stand: the pool that fired more wins (ties go to stand)."""
        return (self.mbon_rates[:, 1] >= self.mbon_rates[:, 0]).long()


def _bins_to_frames(mask_bins: list[torch.Tensor]) -> list[list[int]]:
    return [torch.nonzero(mask).flatten().tolist() for mask in mask_bins]


class FlyNetwork:
    def __init__(self, wiring: Wiring, seed: int = 21) -> None:
        self.wiring = wiring
        self.topology = Topology.from_wiring(wiring)
        self.n_kc = wiring.n_kc
        self.w_in = wiring.w_in.float()
        self.kc_pool = wiring.kc_pool.float()
        self.w_kc = torch.zeros(self.n_kc, 2)  # learned KC→MBON weights (hit, stand)
        self.reset_weights(seed)

    def reset_weights(self, seed: int | None = None) -> None:
        gen = torch.Generator().manual_seed(seed) if seed is not None else None
        self.w_kc = (torch.rand(self.n_kc, 2, generator=gen) - 0.5) * 0.04

    def values(self, x: torch.Tensor) -> torch.Tensor:
        """Learned value of (hit, stand) [B, 2] for KC eligibility traces x [B, n_kc]."""
        return plasticity.values(self.w_kc, self.kc_pool, x)

    @torch.no_grad()
    def simulate(self, rates: torch.Tensor, mods: Modifiers = Modifiers(), record: bool = False) -> SimResult:
        """Runs DECIDE_STEPS of simulation for a batch of input rate vectors [B, N_INPUT]."""
        b, n_kc = rates.shape[0], self.n_kc
        n_hit, n_stand = self.wiring.n_mbon
        top = self.topology
        p_in = rates * DT
        decay_kc = math.exp(-DT_MS / (TAU_KC_MS * mods.tau_scale))
        decay_mb = math.exp(-DT_MS / (TAU_MBON_MS * mods.tau_scale))
        decay_apl = math.exp(-DT_MS / TAU_APL_MS)
        decay_q = math.exp(-DT_MS / TAU_Q_MS)
        w_in = self.w_in * mods.excitation
        in_mean = p_in @ w_in
        in_std = ((p_in * (1 - p_in)) @ (w_in * w_in)).sqrt()
        w_eff = self.w_kc * self.kc_pool
        g_apl = G_APL * mods.inhibition
        kc_noise = KC_NOISE * mods.noise
        mb_noise = MBON_NOISE * mods.readout_noise
        g_mbon = G_MBON * mods.transmission

        v_kc = torch.zeros(b, n_kc)
        ref = torch.zeros(b, n_kc)
        apl = torch.zeros(b, 1)
        v_hit = torch.zeros(b, n_hit)
        v_stand = torch.zeros(b, n_stand)
        num = torch.zeros(b, 2)
        den = torch.zeros(b, 2)
        kc_counts = torch.zeros(b, n_kc)
        hit_spikes = torch.zeros(b)
        stand_spikes = torch.zeros(b)

        bins: list[torch.Tensor] = []
        mask = torch.zeros(top.count, dtype=torch.bool) if record else None
        p_dan = DAN_BACKGROUND_HZ * DT
        n_dan = self.wiring.n_pam + self.wiring.n_ppl1

        for t in range(DECIDE_STEPS):
            # Each glomerulus has several PNs firing independently, so every KC gets its own
            # input spikes at the channel's rate: Gaussian approximation of the summed trains.
            s_in = torch.rand(b, N_INPUT) < p_in  # one PN per channel, for the display only
            drive = in_mean + in_std * torch.randn(b, n_kc)

            current = drive - g_apl * apl + kc_noise * torch.randn(b, n_kc)
            v_kc = (v_kc * decay_kc + current) * (ref <= 0)
            s_kc = v_kc >= 1.0
            v_kc = v_kc.masked_fill(s_kc, 0.0)
            ref = torch.where(s_kc, REFRACTORY_STEPS, ref - 1)
            s_kc_f = s_kc.float()
            apl = apl * decay_apl + s_kc_f.mean(dim=1, keepdim=True)
            kc_counts += s_kc_f

            # Running estimate of each action's learned value from current KC activity,
            # weighted by how strongly the active KCs reach each pool.
            num = num * decay_q + s_kc_f @ w_eff
            den = den * decay_q + s_kc_f @ self.kc_pool
            q = num / (den + 1e-3)
            diff = (q[:, 0] - q[:, 1]).unsqueeze(1)

            v_hit = v_hit * decay_mb + (I0_MBON + g_mbon * diff) + mb_noise * torch.randn(b, n_hit)
            v_stand = v_stand * decay_mb + (I0_MBON - g_mbon * diff) + mb_noise * torch.randn(b, n_stand)
            s_hit, s_stand = v_hit >= 1.0, v_stand >= 1.0
            v_hit = v_hit.masked_fill(s_hit, 0.0)
            v_stand = v_stand.masked_fill(s_stand, 0.0)
            hit_spikes += s_hit.sum(dim=1)
            stand_spikes += s_stand.sum(dim=1)

            if mask is not None:
                mask[top["input"].slice] |= s_in[0]
                mask[top["kc"].slice] |= s_kc[0]
                mask[top["mbon_hit"].slice] |= s_hit[0]
                mask[top["mbon_stand"].slice] |= s_stand[0]
                mask[top["pam"].start : top["ppl1"].stop] |= torch.rand(n_dan) < p_dan
                if (t + 1) % STEPS_PER_BIN == 0:
                    bins.append(mask.clone())
                    mask.zero_()

        mbon_rates = torch.stack([hit_spikes / n_hit, stand_spikes / n_stand], dim=1)
        return SimResult(kc_counts, mbon_rates, _bins_to_frames(bins) if record else None)

    @torch.no_grad()
    def dopamine_frames(self, kind: str) -> list[list[int]]:
        """Replay of the reinforcement signal: a burst in PAM (reward) or PPL1 (punishment)."""
        top = self.topology
        n_pam, n_ppl1 = self.wiring.n_pam, self.wiring.n_ppl1
        decay = math.exp(-DT_MS / 10.0)
        pulse_decay = math.exp(-DT_MS / TAU_DAN_PULSE_MS)
        v_pam, v_ppl1 = torch.zeros(n_pam), torch.zeros(n_ppl1)
        pulse_pam = DAN_PULSE if kind == "pam" else 0.0
        pulse_ppl1 = DAN_PULSE if kind == "ppl1" else 0.0
        p_bg = DAN_BACKGROUND_HZ * DT
        bins, mask = [], torch.zeros(top.count, dtype=torch.bool)
        for t in range(DOPAMINE_STEPS):
            v_pam = v_pam * decay + pulse_pam + 0.03 * torch.randn(n_pam)
            v_ppl1 = v_ppl1 * decay + pulse_ppl1 + 0.03 * torch.randn(n_ppl1)
            pulse_pam *= pulse_decay
            pulse_ppl1 *= pulse_decay
            s_pam = (v_pam >= 1.0) | (torch.rand(n_pam) < p_bg)
            s_ppl1 = (v_ppl1 >= 1.0) | (torch.rand(n_ppl1) < p_bg)
            v_pam = v_pam.masked_fill(s_pam, 0.0)
            v_ppl1 = v_ppl1.masked_fill(s_ppl1, 0.0)
            mask[top["pam"].slice] |= s_pam
            mask[top["ppl1"].slice] |= s_ppl1
            mask[top["kc"].slice] |= torch.rand(self.n_kc) < 0.0004
            if (t + 1) % STEPS_PER_BIN == 0:
                bins.append(mask.clone())
                mask.zero_()
        return _bins_to_frames(bins)
