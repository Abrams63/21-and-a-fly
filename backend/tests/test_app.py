import json

import pytest
import torch
from starlette.websockets import WebSocketDisconnect


def recv(ws):
    return json.loads(ws.receive_text())


def test_rest(client):
    assert client.get("/health").json() == {"ok": True}
    top = client.get("/brain/topology").json()
    assert top["binMs"] == 5
    assert top["groups"][1]["id"] == "kc"
    state = client.get("/brain").json()
    assert state["info"]["source"] == "python"
    assert state["info"]["mode"] == "pretrained"
    assert state["flies"] == 0


def test_root_redirects_to_dashboard(client):
    response = client.get("/", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "/dash/"


def test_ws_episode(client):
    with client.websocket_connect("/ws/brain") as ws:
        hello = recv(ws)
        assert hello["type"] == "hello"
        assert hello["topology"]["count"] > 300
        before = hello["info"]["episodes"]

        obs = {"playerSum": 14, "dealerCard": 10, "usableAce": False}
        ws.send_text(json.dumps({"type": "decide", "id": 2, "fly": "a", "episode": "t:1", "observation": obs}))
        d = recv(ws)
        assert d["type"] == "decision"
        assert d["id"] == 2
        assert d["action"] in {"hit", "stand"}
        assert len(d["frames"]) == 20
        assert set(d["mbon"]) == {"hit", "stand"}

        ws.send_text(json.dumps({"type": "reward", "id": 3, "fly": "a", "episode": "t:1", "reward": -1}))
        r = recv(ws)
        assert r["type"] == "reinforcement"
        assert r["kind"] == "ppl1"
        assert r["info"]["episodes"] == before + 1


def test_flies_are_independent(client):
    with client.websocket_connect("/ws/brain") as ws:
        pretrained = recv(ws)["info"]["episodes"]
        ws.send_text(json.dumps({"type": "reset", "id": 1, "fly": "mine", "mode": "naive"}))
        ack = recv(ws)
        assert ack == {"type": "ack", "id": 1, "info": ack["info"]}
        assert ack["info"]["mode"] == "naive"
        assert ack["info"]["episodes"] == 0

        # Another player's fly is untouched by the reset and by the drink.
        obs = {"playerSum": 12, "dealerCard": 4, "usableAce": False}
        ws.send_text(json.dumps({"type": "decide", "id": 2, "fly": "theirs", "episode": "u:1", "observation": obs}))
        recv(ws)
        ws.send_text(json.dumps({"type": "reward", "id": 3, "fly": "theirs", "episode": "u:1", "reward": 1}))
        theirs = recv(ws)["info"]
        assert theirs["mode"] == "pretrained"
        assert theirs["episodes"] == pretrained + 1

    brain = client.app.state.brain
    assert not torch.equal(brain.flies["mine"].w_kc, brain.flies["theirs"].w_kc)


def test_drunk_is_per_request(client):
    with client.websocket_connect("/ws/brain") as ws:
        recv(ws)
        obs = {"playerSum": 16, "dealerCard": 9, "usableAce": False}
        req = {"type": "decide", "id": 1, "fly": "f", "episode": "e", "observation": obs, "drunk": 0.8}
        ws.send_text(json.dumps(req))
        assert recv(ws)["type"] == "decision"
        assert client.app.state.brain.last_drunk == pytest.approx(0.8)
        ws.send_text(json.dumps({**req, "id": 2, "drunk": 3}))
        assert recv(ws)["type"] == "error"


def test_ws_rejects_bad_requests(client):
    with client.websocket_connect("/ws/brain") as ws:
        recv(ws)
        bad_obs = {"playerSum": 30, "dealerCard": 1, "usableAce": False}
        ws.send_text(json.dumps({"type": "decide", "id": 9, "fly": "f", "episode": "x", "observation": bad_obs}))
        err = recv(ws)
        assert err["type"] == "error"
        assert "playerSum" in err["message"]
        ws.send_text("not json")
        assert recv(ws)["type"] == "error"


def test_ws_rejects_foreign_origin(client):
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect("/ws/brain", headers={"origin": "https://evil.example"}) as ws,
    ):
        ws.receive_text()


def test_dash_mounted(client):
    page = client.get("/dash/")
    assert page.status_code == 200
    assert "dash" in page.text.lower()
    assert client.get("/dash/_dash-layout").status_code == 200
