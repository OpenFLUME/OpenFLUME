"""Command line: ``openflume info | validate MODEL | solve MODEL [-o OUT]``.

Also runnable as ``python -m openflume``. Results are written as JSON (the
core's raw result object); exit status is 0 on success, 1 on validation
failure or a non-converged solve, 2 on usage/IO errors.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from ._bridge import _encode_nonfinite, default_session, find_node
from .errors import OpenFLUMEError
from .network import Network


def _cmd_info(_: argparse.Namespace) -> int:
    info = default_session().start().info
    print(f"openflume {__version__}")
    print(f"core      {info.get('version')} (config schema v{info.get('configVersion')})")
    print(f"node      {info.get('node')} ({find_node()})")
    return 0


def _cmd_validate(args: argparse.Namespace) -> int:
    errors = Network.load(args.model).validate()
    for e in errors:
        print(e)
    if not errors:
        print("valid")
    return 1 if errors else 0


def _cmd_solve(args: argparse.Namespace) -> int:
    net = Network.load(args.model)

    def progress(p: dict) -> None:
        if p.get("kind") == "transient":
            print(f"\r  t = {p['time']:.6g} / {p['endTime']:.6g} s", end="", file=sys.stderr)
        else:
            print(f"\r  iter {p['iteration']}  residual {p['residual']:.3e}", end="", file=sys.stderr)

    result = net.solve(args.mode, progress=None if args.quiet else progress)
    if not args.quiet:
        print(file=sys.stderr)
        print(repr(result), file=sys.stderr)
    text = json.dumps(_encode_nonfinite(result.raw), indent=None if args.compact else 2)
    if args.output:
        Path(args.output).write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    return 0 if result.converged else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="openflume", description="OpenFLUME thermal-fluid network solver")
    parser.add_argument("--version", action="version", version=f"openflume {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("info", help="show package, core and Node.js versions").set_defaults(fn=_cmd_info)

    p_val = sub.add_parser("validate", help="validate a .fn/.json model")
    p_val.add_argument("model")
    p_val.set_defaults(fn=_cmd_validate)

    p_solve = sub.add_parser("solve", help="solve a .fn/.json model and print the JSON result")
    p_solve.add_argument("model")
    p_solve.add_argument("-o", "--output", help="write the JSON result here instead of stdout")
    p_solve.add_argument("--mode", choices=["steady", "transient"], help="override settings.mode")
    p_solve.add_argument("-q", "--quiet", action="store_true", help="no progress on stderr")
    p_solve.add_argument("--compact", action="store_true", help="single-line JSON")
    p_solve.set_defaults(fn=_cmd_solve)

    args = parser.parse_args(argv)
    try:
        return int(args.fn(args))
    except OpenFLUMEError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
