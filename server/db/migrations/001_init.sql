-- Bee2Bee directory schema (Neon Postgres).

create table if not exists nodes (
    peer_id text primary key check (peer_id ~ '^peer-[0-9a-f]{32}$'),
    pubkey text not null,
    name text not null,
    addr text not null,
    region text not null default 'Auto',
    version text,
    api_port integer,
    reachable boolean not null default false,
    verified_addr text,
    verified_at timestamptz,
    probe_error text,
    latency_ms real,
    tokens_per_sec real,
    cpu_percent real,
    memory_percent real,
    gpu_percent real,
    heartbeats bigint not null default 0,
    first_seen timestamptz not null default now(),
    last_seen timestamptz not null default now()
);
create index if not exists nodes_last_seen_idx on nodes (last_seen desc);
create index if not exists nodes_region_idx on nodes (lower(region));

create table if not exists node_models (
    peer_id text not null references nodes (peer_id) on delete cascade,
    model text not null,
    provider text not null,
    tokens_per_sec real,
    primary key (peer_id, model, provider)
);
create index if not exists node_models_model_idx on node_models (lower(model));
create index if not exists node_models_provider_idx on node_models (lower(provider));

-- Heartbeats per node per day, for uptime percentages.
create table if not exists node_uptime (
    peer_id text not null references nodes (peer_id) on delete cascade,
    day date not null,
    beats integer not null default 0,
    primary key (peer_id, day)
);

-- Replay protection for signed heartbeats.
create table if not exists heartbeat_nonces (
    nonce text primary key,
    peer_id text not null,
    created_at timestamptz not null default now()
);
create index if not exists heartbeat_nonces_created_idx on heartbeat_nonces (created_at);

create table if not exists schema_migrations (
    version text primary key,
    applied_at timestamptz not null default now()
);
