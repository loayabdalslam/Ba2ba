-- Bee2Bee production schema.
--
-- Idempotent: safe on a fresh project and on databases created from the old
-- SUPABASE_SCHEMA.sql (it removes the permissive policies that let anyone
-- insert or update mesh nodes with the anon key).
--
-- Security model:
--   * anon / authenticated roles can READ public mesh data and their OWN rows.
--   * All writes to shared tables go through the gateway using the
--     service_role key, which bypasses RLS. There are deliberately no
--     INSERT/UPDATE policies on active_nodes, usage_events or api_keys.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    email text,
    country text,
    created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "Users can view all profiles for count" on public.profiles;
drop policy if exists "Users can update their own profile" on public.profiles;
drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_select_own on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles for update to authenticated
    using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
    for each row execute procedure public.handle_new_user();

-- ------------------------------------------------------------ active nodes
create table if not exists public.active_nodes (
    peer_id text primary key,
    addr text not null,
    region text default 'Global',
    models text[] default '{}',
    metrics jsonb default '{}'::jsonb,
    last_seen timestamptz default now(),
    created_at timestamptz default now()
);
alter table public.active_nodes add column if not exists pubkey text;
alter table public.active_nodes add column if not exists api_port integer;
alter table public.active_nodes add column if not exists verified boolean not null default false;
alter table public.active_nodes add column if not exists reputation real not null default 0.5;
alter table public.active_nodes add column if not exists tag text;
create index if not exists active_nodes_last_seen_idx on public.active_nodes (last_seen desc);

-- Rows written with the old anon policy are unauthenticated; drop them.
delete from public.active_nodes where pubkey is null;

alter table public.active_nodes enable row level security;
drop policy if exists "Public read access for mesh map" on public.active_nodes;
drop policy if exists "Unauthenticated mesh announcement" on public.active_nodes;
drop policy if exists "Unauthenticated telemetry updates" on public.active_nodes;
drop policy if exists active_nodes_public_read on public.active_nodes;
create policy active_nodes_public_read on public.active_nodes for select to anon, authenticated
    using (verified and last_seen > now() - interval '1 hour');

-- ------------------------------------------------------------ conversations
create table if not exists public.conversations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    title text not null default 'New chat',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists conversations_user_idx on public.conversations (user_id, updated_at desc);
alter table public.conversations enable row level security;
drop policy if exists conversations_own on public.conversations;
create policy conversations_own on public.conversations for all to authenticated
    using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- ----------------------------------------------------------------- messages
create table if not exists public.messages (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id),
    node_id text not null,
    content text not null,
    role text not null check (role in ('user', 'assistant')),
    tokens integer default 0,
    cost numeric(12, 6) default 0,
    metadata jsonb default '{}'::jsonb,
    created_at timestamptz default now()
);
alter table public.messages add column if not exists conversation_id uuid references public.conversations(id) on delete cascade;
alter table public.messages add column if not exists model text;
-- Legacy anonymous "[Metric Log]" rows carried no content; usage now lives in usage_events.
delete from public.messages where user_id is null;
alter table public.messages alter column user_id set not null;
alter table public.messages alter column node_id drop not null;
create index if not exists messages_conversation_idx on public.messages (conversation_id, created_at);
alter table public.messages enable row level security;
drop policy if exists "Users can insert their own messages" on public.messages;
drop policy if exists messages_select_own on public.messages;
drop policy if exists messages_insert_own on public.messages;
drop policy if exists messages_delete_own on public.messages;
create policy messages_select_own on public.messages for select to authenticated using ((select auth.uid()) = user_id);
create policy messages_insert_own on public.messages for insert to authenticated
    with check (
        (select auth.uid()) = user_id
        and (conversation_id is null or exists (
            select 1 from public.conversations c where c.id = conversation_id and c.user_id = (select auth.uid())
        ))
    );
create policy messages_delete_own on public.messages for delete to authenticated using ((select auth.uid()) = user_id);

-- ----------------------------------------------------------------- API keys
create table if not exists public.api_keys (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    name text not null default 'default',
    prefix text not null,
    -- sha256 of the secret. Keys are 32 random bytes, so a fast hash is fine.
    key_hash text not null unique,
    monthly_token_quota bigint not null default 1000000,
    created_at timestamptz not null default now(),
    last_used_at timestamptz,
    revoked_at timestamptz
);
create index if not exists api_keys_user_idx on public.api_keys (user_id);
alter table public.api_keys enable row level security;
drop policy if exists api_keys_select_own on public.api_keys;
create policy api_keys_select_own on public.api_keys for select to authenticated using ((select auth.uid()) = user_id);
-- Never let clients read hashes, even of their own keys.
revoke select on public.api_keys from anon, authenticated;
grant select (id, user_id, name, prefix, monthly_token_quota, created_at, last_used_at, revoked_at)
    on public.api_keys to authenticated;

-- ------------------------------------------------------------- usage events
create table if not exists public.usage_events (
    id bigserial primary key,
    user_id uuid references auth.users(id) on delete set null,
    api_key_id uuid references public.api_keys(id) on delete set null,
    source text not null check (source in ('web', 'api')),
    model text,
    provider text,
    prompt_tokens integer not null default 0,
    completion_tokens integer not null default 0,
    created_at timestamptz not null default now()
);
create index if not exists usage_events_key_month_idx on public.usage_events (api_key_id, created_at);
create index if not exists usage_events_user_idx on public.usage_events (user_id, created_at);
alter table public.usage_events enable row level security;
drop policy if exists usage_select_own on public.usage_events;
create policy usage_select_own on public.usage_events for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.api_key_usage_this_month(p_key uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(prompt_tokens + completion_tokens), 0)::bigint
  from public.usage_events
  where api_key_id = p_key and created_at >= date_trunc('month', now());
$$;
revoke all on function public.api_key_usage_this_month(uuid) from public, anon, authenticated;
grant execute on function public.api_key_usage_this_month(uuid) to service_role;

-- ------------------------------------------------------------ legacy tables
drop table if exists public.node_logs;

-- -------------------------------------------------------------- statistics
-- Aggregates only; runs with the owner's rights so it can count across users.
drop view if exists public.system_stats;
create view public.system_stats with (security_invoker = false) as
select
    (select coalesce(sum(prompt_tokens + completion_tokens), 0) from public.usage_events)::bigint as total_tokens,
    (select count(*) from public.usage_events)::bigint as total_chats,
    (select count(*) from public.profiles)::bigint as total_users,
    (select count(*) from public.active_nodes where verified and last_seen > now() - interval '5 minutes')::bigint as active_nodes;
grant select on public.system_stats to anon, authenticated;

-- -------------------------------------------------------------- maintenance
-- Prune stale nodes every 10 minutes when pg_cron is available
-- (enable it under Database -> Extensions in the Supabase dashboard).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'bee2bee-prune-nodes';
    perform cron.schedule('bee2bee-prune-nodes', '*/10 * * * *',
      $cron$delete from public.active_nodes where last_seen < now() - interval '1 hour'$cron$);
  end if;
end;
$$;
