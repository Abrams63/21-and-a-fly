import json

import pytest
from starlette.websockets import WebSocketDisconnect


def recv(ws):
    return json.loads(ws.receive_text())


def test_rest(client):
    assert client.get("/health").json() == {"ok": True}
    top = client.get("/brain/topology").json()
    assert top["binMs"] == 5
    assert top["groups"][1]["id"] == "kc"
    state = client.patch("/brain/modifiers", json={"drunk": 0.4}).json()
    assert state["drunk"] == 0.4
    assert state["info"]["source"] == "python"
    assert client.patch("/brain/modifiers", json={"drunk": 3}).status_code == 422
    state = client.post("/brain/reset", json={"mode": "naive"}).json()
    assert state["info"] == {"source": "python", "mode": "naive", "episodes": 0, "wiring": "synthetic"}


def test_root_redirects_to_dashboard(client):
    response = client.get("/", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "/dash/"


def test_ws_episode(client):
    with client.websocket_connect("/ws/brain") as ws:
        hello = recv(ws)
        assert hello["type"] == "hello"
        assert hello["topology"]["count"] > 300
        ws.send_text(json.dumps({"type": "reset", "id": 1, "mode": "pretrained"}))
        ack = recv(ws)
        assert ack == {"type": "ack", "id": 1, "info": ack["info"], "drunk": ack["drunk"]}
        before = ack["info"]["episodes"]

        obs = {"playerSum": 14, "dealerCard": 10, "usableAce": False}
        ws.send_text(json.dumps({"type": "decide", "id": 2, "episode": "t:1", "observation": obs}))
        d = recv(ws)
        assert d["type"] == "decision"
        assert d["id"] == 2
        assert d["action"] in {"hit", "stand"}
        assert len(d["frames"]) == 20
        assert set(d["mbon"]) == {"hit", "stand"}

        ws.send_text(json.dumps({"type": "reward", "id": 3, "episode": "t:1", "reward": -1}))
        r = recv(ws)
        assert r["type"] == "reinforcement"
        assert r["kind"] == "ppl1"
        assert r["info"]["episodes"] == before + 1


def test_ws_rejects_bad_requests(client):
    with client.websocket_connect("/ws/brain") as ws:
        recv(ws)
        bad_obs = {"playerSum": 30, "dealerCard": 1, "usableAce": False}
        ws.send_text(json.dumps({"type": "decide", "id": 9, "episode": "x", "observation": bad_obs}))
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
