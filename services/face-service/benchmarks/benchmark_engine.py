"""CPU inference benchmark for the InsightFace engine.

Measures:

- Model load time (once)
- Per-image timings: decode_ms, detection_ms, face_count

Reports mean / median / p95 / min / max aggregated across the supplied
images, separated by zero-face / one-face / multi-face buckets where the
fixture set allows.

The benchmark NEVER prints embeddings and NEVER saves annotated images.
"""

from __future__ import annotations

import argparse
import json
import logging
import statistics
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

from app.core.config import get_settings
from app.engine.base import set_engine
from app.engine.insightface_engine import InsightFaceEngine
from app.utils.image import ImageError, decode_image


log = logging.getLogger("face_service.benchmark")


@dataclass
class _Sample:
    """One per-image timing sample."""

    file: str
    decode_ms: float
    detection_ms: float
    face_count: int


@dataclass
class _Aggregate:
    """Per-bucket aggregate statistics."""

    samples: int
    decode_ms_mean: float
    decode_ms_median: float
    decode_ms_p95: float
    decode_ms_min: float
    decode_ms_max: float
    detection_ms_mean: float
    detection_ms_median: float
    detection_ms_p95: float
    detection_ms_min: float
    detection_ms_max: float


def _aggregate(samples: list[_Sample]) -> _Aggregate:
    if not samples:
        return _Aggregate(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    decode = sorted(s.decode_ms for s in samples)
    detect = sorted(s.detection_ms for s in samples)

    def p95(xs: list[float]) -> float:
        if len(xs) == 1:
            return xs[0]
        idx = max(0, int(round(0.95 * (len(xs) - 1))))
        return xs[idx]

    return _Aggregate(
        samples=len(samples),
        decode_ms_mean=statistics.fmean(decode),
        decode_ms_median=statistics.median(decode),
        decode_ms_p95=p95(decode),
        decode_ms_min=min(decode),
        decode_ms_max=max(decode),
        detection_ms_mean=statistics.fmean(detect),
        detection_ms_median=statistics.median(detect),
        detection_ms_p95=p95(detect),
        detection_ms_min=min(detect),
        detection_ms_max=max(detect),
    )


def _iter_images(roots: Iterable[Path]) -> Iterable[Path]:
    seen: set[Path] = set()
    for root in roots:
        if not root.exists():
            log.warning("fixture_root_missing path=%s", root)
            continue
        for candidate in sorted(root.rglob("*")):
            if not candidate.is_file():
                continue
            if candidate.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp", ".bmp"}:
                continue
            if candidate in seen:
                continue
            seen.add(candidate)
            yield candidate


def _bucket(samples: list[_Sample]) -> dict[str, _Aggregate]:
    zero = [s for s in samples if s.face_count == 0]
    one = [s for s in samples if s.face_count == 1]
    multi = [s for s in samples if s.face_count >= 2]
    return {
        "all": _aggregate(samples),
        "zero_face": _aggregate(zero),
        "one_face": _aggregate(one),
        "multi_face": _aggregate(multi),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="CPU inference benchmark.")
    parser.add_argument(
        "--fixtures",
        type=Path,
        nargs="+",
        default=[Path("benchmarks/fixtures-local")],
        help="One or more directories of fixture images.",
    )
    parser.add_argument(
        "--json-out",
        type=Path,
        default=None,
        help="Optional path to dump the JSON report.",
    )
    parser.add_argument(
        "--warmup",
        type=int,
        default=0,
        help="Number of warm-up passes before measurements begin.",
    )
    args = parser.parse_args(argv)

    settings = get_settings()

    log.info(
        "benchmark_start model=%s provider=%s det_threshold=%.2f det_size=%s",
        settings.face_model_name,
        settings.face_execution_provider,
        settings.face_det_threshold,
        settings.face_det_size,
    )

    engine = InsightFaceEngine()
    set_engine(engine)
    load_t0 = time.perf_counter()
    engine.load()
    load_ms = (time.perf_counter() - load_t0) * 1000.0
    log.info("model_load_ms=%.1f", load_ms)

    images = list(_iter_images(args.fixtures))
    if not images:
        log.warning(
            "no_fixtures_found roots=%s — exiting without measurements",
            [str(p) for p in args.fixtures],
        )
        report = {
            "model": settings.face_model_name,
            "provider": settings.face_execution_provider,
            "model_load_ms": round(load_ms, 3),
            "image_count": 0,
            "buckets": {},
            "warning": "no fixtures found",
        }
        if args.json_out:
            args.json_out.write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2))
        return 0

    # Warm-up
    for i in range(args.warmup):
        try:
            engine.analyze(images[i % len(images)].read_bytes())
        except Exception:  # noqa: BLE001
            pass

    samples: list[_Sample] = []
    for path in images:
        try:
            payload = path.read_bytes()
            t0 = time.perf_counter()
            decoded = decode_image(payload)
            decode_ms = (time.perf_counter() - t0) * 1000.0

            t1 = time.perf_counter()
            faces = engine.analyze(payload)
            detection_ms = (time.perf_counter() - t1) * 1000.0

            samples.append(
                _Sample(
                    file=str(path),
                    decode_ms=round(decode_ms, 3),
                    detection_ms=round(detection_ms, 3),
                    face_count=len(faces),
                )
            )
        except ImageError as exc:
            log.warning("decode_failed file=%s code=%s", path, exc.code)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "inference_failed file=%s error=%s",
                path,
                type(exc).__name__,
            )

    bucketed = _bucket(samples)
    report = {
        "model": settings.face_model_name,
        "provider": settings.face_execution_provider,
        "det_threshold": settings.face_det_threshold,
        "det_size": settings.face_det_size,
        "model_load_ms": round(load_ms, 3),
        "image_count": len(samples),
        "buckets": {k: asdict(v) for k, v in bucketed.items()},
    }

    print(json.dumps(report, indent=2))
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    raise SystemExit(main())
