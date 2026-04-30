"""
Unit tests for pipeline_state.{write_state, write_error}.

Run from the repo root:
    python -m pytest scripts/tests/

These tests use a temporary results directory via monkeypatch so they
don't touch the real results/ folder.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

# Make the agents/ directory importable
sys.path.insert(0, str(Path(__file__).parent.parent / "agents"))


@pytest.fixture
def state_module(tmp_path, monkeypatch):
    """Reload pipeline_state with RESULTS_ROOT pointed at a tmp dir."""
    import pipeline_state as ps
    monkeypatch.setattr(ps, "RESULTS_ROOT", tmp_path)
    monkeypatch.setattr(ps, "STATE_FILE",   tmp_path / "pipeline_state.json")
    return ps


def test_write_state_creates_file(state_module):
    state_module.write_state("running", "First step")
    assert state_module.STATE_FILE.exists()

    data = json.loads(state_module.STATE_FILE.read_text())
    assert data["status"]       == "running"
    assert data["current_step"] == "First step"
    assert "started_at"  in data
    assert "updated_at"  in data


def test_write_state_preserves_started_at(state_module):
    state_module.write_state("running", "Step 1")
    first_start = json.loads(state_module.STATE_FILE.read_text())["started_at"]

    state_module.write_state("running", "Step 2")
    second_start = json.loads(state_module.STATE_FILE.read_text())["started_at"]

    assert first_start == second_start, "started_at must not change on later writes"


def test_write_state_merges_extra_fields(state_module):
    state_module.write_state("running", "Provisioning", pod_id="pod_abc")
    state_module.write_state("running", "SSH ready", pod_ip="1.2.3.4")

    data = json.loads(state_module.STATE_FILE.read_text())
    assert data["pod_id"]       == "pod_abc"   # from first call
    assert data["pod_ip"]       == "1.2.3.4"   # from second
    assert data["current_step"] == "SSH ready"


def test_write_state_sets_finished_at_on_terminal_status(state_module):
    state_module.write_state("running", "Working")
    data = json.loads(state_module.STATE_FILE.read_text())
    assert "finished_at" not in data

    state_module.write_state("done", "Complete")
    data = json.loads(state_module.STATE_FILE.read_text())
    assert "finished_at" in data


def test_write_error_captures_traceback(state_module):
    try:
        raise ValueError("boom")
    except ValueError as exc:
        state_module.write_error("Something failed", exception=exc)

    data = json.loads(state_module.STATE_FILE.read_text())
    assert data["status"]          == "failed"
    assert data["error_type"]      == "ValueError"
    assert data["error_message"]   == "boom"
    assert "Traceback" in data["error_traceback"]
    assert "raise ValueError" in data["error_traceback"]


def test_write_error_without_exception(state_module):
    state_module.write_error("Manual failure message")
    data = json.loads(state_module.STATE_FILE.read_text())
    assert data["status"]        == "failed"
    assert data["error_message"] == "Manual failure message"
    assert "error_traceback" not in data
