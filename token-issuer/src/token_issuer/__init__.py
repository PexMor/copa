"""Independent token service used to test the copa widget and copasrv.

It implements the widget <-> token-service contract (popup login, verifier-bound
hand-off, token, refresh, logout) and publishes a JWKS, exactly as a third-party
service would. It shares no code with copasrv.
"""

__version__ = "0.1.0"
