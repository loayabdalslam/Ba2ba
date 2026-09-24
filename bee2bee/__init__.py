"""Bee2Bee: decentralized peer-to-peer AI inference mesh."""

from ._version import __version__

__all__ = ["__version__", "P2PNode", "run_p2p_node", "create_app"]


def __getattr__(name):
    # Lazy imports keep `import bee2bee` cheap and free of side effects.
    if name in ("P2PNode", "run_p2p_node"):
        from . import p2p_runtime

        return getattr(p2p_runtime, name)
    if name == "create_app":
        from .api import create_app

        return create_app
    raise AttributeError(name)
