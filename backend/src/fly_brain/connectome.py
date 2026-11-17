"""Downloads the mushroom-body wiring of the hemibrain connectome from neuPrint.

    uv run fly-connectome

Needs a neuPrint token in `backend/.env` (NEUPRINT_APPLICATION_CREDENTIALS=...).
Writes `data/hemibrain_mb.npz`; the brain server only reads that file, it never
talks to neuPrint itself.

What is fetched (hemibrain v1.2.1):
* Kenyon cells (all KC types), ordered by type so γ / α'β' / αβ cells sit together
* uniglomerular projection neurons → KC synapses, grouped by glomerulus; the 30
  glomeruli with the most synapses onto KCs become the game's 30 input channels
* KC → MBON synapses, summed into two pools by MBON valence (Aso et al. 2014):
  glutamatergic MBON01–07 drive avoidance → "stand";
  GABA/ACh MBON08–19 drive approach → "hit"
* PAM and PPL1 dopamine neuron counts (for the display)
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from dotenv import load_dotenv

from .snn.wiring import HEMIBRAIN_FILE, N_INPUT, save_hemibrain

DATASET = "hemibrain:v1.2.1"
SERVER = "neuprint.janelia.org"
ENV_FILE = Path(__file__).resolve().parents[2] / ".env"

STAND_MBONS = {f"MBON{n:02d}" for n in range(1, 8)}  # glutamatergic → avoidance
HIT_MBONS = {f"MBON{n:02d}" for n in range(8, 20)}  # GABA / ACh → approach
UNIGLOMERULAR_PN = re.compile(r"^(?!M_|MZ_)([A-Za-z0-9+]+)_.*PN")


def _summed(conn: pd.DataFrame) -> pd.DataFrame:
    """fetch_adjacencies returns one row per ROI; sum to one row per neuron pair."""
    return conn.groupby(["bodyId_pre", "bodyId_post"], as_index=False)["weight"].sum()


def main() -> None:
    load_dotenv(ENV_FILE)
    token = os.environ.get("NEUPRINT_APPLICATION_CREDENTIALS", "").strip()
    if not token:
        sys.exit(
            f"No neuPrint token. Put NEUPRINT_APPLICATION_CREDENTIALS=<token> into {ENV_FILE}\n"
            "(get it at https://neuprint.janelia.org -> Account -> Auth Token)."
        )

    from neuprint import Client, NeuronCriteria, fetch_adjacencies, fetch_neurons
    from requests import RequestException

    print(f"Connecting to {SERVER} ({DATASET})...")
    try:
        client = Client(SERVER, dataset=DATASET, token=token)
    except (RequestException, RuntimeError) as error:  # bad token: HTTPError; no server: ConnectionError
        sys.exit(f"neuPrint refused the connection: {error}\nCheck that the token in .env is your neuPrint Auth Token.")

    print("Fetching Kenyon cells...")
    kcs, _ = fetch_neurons(NeuronCriteria(type="KC.*", regex=True), client=client)
    kcs = kcs.sort_values(["type", "bodyId"]).reset_index(drop=True)
    kc_index = {body: i for i, body in enumerate(kcs["bodyId"])}
    print(f"  {len(kcs)} KCs, types: {', '.join(sorted(kcs['type'].unique()))}")

    print("Fetching projection neuron -> KC synapses...")
    pns, pn_conn = fetch_adjacencies(
        NeuronCriteria(type=".*PN.*", regex=True), NeuronCriteria(type="KC.*", regex=True), client=client
    )
    pn_conn = _summed(pn_conn)
    pn_type = pns.set_index("bodyId")["type"].fillna("")
    pn_conn["glomerulus"] = pn_conn["bodyId_pre"].map(
        lambda b: m.group(1) if (m := UNIGLOMERULAR_PN.match(pn_type.get(b, ""))) else None
    )
    pn_conn = pn_conn.dropna(subset=["glomerulus"])
    per_glom = pn_conn.groupby("glomerulus")["weight"].sum().sort_values(ascending=False)
    glomeruli = list(per_glom.index[:N_INPUT])
    if len(glomeruli) < N_INPUT:
        sys.exit(f"Only {len(glomeruli)} glomeruli found, need {N_INPUT}.")
    print(f"  {len(per_glom)} glomeruli; using the top {N_INPUT}: {', '.join(glomeruli)}")

    pn_kc = np.zeros((N_INPUT, len(kcs)), dtype=np.float32)
    channel = {g: i for i, g in enumerate(glomeruli)}
    for row in pn_conn.itertuples(index=False):
        ch = channel.get(row.glomerulus)
        kc = kc_index.get(row.bodyId_post)
        if ch is not None and kc is not None:
            pn_kc[ch, kc] += row.weight

    print("Fetching KC -> MBON synapses...")
    mbons, mbon_conn = fetch_adjacencies(
        NeuronCriteria(type="KC.*", regex=True), NeuronCriteria(type="MBON.*", regex=True), client=client
    )
    mbon_conn = _summed(mbon_conn)
    mbon_type = mbons.set_index("bodyId")["type"].fillna("")
    mbon_conn["pool"] = mbon_conn["bodyId_post"].map(
        lambda b: 0 if mbon_type.get(b) in HIT_MBONS else 1 if mbon_type.get(b) in STAND_MBONS else -1
    )
    mbon_conn = mbon_conn[mbon_conn["pool"] >= 0]
    kc_mbon_pool = np.zeros((len(kcs), 2), dtype=np.float32)
    for row in mbon_conn.itertuples(index=False):
        kc = kc_index.get(row.bodyId_pre)
        if kc is not None:
            kc_mbon_pool[kc, row.pool] += row.weight
    pooled = mbons[mbons["type"].isin(HIT_MBONS | STAND_MBONS)]
    n_hit = int(pooled["type"].isin(HIT_MBONS).sum())
    n_stand = int(pooled["type"].isin(STAND_MBONS).sum())
    print(f"  hit pool: {n_hit} MBONs, stand pool: {n_stand} MBONs")

    print("Counting dopamine neurons...")
    pam, _ = fetch_neurons(NeuronCriteria(type="PAM.*", regex=True), client=client)
    ppl1, _ = fetch_neurons(NeuronCriteria(type="PPL1.*", regex=True), client=client)
    print(f"  PAM: {len(pam)}, PPL1: {len(ppl1)}")

    meta = {
        "dataset": DATASET,
        "n_kc": len(kcs),
        "kc_types": kcs["type"].tolist(),
        "glomeruli": glomeruli,
        "n_mbon": [n_hit, n_stand],
        "mbon_types": {
            "hit": sorted(pooled.loc[pooled["type"].isin(HIT_MBONS), "type"].unique()),
            "stand": sorted(pooled.loc[pooled["type"].isin(STAND_MBONS), "type"].unique()),
        },
        "n_pam": len(pam),
        "n_ppl1": len(ppl1),
        "synapses": {"pn_kc": int(pn_kc.sum()), "kc_mbon": int(kc_mbon_pool.sum())},
    }
    save_hemibrain(HEMIBRAIN_FILE, pn_kc, kc_mbon_pool, meta)
    silent = int((pn_kc.sum(axis=0) == 0).sum())
    print(f"Saved {HEMIBRAIN_FILE} ({silent} KCs get no input from the chosen glomeruli).")


if __name__ == "__main__":
    main()
