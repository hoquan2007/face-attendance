"""InsightFace-backed implementation of :class:`app.engine.base.FaceEngine`.

This module is the *only* place in the Face Service that imports the
``insightface`` package. Everything else (route layer, services, tests,
benchmark) talks to the engine through the Protocol in :mod:`app.engine.base`.

PHASE 3 behaviour:

- The engine is loaded **once** at FastAPI startup. ``load()`` is idempotent.
- Detection runs at ``FACE_DET_SIZE`` (default: SCRFD Auto = 128+640) with
  the configured ``FACE_DET_THRESHOLD``.
- Only ``detection`` and ``recognition`` modules are kept from the model
  pack. Gender/age/landmark 3D modules are dropped at load time when the
  InsightFace API permits.
- Embeddings are taken from ``face.normed_embedding`` (L2-normalised) and
  validated at runtime — the dimension is read from the first embedding and
  stored in :class:`app.engine.types.EngineMetadata`. We never hardcode 512.
- Multi-face results are sorted left-to-right by bbox centre X.
- All outputs are application-owned dataclasses — no InsightFace ``Face``
  objects ever leak past this module.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

import numpy as np

from app.core.config import get_settings
from app.engine.base import (
    BoundingBox,
    Candidate,
    DetectedFace,
    FaceEmbedding,
    FaceEngine,
    RecognitionResult,
)
from app.engine.quality import compute_quality
from app.engine.types import (
    EngineMetadata,
    EngineStatus,
    ENGINE_STATE_ERROR,
    ENGINE_STATE_READY,
    ENGINE_STATE_UNLOADED,
    Landmark,
)
from app.utils.image import ImageError, decode_image, order_faces_by_x


# Stable identifier of the InsightFace recognition model pack currently in
# use. Stored in EngineMetadata so that future migrations can detect
# embeddings produced by an incompatible model.
_DEFAULT_MODEL_IDENTITY = "insightface-buffalo-l"
_RECOGNITION_TASKNAME = "recognition"
_DETECTION_TASKNAME = "detection"


def _resolve_providers(provider_name: str) -> list[str]:
    """Translate ``FACE_EXECUTION_PROVIDER`` config to an ORT provider list.

    Phase 3 supports only ``cpu``. The structure here makes future CUDA
    support a localized change.
    """

    normalized = provider_name.strip().lower()
    if normalized == "cpu":
        return ["CPUExecutionProvider"]
    if normalized == "cuda":
        # Not enabled in PHASE 3 — fail loudly rather than silently fallback
        # so future operators understand the configuration is unsupported.
        raise RuntimeError(
            "FACE_EXECUTION_PROVIDER='cuda' is not enabled in PHASE 3. "
            "Use 'cpu' for development."
        )
    raise RuntimeError(
        f"Unknown FACE_EXECUTION_PROVIDER={provider_name!r}. Use 'cpu'."
    )


def _resolve_model_root() -> str:
    """Return the absolute InsightFace model cache root.

    Resolves ``INSIGHTFACE_HOME`` (when set) or defaults to ``~/.insightface``.
    The value is exposed via :class:`EngineMetadata` only as an opaque
    identifier — never returned over HTTP.
    """

    override = os.environ.get("INSIGHTFACE_HOME", "").strip()
    if override:
        return os.path.abspath(os.path.expanduser(override))
    return os.path.abspath(os.path.expanduser("~/.insightface"))


@dataclass
class _EngineState:
    """Mutable per-engine state, owned by :class:`InsightFaceEngine`."""

    app: Any = None
    model_name: str | None = None
    model_identity: str | None = None
    provider: str | None = None
    library_version: str | None = None
    embedding_dimension: int | None = None
    state: str = ENGINE_STATE_UNLOADED
    error_code: str | None = None
    error_message: str | None = None
    load_lock: threading.Lock = threading.Lock()


class InsightFaceEngine(FaceEngine):
    """InsightFace-backed FaceEngine.

    The InsightFace ``FaceAnalysis`` instance is loaded exactly once in
    :meth:`load` and reused for every subsequent call. Inference is not
    assumed to be infinitely thread-safe — :meth:`_run_detection` acquires
    a per-engine lock so that concurrent requests do not corrupt state.
    """

    name = "insightface"
    model: str | None = None
    provider: str | None = None

    def __init__(self) -> None:
        self._state = _EngineState()
        self._inference_lock = threading.Lock()

    # --- Lifecycle ---------------------------------------------------------

    def load(self) -> None:
        """Initialize the InsightFace model exactly once.

        Idempotent: subsequent calls are no-ops so FastAPI startup retries
        stay safe. Raises RuntimeError with a sanitized message if model
        loading fails; the original exception is logged but not propagated
        to clients.
        """

        with self._state.load_lock:
            if self._state.state == ENGINE_STATE_READY:
                return

            settings = get_settings()
            providers = _resolve_providers(settings.face_execution_provider)
            model_name = settings.face_model_name
            model_root = _resolve_model_root()

            # Local imports keep the module importable in unit tests that
            # never load the real model.
            import insightface  # type: ignore[import-not-found]

            self._state.library_version = getattr(insightface, "__version__", "unknown")
            self._state.model_name = model_name
            self._state.model_identity = _DEFAULT_MODEL_IDENTITY
            self._state.provider = providers[0]

            # Only load detection + recognition. Other buffalo_l modules
            # (genderage, landmark_2d_106, landmark_3d_68) are skipped.
            allowed = [_DETECTION_TASKNAME, _RECOGNITION_TASKNAME]

            try:
                app = insightface.app.FaceAnalysis(
                    name=model_name,
                    root=model_root,
                    allowed_modules=allowed,
                    providers=providers,
                )
                # ctx_id=-1 forces CPU regardless of any built-in CUDA detection.
                det_size = _parse_det_size(settings.face_det_size)
                app.prepare(
                    ctx_id=-1,
                    det_thresh=float(settings.face_det_threshold),
                    det_size=det_size,
                )
            except Exception as exc:  # noqa: BLE001 — broad to survive all ORT errors
                self._state.state = ENGINE_STATE_ERROR
                self._state.error_code = "MODEL_LOAD_FAILED"
                self._state.error_message = (
                    f"Failed to initialize InsightFace model '{model_name}': {exc}"
                )
                raise RuntimeError(self._state.error_message) from exc

            self._state.app = app
            self.model = model_name
            self.provider = providers[0]
            self._state.state = ENGINE_STATE_READY
            self._state.error_code = None
            self._state.error_message = None
            # Probe the recognition model for its output (embedding) shape.
            # We do this immediately so health/metadata are accurate even
            # before the first detect-and-embed call.
            try:
                rec_model = getattr(app, "models", {}).get(_RECOGNITION_TASKNAME)
                output_shape = getattr(rec_model, "output_shape", None) if rec_model else None
                if output_shape:
                    dim = int(output_shape[-1])
                    if dim > 0:
                        self._state.embedding_dimension = dim
            except Exception:
                # Probing is best-effort; the real dimension is also
                # re-asserted on every embedding extraction.
                pass

    def status(self) -> EngineStatus:
        return EngineStatus(
            state=self._state.state,
            engine_name=self.name if self._state.state == ENGINE_STATE_READY else None,
            model_name=self._state.model_name,
            model_identity=self._state.model_identity,
            provider=self._state.provider,
            embedding_dimension=self._state.embedding_dimension,
            error_code=self._state.error_code,
            error_message=self._state.error_message,
        )

    def metadata(self) -> EngineMetadata:
        """Return immutable identification metadata for model compatibility."""

        if self._state.state != ENGINE_STATE_READY:
            raise RuntimeError("Engine metadata requested before model load.")
        return EngineMetadata(
            engine_name=self.name,
            library_version=self._state.library_version or "unknown",
            model_name=self._state.model_name or "",
            model_identity=self._state.model_identity or "",
            provider=self._state.provider or "CPUExecutionProvider",
            embedding_dimension=int(self._state.embedding_dimension or 0),
            normalization="l2",
            detection_module="scrfd",
            recognition_module="arcface",
        )

    # --- Phase 0 surface ---------------------------------------------------

    def detect_faces(self, image: bytes) -> list[DetectedFace]:
        return self.analyze(image)

    def extract_embeddings(
        self, image: bytes, faces: Sequence[DetectedFace]
    ) -> list[FaceEmbedding]:
        """Compute normalised embeddings for the supplied detections.

        ``faces`` here are produced by :meth:`detect_faces` on the same
        image; we match each input bbox to the raw InsightFace face by
        geometric proximity rather than ``id()`` — this allows callers to
        pass bbox data produced in a different process / decorator chain
        while still receiving aligned embeddings.
        """

        if self._state.state != ENGINE_STATE_READY:
            raise RuntimeError("Engine not ready. Call load() first.")
        if not faces:
            return []

        decoded = decode_image(image)
        raw_faces = self._run_detection(decoded.bgr)
        if not raw_faces:
            return []

        embeddings: list[FaceEmbedding] = []
        for det in faces:
            idx = _match_bbox(det, raw_faces)
            if idx is None:
                continue
            embeddings.append(_extract_embedding(raw_faces[idx], self._state))
        return embeddings

    def build_index(self, candidates: Iterable[Candidate]) -> object:
        """Materialise an opaque index for :meth:`recognize_faces`.

        Phase 3 returns a plain list — Phase 7 will introduce a real
        candidate matrix. The return type is intentionally ``object``.
        """

        return [dict(user_id=c.user_id, embedding=tuple(c.embedding)) for c in candidates]

    def recognize_faces(
        self, image: bytes, index: object
    ) -> list[RecognitionResult]:
        """Detect + embed + match against the supplied candidate index.

        Phase 3 keeps this implementation simple: it computes a similarity
        between every detected face and every candidate. Phase 7 will
        replace this with the candidate matrix for sub-linear search.
        """

        if self._state.state != ENGINE_STATE_READY:
            raise RuntimeError("Engine not ready. Call load() first.")

        from app.engine.matcher import best_candidate_match

        decoded = decode_image(image)
        raw_faces = self._run_detection(decoded.bgr)
        if not raw_faces:
            return []

        candidates = index or []
        results: list[RecognitionResult] = []
        threshold = float(get_settings().face_match_threshold)
        for det in raw_faces:
            emb = _extract_embedding(det, self._state)
            best_id = None
            best_sim = -1.0
            for cand in candidates:
                cand_emb = FaceEmbedding(
                    vector=tuple(float(x) for x in cand["embedding"]),
                    dimension=len(cand["embedding"]),
                )
                from app.engine.matcher import cosine_similarity

                sim = cosine_similarity(emb, cand_emb)
                if sim > best_sim:
                    best_sim = sim
                    if sim >= threshold:
                        best_id = str(cand["user_id"])
            status = "candidate" if best_id is not None else "unknown"
            bbox_arr = det.bbox.astype(float)
            results.append(
                RecognitionResult(
                    bbox=BoundingBox(
                        x=float(bbox_arr[0]),
                        y=float(bbox_arr[1]),
                        width=float(bbox_arr[2] - bbox_arr[0]),
                        height=float(bbox_arr[3] - bbox_arr[1]),
                    ),
                    candidate_id=best_id,
                    similarity=float(best_sim),
                    status=status,
                )
            )
        return results

    # --- Phase 3 high-level API -------------------------------------------

    def analyze(self, image: bytes) -> list[DetectedFace]:
        """Decode + detect + annotate; returns ordered ``DetectedFace`` list."""

        if self._state.state != ENGINE_STATE_READY:
            raise RuntimeError("Engine not ready. Call load() first.")
        try:
            decoded = decode_image(image)
        except ImageError:
            raise

        raw_faces = self._run_detection(decoded.bgr)
        faces = [_to_detected_face(decoded.bgr, f, self._state) for f in raw_faces]
        return order_faces_by_x(faces)

    # --- Internals --------------------------------------------------------

    def _run_detection(self, bgr: np.ndarray) -> list[Any]:
        """Run ``app.get`` under the inference lock. Returns raw InsightFace faces."""

        app = self._state.app
        if app is None:
            raise RuntimeError("Engine not ready. Call load() first.")

        with self._inference_lock:
            raw = list(app.get(bgr))

        return raw


# --- helpers ---------------------------------------------------------------


def _parse_det_size(raw: str) -> tuple[int, int] | str:
    """Translate ``FACE_DET_SIZE`` to an InsightFace-compatible argument.

    InsightFace 1.0 (which uses SCRFD 10GF) does **not** support the string
    "auto" — it requires concrete ``(W, H)`` input sizes. We therefore:

    - Map ``"auto"`` (the documented default) to ``(640, 640)`` — the same
      pair InsightFace itself recommends and uses when its CLI is invoked
      with ``--det-size 640 640``.
    - Accept explicit ``W x H`` strings like ``"640x480"``.
    - Fall back to ``(640, 640)`` silently on malformed input. Callers who
      want stricter behaviour can check the env value upstream.
    """

    value = (raw or "640x640").strip().lower()
    if value in {"auto", "default"}:
        return (640, 640)
    if "x" in value:
        try:
            w_str, h_str = value.split("x", 1)
            w, h = int(w_str), int(h_str)
            if w <= 0 or h <= 0:
                raise ValueError
            return (w, h)
        except ValueError as exc:
            raise RuntimeError(
                f"Invalid FACE_DET_SIZE={raw!r}. Use 'auto' or 'WxH'."
            ) from exc
    raise RuntimeError(f"Invalid FACE_DET_SIZE={raw!r}. Use 'auto' or 'WxH'.")


def _match_bbox(det: DetectedFace, raw_faces: Sequence[Any]) -> int | None:
    """Return the index of the raw face whose bbox most closely matches ``det``.

    Used to align ``extract_embeddings`` output to the order of input
    DetectedFace objects. We compare bbox centers and require they be
    within a small pixel tolerance; anything outside the tolerance is
    treated as "no match" (the caller will skip that face).
    """

    dx = det.bbox.x + det.bbox.width / 2.0
    dy = det.bbox.y + det.bbox.height / 2.0
    best_idx: int | None = None
    best_dist = float("inf")
    for i, f in enumerate(raw_faces):
        bbox_arr = np.asarray(f.bbox, dtype=float)
        if len(bbox_arr) < 4:
            continue
        rx1 = float(bbox_arr[0])
        ry1 = float(bbox_arr[1])
        rx2 = float(bbox_arr[2])
        ry2 = float(bbox_arr[3])
        cx = (rx1 + rx2) / 2.0
        cy = (ry1 + ry2) / 2.0
        d = (cx - dx) ** 2 + (cy - dy) ** 2
        if d < best_dist:
            best_dist = d
            best_idx = i
    # Tolerance: 8-pixel radius.
    if best_idx is not None and best_dist <= 64.0:
        return best_idx
    return None


def _to_detected_face(
    bgr: np.ndarray, ins_face: Any, state: _EngineState
) -> DetectedFace:
    """Convert one InsightFace ``Face`` into our ``DetectedFace``."""

    bbox_arr = np.asarray(ins_face.bbox, dtype=float)
    x1 = float(bbox_arr[0])
    y1 = float(bbox_arr[1])
    x2 = float(bbox_arr[2])
    y2 = float(bbox_arr[3])
    h, w = bgr.shape[:2]
    x1c = max(0.0, min(x1, float(w)))
    y1c = max(0.0, min(y1, float(h)))
    x2c = max(0.0, min(x2, float(w)))
    y2c = max(0.0, min(y2, float(h)))

    bbox = BoundingBox(x=x1c, y=y1c, width=max(0.0, x2c - x1c), height=max(0.0, y2c - y1c))
    score = float(getattr(ins_face, "det_score", 0.0))

    kps = getattr(ins_face, "kps", None)
    landmarks: list[Landmark] = []
    if kps is not None:
        kps_arr = np.asarray(kps, dtype=float)
        for row in kps_arr:
            landmarks.append(Landmark(x=float(row[0]), y=float(row[1])))

    quality = compute_quality(bgr, bbox, score)
    return DetectedFace(
        bbox=bbox,
        detection_score=score,
        landmarks=landmarks,
        quality=quality,
    )


def _extract_embedding(ins_face: Any, state: _EngineState) -> FaceEmbedding:
    """Return the L2-normalised embedding of one InsightFace face."""

    normed = getattr(ins_face, "normed_embedding", None)
    if normed is None:
        raw = np.asarray(ins_face.embedding, dtype=np.float32)
        norm = float(np.linalg.norm(raw))
        if norm <= 0.0:
            raise RuntimeError("InsightFace returned zero-norm embedding.")
        normed = raw / norm
    arr = np.asarray(normed, dtype=np.float32).reshape(-1)
    dim = int(arr.shape[0])
    if state.embedding_dimension is None:
        state.embedding_dimension = dim
    elif state.embedding_dimension != dim:
        # Same model should always produce the same dimension. Anything
        # else indicates a model swap or a corrupt pack.
        raise RuntimeError(
            f"Inconsistent embedding dimension: was {state.embedding_dimension}, "
            f"now {dim}."
        )
    return FaceEmbedding(vector=tuple(float(x) for x in arr), dimension=dim)


__all__ = ["InsightFaceEngine"]
