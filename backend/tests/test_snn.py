import pytest
import torch

from fly_brain.snn import FlyNetwork, Modifiers, plasticity, synthetic
from fly_brain.snn.codec import channels, encode
from fly_brain.snn.wiring import from_counts


def test_codec_channels():
    assert channels(4, 1, False) == (0, 18, 28)
    assert channels(21, 10, True) == (17, 27, 29)


def test_kc_coding_is_sparse_and_frames_fit_topology():
    torch.manual_seed(0)
    net = FlyNetwork(synthetic(n_kc=600))
    rates = encode(torch.tensor([15, 20]), torch.tensor([10, 6]), torch.tensor([0, 1]))
    r = net.simulate(rates, record=True)
    active = (r.kc_counts > 0).float().mean().item()
    assert 0.02 < active < 0.3
    assert len(r.frames) == 20
    assert all(0 <= n < net.topology.count for frame in r.frames for n in frame)
    assert r.mbon_rates.shape == (2, 2)
    net.simulate(rates, Modifiers(drunk=1.0))  # drunk path runs


def test_plasticity_moves_value_towards_reward():
    w = torch.zeros(50, 2)
    pool = torch.ones(50, 2)
    x = plasticity.eligibility(torch.rand(1, 50))
    plasticity.apply(w, pool, x, torch.tensor([1]), torch.tensor([1.0]), lr=0.5)
    q = plasticity.values(w, pool, x)[0]
    assert q[1].item() == pytest.approx(0.5, abs=1e-4)
    assert q[0].item() == 0


def test_kcs_without_a_pool_do_not_learn_it():
    w = torch.zeros(4, 2)
    pool = torch.tensor([[1.0, 0.0]] * 4)
    plasticity.apply(w, pool, torch.full((1, 4), 0.25), torch.tensor([1]), torch.tensor([1.0]))
    assert torch.all(w == 0)


def test_hemibrain_counts_become_bounded_weights():
    pn_kc = torch.randint(0, 5, (30, 40)).numpy()
    wiring = from_counts(pn_kc, torch.rand(40, 2).numpy() * 30, (5, 7), 3, 4, {})
    assert wiring.source == "hemibrain"
    assert wiring.n_kc == 40
    assert wiring.w_in.max() <= 0.8
    assert wiring.kc_pool.max() <= 1.0
    net = FlyNetwork(wiring)
    assert [g.size for g in net.topology.groups] == [30, 40, 5, 7, 3, 4]
