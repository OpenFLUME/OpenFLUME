from __future__ import annotations

import json
import math
import re
from pathlib import Path

import pytest

import openflume as of
from openflume import _bridge
from openflume.__main__ import main

PYTHON_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PYTHON_ROOT.parent


def test_codec_round_trips_nonfinite():
    value = {"a": [1.0, math.nan, math.inf, -math.inf], "b": "x"}
    back = _bridge.loads(_bridge.dumps(value))
    assert back["a"][0] == 1.0
    assert math.isnan(back["a"][1])
    assert back["a"][2:] == [math.inf, -math.inf]


def test_bundle_is_installed():
    assert _bridge.BRIDGE_SCRIPT.is_file()
    assert (_bridge.BRIDGE_SCRIPT.parent / "coolprop.wasm").is_file()


def test_handshake_reports_versions(session):
    info = session.info
    assert info["protocol"] == _bridge.PROTOCOL_VERSION
    assert info["configVersion"] == 2
    assert int(info["node"].split(".")[0]) >= _bridge.MIN_NODE_MAJOR
    assert info["version"] == of.__version__


def test_versions_in_sync_with_package_json():
    package_json = REPO_ROOT / "package.json"
    if not package_json.is_file():
        pytest.skip("not running from a source checkout")
    npm_version = json.loads(package_json.read_text())["version"]
    match = re.search(r'^version = "([^"]+)"', (PYTHON_ROOT / "pyproject.toml").read_text(), re.M)
    assert match, "pyproject.toml must declare a static version"
    py_version = match.group(1)
    assert py_version == npm_version, "bump python/pyproject.toml together with package.json"


def test_sessions_are_isolated_and_restartable():
    with of.Session() as a:
        assert a.running
        a.close()
        assert not a.running
        # Restarts transparently on next call.
        assert "Tank blowdown" in a.call("examples")
        assert a.running
    assert not a.running


def test_explicit_session_is_used_end_to_end(session):
    net = of.example("Sanity: orifice hand-calc", session=session)
    assert net.solve().converged
    assert of.Fluid.air(session=session).density(1e5, 300.0) > 0


def test_bad_node_override(monkeypatch):
    monkeypatch.setenv("OPENFLUME_NODE", "/definitely/not/node")
    with pytest.raises(of.BridgeError):
        of.Session().start()


def test_console_output_does_not_corrupt_protocol(session):
    # The core writes diagnostics with console.*; the bridge must route them
    # to stderr. A user component that logs exercises that path.
    net = of.example("Sanity: orifice hand-calc", session=session)
    net.config["componentLibrary"] = {
        "noisy": {
            "format": "inline",
            "code": "console.log('hello from user code'); return 0.5 * 1e4 * args.mdot * Math.abs(args.mdot);",
        }
    }
    net.branch("o")["component"] = {"type": "userComponent", "component": "noisy", "params": {}}
    result = net.solve()
    assert result.converged
    # dP = 1e5 Pa = 5000 · mdot² → mdot = sqrt(20)
    assert result.branch("o")["mdot"] == pytest.approx(math.sqrt(20.0), rel=1e-6)


def test_cli(tmp_path, capsys):
    model = of.example("Sanity: orifice hand-calc").save(tmp_path / "orifice.fn")
    assert main(["validate", str(model)]) == 0
    out = tmp_path / "result.json"
    assert main(["solve", str(model), "-o", str(out), "-q"]) == 0
    data = json.loads(out.read_text())
    assert data["converged"] is True
    assert main(["info"]) == 0
    assert "openflume" in capsys.readouterr().out
