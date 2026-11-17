"""Plotly Dash view of the fly's brain, mounted at /dash inside FastAPI."""

from __future__ import annotations

from collections.abc import Callable

import numpy as np
import plotly.graph_objects as go
from dash import Dash, Input, Output, dcc, html
from plotly.subplots import make_subplots

from .brain import FlyBrain

BG = "#0f1712"
PANEL = "#16211a"
INK = "#e8efe9"
MUTED = "#8fa596"
HIT = "#e0a64a"
STAND = "#5fb3c9"
GROUP_COLORS = {
    "input": "#b7c4bb",
    "kc": "#7bd389",
    "mbon_hit": HIT,
    "mbon_stand": STAND,
    "pam": "#f2d16b",
    "ppl1": "#d9645c",
}
WINDOW = 100


def _layout(fig: go.Figure, title: str, height: int = 320) -> go.Figure:
    fig.update_layout(
        title={"text": title, "x": 0.02, "font": {"size": 15}},
        height=height,
        margin={"l": 50, "r": 20, "t": 50, "b": 40},
        paper_bgcolor=PANEL,
        plot_bgcolor=PANEL,
        font={"color": INK, "family": "system-ui, sans-serif", "size": 12},
        legend={"orientation": "h", "y": -0.2},
    )
    fig.update_xaxes(gridcolor="#25332a", zerolinecolor="#25332a")
    fig.update_yaxes(gridcolor="#25332a", zerolinecolor="#25332a")
    return fig


def win_rate_figure(rewards: list[float]) -> go.Figure:
    fig = go.Figure()
    if rewards:
        r = np.asarray(rewards)
        kernel = np.ones(min(WINDOW, len(r))) / min(WINDOW, len(r))
        valid = np.arange(len(kernel), len(r) + 1)
        fig.add_scatter(x=valid, y=np.convolve(r > 0, kernel, "valid"), name="win rate", line={"color": "#7bd389"})
        fig.add_scatter(x=valid, y=np.convolve(r, kernel, "valid"), name="mean reward", line={"color": HIT})
    else:
        fig.add_annotation(text="No hands played yet", showarrow=False, font={"color": MUTED})
    fig.update_yaxes(range=[-1, 1])
    fig.update_xaxes(title="hands, all flies")
    return _layout(fig, f"Live play (rolling {WINDOW} hands)")


def policy_figure(policy: np.ndarray) -> go.Figure:
    fig = make_subplots(
        rows=1, cols=2, subplot_titles=("hard hands", "soft hands (usable ace)"), horizontal_spacing=0.08
    )
    dealer = ["A", *map(str, range(2, 11))]
    limit = float(np.abs(policy).max()) or 1.0
    for col, ace in ((1, 0), (2, 1)):
        rows = slice(0, 18) if ace == 0 else slice(8, 18)  # soft sums start at 12
        sums = list(range(4, 22))[rows]
        fig.add_heatmap(
            z=policy[rows, :, ace],
            x=dealer,
            y=sums,
            zmin=-limit,
            zmax=limit,
            colorscale=[[0, HIT], [0.5, PANEL], [1, STAND]],
            showscale=col == 2,
            colorbar={"title": "stand − hit"},
            row=1,
            col=col,
        )
    fig.update_xaxes(title="dealer up card")
    fig.update_yaxes(title="fly's sum", row=1, col=1)
    return _layout(fig, "Learned preference: Q(stand) − Q(hit)", height=420)


def weights_figure(weights: np.ndarray) -> go.Figure:
    fig = go.Figure()
    fig.add_histogram(x=weights[:, 0], name="KC → MBON hit", marker_color=HIT, opacity=0.7, nbinsx=60)
    fig.add_histogram(x=weights[:, 1], name="KC → MBON stand", marker_color=STAND, opacity=0.7, nbinsx=60)
    fig.update_layout(barmode="overlay")
    fig.update_yaxes(type="log", title="synapses")
    return _layout(fig, "Learned KC → MBON weights")


def raster_figure(frames: list[list[int]], groups: list[dict], bin_ms: float) -> go.Figure:
    fig = go.Figure()
    if frames:
        for g in groups:
            xs, ys = [], []
            for t, frame in enumerate(frames):
                for n in frame:
                    if g["start"] <= n < g["start"] + g["size"]:
                        xs.append(t * bin_ms)
                        ys.append(n)
            fig.add_scattergl(
                x=xs, y=ys, mode="markers", name=g["id"], marker={"size": 3, "color": GROUP_COLORS[g["id"]]}
            )
        fig.update_yaxes(autorange="reversed", title="neuron")
    else:
        fig.add_annotation(text="The fly has not decided anything yet", showarrow=False, font={"color": MUTED})
    fig.update_xaxes(title="ms")
    return _layout(fig, "Last decision (spike raster)", height=420)


def create_dash(get_brain: Callable[[], FlyBrain]) -> Dash:
    app = Dash(__name__, requests_pathname_prefix="/dash/", title="Fly brain")
    card = {"background": PANEL, "borderRadius": "12px", "padding": "8px", "minWidth": 0}
    app.layout = html.Div(
        style={
            "background": BG,
            "color": INK,
            "minHeight": "100vh",
            "padding": "16px",
            "fontFamily": "system-ui, sans-serif",
        },
        children=[
            html.H1("Fly brain", style={"margin": "0 0 4px", "fontSize": "22px"}),
            html.P(id="summary", style={"margin": "0 0 16px", "color": MUTED}),
            html.Div(
                style={
                    "display": "grid",
                    "gap": "16px",
                    "gridTemplateColumns": "repeat(auto-fit, minmax(min(100%, 520px), 1fr))",
                },
                children=[
                    html.Div(dcc.Graph(id="win-rate"), style=card),
                    html.Div(dcc.Graph(id="weights"), style=card),
                    html.Div(dcc.Graph(id="policy"), style=card),
                    html.Div(dcc.Graph(id="raster"), style=card),
                ],
            ),
            dcc.Interval(id="tick", interval=3000),
        ],
    )

    @app.callback(
        Output("summary", "children"),
        Output("win-rate", "figure"),
        Output("weights", "figure"),
        Output("policy", "figure"),
        Output("raster", "figure"),
        Input("tick", "n_intervals"),
    )
    def refresh(_):
        brain = get_brain()
        snap = brain.snapshot()
        info = snap["info"]
        top = brain.topology
        summary = (
            f"{info['wiring']} wiring · {top['count']} neurons · {info['mode']} · "
            f"{snap['flies']:,} flies at tables · the last one learned from {info['episodes']:,} hands, "
            f"drunk {snap['drunk']:.0%}"
        )
        return (
            summary,
            win_rate_figure(snap["rewards"]),
            weights_figure(brain.weights().numpy()),
            policy_figure(brain.policy().numpy()),
            raster_figure(snap["frames"], top["groups"], top["binMs"]),
        )

    return app
