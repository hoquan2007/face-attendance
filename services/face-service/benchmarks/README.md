# Benchmark & Evaluation Tools

This directory hosts the PHASE 3 measurement tools for the Face Service.
None of these tools are imported by the FastAPI app — they are run
manually / in CI to characterize CPU performance and gather threshold data.

## `benchmark_engine.py`

```bash
# Place consented images under benchmarks/fixtures-local/, then:
python -m benchmarks.benchmark_engine --fixtures benchmarks/fixtures-local
```

Reports (JSON to stdout, optionally to a file):

- model load time (ms)
- per-image decode_ms and detection_ms
- aggregate mean / median / p95 / min / max
- buckets: `zero_face`, `one_face`, `multi_face`

Never prints embeddings. Never saves annotated images.

## `evaluate_pairs.py`

```bash
# Provide a manifest of image pairs:
#   path_a,path_b,label        # label = same | different
python -m benchmarks.evaluate_pairs \
    --manifest benchmarks/fixtures-local/pairs/manifest.csv
```

Reports:

- per-pair cosine similarity
- positive/negative pair statistics
- threshold operating points at 0.30 / 0.35 / 0.40 / 0.45 / 0.50
- a calibration status flag (`INSUFFICIENT` when fewer than 20 valid pairs)

When the dataset is too small the report prints:

```
"calibration_status": "INSUFFICIENT"
```

Do **not** report "100% accurate" even if a tiny test set happens to have
zero errors. Calibration must use a representative dataset before any
production deployment.

## Fixture rules

See `fixtures-local/README.md`. Real face images must NEVER be committed.
