"""Tests for FACE_ENROLLMENT_MIN_SELF_SIMILARITY config.

Covers:
1. Default value is valid (finite, within [-1, 1])
2. Below valid cosine range is rejected
3. Above valid cosine range is rejected
4. NaN is rejected if settings parsing permits reaching validation
5. Custom valid threshold is propagated
"""

from __future__ import annotations

import math

import pytest

from app.core.config import Settings


def _fresh_settings(**overrides: object) -> Settings:
    """Return a fresh Settings instance with optional env overrides."""
    import os

    from app.core.config import get_settings

    # Clear the lru_cache so we get a fresh instance.
    get_settings.cache_clear()  # type: ignore[attr-defined]

    for key, value in overrides.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = str(value)

    # Return the new instance.
    return get_settings()


class TestMinSelfSimilarityConfig:
    """Tests for the FACE_ENROLLMENT_MIN_SELF_SIMILARITY setting."""

    # --- Test 1: default value is valid ---------------------------------

    def test_default_is_finite(self) -> None:
        """Test 1: default self-similarity setting is finite."""
        s = _fresh_settings(FACE_SERVICE_SECRET=None)
        assert math.isfinite(s.face_enrollment_min_self_similarity)

    def test_default_within_valid_cosine_range(self) -> None:
        """Test 1 (continued): default is within [-1.0, 1.0]."""
        s = _fresh_settings(FACE_SERVICE_SECRET=None)
        threshold = s.face_enrollment_min_self_similarity
        assert -1.0 <= threshold <= 1.0

    def test_default_is_0_7(self) -> None:
        """Test 1 (continued): default is 0.7."""
        s = _fresh_settings(FACE_SERVICE_SECRET=None)
        assert s.face_enrollment_min_self_similarity == 0.7

    # --- Test 2: below valid cosine range is rejected -------------------

    def test_below_minus_one_rejected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Test 2: below valid cosine range (-1.0) is rejected."""
        # The Pydantic Field uses ge=-1.0, so values below -1.0 should fail.
        with pytest.raises(Exception):  # ValidationError from Pydantic
            _fresh_settings(
                FACE_SERVICE_SECRET="test",
                FACE_ENROLLMENT_MIN_SELF_SIMILARITY="-1.5",
            )

    # --- Test 3: above valid cosine range is rejected --------------------

    def test_above_plus_one_rejected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Test 3: above valid cosine range (+1.0) is rejected."""
        # The Pydantic Field uses le=1.0, so values above +1.0 should fail.
        with pytest.raises(Exception):  # ValidationError from Pydantic
            _fresh_settings(
                FACE_SERVICE_SECRET="test",
                FACE_ENROLLMENT_MIN_SELF_SIMILARITY="1.5",
            )

    # --- Test 4: NaN is rejected ---------------------------------------

    def test_nan_rejected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Test 4: NaN is rejected by Pydantic parsing."""
        with pytest.raises(Exception):  # ValidationError from Pydantic
            _fresh_settings(
                FACE_SERVICE_SECRET="test",
                FACE_ENROLLMENT_MIN_SELF_SIMILARITY="NaN",
            )

    def test_infinity_rejected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Test 4 (continued): infinity is rejected."""
        with pytest.raises(Exception):  # ValidationError from Pydantic
            _fresh_settings(
                FACE_SERVICE_SECRET="test",
                FACE_ENROLLMENT_MIN_SELF_SIMILARITY="inf",
            )

    # --- Test 5: custom valid threshold is propagated -------------------

    def test_custom_valid_threshold_0_5(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Test 5: custom valid threshold (0.5) is propagated."""
        s = _fresh_settings(
            FACE_SERVICE_SECRET="test",
            FACE_ENROLLMENT_MIN_SELF_SIMILARITY="0.5",
        )
        assert s.face_enrollment_min_self_similarity == 0.5

    def test_custom_valid_threshold_boundary_minus_one(self) -> None:
        """Test 5 (continued): boundary value -1.0 is accepted."""
        s = _fresh_settings(
            FACE_SERVICE_SECRET="test",
            FACE_ENROLLMENT_MIN_SELF_SIMILARITY="-1.0",
        )
        assert s.face_enrollment_min_self_similarity == -1.0

    def test_custom_valid_threshold_boundary_plus_one(self) -> None:
        """Test 5 (continued): boundary value +1.0 is accepted."""
        s = _fresh_settings(
            FACE_SERVICE_SECRET="test",
            FACE_ENROLLMENT_MIN_SELF_SIMILARITY="1.0",
        )
        assert s.face_enrollment_min_self_similarity == 1.0

    def test_custom_valid_threshold_0_9(self) -> None:
        """Test 5 (continued): strict threshold 0.9 is propagated."""
        s = _fresh_settings(
            FACE_SERVICE_SECRET="test",
            FACE_ENROLLMENT_MIN_SELF_SIMILARITY="0.9",
        )
        assert s.face_enrollment_min_self_similarity == 0.9
