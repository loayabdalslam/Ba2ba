from bee2bee.metrics import Registry
from bee2bee.p2p import generate_join_link, parse_join_link
from bee2bee.ratelimit import RateLimiter
from bee2bee.utils import gen_salt, hash_password


def test_join_link_roundtrip():
    link = generate_join_link("bee2bee", "demo", "abc123", ["ws://127.0.0.1:4003"])
    info = parse_join_link(link)
    assert info == {"network": "bee2bee", "model": "demo", "hash": "abc123", "bootstrap": ["ws://127.0.0.1:4003"]}


def test_rate_limiter_blocks_then_recovers(monkeypatch):
    import bee2bee.ratelimit as rl

    now = [1000.0]
    monkeypatch.setattr(rl.time, "monotonic", lambda: now[0])
    limiter = RateLimiter(per_minute=60, burst=2)
    assert limiter.allow("a")[0] and limiter.allow("a")[0]
    allowed, retry = limiter.allow("a")
    assert not allowed and retry > 0
    assert limiter.allow("b")[0]
    now[0] += 1.1
    assert limiter.allow("a")[0]


def test_metrics_render():
    reg = Registry()
    c = reg.counter("x_total", "x")
    c.inc(route='/a"b')
    h = reg.histogram("lat_seconds", "lat", buckets=(1, 5))
    h.observe(2)
    reg.gauge("g", "g", fn=lambda: 3)
    text = reg.render()
    assert 'x_total{route="/a\\"b"} 1.0' in text
    assert 'lat_seconds_bucket{le="1"} 0' in text and 'lat_seconds_bucket{le="5"} 1' in text
    assert "g 3.0" in text


def test_password_hash_is_salted_and_stable():
    salt = gen_salt()
    assert hash_password("p", salt) == hash_password("p", salt)
    assert hash_password("p", salt) != hash_password("p", gen_salt())
