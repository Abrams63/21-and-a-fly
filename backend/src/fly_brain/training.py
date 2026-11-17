"""Offline pretraining: the fly plays many hands of blackjack against itself.

Only KC→MBON weights learn, and a KC's code depends only on the observation, so
we simulate the spiking network a few times per observation (there are just
18 player sums × 10 dealer cards × 2 ace flags = 360), cache those noisy KC codes,
and then play hands in a vectorised infinite-deck environment, applying the
same three-factor rule as the live brain to a randomly drawn cached code.

    uv run fly-train            # writes checkpoints/fly_brain.pt
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import torch

from .snn import FlyNetwork, load_wiring, plasticity
from .snn.codec import encode

CHECKPOINT_DIR = Path(__file__).resolve().parents[2] / "checkpoints"
CHECKPOINT_FILE = CHECKPOINT_DIR / "fly_brain.pt"

SUMS = torch.arange(4, 22)
DEALER = torch.arange(1, 11)


def state_index(player_sum: torch.Tensor, dealer: torch.Tensor, ace: torch.Tensor) -> torch.Tensor:
    return ((player_sum - 4) * 10 + (dealer - 1)) * 2 + ace.long()


def all_states() -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    ps, dc, ua = torch.meshgrid(SUMS, DEALER, torch.arange(2), indexing="ij")
    return ps.flatten(), dc.flatten(), ua.flatten()


@torch.no_grad()
def kc_codes(net: FlyNetwork, samples: int = 16, batch: int = 720) -> torch.Tensor:
    """Eligibility traces of `samples` simulated decisions per state: [360, samples, n_kc]."""
    ps, dc, ua = all_states()
    ps, dc, ua = ps.repeat(samples), dc.repeat(samples), ua.repeat(samples)
    out = []
    for i in range(0, len(ps), batch):
        r = net.simulate(encode(ps[i : i + batch], dc[i : i + batch], ua[i : i + batch]))
        out.append(plasticity.eligibility(r.kc_counts))
    return torch.cat(out).view(samples, 360, -1).transpose(0, 1).contiguous()


def draw(n: int) -> torch.Tensor:
    """Infinite deck: 1 (ace) .. 10, tens four times as likely."""
    return torch.randint(1, 14, (n,)).clamp(max=10)


def add_card(total: torch.Tensor, aces: torch.Tensor, card: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    return total + card, aces + (card == 1).long()


def best(total: torch.Tensor, aces: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Best hand value and whether an ace counts as 11."""
    soft = (aces > 0) & (total + 10 <= 21)
    return total + 10 * soft.long(), soft


@torch.no_grad()
def play(
    w_kc: torch.Tensor,
    kc_pool: torch.Tensor,
    codes: torch.Tensor,
    hands: int,
    epsilon: float,
    learn: bool,
    lr: float,
) -> torch.Tensor:
    """Plays `hands` hands in parallel (naturals skipped); returns rewards [hands]."""
    n_samples = codes.shape[1]
    p_tot, p_ace = add_card(
        *add_card(torch.zeros(hands, dtype=torch.long), torch.zeros(hands, dtype=torch.long), draw(hands)), draw(hands)
    )
    d_up = draw(hands)
    d_tot, d_ace = add_card(torch.zeros(hands, dtype=torch.long), torch.zeros(hands, dtype=torch.long), d_up)
    d_tot, d_ace = add_card(d_tot, d_ace, draw(hands))

    live = best(p_tot, p_ace)[0] < 21  # 21 on two cards is a natural: no decision to make
    xs, acts, owners = [], [], []
    while live.any():
        idx = live.nonzero().flatten()
        value, soft = best(p_tot[idx], p_ace[idx])
        s = state_index(value, d_up[idx], soft)
        x = codes[s, torch.randint(0, n_samples, (len(idx),))]
        q = plasticity.values(w_kc, kc_pool, x)
        action = (q[:, 1] >= q[:, 0]).long()
        explore = torch.rand(len(idx)) < epsilon
        action = torch.where(explore, torch.randint(0, 2, (len(idx),)), action)
        xs.append(x), acts.append(action), owners.append(idx)

        hit = idx[action == 0]
        p_tot[hit], p_ace[hit] = add_card(p_tot[hit], p_ace[hit], draw(len(hit)))
        live[idx[action == 1]] = False
        live[hit[best(p_tot[hit], p_ace[hit])[0] >= 21]] = False  # bust, or 21: stands automatically

    # Dealer draws to 17 (stands on soft 17) for every hand that did not bust.
    while True:
        d_val = best(d_tot, d_ace)[0]
        need = d_val < 17
        if not need.any():
            break
        d_tot[need], d_ace[need] = add_card(d_tot[need], d_ace[need], draw(int(need.sum())))

    p_val, d_val = best(p_tot, p_ace)[0], best(d_tot, d_ace)[0]
    reward = torch.where(
        p_val > 21, -1.0, torch.where((d_val > 21) | (p_val > d_val), 1.0, torch.where(p_val < d_val, -1.0, 0.0))
    )

    if learn and xs:
        owners_t = torch.cat(owners)
        plasticity.apply(w_kc, kc_pool, torch.cat(xs), torch.cat(acts), reward[owners_t], lr=lr)
    return reward


def train(
    hands: int = 400_000, batch: int = 2_000, samples: int = 16, seed: int = 21, verbose: bool = True
) -> FlyNetwork:
    torch.manual_seed(seed)
    net = FlyNetwork(load_wiring(), seed=seed)
    t0 = time.time()
    codes = kc_codes(net, samples)
    if verbose:
        print(f"[{net.wiring.source}] cached {samples} KC codes x 360 states in {time.time() - t0:.1f}s")

    rounds = hands // batch
    for i in range(rounds):
        frac = i / max(rounds - 1, 1)
        epsilon = 0.3 * (1 - frac) + 0.05 * frac
        lr = 0.02 * (1 - frac) + 0.002 * frac
        # Updates are summed over the batch, so scale the step by the number of decisions per state.
        play(net.w_kc, net.kc_pool, codes, batch, epsilon, learn=True, lr=lr / (batch / 360))
        if verbose and (i + 1) % max(rounds // 8, 1) == 0:
            r = play(net.w_kc, net.kc_pool, codes, 20_000, 0.0, learn=False, lr=0)
            print(f"  {(i + 1) * batch:>8} hands  greedy reward {r.mean():+.3f}  win {(r > 0).float().mean():.3f}")
    if verbose:
        print(f"done in {time.time() - t0:.1f}s")
    return net


def save(net: FlyNetwork, hands: int, path: Path = CHECKPOINT_FILE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"w_kc": net.w_kc, "source": net.wiring.source, "n_kc": net.n_kc, "hands": hands}, path)


def load_into(net: FlyNetwork, path: Path = CHECKPOINT_FILE) -> int | None:
    """Loads trained weights if a checkpoint matches this wiring; returns its hand count."""
    if not path.exists():
        return None
    data = torch.load(path, weights_only=True)
    if data["source"] != net.wiring.source or data["n_kc"] != net.n_kc:
        return None
    net.w_kc = data["w_kc"].clone()
    return int(data.get("hands", 0))


def main() -> None:
    parser = argparse.ArgumentParser(description="Pretrain the fly's KC→MBON weights.")
    parser.add_argument("--hands", type=int, default=400_000)
    args = parser.parse_args()
    net = train(args.hands)
    save(net, args.hands)
    print(f"saved {CHECKPOINT_FILE}")


if __name__ == "__main__":
    main()
