\set ON_ERROR_STOP on
-- Fixtures (as the table owner / service role).
insert into auth.users values ('11111111-1111-1111-1111-111111111111', 'a@x'), ('22222222-2222-2222-2222-222222222222', 'b@x')
  on conflict do nothing;
insert into public.active_nodes (peer_id, pubkey, addr, verified, last_seen) values
  ('peer-good', 'pk', 'wss://good:4003', true, now()),
  ('peer-unverified', 'pk', 'wss://u:4003', false, now()),
  ('peer-stale', 'pk', 'wss://s:4003', true, now() - interval '2 hours')
  on conflict (peer_id) do nothing;
insert into public.api_keys (id, user_id, prefix, key_hash) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'b2b_abcd', 'hash-a'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'b2b_efgh', 'hash-b')
  on conflict do nothing;
insert into public.usage_events (user_id, api_key_id, source, prompt_tokens, completion_tokens) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'api', 10, 5);

do $$ begin
  assert not exists (select 1 from public.active_nodes where peer_id = 'spoofed'), 'unsigned legacy node rows must be purged';
  assert not exists (select 1 from public.messages where user_id is null), 'anonymous legacy messages must be purged';
  assert to_regclass('public.node_logs') is null, 'node_logs should be dropped';
  assert public.api_key_usage_this_month('aaaaaaaa-0000-0000-0000-000000000001') = 15, 'usage function';
end $$;

-- ---- anon
set role anon;
do $$ begin
  assert (select count(*) from public.active_nodes) = 1, 'anon sees only verified, fresh nodes';
  begin
    perform 1 from public.api_keys;
    raise exception 'anon must not read api_keys';
  exception when insufficient_privilege then null;
  end;
end $$;
do $$ begin
  begin
    insert into public.active_nodes (peer_id, pubkey, addr) values ('attacker', 'pk', 'ws://evil:1');
    raise exception 'anon insert into active_nodes must fail';
  exception when insufficient_privilege then null;
  end;
  update public.active_nodes set addr = 'ws://evil:1' where peer_id = 'peer-good';
  assert not found, 'anon update must affect no rows';
  assert (select total_users from public.system_stats) = 2, 'stats readable; profiles are created by the auth trigger';
  assert (select total_tokens from public.system_stats) = 15, 'stats aggregate usage';
  assert (select count(*) from public.profiles) = 0, 'anon cannot list profiles';
end $$;
reset role;

-- ---- authenticated user A
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false) \gset ignored_
do $$
declare conv uuid;
begin
  assert (select count(*) from public.api_keys) = 1, 'user sees only own keys';
  begin
    perform key_hash from public.api_keys;
    raise exception 'key_hash must not be readable';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.api_keys (user_id, prefix, key_hash) values (auth.uid(), 'x', 'y');
    raise exception 'users must not mint keys directly';
  exception when insufficient_privilege or check_violation then null;
    when others then if sqlstate <> '42501' then raise; end if;
  end;
  assert (select count(*) from public.usage_events) = 1, 'own usage visible';
  insert into public.conversations (user_id, title) values (auth.uid(), 'mine') returning id into conv;
  insert into public.messages (user_id, conversation_id, role, content) values (auth.uid(), conv, 'user', 'hi');
  begin
    insert into public.messages (user_id, role, content) values ('22222222-2222-2222-2222-222222222222', 'user', 'forged');
    raise exception 'writing as another user must fail';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.active_nodes set verified = true;
    assert not found, 'authenticated cannot update nodes';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ---- authenticated user B cannot see A's data
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false) \gset ignored_
do $$ begin
  assert (select count(*) from public.conversations) = 0, 'B cannot see A conversations';
  assert (select count(*) from public.messages) = 0, 'B cannot see A messages';
  assert (select count(*) from public.usage_events) = 0, 'B cannot see A usage';
  assert (select count(*) from public.api_keys) = 1, 'B sees only own key';
  begin
    insert into public.messages (user_id, conversation_id, role, content)
      select auth.uid(), id, 'user', 'x' from public.conversations limit 1;
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
select 'RLS assertions passed' as result;
