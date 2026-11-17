#!/bin/sh
# Container entry point: fetch the hemibrain wiring once (if a neuPrint token is set), then serve.
# Without the token or on a fetch error the brain falls back to the synthetic wiring.
set -e

if [ -n "$NEUPRINT_APPLICATION_CREDENTIALS" ] && [ ! -f "$FLY_BRAIN_DATA_DIR/hemibrain_mb.npz" ]; then
  fly-connectome || echo "connectome fetch failed; using the synthetic wiring"
fi

# The first start without a checkpoint trains the fly (about a minute or two of CPU).
exec fly-brain
