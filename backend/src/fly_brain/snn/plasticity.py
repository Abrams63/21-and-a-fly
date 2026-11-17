"""Three-factor learning on KC→MBON synapses.

factor 1 — presynaptic: which Kenyon cells fired during the decision (eligibility trace)
factor 2 — postsynaptic: which MBON pool won (the chosen action)
factor 3 — dopamine: reward prediction error δ = r − Q(s, a);
           δ > 0 is a PAM burst (strengthen), δ < 0 a PPL1 burst (weaken)

A KC can only change synapses onto a pool it actually reaches (`kc_pool` from the
connectome), and the update is normalised (NLMS), so one hand moves the predicted
value by η·δ regardless of how many KCs happened to fire.
"""

import torch

LEARNING_RATE = 0.05


def eligibility(kc_counts: torch.Tensor) -> torch.Tensor:
    """KC spike counts [B, n_kc] → normalised activity x (rows sum to 1)."""
    return kc_counts / (kc_counts.sum(dim=1, keepdim=True) + 1e-6)


def values(w_kc: torch.Tensor, kc_pool: torch.Tensor, x: torch.Tensor) -> torch.Tensor:
    """Predicted value of both actions [B, 2] for eligibility traces x [B, n_kc]."""
    return x @ (w_kc * kc_pool)


@torch.no_grad()
def apply(
    w_kc: torch.Tensor,
    kc_pool: torch.Tensor,
    x: torch.Tensor,
    actions: torch.Tensor,
    rewards: torch.Tensor,
    lr: float = LEARNING_RATE,
) -> torch.Tensor:
    """Updates w_kc in place for a batch of (x, action, reward). Returns δ per item."""
    q = values(w_kc, kc_pool, x).gather(1, actions.view(-1, 1)).squeeze(1)
    delta = rewards - q
    for a in (0, 1):
        mask = actions == a
        if not mask.any():
            continue
        f = x[mask] * kc_pool[:, a]  # features of this pool's synapses
        norm = (f * f).sum(dim=1, keepdim=True).clamp_min(1e-6)
        w_kc[:, a] += (lr * delta[mask].unsqueeze(1) / norm * f).sum(dim=0)
    return delta
