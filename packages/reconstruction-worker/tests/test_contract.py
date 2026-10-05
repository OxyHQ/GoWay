"""The worker parses exactly the fixtures the backend parses."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from goway_reconstruction.contract import (
    CapturePrivacyJob,
    CapturePrivacyResult,
    Event,
    SceneInputManifest,
    SceneReconstructJob,
    SceneReconstructResult,
    parse_job,
)

FIXTURES = Path(__file__).resolve().parents[1] / "contract" / "fixtures"


def load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def test_every_fixture_is_covered():
    assert {p.name for p in FIXTURES.glob("*.json")} == {
        "job.capture_privacy.json",
        "job.capture_privacy.equirectangular.json",
        "job.scene_reconstruct.json",
        "scene_input_manifest.json",
        "result.capture_privacy.json",
        "result.capture_privacy.equirectangular.json",
        "result.scene_reconstruct.json",
        "event.heartbeat.json",
        "event.completed.json",
        "event.failed.json",
    }


def test_job_envelopes():
    assert isinstance(parse_job(load("job.capture_privacy.json")), CapturePrivacyJob)
    assert isinstance(parse_job(load("job.scene_reconstruct.json")), SceneReconstructJob)
    assert parse_job(load("job.capture_privacy.equirectangular.json")).projection == "equirectangular"


def test_projection_defaults_to_perspective_and_is_a_closed_set():
    raw = load("job.capture_privacy.json")
    del raw["projection"]
    assert parse_job(raw).projection == "perspective"  # a backend that predates 360° captures
    with pytest.raises(ValidationError):
        parse_job(raw | {"projection": "fisheye"})


def test_panorama_views_carry_their_parent_and_yaw():
    result = CapturePrivacyResult.model_validate(load("result.capture_privacy.equirectangular.json"))
    assert result.projection == "equirectangular"
    assert {(f.panorama.index, f.panorama.yawDegrees) for f in result.frames} == {(0, 0.0), (0, 45.0), (1, 0.0)}
    manifest = SceneInputManifest.model_validate(load("scene_input_manifest.json"))
    views = [f for f in manifest.frames if f.panorama is not None]
    assert len(views) == 2 and {f.captureAssetId for f in views} == {"3f7a1c55-9e2b-4d18-b6a0-5c8e2d9f1b34"}
    bad = load("result.capture_privacy.equirectangular.json")
    bad["frames"][0]["panorama"]["yawDegrees"] = 360.0
    with pytest.raises(ValidationError):
        CapturePrivacyResult.model_validate(bad)
    with pytest.raises(ValidationError):  # views under a perspective verdict
        CapturePrivacyResult.model_validate(load("result.capture_privacy.equirectangular.json") | {"projection": "perspective"})
    with pytest.raises(ValidationError):  # a panorama reported as flat frames
        CapturePrivacyResult.model_validate(load("result.capture_privacy.json") | {"projection": "equirectangular"})


def test_unknown_job_type_is_refused():
    raw = load("job.capture_privacy.json") | {"jobType": "mine_bitcoin"}
    with pytest.raises(ValueError):
        parse_job(raw)


def test_job_keys_cannot_escape_the_bucket_prefixes():
    raw = load("job.capture_privacy.json")
    raw["input"]["key"] = "../../etc/passwd"
    with pytest.raises(ValidationError):
        parse_job(raw)


def test_manifest_and_results_and_events():
    SceneInputManifest.model_validate(load("scene_input_manifest.json"))
    CapturePrivacyResult.model_validate(load("result.capture_privacy.json"))
    SceneReconstructResult.model_validate(load("result.scene_reconstruct.json"))
    for name in ("event.heartbeat.json", "event.completed.json", "event.failed.json"):
        Event.model_validate(load(name))


def test_results_round_trip_unchanged():
    for name, model in (
        ("result.capture_privacy.json", CapturePrivacyResult),
        ("result.capture_privacy.equirectangular.json", CapturePrivacyResult),
        ("result.scene_reconstruct.json", SceneReconstructResult),
    ):
        raw = load(name)
        assert model.model_validate(raw).model_dump(exclude_none=True) == raw
