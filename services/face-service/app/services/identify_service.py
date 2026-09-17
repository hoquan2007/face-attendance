"""Identify service — multi-face gallery recognition.

Phase 6.3: POST /attendance/identify pipeline.

Privacy contract:
    - The Face Service receives ONLY ephemeral candidate keys + embeddings.
    - Real student identities (userId, fullName, identificationCode) are NEVER sent.
    - Embeddings received in the gallery are NEVER returned in the response.
    - The gallery is always session-scoped and built by the web server.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np

from app.core.config import get_settings
from app.engine.matcher import MatcherError, cosine_similarity
from app.engine.types import FaceEmbedding
from app.schemas.identify import (
    IdentifyGalleryItem,
    IdentifyMatch,
    IdentifyResponse,
)


@dataclass(frozen=True)
class IdentifyResult:
    """Internal result from the identify pipeline."""

    faces_detected: int
    matches: list[IdentifyMatch]
    unmatched_count: int
    processing_ms: float


def _validate_embedding_vector(
    vector: list[float],
    expected_dimension: int,
    normalization: str,
) -> None:
    """Validate a gallery embedding vector.

    Raises MatcherError on any validation failure.
    """
    import math

    if not vector or len(vector) == 0:
        raise MatcherError("INVALID_EMBEDDING", "Embedding vector is empty.")

    if len(vector) != expected_dimension:
        raise MatcherError(
            "INVALID_EMBEDDING",
            f"Embedding dimension mismatch: expected {expected_dimension}, got {len(vector)}.",
        )

    for i, v in enumerate(vector):
        if not math.isfinite(v):
            raise MatcherError(
                "INVALID_EMBEDDING",
                f"Embedding contains non-finite value at index {i}.",
            )

    if normalization != "l2":
        raise MatcherError(
            "INVALID_EMBEDDING",
            f"Unsupported normalisation: {normalization}. Only 'l2' is supported.",
        )

    # The contract is that gallery embeddings are already L2-normalised.
    # Reject vectors that clearly are not unit-norm (avoid the floating-point
    # fuzz of vectors produced by normalising internally).
    vec_arr = np.asarray(vector, dtype=np.float32)
    norm = float(np.linalg.norm(vec_arr))
    if not math.isclose(norm, 1.0, abs_tol=1e-3):
        raise MatcherError(
            "INVALID_EMBEDDING",
            f"Embedding is not L2-normalised (norm={norm:.6f}, expected ~1.0).",
        )


def _validate_gallery_item(item: IdentifyGalleryItem) -> tuple[str, np.ndarray]:
    """Validate a single gallery item and return (candidate_key, unit_embedding).

    Raises MatcherError on validation failure.
    """
    _validate_embedding_vector(
        item.embedding,
        item.embedding_dimension,
        item.normalization,
    )

    vec = np.asarray(item.embedding, dtype=np.float32)
    norm = float(np.linalg.norm(vec))
    if norm <= 0.0:
        raise MatcherError("INVALID_EMBEDDING", "Embedding has zero norm.")
    unit = vec / norm

    return item.candidate_key, unit


def _vectorized_cosine_similarities(
    query: np.ndarray,
    gallery_units: np.ndarray,
) -> np.ndarray:
    """Compute cosine similarities between one query embedding and all gallery embeddings.

    Both query and gallery are already L2-normalised, so cosine similarity
    is simply the dot product. Uses vectorized NumPy for efficiency.
    """
    return np.dot(gallery_units, query).astype(np.float64)


def _greedy_one_to_one_match(
    similarities: np.ndarray,  # shape: (num_faces, num_candidates)
    threshold: float,
) -> list[tuple[int, int, float]]:
    """Greedy deterministic one-to-one matching.

    Algorithm:
        1. Keep pairs (face_i, candidate_j) only where sim >= threshold.
        2. Sort all valid pairs descending by similarity.
        3. Greedily assign pairs: accept a pair only when both the face
           and the candidate are still unassigned.
        4. Deterministic: ties are broken by face index ascending, then
           candidate index ascending (stable sort order).

    Returns:
        List of (face_index, candidate_index, similarity) tuples for matched pairs.
    """
    num_faces, num_candidates = similarities.shape

    # Build list of all above-threshold pairs.
    pairs: list[tuple[float, int, int]] = []
    for i in range(num_faces):
        for j in range(num_candidates):
            sim = similarities[i, j]
            if sim >= threshold:
                pairs.append((sim, i, j))

    # Sort descending by similarity.
    # Python's sort is stable, so original insertion order (face asc, candidate asc)
    # is the tie-breaker — exactly what we want for deterministic results.
    pairs.sort(key=lambda x: (x[0], -x[1], -x[2]), reverse=True)

    face_assigned = [False] * num_faces
    candidate_assigned = [False] * num_candidates
    matched: list[tuple[int, int, float]] = []

    for sim, face_idx, cand_idx in pairs:
        if not face_assigned[face_idx] and not candidate_assigned[cand_idx]:
            face_assigned[face_idx] = True
            candidate_assigned[cand_idx] = True
            matched.append((face_idx, cand_idx, float(sim)))

    return matched


def identify_faces(
    image: bytes,
    gallery: list[IdentifyGalleryItem],
    max_faces: int = 5,
) -> IdentifyResult:
    """Run multi-face identification against a session-scoped gallery.

    Pipeline:
        1. Decode image.
        2. Detect up to `max_faces` faces.
        3. Extract one embedding per detected face.
        4. Validate all gallery embeddings.
        5. Vectorized cosine similarity between each detected face and every gallery candidate.
        6. Greedy deterministic one-to-one matching above threshold.
        7. Return matches keyed by ephemeral candidate_key.

    Raises:
        ImageError / ValueError for bad image / no face / too many faces / empty gallery.
    """
    from app.engine.base import get_engine
    from app.utils.image import ImageError, decode_image

    settings = get_settings()
    threshold = float(settings.face_match_threshold)

    t0 = time.perf_counter()

    # Server-side cap on max_faces (default 5, max 10).
    server_max_faces = min(max(1, max_faces), 10)

    # ---- 1. Decode image ----
    try:
        decoded = decode_image(image)
    except ImageError:
        raise

    # ---- 2. Detect faces (bounded) ----
    engine = get_engine()
    all_faces = engine.analyze(image)

    if len(all_faces) == 0:
        raise ValueError("NO_FACE")

    faces_to_process = all_faces[:server_max_faces]
    num_faces = len(faces_to_process)

    # ---- 3. Extract one embedding per detected face ----
    face_embeddings: list[FaceEmbedding] = []
    for face in faces_to_process:
        embeddings = engine.extract_embeddings(image, [face])
        if not embeddings:
            raise RuntimeError("Engine produced no embedding for a detected face.")
        face_embeddings.append(embeddings[0])

    # ---- 4. Validate and build gallery unit matrix ----
    if not gallery:
        raise ValueError("EMPTY_GALLERY")

    candidate_keys: list[str] = []
    gallery_units_list: list[np.ndarray] = []
    expected_dimension: int | None = None

    for item in gallery:
        key, unit = _validate_gallery_item(item)
        candidate_keys.append(key)
        gallery_units_list.append(unit)
        if expected_dimension is None:
            expected_dimension = len(unit)
        elif len(unit) != expected_dimension:
            raise MatcherError(
                "INVALID_EMBEDDING",
                f"Gallery contains mixed dimensions: {expected_dimension} vs {len(unit)}.",
            )

    # Stack gallery into a matrix: (num_candidates, embedding_dim)
    gallery_matrix = np.stack(gallery_units_list, axis=0)  # type: ignore[arg-type]
    num_candidates = len(candidate_keys)

    # ---- 5. Vectorized cosine similarity (num_faces x num_candidates) ----
    face_unit_matrix = np.stack(
        [
            np.asarray(fe.vector, dtype=np.float32)
            for fe in face_embeddings
        ],
        axis=0,
    )  # (num_faces, embedding_dim)
    similarities = np.dot(face_unit_matrix, gallery_matrix.T)  # type: ignore[arg-type, misc]
    similarities = np.clip(similarities, -1.0, 1.0)

    # ---- 6. Greedy deterministic one-to-one matching ----
    matched_pairs = _greedy_one_to_one_match(similarities, threshold)

    matches: list[IdentifyMatch] = []
    for face_idx, cand_idx, _sim in matched_pairs:
        matches.append(
            IdentifyMatch(
                face_index=face_idx,
                candidate_key=candidate_keys[cand_idx],
            )
        )

    unmatched_count = num_faces - len(matches)

    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    return IdentifyResult(
        faces_detected=num_faces,
        matches=matches,
        unmatched_count=unmatched_count,
        processing_ms=round(elapsed_ms, 3),
    )


def identify_faces_to_response(
    image: bytes,
    gallery: list[IdentifyGalleryItem],
    max_faces: int = 5,
) -> IdentifyResponse:
    """Run identify and convert to the public HTTP response DTO."""
    result = identify_faces(image, gallery, max_faces)
    return IdentifyResponse(
        faces_detected=result.faces_detected,
        matches=result.matches,
        unmatched_count=result.unmatched_count,
        processing_ms=result.processing_ms,
    )


__all__ = [
    "IdentifyResult",
    "identify_faces",
    "identify_faces_to_response",
]
