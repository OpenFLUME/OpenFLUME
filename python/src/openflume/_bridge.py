"""Node.js subprocess bridge to the bundled OpenFLUME core.

One long-lived ``node`` process per :class:`Session`, speaking newline-delimited
JSON over stdio (protocol documented in python/bridge/server.ts). Requests are
serialized with a lock; the solvers are synchronous so there is no benefit to
pipelining. Use several sessions (e.g. one per worker process) for parallelism.
"""

from __future__ import annotations

import atexit
import json
import logging
import math
import os
import shutil
import subprocess
import threading
from collections import deque
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .errors import BridgeError, from_payload

PROTOCOL_VERSION = 1
MIN_NODE_MAJOR = 22

_JS_DIR = Path(__file__).resolve().parent / "_js"
BRIDGE_SCRIPT = _JS_DIR / "openflume-bridge.mjs"

_log = logging.getLogger("openflume.node")

ProgressCallback = Callable[[dict[str, Any]], None]


# ── non-finite number codec (mirrors server.ts) ─────────────────────────────
_NUM_TAG = "$num"


def _encode_nonfinite(value: Any) -> Any:
    if isinstance(value, float):
        if math.isnan(value):
            return {_NUM_TAG: "NaN"}
        if math.isinf(value):
            return {_NUM_TAG: "Infinity" if value > 0 else "-Infinity"}
        return value
    if isinstance(value, dict):
        return {k: _encode_nonfinite(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_encode_nonfinite(v) for v in value]
    # numpy scalars / arrays, without importing numpy
    tolist = getattr(value, "tolist", None)
    if callable(tolist) and type(value).__module__.startswith("numpy"):
        return _encode_nonfinite(tolist())
    return value


def _decode_hook(obj: dict[str, Any]) -> Any:
    if len(obj) == 1 and _NUM_TAG in obj:
        return float(obj[_NUM_TAG])
    return obj


def dumps(value: Any) -> str:
    return json.dumps(_encode_nonfinite(value), allow_nan=False, separators=(",", ":"))


def loads(text: str) -> Any:
    return json.loads(text, object_hook=_decode_hook)


# ── Node discovery ──────────────────────────────────────────────────────────
def _wheel_node() -> str | None:
    try:
        import nodejs_wheel  # type: ignore[import-not-found]
    except ImportError:
        return None
    root = Path(nodejs_wheel.__file__).resolve().parent
    candidate = root / "node.exe" if os.name == "nt" else root / "bin" / "node"
    return str(candidate) if candidate.is_file() else None


def find_node() -> str:
    """Return the Node.js executable to use.

    Order: ``$OPENFLUME_NODE``, the ``nodejs-wheel-binaries`` runtime installed
    alongside openflume, then ``node`` on ``PATH``.
    """
    override = os.environ.get("OPENFLUME_NODE")
    if override:
        return override
    found = _wheel_node() or shutil.which("node")
    if not found:
        raise BridgeError(
            "openflume needs Node.js >= 22. Install the bundled runtime with "
            "`pip install nodejs-wheel-binaries`, install Node.js on PATH, or set "
            "OPENFLUME_NODE to a node executable."
        )
    return found


# ── session ─────────────────────────────────────────────────────────────────
class Session:
    """A running instance of the OpenFLUME core.

    Most code never needs this: module-level functions use a shared default
    session that starts on first use and stops at interpreter exit. Create one
    explicitly to pick a Node executable, or to isolate state (e.g. one per
    worker process). Usable as a context manager.
    """

    def __init__(self, node: str | os.PathLike[str] | None = None) -> None:
        self._node = os.fspath(node) if node is not None else None
        self._proc: subprocess.Popen[str] | None = None
        self._lock = threading.RLock()
        self._next_id = 0
        self._stderr_tail: deque[str] = deque(maxlen=50)
        self.info: dict[str, Any] = {}

    # lifecycle -----------------------------------------------------------------
    def start(self) -> Session:
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                return self
            if not BRIDGE_SCRIPT.is_file():
                raise BridgeError(
                    f"bundled OpenFLUME core missing at {BRIDGE_SCRIPT}; this "
                    "installation is incomplete (source checkouts need "
                    "`npm run build:python`)."
                )
            node = self._node or find_node()
            self._stderr_tail.clear()
            try:
                self._proc = subprocess.Popen(
                    [node, "--no-warnings", str(BRIDGE_SCRIPT)],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    bufsize=1,
                    cwd=str(_JS_DIR),
                    # Own process group: a terminal Ctrl-C reaches only Python,
                    # which then kills Node (see _request), instead of Node
                    # dying first and surfacing as a BridgeError.
                    start_new_session=os.name != "nt",
                    creationflags=(
                        subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
                    ),
                )
            except OSError as exc:
                raise BridgeError(f"could not start Node.js ({node}): {exc}") from exc
            threading.Thread(
                target=self._pump_stderr, args=(self._proc,), name="openflume-node-stderr", daemon=True
            ).start()
            info = self._request("hello", {}, None)
            if info.get("protocol") != PROTOCOL_VERSION:
                self.close()
                raise BridgeError(f"bridge protocol mismatch: expected {PROTOCOL_VERSION}, got {info.get('protocol')}")
            major = int(str(info.get("node", "0")).split(".")[0] or 0)
            if major < MIN_NODE_MAJOR:
                self.close()
                raise BridgeError(
                    f"Node.js {info.get('node')} at {node} is too old; openflume needs >= {MIN_NODE_MAJOR}."
                )
            self.info = info
            return self

    def close(self) -> None:
        """Stop the Node process. The session restarts automatically on next use."""
        with self._lock:
            proc, self._proc = self._proc, None
            if proc is None:
                return
            try:
                if proc.stdin:
                    proc.stdin.close()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()
                proc.wait()

    def _kill(self) -> None:
        proc, self._proc = self._proc, None
        if proc is not None:
            proc.kill()
            proc.wait()

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def __enter__(self) -> Session:
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.close()

    # I/O -----------------------------------------------------------------------
    def _pump_stderr(self, proc: subprocess.Popen[str]) -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            line = line.rstrip("\n")
            self._stderr_tail.append(line)
            _log.info("%s", line)

    def _died(self) -> BridgeError:
        code = self._proc.poll() if self._proc else None
        tail = "\n".join(self._stderr_tail)
        self._proc = None
        msg = f"OpenFLUME Node process exited unexpectedly (exit code {code})"
        return BridgeError(msg + (f":\n{tail}" if tail else ""))

    def call(
        self, method: str, params: dict[str, Any] | None = None, *, on_progress: ProgressCallback | None = None
    ) -> Any:
        """Invoke a bridge method and return its decoded result."""
        with self._lock:
            self.start()
            return self._request(method, params or {}, on_progress)

    def _request(self, method: str, params: dict[str, Any], on_progress: ProgressCallback | None) -> Any:
        proc = self._proc
        assert proc is not None and proc.stdin is not None and proc.stdout is not None
        self._next_id += 1
        req_id = self._next_id
        try:
            proc.stdin.write(dumps({"id": req_id, "method": method, "params": params}) + "\n")
            proc.stdin.flush()
        except (BrokenPipeError, OSError):
            raise self._died() from None
        try:
            while True:
                line = proc.stdout.readline()
                if not line:
                    raise self._died()
                msg = loads(line)
                if msg.get("id") != req_id:
                    continue  # stale reply from an interrupted request
                if "event" in msg:
                    if on_progress is not None and msg["event"] == "progress":
                        on_progress(msg.get("data", {}))
                    continue
                if "error" in msg:
                    raise from_payload(msg["error"])
                return msg.get("result")
        except KeyboardInterrupt:
            # The solve is synchronous inside Node and cannot be cancelled
            # cooperatively; kill it so the session is usable again.
            self._kill()
            raise
        except BaseException:
            if self._proc is not None and self._proc.poll() is not None:
                self._proc = None
            raise


_default: Session | None = None
_default_lock = threading.Lock()


def default_session() -> Session:
    """The shared session used by module-level functions."""
    global _default
    with _default_lock:
        if _default is None:
            _default = Session()
        return _default


def shutdown() -> None:
    """Stop the shared default session (it restarts on next use)."""
    with _default_lock:
        if _default is not None:
            _default.close()


atexit.register(shutdown)
