-- Central de Chamados — segurança: este sistema NÃO tem portas públicas; privilégios, search_path, RLS ligada, escrita só por RPC, MFA, isolamento A/B entre empresas.

\set as_oa 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000f0","aal":"aal2","email":"oa@t.invalid"}'', true); set local role authenticated;'
\set as_oa1 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000f0","aal":"aal1","email":"oa@t.invalid"}'', true); set local role authenticated;'
\set as_ob 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000f1","aal":"aal2","email":"ob@t.invalid"}'', true); set local role authenticated;'
\set as_ra 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000f2","aal":"aal1","email":"ra@t.invalid"}'', true); set local role authenticated;'
\set as_rb 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000f3","aal":"aal1","email":"rb@t.invalid"}'', true); set local role authenticated;'
\set as_anon 'select set_config(''request.jwt.claims'', '''', true); set local role anon;'

begin;

create function test.errmsg(q text) returns text language plpgsql as $$ begin execute q; return null; exception when others then return sqlerrm; end $$;
create function test.has(msg text, pat text, label text) returns void language plpgsql as $$ begin if msg is null or msg not like pat then raise exception 'FALHOU: % — esperado %, veio %', label, pat, coalesce(msg, '(sem erro)'); end if; end $$;
create function test.t(k text) returns uuid language sql as $$ select current_setting('t.' || k)::uuid $$;
grant execute on all functions in schema test to anon, authenticated;

insert into auth.users (id, email) values ('ffffffff-0000-4000-8000-0000000000f0', 'oa@t.invalid'), ('ffffffff-0000-4000-8000-0000000000f1', 'ob@t.invalid'),
  ('ffffffff-0000-4000-8000-0000000000f2', 'ra@t.invalid'), ('ffffffff-0000-4000-8000-0000000000f3', 'rb@t.invalid');

-- ===================================================================== (1) privilégios e superfície
do $$
declare f record; n integer := 0; tbl text; bad text;
begin
  -- nenhuma função tk_* é executável por anon (este sistema não tem porta pública)
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname in ('public', 'private') and p.proname like 'tk\_%' loop
    n := n + 1;
    assert not has_function_privilege('anon', f.sig, 'execute'), 'anon NÃO pode executar ' || f.sig::text;
  end loop;
  assert n > 40, 'funções tk_* encontradas: ' || n;
  -- toda função tk_* SECURITY DEFINER tem search_path fixo
  select string_agg(p.oid::regprocedure::text, ', ') into bad from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname in ('public', 'private') and p.proname like 'tk\_%' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  assert bad is null, 'SECURITY DEFINER sem search_path fixo: ' || coalesce(bad, '');
  -- funções internas (private.tk_*) só para o allowlist de RLS
  select string_agg(p.oid::regprocedure::text, ', ') into bad from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'private' and p.proname like 'tk\_%' and has_function_privilege('authenticated', p.oid, 'execute')
      and p.proname not in ('tk_role', 'tk_agent_active', 'tk_profile', 'tk_is_owner', 'tk_is_manager', 'tk_is_staff', 'tk_in_team', 'tk_ticket_visible', 'tk_ticket_access', 'tk_message_visible', 'tk_attachment_visible', 'tk_guard');
  assert bad is null, 'função interna exposta ao usuário autenticado: ' || coalesce(bad, '');
  -- tabelas: RLS ligada, nenhum privilégio de escrita para anon/authenticated, nenhum acesso para anon
  for tbl in select unnest(array['ticket_settings', 'teams', 'team_members', 'agent_status', 'ticket_categories', 'business_calendar_versions', 'sla_policy_versions', 'ticket_counters', 'tickets',
    'ticket_messages', 'ticket_attachments', 'ticket_events', 'ticket_service_cycles', 'ticket_sla_pauses', 'canned_responses', 'notifications', 'mutation_requests', 'ticket_rate_limits']) loop
    assert (select relrowsecurity from pg_class where oid = ('public.' || tbl)::regclass), 'RLS ligada em ' || tbl;
    assert not has_table_privilege('anon', 'public.' || tbl, 'select, insert, update, delete'), 'anon sem acesso a ' || tbl;
    assert not has_table_privilege('authenticated', 'public.' || tbl, 'insert') and not has_table_privilege('authenticated', 'public.' || tbl, 'update') and not has_table_privilege('authenticated', 'public.' || tbl, 'delete'),
      'authenticated sem escrita direta em ' || tbl;
  end loop;
  assert not has_table_privilege('authenticated', 'public.mutation_requests', 'select') and not has_table_privilege('authenticated', 'public.ticket_counters', 'select') and not has_table_privilege('authenticated', 'public.ticket_rate_limits', 'select'),
    'controle interno (idempotência, contador, limite) ilegível pela API';
  raise notice 'PASS: superfície mínima, search_path fixo e RLS ligada (1)';
end $$;

-- ===================================================================== (2) duas empresas A e B
:as_oa
do $$
declare a uuid;
begin
  a := public.create_organization('Empresa A', 'empresa-a');
  perform set_config('t.a', a::text, true);
  insert into public.organization_members (organization_id, user_id, role) values (a, 'ffffffff-0000-4000-8000-0000000000f2', 'viewer');
  perform set_config('t.ta', public.tk_save_team(a, null, 'Time A', true)::text, true);
  perform set_config('t.ca', public.tk_save_category(a, null, 'Cat A', test.t('ta'), true)::text, true);
  perform set_config('t.canA', public.tk_save_canned(a, null, 'Saudação', 'Olá, tudo bem?', true)::text, true);
end $$;
reset role;
:as_ob
do $$
declare b uuid;
begin
  b := public.create_organization('Empresa B', 'empresa-b');
  perform set_config('t.b', b::text, true);
  insert into public.organization_members (organization_id, user_id, role) values (b, 'ffffffff-0000-4000-8000-0000000000f3', 'viewer');
  perform set_config('t.tb', public.tk_save_team(b, null, 'Time B', true)::text, true);
  perform set_config('t.cb', public.tk_save_category(b, null, 'Cat B', test.t('tb'), true)::text, true);
end $$;
reset role;
:as_ra
do $$
declare a uuid := test.t('a'); k uuid := gen_random_uuid();
begin
  perform public.tk_open_ticket(a, k, gen_random_uuid(), 'Problema da empresa A', test.t('ca'), 'conteúdo confidencial de A', null, null, null, null, null);
  perform set_config('t.kA', k::text, true);
end $$;
reset role;
:as_rb
do $$
declare b uuid := test.t('b'); k uuid := gen_random_uuid();
begin
  perform public.tk_open_ticket(b, k, gen_random_uuid(), 'Problema da empresa B', test.t('cb'), 'conteúdo confidencial de B', null, null, null, null, null);
  perform set_config('t.kB', k::text, true);
  assert (select count(*) from public.tickets) = 1 and (select count(*) from public.ticket_messages) = 1, 'solicitante de B só vê o próprio';
  perform test.has(test.errmsg(format($q$select public.tk_ticket_detail(%L, %L)$q$, test.t('a'), test.t('kA'))), '%sem permissão%', 'sem acesso à empresa A');
  perform test.has(test.errmsg(format($q$select public.tk_ticket_detail(%L, %L)$q$, b, test.t('kA'))), '%não encontrado%', 'chamado de A com a empresa B na chamada');
  perform test.has(test.errmsg(format($q$select public.tk_open_ticket(%L, gen_random_uuid(), gen_random_uuid(), 'Cruzado', %L, 'x', null, null, null, null, null)$q$, b, test.t('ca'))), '%categoria inválida%', 'categoria de A na empresa B');
  perform test.has(test.errmsg(format($q$select public.tk_post_message(%L, %L, gen_random_uuid(), 'public', 'invasão', null, null, null)$q$, b, test.t('kA'))), '%não encontrado%', 'resposta em chamado de A');
  perform test.has(test.errmsg(format($q$select public.tk_queue(%L, '{}', 1, 10)$q$, test.t('a'))), '%sem permissão%', 'fila de A');
  raise notice 'PASS: isolamento A/B no solicitante (2)';
end $$;
reset role;
:as_ob
do $$
declare b uuid := test.t('b');
begin
  assert (select count(*) from public.tickets) = 1 and (select count(*) from public.teams) = 1 and (select count(*) from public.canned_responses) = 0, 'proprietário de B só vê B';
  perform test.has(test.errmsg(format($q$select public.tk_save_canned(%L, %L, 'Sequestrada', 'x', true)$q$, b, test.t('canA'))), '%não encontrada%', 'resposta pronta de A não é editável por B');
  perform test.has(test.errmsg(format($q$select public.tk_save_team(%L, %L, 'Renomeada', true)$q$, b, test.t('ta'))), '%não encontrada%', 'equipe de A não é editável por B');
  perform test.has(test.errmsg(format($q$select public.tk_set_team_members(%L, %L, array[]::uuid[])$q$, b, test.t('ta'))), '%não encontrada%', 'membros da equipe de A');
  perform test.has(test.errmsg(format($q$select public.tk_claim(%L, %L)$q$, b, test.t('kA'))), '%não encontrado%', 'assumir chamado de A');
  perform test.has(test.errmsg(format($q$select public.tk_set_priority(%L, %L, 'urgent', null)$q$, b, test.t('kA'))), '%não encontrado%', 'prioridade de chamado de A');
  perform test.has(test.errmsg(format($q$select public.tk_move_team(%L, %L, %L, null)$q$, b, test.t('kB'), test.t('ta'))), '%equipe inválida%', 'mover chamado de B para equipe de A');
  perform test.has(test.errmsg(format($q$select public.tk_set_category(%L, %L, %L, null)$q$, b, test.t('kB'), test.t('ca'))), '%categoria inválida%', 'categoria de A num chamado de B');
  assert (public.tk_dashboard(b, current_date - 1, current_date, null) ->> 'created_tickets')::int = 1, 'painel de B conta só B';
  assert jsonb_array_length(public.tk_export_rows(b, '{}')) = 1, 'exportação de B só tem B';
  raise notice 'PASS: isolamento A/B na equipe (2)';
end $$;
reset role;

-- ===================================================================== (3) escrita direta e anon
:as_ra
do $$
begin
  perform test.has(test.errmsg(format($q$insert into public.tickets (organization_id, ticket_number, requester_user_id, subject, created_by) values (%L, 500, 'ffffffff-0000-4000-8000-0000000000f2', 'direto', 'ffffffff-0000-4000-8000-0000000000f2')$q$, test.t('a'))), '%permission denied%', 'insert direto em tickets');
  perform test.has(test.errmsg(format($q$update public.ticket_messages set body = 'x'$q$)), '%permission denied%', 'update direto em mensagens');
  perform test.has(test.errmsg($q$delete from public.tickets$q$), '%permission denied%', 'delete direto em tickets');
  perform test.has(test.errmsg(format($q$insert into public.notifications (organization_id, recipient_user_id, ticket_id, event_type) values (%L, 'ffffffff-0000-4000-8000-0000000000f2', %L, 'assigned')$q$, test.t('a'), test.t('kA'))), '%permission denied%', 'insert direto em notificações');
  perform test.has(test.errmsg($q$select * from public.mutation_requests$q$), '%permission denied%', 'idempotência ilegível');
  raise notice 'PASS: sem escrita direta pela API (3)';
end $$;
reset role;
:as_anon
do $$
begin
  perform test.has(test.errmsg($q$select * from public.tickets$q$), '%permission denied%', 'anon sem tabela');
  perform test.has(test.errmsg(format($q$select public.tk_queue(%L, '{}', 1, 10)$q$, test.t('a'))), '%permission denied%', 'anon sem função pública');
  perform test.has(test.errmsg(format($q$select public.tk_open_ticket(%L, gen_random_uuid(), gen_random_uuid(), 'anon', null, 'x', null, null, null, null, null)$q$, test.t('a'))), '%permission denied%', 'anon não abre chamado');
  raise notice 'PASS: anon nada acessa (3)';
end $$;
reset role;

-- ===================================================================== (4) MFA no banco para o proprietário
:as_oa1
do $$
begin
  perform test.has(test.errmsg(format($q$select public.tk_save_team(%L, null, 'Sem MFA', true)$q$, test.t('a'))), '%duas etapas%', 'proprietário em aal1 não escreve');
  perform test.has(test.errmsg(format($q$select public.tk_publish_sla(%L, 'America/Sao_Paulo', '{}', '{}')$q$, test.t('a'))), '%duas etapas%', 'proprietário em aal1 não publica SLA');
  raise notice 'PASS: MFA exigido no banco (4)';
end $$;
reset role;

rollback;
