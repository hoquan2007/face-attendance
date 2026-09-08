"""Engine metadata serialization tests (no real model required)."""

from __future__ import annotations

import pytest

from app.engine.types import (
    EngineMetadata,
    ENGINE_STATE_READY,
    ENGINE_STATE_UNLOADED,
    EngineStatus,
)


def test_engine_metadata_round_trip() -> None:
    meta = EngineMetadata(
        engine_name="insightface",
        library_version="1.0.1",
        model_name="buffalo_l",
        model_identity="insightface-buffalo-l",
        provider="CPUExecutionProvider",
        embedding_dimension=512,
        normalization="l2",
        detection_module="scrfd",
        recognition_module="arcface",
    )
    payload = meta.as_dict()
    assert payload == {
        "engine_name": "insightface",
        "library_version": "1.0.1",
        "model_name": "buffalo_l",
        "model_identity": "insightface-buffalo-l",
        "provider": "CPUExecutionProvider",
        "embedding_dimension": 512,
        "normalization": "l2",
        "detection_module": "scrfd",
        "recognition_module": "arcface",
    }


def test_engine_status_shape() -> None:
    status = EngineStatus(
        state=ENGINE_STATE_READY,
        engine_name="insightface",
        model_name="buffalo_l",
        model_identity="insightface-buffalo-l",
        provider="CPUExecutionProvider",
        embedding_dimension=512,
    )
    assert status.state == ENGINE_STATE_READY
    assert status.embedding_dimension == 512


def test_engine_status_error_carries_code_and_message() -> None:
    status = EngineStatus(
        state="error",
        engine_name=None,
        model_name="buffalo_l",
        model_identity="insightface-buffalo-l",
        provider="CPUExecutionProvider",
        embedding_dimension=None,
        error_code="MODEL_LOAD_FAILED",
        error_message="init failed",
    )
    assert status.error_code == "MODEL_LOAD_FAILED"
    assert status.state == "error"


def test_engine_state_constants_are_distinct() -> None:
    states = {ENGINE_STATE_UNLOADED, ENGINE_STATE_READY, "error"}
    assert len(states) == 3
