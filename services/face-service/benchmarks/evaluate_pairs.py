"""Offline threshold calibration tool.

Reads a local CSV manifest of image pairs and computes cosine similarities
plus threshold operating points (FAR / FRR / TAR) where the dataset permits.

Manifest format:

    path_a,path_b,label
    fixtures-local/pairs/p1_a.jpg,fixtures-local/pairs/p1_b.jpg,same
    fixtures-local/pairs/p1_a.jpg,fixtures-local/pairs/p2_a.jpg,different

The script never uploads images anywhere. Embeddings live in process memory
only and are not written to disk.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import math
import statistics
from dataclasses import asdict, dataclass
from pathlib import Path

from app.core.config import get_settings
from app.engine.base import set_engine
from app.engine.insightface_engine import InsightFaceEngine
from app.engine.matcher import MatcherError, cosine_similarity
from app.engine.types import FaceEmbedding, ENGINE_STATE_ERROR, ENGINE_STATE_READY
from app.utils.image import ImageError, decode_image


log = logging.getLogger("face_service.evaluate_pairs")


@dataclass
class _Row:
    path_a: str
    path_b: str
    label: str


@dataclass
class _PairResult:
    path_a: str
    path_b: str
    label: str
    similarity: float | None
    error: str | None


def _load_manifest(path: Path) -> list[_Row]:
    rows: list[_Row] = []
    with path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for raw in reader:
            label = (raw.get("label") or "").strip().lower()
            if label not in {"same", "different"}:
                log.warning("manifest_skip label=%r", label)
                continue
            rows.append(
                _Row(
                    path_a=(raw.get("path_a") or "").strip(),
                    path_b=(raw.get("path_b") or "").strip(),
                    label=label,
                )
            )
    return rows


def _single_face_embedding(engine: InsightFaceEngine, image_path: Path) -> FaceEmbedding:
    payload = image_path.read_bytes()
    decoded = decode_image(payload)
    faces = engine.analyze(payload)
    if len(faces) != 1:
        raise RuntimeError(
            f"{image_path}: expected exactly 1 face, got {len(faces)}."
        )
    embeddings = engine.extract_embeddings(payload, faces)
    if not embeddings:
        raise RuntimeError(f"{image_path}: engine produced no embedding.")
    return embeddings[0]


def _safe_similarity(
    engine: InsightFaceEngine, row: _Row, base: Path
) -> tuple[float | None, str | None]:
    try:
        path_a = base / row.path_a
        path_b = base / row.path_b
        if not path_a.exists():
            return None, f"missing path_a={path_a}"
        if not path_b.exists():
            return None, f"missing path_b={path_b}"
        emb_a = _single_face_embedding(engine, path_a)
        emb_b = _single_face_embedding(engine, path_b)
        sim = cosine_similarity(emb_a, emb_b)
        return sim, None
    except ImageError as exc:
        return None, f"image_error code={exc.code}"
    except MatcherError as exc:
        return None, f"matcher_error code={exc.code}"
    except Exception as exc:  # noqa: BLE001
        return None, f"{type(exc).__name__}: {exc}"


def _summarise(results: list[_PairResult]) -> dict[str, object]:
    valid = [r for r in results if r.similarity is not None]
    pos = [r.similarity for r in valid if r.label == "same"]
    neg = [r.similarity for r in valid if r.label == "different"]

    def stats(xs: list[float]) -> dict[str, float]:
        if not xs:
            return {"count": 0}
        ordered = sorted(xs)
        idx_p95 = max(0, int(round(0.95 * (len(ordered) - 1))))
        return {
            "count": len(xs),
            "min": round(min(xs), 6),
            "max": round(max(xs), 6),
            "mean": round(statistics.fmean(xs), 6),
            "median": round(statistics.median(xs), 6),
            "p95": round(ordered[idx_p95], 6),
        }

    def threshold_table(thresholds: list[float]) -> list[dict[str, object]]:
        rows: list[dict[str, object]] = []
        for tau in thresholds:
            if not pos or not neg:
                rows.append({"threshold": tau, "tar": None, "far": None, "frr": None})
                continue
            tp = sum(1 for s in pos if s >= tau)
            tn = sum(1 for s in neg if s < tau)
            fn = sum(1 for s in pos if s < tau)
            fp = sum(1 for s in neg if s >= tau)
            tar = tp / max(1, len(pos))
            far = fp / max(1, len(neg))
            frr = fn / max(1, len(pos))
            rows.append(
                {
                    "threshold": round(tau, 4),
                    "tar": round(tar, 6),
                    "far": round(far, 6),
                    "frr": round(frr, 6),
                }
            )
        return rows

    summary: dict[str, object] = {
        "valid_pairs": len(valid),
        "skipped_pairs": len(results) - len(valid),
        "positive_pairs": stats(pos),
        "negative_pairs": stats(neg),
        "thresholds": threshold_table([0.30, 0.35, 0.40, 0.45, 0.50]),
    }

    # Note explicitly when the dataset is too small to draw conclusions.
    if len(valid) < 20:
        summary["calibration_status"] = "INSUFFICIENT"
        summary["calibration_note"] = (
            "Dataset is too small for statistically meaningful FAR/FRR/TAR "
            "estimates. Collect more consented pairs before production "
            "calibration."
        )
    else:
        summary["calibration_status"] = "PRELIMINARY"
        summary["calibration_note"] = (
            "Numbers are based on the supplied local dataset only and are "
            "not generalisable. Re-run with a representative dataset before "
            "production deployment."
        )
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Offline pair evaluation.")
    parser.add_argument(
        "--manifest",
        type=Path,
        required=True,
        help="CSV with columns: path_a,path_b,label (label = same|different).",
    )
    parser.add_argument(
        "--base",
        type=Path,
        default=Path(".").resolve(),
        help="Base directory for relative manifest paths.",
    )
    parser.add_argument(
        "--json-out",
        type=Path,
        default=None,
        help="Optional path to dump the JSON report.",
    )
    args = parser.parse_args(argv)

    if not args.manifest.exists():
        log.error("manifest_missing path=%s", args.manifest)
        return 2

    settings = get_settings()
    engine = InsightFaceEngine()
    set_engine(engine)
    engine.load()
    if engine.status().state == ENGINE_STATE_ERROR:
        log.error("engine_load_failed state=%s", engine.status().state)
        return 3

    rows = _load_manifest(args.manifest)
    if not rows:
        log.warning("manifest_empty path=%s", args.manifest)
        report = {
            "model": settings.face_model_name,
            "provider": settings.face_execution_provider,
            "summary": {"valid_pairs": 0, "skipped_pairs": 0},
            "results": [],
        }
        print(json.dumps(report, indent=2))
        return 0

    results: list[_PairResult] = []
    for row in rows:
        sim, err = _safe_similarity(engine, row, args.base)
        results.append(
            _PairResult(
                path_a=row.path_a,
                path_b=row.path_b,
                label=row.label,
                similarity=sim,
                error=err,
            )
        )

    summary = _summarise(results)
    report = {
        "model": settings.face_model_name,
        "provider": settings.face_execution_provider,
        "match_threshold_default": settings.face_match_threshold,
        "summary": summary,
        "results": [asdict(r) for r in results],
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
