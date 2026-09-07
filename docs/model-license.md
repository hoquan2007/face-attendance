# Model License

> Status: **Phase 0** — informational. Actual model downloads happen in Phase 3.

## What model do we plan to use?

The first `FaceEngine` implementation is **InsightFace** with the **`buffalo_l`** pack (an ArcFace-based pretrained bundle). `buffalo_l` is the development default because it offers high accuracy and works on CPU.

## Important: source code license ≠ model weights license

> **Do not assume that the pretrained InsightFace model weights share the same license as the InsightFace source code.**

- The InsightFace *source code* is generally distributed under the **MIT License**.
- The pretrained **model weights** (e.g. `buffalo_l`) are often distributed under separate terms — frequently a **non-commercial research-only license** — and may require the operator to accept additional terms before download.
- Commercial deployment of any bundled weights is the **responsibility of the application deployer**. You must read and comply with the license that ships with the specific weights you download.

## What this means for the MVP

1. We will not bundle model weights in the repository.
2. On first run the Face Service will fetch the configured pack into the local model cache directory (default `~/.insightface/`).
3. The application developer / operator is responsible for:
   - Confirming that the chosen pack's license permits their use case.
   - Recording that confirmation in this file (date, model, license text, source URL) before moving the system to production.
4. If a license is incompatible with the intended use case, swap to a compatible model. The `FaceEngine` abstraction exists precisely so that this is a localized change.

## Default Phase 3 config

| Setting | Default | Notes |
| --- | --- | --- |
| `FACE_MODEL_NAME` | `buffalo_l` | High-accuracy ArcFace pack. |
| Execution provider | `cpu` (auto-fallback to `cuda` if available) | Controlled via `FACE_EXECUTION_PROVIDER`. |

## Verification log (operator to fill in)

| Date | Model | License observed | Source URL | Cleared for production? |
| --- | --- | --- | --- | --- |
| _to be filled in Phase 3_ | | | | |

> This table must be completed before any production deployment that uses face recognition for attendance.