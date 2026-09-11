/**
 * Centralized biometric enrollment constants.
 *
 * PHASE 4.4B1 — Face ID Enrollment Start API.
 *
 * Centralizes numeric invariants for enrollment so future API routes
 * and services do not have to repeat the same magic numbers. The
 * values here are deliberately small and explicit — no environment
 * variable, no per-request override — to keep the enrollment pipeline
 * deterministic across server contexts.
 *
 * If a future phase needs to make these configurable (for example,
 * to A/B-test different sample counts), the place to do it is here,
 * not at the call sites.
 */

/**
 * Maximum size in bytes for a single enrollment sample image upload.
 *
 * 1.5 MB is sufficient for a high-quality JPEG photo from a modern
 * webcam while being small enough to prevent abuse and avoid
 * forwarding excessively large payloads to the trusted Face Service.
 *
 * Validated at the Next.js API boundary before forwarding to
 * `analyzeEnrollmentSample()`.
 */
export const FACE_ENROLLMENT_MAX_SAMPLE_BYTES = 1.5 * 1024 * 1024; // 1,572,864 bytes

/**
 * Number of accepted samples required to finalize a CREATE-mode
 * enrollment session.
 *
 * 5 samples is a deliberately conservative default that gives the
 * quality + centroid pipeline enough variance to build a stable
 * template without forcing the user through a long flow. The value
 * is duplicated into:
 *   - `requiredSampleCount` on new `FaceEnrollmentSession` documents
 *   - the success response of `POST /api/face-id/enrollment/start`
 *
 * Do NOT scatter a literal `5` across call sites — import this
 * constant instead.
 */
export const DEFAULT_FACE_ENROLLMENT_REQUIRED_SAMPLES = 5;

/**
 * Current template version. Bumped only when the embedded
 * `EncryptedBiometricValue` / sample / quality schema changes shape.
 * See `docs/privacy-security.md` for the distinction between
 * `templateVersion` (schema) and `keyVersion` (encryption key).
 */
export const DEFAULT_FACE_ENROLLMENT_TEMPLATE_VERSION = 1;