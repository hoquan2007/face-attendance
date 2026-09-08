# Model License

> Status: **Phase 3** — InsightFace `buffalo_l` model pack loaded by default on
> CPU. Production deployment is blocked on a commercial-model licensing
> review.

## What model do we plan to use?

The first `FaceEngine` implementation is **InsightFace** with the **`buffalo_l`**
pack (an ArcFace-based pretrained bundle). `buffalo_l` is the development
default because it offers high accuracy and works on CPU.

`buffalo_l` pack contents (per official InsightFace Model Zoo):

| Component | Model | Notes |
| --- | --- | --- |
| Detection | `SCRFD-10GF` | Anchor-free face detector; PHASE 3 default input size is `640x640`. |
| Recognition | `ResNet50@WebFace600K` | ArcFace-style embedding; 512-D unit-norm vector (validated at runtime, never hardcoded). |
| Alignment | 2D-106 / 3D-68 landmarks | Five-point alignment is used by the recognition step. |
| Attributes | Gender / Age | **Not loaded** by the PHASE 3 Face Service. |

Pack size on disk: ~326 MB. Auto-downloaded into the InsightFace model cache
on first run.

## License distinction

**InsightFace source code** vs **pretrained model weights** are licensed
separately. Treat them independently:

| Asset | License (as observed 2026-09) | Source URL |
| --- | --- | --- |
| `insightface` Python package | **MIT** — free for commercial use | https://github.com/deepinsight/insightface/blob/master/LICENSE |
| `buffalo_l` model pack (and `buffalo_s`, `buffalo_m`, `antelopev2`) | **Non-commercial research use only** | https://github.com/deepinsight/insightface (README "License" section) |
| `insightface-cli model.download buffalo_l` (auto-download) | Same as the pack above — research-only | https://pypi.org/project/insightface/ |
| Commercial licensing of open-source model packs | Contact `recognition-oss-pack@insightface.ai` | https://www.insightface.ai/solutions/face-recognition-licensing |

> **Production gate**: Commercial / production use of the `buffalo_l`
> pretrained recognition model (or any other InsightFace open-source pack) is
> NOT covered by the MIT source-code license. The application deployer must
> contact InsightFace for a separate commercial license before deploying the
> Face Service to production attendance workloads.

## Runtime configuration (PHASE 3 default)

| Variable | Default | Notes |
| --- | --- | --- |
| `FACE_MODEL_NAME` | `buffalo_l` | High-accuracy ArcFace pack. |
| `FACE_EXECUTION_PROVIDER` | `cpu` | CPU-only. CUDA is intentionally not enabled in PHASE 3. |
| `FACE_DET_THRESHOLD` | `0.5` | SCRFD confidence cutoff. |
| `FACE_DET_SIZE` | `640x640` | Concrete `(W, H)` pair. InsightFace 1.0 SCRFD does not accept the literal `"auto"` string. |
| `FACE_MATCH_THRESHOLD` | `0.4` | **DEVELOPMENT BASELINE ONLY** — re-calibrate with representative evaluation data before any production deployment. |
| `INSIGHTFACE_HOME` | (unset) | Override to relocate the InsightFace model cache. |

## Model identity & compatibility principle

Future embeddings produced by a different recognition model are NOT
interchangeable. The PHASE 3 engine exposes an immutable
`EngineMetadata` block from `/health`:

```json
{
  "engine": "insightface",
  "model": "buffalo_l",
  "provider": "CPUExecutionProvider",
  "embedding_dimension": 512
}
```

This metadata will be stored alongside future `face_profiles` templates so
that model swaps cannot silently corrupt enrollment / recognition. Matcher
logic must reject comparisons where the two sides report incompatible
metadata.

## Verification log (operator to fill in before production)

| Date | Model | License observed | Source URL | Cleared for production? |
| --- | --- | --- | --- | --- |
| 2026-09-08 | `buffalo_l` (research-only) | InsightFace repo README — "non-commercial research purposes only" | https://github.com/deepinsight/insightface | **NO** — research-only. Production deployment requires contacting `recognition-oss-pack@insightface.ai` for a commercial license. |

> This table must be re-checked before any production deployment that uses
> face recognition for attendance.

## What is and is not bundled in this repository

- **Source code only.** No `.onnx` files, no `.insightface/` cache, no
  model archives are committed.
- The model pack is downloaded on first run into the local InsightFace
  cache (`~/.insightface/` by default; override via `INSIGHTFACE_HOME`).
- The `services/face-service/.gitignore` excludes `.insightface/` and the
  `benchmarks/fixtures-local/` directory (real face images are never
  committed).
