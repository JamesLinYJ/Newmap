from .client import QgisRuntimeClient

__all__ = ["QgisRunner", "QgisRuntimeClient"]


def __getattr__(name: str):
    if name == "QgisRunner":
        from .runner import QgisRunner

        return QgisRunner
    raise AttributeError(name)
