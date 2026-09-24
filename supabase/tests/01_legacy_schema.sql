-- The schema shipped before the security fix (abridged), plus sample data,
-- to prove the migration upgrades an existing database in place.
create table public.profiles (id uuid references auth.users(id) on delete cascade primary key, email text, country text, created_at timestamptz default now());
create table public.messages (id uuid default gen_random_uuid() primary key, user_id uuid references auth.users(id), node_id text not null,
  content text not null, role text not null check (role in ('user','assistant')), tokens integer default 0, cost decimal(12,6) default 0,
  metadata jsonb default '{}'::jsonb, created_at timestamptz default now());
create table public.node_logs (id bigserial primary key, peer_id text not null, latency_ms float not null, status text not null);
create table public.active_nodes (peer_id text primary key, addr text not null, region text default 'Global', models text[] default '{}',
  metrics jsonb default '{}'::jsonb, last_seen timestamptz default now(), created_at timestamptz default now());
alter table public.active_nodes enable row level security;
create policy "Public read access for mesh map" on public.active_nodes for select using (true);
create policy "Unauthenticated mesh announcement" on public.active_nodes for insert with check (true);
create policy "Unauthenticated telemetry updates" on public.active_nodes for update using (true);
insert into public.active_nodes (peer_id, addr) values ('spoofed', 'ws://evil:1');
insert into public.messages (node_id, content, role, tokens) values ('GLOBAL_METRICS', '[Metric Log]', 'assistant', 10);
