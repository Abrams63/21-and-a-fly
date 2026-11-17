"""The fly's brain: a spiking mushroom-body model in PyTorch, served over FastAPI."""


def main() -> None:
    from .app import main as serve

    serve()
