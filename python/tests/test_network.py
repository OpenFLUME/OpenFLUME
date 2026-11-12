from __future__ import annotations

import itertools
import math

import pytest

import openflume as of


def test_examples_listed():
    names = of.examples()
    assert "Tank blowdown" in names
    assert "Sanity: orifice hand-calc" in names


def test_unknown_example():
    with pytest.raises(of.UnknownExampleError) as info:
        of.example("no such model")
    assert "Tank blowdown" in info.value.available
    assert isinstance(info.value, KeyError)


def test_orifice_matches_hand_calc():
    # Incompressible orifice: mdot = Cd·A·sqrt(2·rho·dP)
    #   = 0.6 · 1e-4 m² · sqrt(2 · 1000 kg/m³ · 1e5 Pa) = 0.8485 kg/s.
    net = of.example("Sanity: orifice hand-calc")
    assert net.validate() == []
    result = net.solve()
    assert isinstance(result, of.SteadyResult)
    assert result.converged
    expected = 0.6 * 1e-4 * math.sqrt(2 * 1000 * 1e5)
    assert result.branch("o")["mdot"] == pytest.approx(expected, rel=1e-6)
    assert result.node("in")["pressure"] == pytest.approx(200_000)


def test_steady_result_mapping_and_frames():
    result = of.example("Three-pipe junction").solve()
    assert result.converged and result.iterations > 0
    assert result["nodes"] is result.nodes  # raw mapping access
    assert set(result.branches) == {b["id"] for b in of.example("Three-pipe junction").config["branches"]}
    pd = pytest.importorskip("pandas")
    frame = result.nodes_frame()
    assert isinstance(frame, pd.DataFrame)
    assert "pressure" in frame.columns


def test_transient_blowdown_pressure_decays():
    net = of.example("Tank blowdown")
    net.settings["endTime"] = 1.0
    events = []
    result = net.solve(progress=events.append)
    assert isinstance(result, of.TransientResult)
    assert result.converged
    times = list(result.times)
    assert times[0] == 0.0 and times[-1] == pytest.approx(1.0)
    p = list(result.series("tank", "pressure"))
    assert len(p) == len(times)
    assert p[0] == pytest.approx(500_000)
    assert all(b < a for a, b in itertools.pairwise(p)), "tank pressure must fall monotonically"
    assert events and events[0]["kind"] == "transient"
    pytest.importorskip("pandas")
    frame = result.frame()
    assert frame["tank"]["pressure"].iloc[0] == pytest.approx(500_000)
    assert frame.index.name == "time"


def test_mode_override():
    net = of.example("Tank blowdown")
    steady = net.solve("steady")
    assert isinstance(steady, of.SteadyResult)
    assert net.mode == "transient"  # caller's config untouched


def test_text_and_json_round_trip(tmp_path):
    net = of.example("Three-pipe junction")
    fn = net.save(tmp_path / "model.fn")
    assert fn.read_text(encoding="utf-8").startswith("// Fluid Network config v2")
    js = net.save(tmp_path / "model.json")
    a = of.load(fn).solve()
    b = of.load(js).solve()
    c = net.solve()
    for res in (a, b):
        for bid, flow in c.branches.items():
            assert res.branch(bid)["mdot"] == pytest.approx(flow["mdot"], rel=1e-12)


def test_parse_error_reports_lines():
    with pytest.raises(of.ParseError) as info:
        of.Network.from_text('// Fluid Network config v2\nnetwork "x" {\nbogus line\n}\n')
    assert info.value.errors
    assert any(e.get("line") is not None for e in info.value.errors)


def test_decode_error_has_code_and_path():
    cfg = of.example("Three-pipe junction").to_dict()
    cfg["meta"]["version"] = 99
    with pytest.raises(of.ConfigDecodeError) as info:
        of.validate(cfg)
    assert info.value.code == "unsupported-version"
    assert info.value.path == "meta.version"


def test_validation_error_on_solve():
    net = of.example("Three-pipe junction")
    net.config["branches"][0]["to"] = "missing-node"
    errors = net.validate()
    assert errors
    assert not net.is_valid
    with pytest.raises(of.ValidationError) as info:
        net.solve()
    assert info.value.errors == errors


def test_editing_live_config_changes_result():
    net = of.example("Sanity: orifice hand-calc")
    base = net.solve().branch("o")["mdot"]
    net.branch("o")["component"]["area"] *= 2
    assert net.solve().branch("o")["mdot"] == pytest.approx(2 * base, rel=1e-6)


def test_nonfinite_numbers_survive_round_trip():
    # A NaN in the config must reach the core as NaN — and be rejected by the
    # decoder as a non-finite number — not silently become null or 0.
    net = of.example("Sanity: orifice hand-calc")
    net.branch("o")["component"]["area"] = float("nan")
    with pytest.raises(of.ConfigDecodeError) as info:
        net.validate()
    assert info.value.path == "branches[0].component.area"


def test_transient_solver_settings_pass_through():
    # settings.closureFluidState / maxOuterIterations reach the core as-is:
    # valid values solve (and the outer-iteration diagnostics come back),
    # invalid ones are rejected by the core validator.
    net = of.example("Tank blowdown")
    net.settings["endTime"] = 0.2
    net.settings["closureFluidState"] = "lagged"
    net.settings["maxOuterIterations"] = 50
    result = net.solve()
    assert result.converged
    outers = result["stepOuterIterations"]
    assert len(outers) == len(result.times) - 1
    assert all(1 <= n <= 50 for n in outers)
    assert result["outerCapSteps"] == 0

    net.settings["maxOuterIterations"] = 0
    net.settings["closureFluidState"] = "sometimes"
    errors = net.validate()
    assert any("settings.maxOuterIterations" in e for e in errors)
    assert any("settings.closureFluidState" in e for e in errors)
