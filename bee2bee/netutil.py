"""Validation for addresses received from peers, users and the registry."""

from __future__ import annotations

import ipaddress
import socket
from typing import Iterable
from urllib.parse import urlparse


class AddressError(ValueError):
    pass


def _is_private(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified


def resolve_host(host: str) -> Iterable[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    try:
        return [ipaddress.ip_address(host)]
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise AddressError(f"cannot resolve {host}") from e
    return {ipaddress.ip_address(info[4][0]) for info in infos}


def validate_peer_addr(addr: str, *, require_tls: bool = False, allow_private: bool = True, resolve: bool = True) -> str:
    """Accept only ws:// or wss:// URLs with a host, optionally public-only."""
    if not isinstance(addr, str) or len(addr) > 512:
        raise AddressError("invalid address")
    parsed = urlparse(addr.strip())
    if parsed.scheme not in ("ws", "wss"):
        raise AddressError("address must use ws:// or wss://")
    if require_tls and parsed.scheme != "wss":
        raise AddressError("TLS (wss://) is required")
    if not parsed.hostname:
        raise AddressError("address has no host")
    if parsed.username or parsed.password:
        raise AddressError("credentials in address are not allowed")
    try:
        _ = parsed.port  # validates the port range
    except ValueError as e:
        raise AddressError("invalid port") from e
    if not allow_private and resolve:
        for ip in resolve_host(parsed.hostname):
            if _is_private(ip):
                raise AddressError("private or loopback addresses are not allowed")
    return addr.strip()
