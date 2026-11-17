"""Game state → input firing rates (one-hot Poisson channels)."""

import torch

from .wiring import N_INPUT

ACTIVE_HZ = 120.0
BACKGROUND_HZ = 4.0


def channels(player_sum: int, dealer_card: int, usable_ace: bool) -> tuple[int, int, int]:
    """Active input channels for one observation (sum 4..21, dealer 1..10)."""
    if not 4 <= player_sum <= 21:
        raise ValueError(f"player_sum out of range: {player_sum}")
    if not 1 <= dealer_card <= 10:
        raise ValueError(f"dealer_card out of range: {dealer_card}")
    return player_sum - 4, 18 + dealer_card - 1, 29 if usable_ace else 28


def encode(player_sum: torch.Tensor, dealer_card: torch.Tensor, usable_ace: torch.Tensor) -> torch.Tensor:
    """Batched encoding: int tensors [B] → rates in Hz [B, N_INPUT]."""
    b = player_sum.shape[0]
    rates = torch.full((b, N_INPUT), BACKGROUND_HZ)
    rows = torch.arange(b)
    rates[rows, player_sum - 4] = ACTIVE_HZ
    rates[rows, 18 + dealer_card - 1] = ACTIVE_HZ
    rates[rows, 28 + usable_ace.long()] = ACTIVE_HZ
    return rates
