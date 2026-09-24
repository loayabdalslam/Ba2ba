"""Bee2Bee command line interface."""

from __future__ import annotations

import asyncio
import os
import sys
from typing import Optional

import click
from rich.console import Console

from ._version import __version__
from .settings import load_settings

console = Console()


def _bootstrap(settings_overrides: dict):
    from dotenv import load_dotenv

    load_dotenv()
    from . import observability

    settings = load_settings(**settings_overrides)
    observability.setup(settings)
    return settings


def _serve(backend: str, model: str, host, port, public_host, region, api_port, bootstrap, price) -> None:
    from .p2p_runtime import run_p2p_node

    settings = _bootstrap(
        dict(host=host, port=port, announce_host=public_host, region=region, bootstrap=[bootstrap] if bootstrap else None)
    )
    try:
        asyncio.run(
            run_p2p_node(
                model_name=model,
                backend=backend,
                api_port=api_port or None,
                price_per_token=price,
                settings=settings,
            )
        )
    except KeyboardInterrupt:
        pass


def serve_options(default_model: str):
    def decorator(fn):
        options = [
            click.option("--model", default=default_model, show_default=True, help="Model name"),
            click.option("--host", default=None, help="P2P bind host [env BEE2BEE_HOST, default 0.0.0.0]"),
            click.option("--port", default=None, type=int, help="P2P port [env BEE2BEE_PORT, default 4003]"),
            click.option("--public-host", default=None, help="Public host/IP to announce [env BEE2BEE_ANNOUNCE_HOST]"),
            click.option("--region", default=None, help="Region label [env BEE2BEE_REGION]"),
            click.option(
                "--api-port", default=None, type=int, help="HTTP API port, 0 to disable [env BEE2BEE_API_PORT, default 4002]"
            ),
            click.option("--bootstrap", default=None, help="Bootstrap peer (ws:// URL or join link) [env BEE2BEE_BOOTSTRAP]"),
            click.option("--price", default=0.0, type=float, show_default=True, help="Advertised price per token"),
        ]
        for option in reversed(options):
            fn = option(fn)
        return fn

    return decorator


def _api_port(value: Optional[int]) -> int:
    if value is not None:
        return value
    return int(os.getenv("BEE2BEE_API_PORT", "4002"))


@click.group()
@click.version_option(__version__, prog_name="bee2bee")
def cli():
    """Bee2Bee: decentralized peer-to-peer AI inference mesh."""


@cli.command("serve-ollama")
@serve_options("llama3")
def serve_ollama(model, host, port, public_host, region, api_port, bootstrap, price):
    """Serve a local Ollama model (set OLLAMA_HOST for a remote Ollama)."""
    _serve("ollama", model, host, port, public_host, region, _api_port(api_port), bootstrap, price)


@cli.command("serve-hf")
@serve_options("distilgpt2")
def serve_hf(model, host, port, public_host, region, api_port, bootstrap, price):
    """Serve a Hugging Face transformers model locally (needs bee2bee[hf,torch])."""
    _serve("hf", model, host, port, public_host, region, _api_port(api_port), bootstrap, price)


@cli.command("serve-hf-remote")
@serve_options("HuggingFaceH4/zephyr-7b-beta")
@click.option("--token", default=None, envvar="HF_TOKEN", help="Hugging Face token (prefer the HF_TOKEN env var)")
def serve_hf_remote(model, host, port, public_host, region, api_port, bootstrap, price, token):
    """Serve through the Hugging Face Inference API."""
    if token:
        os.environ["HF_TOKEN"] = token
    _serve("hf_remote", model, host, port, public_host, region, _api_port(api_port), bootstrap, price)


@cli.command("serve-echo")
@serve_options("echo")
def serve_echo(model, host, port, public_host, region, api_port, bootstrap, price):
    """Serve a test backend that echoes the prompt (no model needed)."""
    _serve("echo", model, host, port, public_host, region, _api_port(api_port), bootstrap, price)


@cli.command()
@click.option("--host", default=None)
@click.option("--port", default=None, type=int)
@click.option("--api-port", default=None, type=int)
@click.option("--bootstrap", default=None)
def relay(host, port, api_port, bootstrap):
    """Run a node without a model: routes requests to other peers."""
    from .p2p_runtime import run_p2p_node

    settings = _bootstrap(dict(host=host, port=port, bootstrap=[bootstrap] if bootstrap else None))
    try:
        asyncio.run(run_p2p_node(api_port=_api_port(api_port) or None, settings=settings))
    except KeyboardInterrupt:
        pass


@cli.command()
def identity():
    """Show this node's peer id and public key."""
    from .identity import Identity

    ident = Identity.load_or_create()
    console.print(f"peer_id: {ident.peer_id}\npubkey:  {ident.pubkey}")


@cli.command("api-key")
@click.option("--rotate", is_flag=True, help="Generate a new key (the old one stops working)")
def api_key(rotate):
    """Show (or rotate) the local HTTP API key."""
    from .api import API_KEY_FILE, load_or_create_api_key
    from .utils import bee2bee_home

    if rotate:
        (bee2bee_home() / API_KEY_FILE).unlink(missing_ok=True)
    settings = _bootstrap({})
    if settings.api_key:
        console.print("[yellow]BEE2BEE_API_KEY is set in the environment; that key is used.[/yellow]")
    console.print(load_or_create_api_key(settings))


@cli.command()
@click.argument("key", type=click.Choice(["bootstrap_url"]))
@click.argument("value")
def config(key, value):
    """Persist a config value, e.g. `bee2bee config bootstrap_url wss://host:4003`."""
    from .config import load_config, save_config
    from .netutil import AddressError, validate_peer_addr

    try:
        validate_peer_addr(value, resolve=False)
    except AddressError as e:
        raise click.BadParameter(str(e))
    cfg = load_config()
    cfg[key] = value
    save_config(cfg)
    console.print(f"[green]Saved {key} = {value}[/green]")


@cli.command()
def register():
    """Register this node with the registry once (normally automatic)."""
    from .identity import Identity
    from .registry import RegistryClient

    settings = _bootstrap({})
    reg = RegistryClient(settings, Identity.load_or_create())
    if not reg.enabled:
        console.print("[red]No registry configured. Set BEE2BEE_REGISTRY_URL.[/red]")
        sys.exit(1)
    if not (settings.announce_addr or settings.announce_host):
        console.print("[red]Set BEE2BEE_ANNOUNCE_ADDR (or BEE2BEE_ANNOUNCE_HOST) so the registry can reach this node.[/red]")
        sys.exit(1)
    scheme = "wss" if settings.tls_enabled else "ws"
    addr = settings.announce_addr or f"{scheme}://{settings.announce_host}:{settings.announce_port or settings.port}"

    async def _go() -> bool:
        try:
            return await reg.sync_node(addr=addr, models=[], region=settings.region, api_port=settings.api_port)
        finally:
            await reg.close()

    if asyncio.run(_go()):
        console.print(f"[green]Registered {reg.identity.peer_id} at {addr}[/green]")
    else:
        console.print("[red]Registration failed (see log above).[/red]")
        sys.exit(1)


def main() -> None:
    cli()


if __name__ == "__main__":
    main()
