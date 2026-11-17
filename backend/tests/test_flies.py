import torch


def test_flies_survive_a_restart(small_brain_factory, tmp_path):
    brain = small_brain_factory()
    brain.flies_file = tmp_path / "flies.pt"
    brain.decide("you:1", "e1", 15, 10, False)
    brain.reward("you:1", "e1", -1)
    brain.reset("naive:1", "naive")
    assert brain.unsaved == 2
    assert brain.save_flies() == 2
    assert brain.unsaved == 0

    again = small_brain_factory()
    again.flies_file = brain.flies_file
    again._load_flies()
    assert set(again.flies) == {"you:1", "naive:1"}
    assert torch.equal(again.flies["you:1"].w_kc, brain.flies["you:1"].w_kc)
    assert again.info("you:1")["episodes"] == brain.info("you:1")["episodes"]
    assert again.info("naive:1")["mode"] == "naive"


def test_flies_saved_for_other_wiring_are_ignored(small_brain_factory, tmp_path):
    path = tmp_path / "flies.pt"
    torch.save({"source": "hemibrain", "n_kc": 7, "flies": {"x": (torch.zeros(7, 2), "naive", 0)}}, path)
    brain = small_brain_factory()
    brain.flies_file = path
    brain._load_flies()
    assert not brain.flies


def test_a_torn_file_does_not_stop_the_brain(small_brain_factory, tmp_path):
    path = tmp_path / "flies.pt"
    path.write_bytes(b"half a file")
    brain = small_brain_factory()
    brain.flies_file = path
    brain._load_flies()
    assert not brain.flies
