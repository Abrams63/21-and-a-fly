# 21 and Fly

Blackjack with three players at one table: **you**, a **dealer** that follows the
house rules, and a **fruit fly** whose decisions come from a spiking model of the
*Drosophila* mushroom body, wired from the real hemibrain connectome.

**Play:** <https://21-and-fly.com>

While the fly thinks you watch its neurons fire: input channels light up the
Kenyon cells, the "hit" and "stand" output neurons race each other, and after the
hand dopamine neurons reward or punish what it did. The fly learns from every
hand it plays with you. You can also get it drunk.

## How it works

```
browser (React)  ──WS /ws/game──▶  web: Bun game server  ──WS /ws/brain──▶  brain: FastAPI + PyTorch
                                   deals, runs the table,                   spiking mushroom body,
                                   keeps the bank cookie                    learns from rewards
```

- **web** ([`frontend/`](frontend)): Bun serves the React UI and runs the game:
  6-deck shoe, you → fly → dealer, payouts, the bank. If the brain service isn't
  reachable, a small TypeScript mock brain plays instead, so the game never stalls.
- **brain** ([`backend/`](backend)): PyTorch simulation of the fly's decision
  circuit, served over FastAPI, with a Dash dashboard at `/dash/`.

### The fly's brain

```
30 input channels        player sum · dealer up-card · usable ace
  → ~1,900 Kenyon cells  sparse code, APL inhibition keeps ~10% active
  → MBON hit / stand     the pool that fires more decides
  ← PAM / PPL1 dopamine  reward prediction error after each hand
```

- Leaky integrate-and-fire neurons, 100 ms of simulated time per decision.
- Only Kenyon cell → MBON synapses learn, by a three-factor rule
  (KC activity × chosen action × dopamine).
- Pretrained on 400,000 simulated hands, it plays close to basic strategy.
  "Newborn fly" starts from random weights and learns as you play.
- Every player gets their own fly: the wiring is shared, the learned weights,
  resets and drinks are not.
- "Drunk" weakens excitation and transmission, strengthens inhibition and adds
  noise, and the fly plays noticeably worse.

Details, training and the API are in [`backend/README.md`](backend/README.md).

## Rules of the house

- You and the fly start with 100 chips; the fly always matches your bet.
- Blackjack pays 3:2, a win pays 1:1, the dealer stands on 17.
- A fly that can't cover your bet is shooed off and a new one sits down.
  The scoreboard counts flies ruined and rounds won, you vs flies.
- Out of chips after a round? Buy back in for 100.
- Balances and scores live in a cookie, so they survive a reload.

## Run locally

Needs [Bun](https://bun.sh) and [uv](https://docs.astral.sh/uv/).

```bash
# the fly's brain (optional): http://127.0.0.1:8000, dashboard at /dash/
cd backend
uv sync
uv run fly-brain
```

```bash
# the game: http://localhost:3000
cd frontend
bun install
bun dev
```

The first `fly-brain` start trains the fly (about a minute on a CPU) and caches
the weights in `backend/checkpoints/`. Without a neuPrint token the wiring is
synthetic; see [`backend/README.md`](backend/README.md) to fetch the real one.

### Checks

```bash
cd backend && uv run ruff check . && uv run pytest
```

```bash
cd frontend && bun run lint && bun check
```

## Deploy

Two Railway services from this repository, each with its own Dockerfile:
[`DEPLOY.md`](DEPLOY.md).

## Stack

- **Frontend:** Bun, React 19, TypeScript, CSS modules, Biome.
- **Backend:** Python 3.13, uv, PyTorch (CPU), FastAPI, Pydantic, Dash,
  neuprint-python, Ruff, pytest.

## Data

The mushroom-body wiring comes from the
[hemibrain v1.2.1](https://www.janelia.org/project-team/flyem/hemibrain) connectome
(Scheffer et al., 2020, *eLife*), accessed through [neuPrint](https://neuprint.janelia.org).
The split of MBONs into "hit" and "stand" pools follows their valence in Aso et al.,
2014 (*eLife*). It is a modelling choice; the connectome says nothing about blackjack.
