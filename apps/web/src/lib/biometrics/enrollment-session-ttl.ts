/**
 * Default enrollment session lifetime.
 *
 * PHASE 4.2 — FaceProfile + FaceEnrollmentSession database foundation.
 *
 * MongoDB TTL deletion is asynchronous; service code must also treat
 * `expiresAt <= now` as expired even if the document has not yet been
 * physically removed. The helper `isEnrollmentSessionExpired`
 * encapsulates that logic.
 *
 * 15 minutes is a deliberately generous default so users can complete
 * enrollment on slow networks without losing progress. Future phases
 * may make this configurable per request without changing the public
 * service interface.
 */
export const DEFAULT_ENROLLMENT_SESSION_TTL_MS = 15 * 60 * 1000;
