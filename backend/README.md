# fly-brain

The fly's brain for **21 & a fly**: a spiking model of the *Drosophila* mushroom
body in PyTorch, served over FastAPI. The Bun game server (`../frontend`) asks it
what to do on every turn and tells it how each hand ended.

```bash
uv sync
uv run fly-brain          # http://127.0.0.1:8000, dashboard at /dash/
```

Then start the game (`bun dev` in `../frontend`). Without this service the game
falls back to its TypeScript mock.

## The circuit

```
30 input channels (Poisson)          player sum 4..21 · dealer card 1..10 · usable ace
  → Kenyon cells (LIF, sparse)       APL feedback inhibition keeps ~10% of KCs active
  → MBON "hit" / MBON "stand" (LIF)  the pool that fires more decides
  ← PAM / PPL1 dopamine              reward prediction error δ = r − Q(s, a)
```

Only KC → MBON synapses learn (three-factor rule: KC activity × chosen action ×
dopamine). "Drunk" lowers excitation, raises inhibition and membrane noise, and
shortens time constants.

## Real wiring from the hemibrain connectome

By default the PN → KC and KC → MBON wiring is synthetic. To use the real fly
connectome (neuPrint, hemibrain v1.2.1):

1. Get your token at <https://neuprint.janelia.org> → Account → Auth Token.
2. Put it into `backend/.env` (git-ignored; see `.env.example`):
   `NEUPRINT_APPLICATION_CREDENTIALS=<token>`
3. Download the data and retrain:

```bash
uv run fly-connectome     # writes data/hemibrain_mb.npz
uv run fly-train          # writes checkpoints/fly_brain.pt
```

What is taken from the connectome:

- the Kenyon cells and their synapse counts from uniglomerular projection
  neurons; the 30 glomeruli with the most PN → KC synapses become the 30 input
  channels;
- how strongly each KC reaches each MBON pool. Splitting MBONs into "stand"
  (glutamatergic MBON01–07, avoidance) and "hit" (MBON08–19, approach) follows
  their valence in Aso et al. 2014; it is a modelling choice, not something the
  connectome says about blackjack;
- the number of PAM and PPL1 dopamine neurons (for the display).

## Training

`fly-train` plays 400,000 hands in about 40 s on a CPU. KC codes depend only on
what the fly sees (360 possible observations), so it simulates the spiking network
16 times per observation, caches those noisy codes and then runs the same learning
rule as the live brain over a vectorised blackjack table. If no checkpoint matches
the current wiring, `fly-brain` trains one on start-up.

The pretrained fly plays close to basic strategy (mean reward about −0.08 per
hand, naturals excluded). "Naive" mode starts from random weights and learns while
you play.

## API

| | |
|---|---|
| `WS /ws/brain` | `decide`, `reward`, `reset`, `set_drunk` (each with an `id`); replies `decision`, `reinforcement`, `ack`, `error`; pushes `hello` on connect and `info` on outside changes |
| `GET /health` | liveness |
| `GET /brain` | mode, hands learned, wiring, drunk level |
| `GET /brain/topology` | neuron groups for the spike display |
| `POST /brain/reset` | `{"mode": "pretrained" \| "naive"}` |
| `PATCH /brain/modifiers` | `{"drunk": 0..1}` |
| `GET /dash/` | Dash: live win rate, learned policy heatmap, weight histogram, last spike raster |

The service listens on 127.0.0.1 only and refuses WebSocket connections from
non-local web pages.

```bash
uv run pytest
```

## Layout

```
src/fly_brain/
  snn/wiring.py      synthetic or hemibrain wiring
  snn/topology.py    neuron groups and timing
  snn/codec.py       observation → input firing rates
  snn/network.py     batched LIF simulation, dopamine replay
  snn/plasticity.py  three-factor KC → MBON learning
  connectome.py      fly-connectome: download from neuPrint
  training.py        fly-train: offline pretraining
  brain.py           live brain shared by all tables
  schemas.py         Pydantic wire format (camelCase)
  dashboard.py       Dash app
  app.py             FastAPI app, fly-brain entry point
```
