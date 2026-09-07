"""Service-to-service authentication.

MVP: shared secret sent as `X-Service-Token`. Replace with mTLS / signed JWT
/ workload identity later without changing route signatures.
"""

from fastapi import Header, HTTPException, status


def verify_service_token(
    x_service_token: str | None = Header(default=None, alias="X-Service-Token"),
) -> None:
    """Verify the shared service token.

    In Phase 0 this is enforced as a no-op when no secret is configured so the
    skeleton can boot. From Phase 1 onward, the secret becomes required and
    mismatched tokens return 401.
    """
    # Lazy import to avoid circulars at module load.
    from app.core.config import get_settings

    settings = get_settings()
    expected = settings.face_service_secret

    if expected is None:
        # Phase 0 only: skip verification when secret not configured.
        return

    if x_service_token != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": {"code": "UNAUTHENTICATED", "message": "Invalid service token."}},
        )