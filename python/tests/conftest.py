from __future__ import annotations

import pytest

import openflume as of


@pytest.fixture(scope="session")
def session():
    """One Node process for the whole test run."""
    with of.Session() as sess:
        yield sess
