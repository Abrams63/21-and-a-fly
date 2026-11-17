# Deploying on Railway

Two services from this one repository, each built from its own Dockerfile:

| Service | Root directory | Public? | What it runs |
|---|---|---|---|
| `brain` | `/backend` | **no** (private network only) | FastAPI + PyTorch fly brain, Dash at `/dash/` |
| `web` | `/frontend` | yes | Bun game server + React UI |

The browser only talks to `web`. `web` talks to `brain` over Railway's private network.
The brain's REST API and dashboard have no auth, so don't give `brain` a public domain.

## 1. Project

1. Create a project in Railway → **Deploy from GitHub repo** → `21-and-a-fly`.
2. That creates one service. Rename it to `brain`. Add a second service from the same repo and name it `web`.

## 2. `brain` service

Settings:

- **Root Directory**: `/backend`
- **Config file path**: `/backend/railway.json` (Railway doesn't look inside the root directory for it)
- **Networking**: no public domain. The private one (`brain.railway.internal`) is there by default.

Variables:

| Name | Value |
|---|---|
| `PORT` | `8000` |
| `NEUPRINT_APPLICATION_CREDENTIALS` | your neuPrint token (optional, *sealed*). Without it the brain uses the synthetic wiring. |

Volume (optional but recommended): mount a volume at **`/data`**. It keeps the downloaded
hemibrain wiring, the trained weights and every player's fly (`flies.pt`), so redeploys start
in seconds instead of fetching and retraining (~1–2 min of CPU), and the flies remember what
they learned.

The first deploy trains 400k hands before `/health` answers. The health check waits up to 15 min.

## 3. `web` service

Settings:

- **Root Directory**: `/frontend`
- **Config file path**: `/frontend/railway.json`
- **Networking** → **Generate Domain** (port `3000`, or whatever Railway suggests from `PORT`).

Variables:

| Name | Value |
|---|---|
| `FLY_BRAIN_URL` | `ws://${{brain.RAILWAY_PRIVATE_DOMAIN}}:${{brain.PORT}}/ws/brain` |

If `brain` is down or still training, `web` plays with its built-in mock brain and
switches over as soon as the PyTorch brain connects.

## 4. Check

- `web` logs: `🧠 PyTorch brain connected (hemibrain wiring, 2307 neurons)`.
- Open the `web` domain and play a hand.

## Environment variables reference

| Variable | Service | Default | Meaning |
|---|---|---|---|
| `FLY_BRAIN_HOST` | brain | `127.0.0.1` (Docker: `::`) | Bind address |
| `PORT` / `FLY_BRAIN_PORT` | brain | `8000` | Port (`FLY_BRAIN_PORT` wins if both are set) |
| `FLY_BRAIN_DATA_DIR` | brain | `backend/data` (Docker: `/data/connectome`) | Hemibrain wiring file |
| `FLY_BRAIN_CHECKPOINT_DIR` | brain | `backend/checkpoints` (Docker: `/data/checkpoints`) | Trained weights |
| `NEUPRINT_APPLICATION_CREDENTIALS` | brain | — | neuPrint token for the first wiring fetch |
| `PORT` | web | `3000` | Port |
| `FLY_BRAIN_URL` | web | `ws://127.0.0.1:8000/ws/brain` | Brain WebSocket |
| `SITE_URL` | web | `https://21-and-fly.com` | Public address for the sitemap, robots.txt and which host analytics counts |
| `UMAMI_WEBSITE_ID` | web | — | Turns on Umami visit counting (no cookies); the website id from your Umami dashboard |
| `UMAMI_SCRIPT_URL` | web | `https://cloud.umami.is/script.js` | Umami tracker script, for a self-hosted Umami |

## Visit counting (optional)

The site can count visits with [Umami](https://umami.is), which sets no cookies and
keeps no personal data, so no consent banner is needed. It is off until you set it up:

1. Create a free Umami Cloud account and add the website `21-and-fly.com`.
2. Copy its website id (a UUID) from the website's settings.
3. In Railway, add `UMAMI_WEBSITE_ID=<that id>` to the `web` service's variables.

Only visits on the `SITE_URL` host are counted, so local runs and the
`*.up.railway.app` address don't skew the numbers.
