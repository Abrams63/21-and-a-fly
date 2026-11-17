import pytest
from fastapi.testclient import TestClient

from fly_brain.app import create_app
from fly_brain.brain import FlyBrain
from fly_brain.snn import synthetic


@pytest.fixture(scope="session")
def checkpoint(tmp_path_factory):
    return tmp_path_factory.mktemp("ckpt") / "small.pt"


@pytest.fixture(scope="session")
def small_brain_factory(checkpoint, monkeypatch_session):
    from fly_brain import brain as brain_module
    from fly_brain import training

    wiring = synthetic(n_kc=300)
    monkeypatch_session.setattr(brain_module, "PRETRAIN_HANDS", 20_000)
    monkeypatch_session.setattr(training, "load_wiring", lambda: wiring)
    return lambda: FlyBrain(wiring=wiring, checkpoint=checkpoint, flies_file=None)


@pytest.fixture(scope="session")
def monkeypatch_session():
    mp = pytest.MonkeyPatch()
    yield mp
    mp.undo()


@pytest.fixture
def client(small_brain_factory):
    with TestClient(create_app(small_brain_factory)) as c:
        yield c
