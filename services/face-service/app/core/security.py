"""Service-to-service authentication.

MVP: shared secret sent as ``X-Service-Token``. The dependency is used by all
sensitive (``/v1/*``) routes. ``GET /health`` is intentionally left open so
that liveness probes can poll the service without holding the secret.

When ``FACE_SERVICE_SECRET`` is unconfigured the dependency rejects every
request with ``FACE_SERVICE_UNAUTHORIZED`` — never silently allow.
"""

from __future__ import annotations

from fastapi import Header, HTTPException, status


def verify_service_token(
    x_service_token: str | None = Header(default=None, alias="X-Service-Token"),
) -> None:
    """Verify the shared service token.

    - If the secret is not configured, every protected call is rejected with
      ``FACE_SERVICE_UNAUTHORIZED`` so the misconfiguration is loud.
    - Otherwise the token must match exactly.
    """

    from app.core.config import get_settings

    settings = get_settings()
    expected = settings.face_service_secret

    if not expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": {
                    "code": "FACE_SERVICE_UNAUTHORIZED",
                    "message": "Service token is not configured on the server.",
                }
            },
        )

    if x_service_token != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": {
                    "code": "FACE_SERVICE_UNAUTHORIZED",
                    "message": "Invalid service token.",
                }
            },
        )


__all__ = ["verify_service_token"]
