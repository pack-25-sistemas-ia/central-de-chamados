-- Central de Chamados — domínio no banco: perfis, abertura (idempotente), isolamento solicitante × equipe, assumir, notas internas, pausa de SLA, resolução, confirmação, reabertura,
-- responsável válido, versão otimista, mover de equipe e desativação de atendente.

\set as_o 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000a0","aal":"aal2","email":"o@t.invalid"}'', true); set local role authenticated;'
\set as_m 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000a1","aal":"aal1","email":"m@t.invalid"}'', true); set local role authenticated;'
\set as_a1 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000a2","aal":"aal1","email":"a1@t.invalid"}'', true); set local role authenticated;'
\set as_a2 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000a3","aal":"aal1","email":"a2@t.invalid"}'', true); set local role authenticated;'
\set as_a3 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000a4","aal":"aal1","email":"a3@t.invalid"}'', true); set local role authenticated;'
\set as_r1 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000b1","aal":"aal1","email":"r1@t.invalid"}'', true); set local role authenticated;'
\set as_r2 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000b2","aal":"aal1","email":"r2@t.invalid"}'', true); set local role authenticated;'
\set as_x 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000c0","aal":"aal2","email":"x@t.invalid"}'', true); set local role authenticated;'

begin;

create function test.errmsg(q text) returns text language plpgsql as $$ begin execute q; return null; exception when others then return sqlerrm; end $$;
create function test.has(msg text, pat text, label text) returns void language plpgsql as $$ begin if msg is null or msg not like pat then raise exception 'FALHOU: % — esperado %, veio %', label, pat, coalesce(msg, '(sem erro)'); end if; end $$;
create function test.t(k text) returns uuid language sql as $$ select current_setting('t.' || k)::uuid $$;
create function test.sql(q text) returns void language plpgsql security definer set search_path = '' as $$ begin execute q; end $$;
create function test.cnt(q text) returns bigint language plpgsql security definer set search_path = '' as $$ declare n bigint; begin execute q into n; return n; end $$;
create function test.txt(q text) returns text language plpgsql security definer set search_path = '' as $$ declare s text; begin execute q into s; return s; end $$;
grant execute on all functions in schema test to anon, authenticated;

insert into auth.users (id, email) values
  ('ffffffff-0000-4000-8000-0000000000a0', 'o@t.invalid'), ('ffffffff-0000-4000-8000-0000000000a1', 'm@t.invalid'), ('ffffffff-0000-4000-8000-0000000000a2', 'a1@t.invalid'),
  ('ffffffff-0000-4000-8000-0000000000a3', 'a2@t.invalid'), ('ffffffff-0000-4000-8000-0000000000a4', 'a3@t.invalid'), ('ffffffff-0000-4000-8000-0000000000b1', 'r1@t.invalid'),
  ('ffffffff-0000-4000-8000-0000000000b2', 'r2@t.invalid'), ('ffffffff-0000-4000-8000-0000000000c0', 'x@t.invalid');

-- ===================================================================== (1) empresa, pessoas, equipes e categorias
:as_o
do $$
declare org uuid; t1 uuid; t2 uuid;
begin
  org := public.create_organization('Suporte Teste', 'suporte-teste');
  perform set_config('t.org', org::text, true);
  insert into public.organization_members (organization_id, user_id, role) values
    (org, 'ffffffff-0000-4000-8000-0000000000a1', 'manager'), (org, 'ffffffff-0000-4000-8000-0000000000a2', 'member'), (org, 'ffffffff-0000-4000-8000-0000000000a3', 'member'),
    (org, 'ffffffff-0000-4000-8000-0000000000a4', 'member'), (org, 'ffffffff-0000-4000-8000-0000000000b1', 'viewer'), (org, 'ffffffff-0000-4000-8000-0000000000b2', 'viewer');
  assert (select count(*) from public.ticket_settings where organization_id = org) = 1 and (select count(*) from public.sla_policy_versions where organization_id = org) = 1, 'configurações e SLA demonstrativo criados com a empresa';
  assert (select targets_by_priority -> 'normal' ->> 'first_response' from public.sla_policy_versions where organization_id = org) = '240', 'meta inicial demonstrativa';
  assert private.tk_profile(org) = 'owner', 'dono é proprietário';
  t1 := public.tk_save_team(org, null, 'Suporte Nível 1', true); t2 := public.tk_save_team(org, null, 'Infraestrutura', true);
  perform set_config('t.t1', t1::text, true); perform set_config('t.t2', t2::text, true);
  perform public.tk_set_team_members(org, t1, array['ffffffff-0000-4000-8000-0000000000a1', 'ffffffff-0000-4000-8000-0000000000a2', 'ffffffff-0000-4000-8000-0000000000a3']::uuid[]);
  perform public.tk_set_team_members(org, t2, array['ffffffff-0000-4000-8000-0000000000a4']::uuid[]);
  perform set_config('t.c1', public.tk_save_category(org, null, 'Acesso e senhas', t1, true)::text, true);
  perform set_config('t.c2', public.tk_save_category(org, null, 'Servidores', t2, true)::text, true);
  perform set_config('t.c3', public.tk_save_category(org, null, 'Sem equipe padrão', null, true)::text, true);
  perform test.has(test.errmsg(format($q$select public.tk_set_team_members(%L, %L, array['ffffffff-0000-4000-8000-0000000000b1']::uuid[])$q$, org, t1)), '%só atendentes%', 'solicitante não entra em equipe');
  raise notice 'PASS: empresa, equipes e categorias (1)';
end $$;
reset role;

-- ===================================================================== (2) permissões de cadastro
:as_m
do $$
declare org uuid := test.t('org');
begin
  assert private.tk_profile(org) = 'manager', 'gestor';
  perform public.tk_save_category(org, null, 'Cobrança', test.t('t1'), true);
  perform test.has(test.errmsg(format($q$select public.tk_save_settings(%L, '{"reopen_window_hours":5}')$q$, org)), '%sem permissão%', 'gestor não altera políticas');
  perform test.has(test.errmsg(format($q$select public.tk_publish_sla(%L, 'America/Sao_Paulo', '{}', '{}')$q$, org)), '%sem permissão%', 'gestor não publica SLA');
  raise notice 'PASS: gestor gerencia equipes/categorias, não políticas (2)';
end $$;
reset role;
:as_a1
do $$
declare org uuid := test.t('org');
begin
  assert private.tk_profile(org) = 'agent', 'atendente';
  perform test.has(test.errmsg(format($q$select public.tk_save_team(%L, null, 'Nova', true)$q$, org)), '%sem permissão%', 'atendente não cria equipe');
  perform test.has(test.errmsg(format($q$select public.tk_save_canned(%L, null, 'x1', 'texto', true)$q$, org)), '%sem permissão%', 'atendente não cria resposta pronta');
  raise notice 'PASS: atendente não administra (2)';
end $$;
reset role;

-- ===================================================================== (3) solicitante abre chamado (idempotente, valores forçados)
:as_r1
do $$
declare org uuid := test.t('org'); kid uuid := gen_random_uuid(); idem uuid := gen_random_uuid(); r jsonb; r2 jsonb; t public.tickets;
begin
  assert private.tk_profile(org) = 'requester', 'viewer é solicitante';
  r := public.tk_open_ticket(org, kid, idem, 'Não consigo entrar no sistema', test.t('c1'), 'Aparece erro de senha inválida.', 'urgent', 'ffffffff-0000-4000-8000-0000000000b2', test.t('t2'), 'ffffffff-0000-4000-8000-0000000000a4', null);
  perform set_config('t.k1', kid::text, true);
  assert (r ->> 'ticket_number')::int = 1 and (r ->> 'replayed')::boolean = false, 'primeiro número é 1';
  select * into t from public.tickets where organization_id = org and ticket_number = 1;
  assert t.status = 'open' and t.priority = 'normal', 'solicitante: status open e prioridade normal (urgent ignorada)';
  assert t.requester_user_id = 'ffffffff-0000-4000-8000-0000000000b1', 'solicitante vem da sessão (p_requester ignorado)';
  assert t.team_id = test.t('t1') and t.assigned_user_id is null, 'equipe pela categoria; sem responsável (p_team/p_assignee ignorados)';
  r2 := public.tk_open_ticket(org, kid, idem, 'Não consigo entrar no sistema', test.t('c1'), 'Aparece erro de senha inválida.', 'urgent', 'ffffffff-0000-4000-8000-0000000000b2', test.t('t2'), 'ffffffff-0000-4000-8000-0000000000a4', null);
  assert (r2 ->> 'replayed')::boolean and r2 ->> 'id' = r ->> 'id' and (r2 ->> 'ticket_number')::int = 1, 'duplo envio devolve o MESMO chamado';
  assert test.cnt('select count(*) from public.tickets') = 1, 'duplo envio não cria segundo chamado';
  perform test.has(test.errmsg(format($q$select public.tk_open_ticket(%L, %L, %L, 'Outro assunto', null, 'texto', null, null, null, null, null)$q$, org, kid, idem)), '%outros dados%', 'mesma chave com outro conteúdo');
  perform test.has(test.errmsg(format($q$select public.tk_open_ticket(%L, %L, gen_random_uuid(), 'Assunto', null, 'texto', null, null, null, null, null)$q$, org, kid)), '%identificador%', 'mesmo id, outra chave');
  assert (select count(*) from public.ticket_messages where ticket_id = kid and visibility = 'public' and author_kind = 'requester') = 1, 'descrição = primeira mensagem pública';
  assert (select count(*) from public.ticket_events) = 0 and (select count(*) from public.ticket_service_cycles) = 0, 'solicitante não lê eventos nem ciclos (SLA)';
  perform test.has(test.errmsg(format($q$select public.tk_open_ticket(%L, gen_random_uuid(), gen_random_uuid(), 'x', null, 'texto', null, null, null, null, null)$q$, org)), '%Assunto%', 'assunto curto');
  perform test.has(test.errmsg(format($q$select public.tk_open_ticket(%L, gen_random_uuid(), gen_random_uuid(), 'Assunto válido', %L, 'texto', null, null, null, null, null)$q$, org, gen_random_uuid())), '%categoria inválida%', 'categoria inexistente');
  raise notice 'PASS: abertura pelo solicitante, valores forçados e idempotência (3)';
end $$;
reset role;
do $$
declare t public.tickets; c public.ticket_service_cycles;
begin
  select * into t from public.tickets where ticket_number = 1;
  select * into c from public.ticket_service_cycles where ticket_id = t.id;
  assert c.cycle_number = 1 and c.first_response_target_minutes = 240 and c.resolution_target_minutes = 1440 and c.priority_snapshot = 'normal' and c.first_response_at is null and c.closed_at is null, 'ciclo 1 com metas da política vigente';
  assert (select count(*) from public.ticket_events where ticket_id = t.id and event_type = 'created') = 1, 'evento de criação';
  assert (select count(*) from public.notifications where ticket_id = t.id) = 3, 'equipe da categoria notificada (3 atendentes/gestor da equipe)';
  assert (select ticket_number from public.tickets where requester_user_id = 'ffffffff-0000-4000-8000-0000000000b1') = 1, 'número legível';
  raise notice 'PASS: ciclo, eventos e notificações da abertura (3)';
end $$;

-- ===================================================================== (4) isolamento: outro solicitante e atendente de outra equipe
:as_r2
do $$
declare org uuid := test.t('org');
begin
  assert (select count(*) from public.tickets) = 0 and (select count(*) from public.ticket_messages) = 0, 'solicitante 2 não vê chamado do solicitante 1';
  perform test.has(test.errmsg(format($q$select public.tk_ticket_detail(%L, %L)$q$, org, test.t('k1'))), '%não encontrado%', 'detalhe alheio negado');
  perform test.has(test.errmsg(format($q$select public.tk_post_message(%L, %L, gen_random_uuid(), 'public', 'intruso', null, null, null)$q$, org, test.t('k1'))), '%não encontrado%', 'resposta em chamado alheio negada');
  assert public.tk_queue(org, '{}', 1, 25) ->> 'total' = '0', 'fila do solicitante 2 vazia';
  raise notice 'PASS: solicitante só acessa os próprios chamados (4)';
end $$;
reset role;
:as_a3
do $$
declare org uuid := test.t('org');
begin
  assert (select count(*) from public.tickets) = 0, 'atendente da OUTRA equipe não vê o chamado';
  perform test.has(test.errmsg(format($q$select public.tk_claim(%L, %L)$q$, org, test.t('k1'))), '%não encontrado%', 'não assume chamado de outra equipe');
  perform test.has(test.errmsg(format($q$select public.tk_post_message(%L, %L, gen_random_uuid(), 'internal', 'nota', null, null, null)$q$, org, test.t('k1'))), '%não encontrado%', 'não escreve em chamado de outra equipe');
  raise notice 'PASS: atendente não acessa equipe indevida (4)';
end $$;
reset role;

-- ===================================================================== (5) assumir (um vence), nota interna invisível ao solicitante, primeira resposta só pública
:as_a1
do $$
declare org uuid := test.t('org'); t public.tickets;
begin
  assert (select count(*) from public.tickets) = 1, 'atendente da equipe vê o chamado';
  perform public.tk_claim(org, test.t('k1'));
  select * into t from public.tickets where id = test.t('k1');
  assert t.assigned_user_id = 'ffffffff-0000-4000-8000-0000000000a2' and t.status = 'in_progress', 'assumir atribui e leva a em atendimento';
  perform public.tk_post_message(org, t.id, gen_random_uuid(), 'internal', 'Verificar log do AD antes de responder.', null, null, null);
  assert (select first_response_at from public.ticket_service_cycles where ticket_id = t.id) is null, 'nota interna NÃO é primeira resposta';
  raise notice 'PASS: assumir e nota interna (5)';
end $$;
reset role;
:as_a2
do $$
begin
  perform test.has(test.errmsg(format($q$select public.tk_claim(%L, %L)$q$, test.t('org'), test.t('k1'))), '%assumido por outra pessoa%', 'segundo a assumir perde');
  raise notice 'PASS: só quem assumiu primeiro vence (5)';
end $$;
reset role;
:as_r1
do $$
declare org uuid := test.t('org'); d jsonb;
begin
  assert (select count(*) from public.ticket_messages where ticket_id = test.t('k1')) = 1, 'RLS: solicitante lê só a mensagem pública';
  assert (select count(*) from public.ticket_attachments) = 0, 'sem anexos';
  d := public.tk_ticket_detail(org, test.t('k1'));
  assert jsonb_array_length(d -> 'messages') = 1 and d::text not like '%log do AD%', 'DTO do solicitante não contém a nota interna';
  assert d -> 'events' = '[]'::jsonb and d -> 'cycles' = '[]'::jsonb and d -> 'calendar' = 'null'::jsonb, 'DTO do solicitante não contém eventos, SLA nem calendário';
  assert (d -> 'ticket' ->> 'team') is null and (d -> 'ticket' ->> 'assignee') is null, 'solicitante não vê equipe nem responsável';
  assert public.tk_queue(org, '{}', 1, 25) -> 'rows' -> 0 ->> 'sla' is null, 'fila do solicitante sem SLA';
  perform test.has(test.errmsg(format($q$select public.tk_post_message(%L, %L, gen_random_uuid(), 'internal', 'tentando nota', null, null, null)$q$, org, test.t('k1'))), '%sem permissão%', 'solicitante não cria nota interna');
  perform test.has(test.errmsg(format($q$select public.tk_assign(%L, %L, null, null)$q$, org, test.t('k1'))), '%sem permissão%', 'solicitante não atribui');
  perform test.has(test.errmsg(format($q$select public.tk_set_priority(%L, %L, 'urgent', null)$q$, org, test.t('k1'))), '%sem permissão%', 'solicitante não muda prioridade');
  perform test.has(test.errmsg(format($q$select public.tk_set_status(%L, %L, 'closed', null)$q$, org, test.t('k1'))), '%sem permissão%', 'solicitante não muda status');
  perform test.has(test.errmsg(format($q$select public.tk_publish_sla(%L, 'America/Sao_Paulo', '{}', '{}')$q$, org)), '%sem permissão%', 'solicitante não altera SLA');
  perform test.has(test.errmsg(format($q$update public.tickets set status = 'resolved' where id = %L$q$, test.t('k1'))), '%permission denied%', 'sem escrita direta em tickets');
  raise notice 'PASS: nota interna e SLA invisíveis ao solicitante (5)';
end $$;
reset role;

-- ===================================================================== (6) pedir informação pausa o SLA; resposta do solicitante retoma
:as_a1
do $$
declare org uuid := test.t('org'); r jsonb;
begin
  perform test.has(test.errmsg(format($q$select public.tk_post_message(%L, %L, gen_random_uuid(), 'internal', 'x', null, 'waiting_requester', null)$q$, org, test.t('k1'))), '%nota interna não altera%', 'nota interna não pausa');
  r := public.tk_post_message(org, test.t('k1'), gen_random_uuid(), 'public', 'Pode informar o horário em que o erro apareceu?', null, 'waiting_requester', 2);
  assert r ->> 'status' = 'waiting_requester', 'aguardando solicitante';
  raise notice 'PASS: pedir informação (6)';
end $$;
reset role;
do $$
declare c public.ticket_service_cycles;
begin
  select * into c from public.ticket_service_cycles where ticket_id = test.t('k1');
  assert c.first_response_at is not null, 'resposta pública da equipe cumpre a primeira resposta';
  assert (select count(*) from public.ticket_sla_pauses where service_cycle_id = c.id and ended_at is null) = 1, 'pausa aberta';
  assert private.tk_metric(c.id, 'resolution', now()) ->> 'state' = 'paused', 'SLA de resolução pausado';
  raise notice 'PASS: pausa aberta na mesma transação (6)';
end $$;
:as_r1
do $$
declare org uuid := test.t('org'); r jsonb;
begin
  r := public.tk_post_message(org, test.t('k1'), gen_random_uuid(), 'public', 'Foi por volta das 9h, depois de trocar a senha.', null, null, null);
  assert r ->> 'status' = 'in_progress', 'resposta do solicitante volta para em atendimento';
  raise notice 'PASS: resposta do solicitante retoma (6)';
end $$;
reset role;
do $$
declare c public.ticket_service_cycles;
begin
  select * into c from public.ticket_service_cycles where ticket_id = test.t('k1');
  assert (select count(*) from public.ticket_sla_pauses where service_cycle_id = c.id and ended_at is null) = 0 and (select count(*) from public.ticket_sla_pauses where service_cycle_id = c.id) = 1, 'pausa encerrada, histórico preservado';
  assert (select count(*) from public.ticket_events where ticket_id = test.t('k1') and event_type in ('sla_paused', 'sla_resumed')) = 2, 'eventos de pausa e retomada';
  raise notice 'PASS: pausa encerrada ao retomar (6)';
end $$;

-- ===================================================================== (7) versão otimista, equipe e responsável válidos
:as_m
do $$
declare org uuid := test.t('org'); v integer;
begin
  select version into v from public.tickets where id = test.t('k1');
  perform test.has(test.errmsg(format($q$select public.tk_set_priority(%L, %L, 'high', %s)$q$, org, test.t('k1'), v - 1)), '%alterado por outra pessoa%', 'versão antiga é rejeitada');
  perform public.tk_set_priority(org, test.t('k1'), 'high', v);
  perform test.has(test.errmsg(format($q$select public.tk_set_priority(%L, %L, 'low', %s)$q$, org, test.t('k1'), v)), '%alterado por outra pessoa%', 'mesma versão depois de alterar é rejeitada');
  assert (select priority from public.tickets where id = test.t('k1')) = 'high', 'prioridade alterada';
  assert (select priority_snapshot from public.ticket_service_cycles where ticket_id = test.t('k1')) = 'normal' and (select first_response_target_minutes from public.ticket_service_cycles where ticket_id = test.t('k1')) = 240, 'meta do ciclo NÃO muda com a prioridade';
  perform test.has(test.errmsg(format($q$select public.tk_assign(%L, %L, 'ffffffff-0000-4000-8000-0000000000a4', null)$q$, org, test.t('k1'))), '%responsável inválido%', 'responsável de outra equipe é negado');
  perform test.has(test.errmsg(format($q$select public.tk_assign(%L, %L, 'ffffffff-0000-4000-8000-0000000000b1', null)$q$, org, test.t('k1'))), '%responsável inválido%', 'solicitante não pode ser responsável');
  perform public.tk_assign(org, test.t('k1'), 'ffffffff-0000-4000-8000-0000000000a3', null);
  assert (select assigned_user_id from public.tickets where id = test.t('k1')) = 'ffffffff-0000-4000-8000-0000000000a3', 'atribuído ao atendente 2';
  assert test.cnt(format($q$select count(*) from public.notifications where ticket_id = %L and recipient_user_id = 'ffffffff-0000-4000-8000-0000000000a3' and event_type = 'assigned'$q$, test.t('k1'))) >= 1, 'responsável notificado';
  perform public.tk_move_team(org, test.t('k1'), test.t('t2'), null);
  assert (select assigned_user_id from public.tickets where id = test.t('k1')) is null and (select team_id from public.tickets where id = test.t('k1')) = test.t('t2'), 'trocar de equipe remove o responsável incompatível';
  assert (select count(*) from public.ticket_events where ticket_id = test.t('k1') and event_type = 'unassigned' and safe_metadata ->> 'reason' = 'team_change') = 1, 'remoção auditada';
  perform public.tk_move_team(org, test.t('k1'), test.t('t1'), null);
  perform public.tk_assign(org, test.t('k1'), 'ffffffff-0000-4000-8000-0000000000a2', null);
  raise notice 'PASS: versão, responsável válido e troca de equipe (7)';
end $$;
reset role;

-- ===================================================================== (8) resolver, confirmar, reabrir e preservar os ciclos
:as_a1
do $$
declare org uuid := test.t('org'); r jsonb;
begin
  perform test.has(test.errmsg(format($q$select public.tk_post_message(%L, %L, gen_random_uuid(), 'public', '   ', null, 'resolved', null)$q$, org, test.t('k1'))), '%Mensagem%', 'resolver exige mensagem');
  r := public.tk_post_message(org, test.t('k1'), gen_random_uuid(), 'public', 'Senha redefinida e acesso confirmado.', null, 'resolved', null);
  assert r ->> 'status' = 'resolved', 'resolvido';
  raise notice 'PASS: resolver com mensagem (8)';
end $$;
reset role;
do $$
declare c public.ticket_service_cycles;
begin
  select * into c from public.ticket_service_cycles where ticket_id = test.t('k1');
  assert c.resolved_at is not null and c.closed_at is null, 'resolução marcada; ciclo ainda ativo até confirmar';
  assert private.tk_metric(c.id, 'resolution', now()) ->> 'state' in ('met', 'breached'), 'SLA de resolução concluído';
  raise notice 'PASS: ciclo marcado como resolvido (8)';
end $$;
:as_r1
do $$
declare org uuid := test.t('org');
begin
  perform test.has(test.errmsg(format($q$select public.tk_post_message(%L, %L, gen_random_uuid(), 'public', 'obrigado', null, null, null)$q$, org, test.t('k1'))), '%encerrado%', 'resposta em resolvido orienta a reabrir');
  perform public.tk_confirm(org, test.t('k1'), null);
  assert (select status from public.tickets where id = test.t('k1')) = 'closed', 'solicitante confirmou: encerrado';
  perform test.has(test.errmsg(format($q$select public.tk_confirm(%L, %L, null)$q$, org, test.t('k1'))), '%resolvido%', 'não confirma duas vezes');
  perform test.has(test.errmsg(format($q$select public.tk_reopen(%L, %L, 'x', null)$q$, org, test.t('k1'))), '%Motivo%', 'reabertura exige motivo');
  assert public.tk_reopen(org, test.t('k1'), 'O erro voltou depois do almoço.', null) ->> 'cycle' = '2', 'reabertura cria o ciclo 2';
  raise notice 'PASS: confirmar e reabrir (8)';
end $$;
reset role;
do $$
declare t public.tickets;
begin
  select * into t from public.tickets where id = test.t('k1');
  assert t.status = 'in_progress' and t.assigned_user_id = 'ffffffff-0000-4000-8000-0000000000a2', 'reabre para em atendimento com responsável válido';
  assert (select count(*) from public.ticket_service_cycles where ticket_id = t.id) = 2, 'dois ciclos';
  assert (select resolved_at is not null and closed_at is not null and first_response_at is not null from public.ticket_service_cycles where ticket_id = t.id and cycle_number = 1), 'ciclo 1 preservado (resolução, encerramento e primeira resposta)';
  assert (select resolved_at is null and closed_at is null and first_response_at is null from public.ticket_service_cycles where ticket_id = t.id and cycle_number = 2), 'ciclo 2 novo, em branco';
  assert (select count(*) from public.ticket_sla_pauses p join public.ticket_service_cycles c on c.id = p.service_cycle_id where c.ticket_id = t.id and c.cycle_number = 1) = 1, 'pausas do ciclo 1 preservadas';
  assert (select count(*) from public.ticket_messages where ticket_id = t.id and body like 'Reabertura:%' and visibility = 'public') = 1, 'motivo registrado na conversa';
  raise notice 'PASS: reabertura preserva o ciclo anterior (8)';
end $$;
-- fora da janela: orienta abrir novo chamado (não reabre em silêncio)
:as_a1
do $$ begin perform public.tk_post_message(test.t('org'), test.t('k1'), gen_random_uuid(), 'public', 'Corrigido de novo.', null, 'resolved', null); end $$;
reset role;
do $$ begin
  alter table public.ticket_service_cycles disable trigger cycle_guard;
  update public.ticket_service_cycles set resolved_at = now() - interval '200 hours', first_response_at = least(first_response_at, now() - interval '200 hours'), started_at = now() - interval '201 hours' where ticket_id = test.t('k1') and cycle_number = 2;
  alter table public.ticket_service_cycles enable trigger cycle_guard;
end $$;
:as_r1
do $$
declare org uuid := test.t('org');
begin
  perform test.has(test.errmsg(format($q$select public.tk_reopen(%L, %L, 'Voltou a acontecer.', null)$q$, org, test.t('k1'))), '%prazo para reabrir%novo chamado%', 'fora da janela de 72 h');
  assert (select status from public.tickets where id = test.t('k1')) = 'resolved', 'não reabriu em silêncio';
  raise notice 'PASS: fora da janela orienta novo chamado (8)';
end $$;
reset role;

-- ===================================================================== (9) abertura administrativa: solicitante escolhido, não conta como resposta
:as_a1
do $$
declare org uuid := test.t('org'); kid uuid := gen_random_uuid(); r jsonb;
begin
  perform test.has(test.errmsg(format($q$select public.tk_open_ticket(%L, gen_random_uuid(), gen_random_uuid(), 'Pedido por telefone', null, 'texto', null, 'ffffffff-0000-4000-8000-0000000000a3', null, null, null)$q$, org)), '%solicitante cadastrado%', 'só solicitantes cadastrados');
  perform test.has(test.errmsg(format($q$select public.tk_open_ticket(%L, gen_random_uuid(), gen_random_uuid(), 'Pedido por telefone', %L, 'texto', 'high', 'ffffffff-0000-4000-8000-0000000000b2', null, 'ffffffff-0000-4000-8000-0000000000a3', null)$q$, org, test.t('c1'))), '%atribuir a si mesmos%', 'atendente não atribui a terceiros');
  r := public.tk_open_ticket(org, kid, gen_random_uuid(), 'Pedido por telefone', test.t('c1'), 'Cliente ligou pedindo acesso à pasta financeira.', 'high', 'ffffffff-0000-4000-8000-0000000000b2', null, 'ffffffff-0000-4000-8000-0000000000a2', null);
  perform set_config('t.k2', kid::text, true);
  assert (r ->> 'ticket_number')::int = 2, 'número sequencial';
  assert (select priority from public.tickets where id = kid) = 'high' and (select requester_user_id from public.tickets where id = kid) = 'ffffffff-0000-4000-8000-0000000000b2', 'prioridade e solicitante definidos pela equipe';
  raise notice 'PASS: abertura administrativa (9)';
end $$;
reset role;
do $$
begin
  assert (select first_response_at from public.ticket_service_cycles where ticket_id = test.t('k2')) is null, 'abertura administrativa NÃO conta como primeira resposta';
  assert (select (safe_metadata ->> 'on_behalf')::boolean from public.ticket_events where ticket_id = test.t('k2') and event_type = 'created'), 'evento registra abertura em nome do solicitante';
  raise notice 'PASS: abertura administrativa não é resposta (9)';
end $$;

-- ===================================================================== (10) desativar atendente: chamados abertos tratados explicitamente
:as_m
do $$
declare org uuid := test.t('org'); r jsonb;
begin
  perform test.has(test.errmsg(format($q$select public.tk_set_agent_active(%L, 'ffffffff-0000-4000-8000-0000000000a2', false, null, null)$q$, org)), '%o que fazer%', 'desativar exige decisão sobre os chamados');
  perform test.has(test.errmsg(format($q$select public.tk_set_agent_active(%L, 'ffffffff-0000-4000-8000-0000000000a1', false, 'unassign', null)$q$, org)), '%próprio acesso%', 'ninguém desativa o próprio acesso');
  perform test.has(test.errmsg(format($q$select public.tk_set_agent_active(%L, 'ffffffff-0000-4000-8000-0000000000a2', false, 'reassign', 'ffffffff-0000-4000-8000-0000000000a4')$q$, org)), '%não pertence à equipe%', 'reatribuir só a quem pertence à equipe');
  r := public.tk_set_agent_active(org, 'ffffffff-0000-4000-8000-0000000000a2', false, 'reassign', 'ffffffff-0000-4000-8000-0000000000a3');
  assert (r ->> 'tickets_changed')::int = 1, 'o chamado aberto do atendente foi reatribuído';
  assert (select assigned_user_id from public.tickets where id = test.t('k2')) = 'ffffffff-0000-4000-8000-0000000000a3', 'agora com o atendente 2';
  raise notice 'PASS: desativação com reatribuição (10)';
end $$;
reset role;
:as_a1
do $$
begin
  assert private.tk_profile(test.t('org')) is null, 'atendente desativado perde o acesso';
  assert (select count(*) from public.tickets) = 0, 'e não enxerga mais chamados';
  perform test.has(test.errmsg(format($q$select public.tk_claim(%L, %L)$q$, test.t('org'), test.t('k2'))), '%sem permissão%', 'desativado não opera');
  raise notice 'PASS: atendente desativado sem acesso (10)';
end $$;
reset role;
do $$
begin
  assert (select count(*) from public.ticket_messages where author_user_id = 'ffffffff-0000-4000-8000-0000000000a2') > 0, 'autoria histórica preservada';
  raise notice 'PASS: autoria preservada (10)';
end $$;

-- ===================================================================== (11) histórico imutável
do $$
begin
  perform test.has(test.errmsg($q$update public.ticket_messages set body = 'alterada'$q$), '%imutável%', 'mensagem não é editável');
  perform test.has(test.errmsg($q$delete from public.ticket_messages$q$), '%apagado%', 'mensagem não é apagável');
  perform test.has(test.errmsg($q$delete from public.ticket_events$q$), '%apagado%', 'evento não é apagável');
  perform test.has(test.errmsg($q$delete from public.tickets$q$), '%apagado%', 'chamado não é apagável');
  perform test.has(test.errmsg($q$update public.ticket_service_cycles set first_response_target_minutes = 1$q$), '%fixadas no início%', 'metas do ciclo não mudam');
  perform test.has(test.errmsg($q$update public.sla_policy_versions set targets_by_priority = '{}'$q$), '%imutável%', 'versão de política é imutável');
  perform test.has(test.errmsg($q$update public.tickets set status = 'closed' where status in ('open', 'in_progress')$q$), '%transição%', 'transição inválida barrada no banco');
  raise notice 'PASS: histórico imutável (11)';
end $$;

-- ===================================================================== (12) outra empresa: isolamento total
:as_x
do $$
declare org2 uuid;
begin
  org2 := public.create_organization('Outra Empresa', 'outra-empresa');
  perform set_config('t.org2', org2::text, true);
  assert (select count(*) from public.tickets) = 0 and (select count(*) from public.teams) = 0 and (select count(*) from public.ticket_messages) = 0, 'outra empresa não enxerga nada';
  perform test.has(test.errmsg(format($q$select public.tk_ticket_detail(%L, %L)$q$, org2, test.t('k1'))), '%não encontrado%', 'detalhe com org errada');
  perform test.has(test.errmsg(format($q$select public.tk_ticket_detail(%L, %L)$q$, test.t('org'), test.t('k1'))), '%sem permissão%', 'sem perfil na empresa');
  perform test.has(test.errmsg(format($q$select public.tk_save_category(%L, null, 'Invasora', %L, true)$q$, org2, test.t('t1'))), '%equipe padrão inválida%', 'equipe de outra empresa na categoria');
  perform test.has(test.errmsg(format($q$select public.tk_open_ticket(%L, gen_random_uuid(), gen_random_uuid(), 'Teste cruzado', %L, 'texto', null, null, null, null, null)$q$, org2, test.t('c1'))), '%categoria inválida%', 'categoria de outra empresa');
  assert (select ticket_number from public.tickets where false) is null, 'consulta vazia';
  raise notice 'PASS: isolamento entre empresas (12)';
end $$;
reset role;
do $$
begin
  perform test.has(test.errmsg(format($q$insert into public.tickets (organization_id, ticket_number, requester_user_id, subject, team_id, created_by) values (%L, 99, 'ffffffff-0000-4000-8000-0000000000b1', 'cruzado', %L, 'ffffffff-0000-4000-8000-0000000000b1')$q$, test.t('org2'), test.t('t1'))), '%violates foreign key%', 'FK composta nega equipe de outra empresa');
  perform test.has(test.errmsg(format($q$insert into public.ticket_messages (organization_id, ticket_id, author_user_id, author_kind, visibility, body) values (%L, %L, 'ffffffff-0000-4000-8000-0000000000b1', 'staff', 'public', 'x')$q$, test.t('org2'), test.t('k1'))), '%violates foreign key%', 'FK composta nega mensagem em chamado de outra empresa');
  raise notice 'PASS: associações entre empresas negadas pelo banco (12)';
end $$;

-- ===================================================================== (13) regras finas que as mutações exigiram (chamadas diretas, sem depender de proteções em camadas)
:as_r1
do $$
declare org uuid := test.t('org'); k3 uuid := gen_random_uuid(); k4 uuid := gen_random_uuid(); k5 uuid := gen_random_uuid(); k6 uuid := gen_random_uuid();
begin
  perform public.tk_open_ticket(org, k3, gen_random_uuid(), 'Chamado para resolver direto de aguardando', test.t('c1'), 'texto', null, null, null, null, null);
  perform public.tk_open_ticket(org, k4, gen_random_uuid(), 'Chamado em atendimento', test.t('c1'), 'texto', null, null, null, null, null);
  perform public.tk_open_ticket(org, k5, gen_random_uuid(), 'Chamado da equipe de infraestrutura', test.t('c2'), 'texto', null, null, null, null, null);
  perform public.tk_open_ticket(org, k6, gen_random_uuid(), 'Chamado para autoatribuição', test.t('c1'), 'texto', null, null, null, null, null);
  perform set_config('t.k3', k3::text, true); perform set_config('t.k4', k4::text, true); perform set_config('t.k5', k5::text, true); perform set_config('t.k6', k6::text, true);
end $$;
reset role;
:as_a2
do $$
declare org uuid := test.t('org');
begin
  perform public.tk_claim(org, test.t('k3'));
  perform public.tk_post_message(org, test.t('k3'), gen_random_uuid(), 'public', 'Precisamos de uma informação', null, 'waiting_requester', null);
  -- resolver DIRETO a partir de «aguardando solicitante»: a pausa é encerrada na mesma transação
  perform public.tk_post_message(org, test.t('k3'), gen_random_uuid(), 'public', 'Resolvido sem precisar da informação.', null, 'resolved', null);
  perform test.has(test.errmsg(format($q$select public.tk_post_message(%L, %L, gen_random_uuid(), 'public', 'tentando responder encerrado', null, null, null)$q$, org, test.t('k3'))), '%encerrado%', 'a equipe não responde chamado resolvido sem reabrir');
  perform public.tk_claim(org, test.t('k4'));
  perform test.has(test.errmsg(format($q$select public.tk_set_status(%L, %L, 'in_progress', null)$q$, org, test.t('k4'))), '%transição de status inválida%', 'retomar um chamado que já está em atendimento');
  perform test.has(test.errmsg(format($q$select public.tk_set_status(%L, %L, 'in_progress', null)$q$, org, test.t('k3'))), '%transição de status inválida%', 'retomar um chamado resolvido');
  perform test.has(test.errmsg(format($q$select public.tk_set_status(%L, %L, 'closed', null)$q$, org, test.t('k4'))), '%resolvido%', 'encerrar sem resolver');
  raise notice 'PASS: resolver de aguardando e transições de retomada (13)';
end $$;
reset role;
do $$
declare cyc uuid;
begin
  select id into cyc from public.ticket_service_cycles where ticket_id = test.t('k3') and closed_at is null;
  assert (select count(*) from public.ticket_sla_pauses where service_cycle_id = cyc and ended_at is null) = 0 and (select count(*) from public.ticket_sla_pauses where service_cycle_id = cyc) = 1, 'resolver encerra a pausa (histórico preservado)';
  assert (select count(*) from public.ticket_events where ticket_id = test.t('k3') and event_type = 'sla_resumed') = 1, 'evento de retomada ao resolver';
  assert (select resolved_at is not null from public.ticket_service_cycles where id = cyc), 'resolução marcada no ciclo';
  raise notice 'PASS: resolver de aguardando encerra a pausa (13)';
end $$;
:as_r1
do $$
declare org uuid := test.t('org');
begin
  -- reabrir direto de RESOLVIDO (sem confirmar): encerra o ciclo anterior e abre o novo
  assert public.tk_reopen(org, test.t('k3'), 'Ainda não está funcionando.', null) ->> 'cycle' = '2', 'reabertura a partir de resolvido cria o ciclo 2';
  -- o solicitante não vê e-mail de colega na conversa
  assert public.tk_ticket_detail(org, test.t('k3'))::text not like '%a2@t.invalid%', 'DTO do solicitante não expõe o e-mail da equipe';
  perform test.has(test.errmsg(format($q$select public.tk_reopen(%L, %L, 'Quero reabrir', null)$q$, org, test.t('k4'))), '%resolvido ou encerrado%', 'só reabre chamado resolvido ou encerrado');
  raise notice 'PASS: reabrir de resolvido e DTO sem e-mail de colega (13)';
end $$;
reset role;
do $$
begin
  assert (select closed_at is not null and resolved_at is not null from public.ticket_service_cycles where ticket_id = test.t('k3') and cycle_number = 1), 'o ciclo anterior foi encerrado e preservado';
  assert (select count(*) from public.ticket_service_cycles where ticket_id = test.t('k3') and closed_at is null) = 1, 'um único ciclo ativo';
  raise notice 'PASS: ciclo anterior encerrado na reabertura (13)';
end $$;
:as_m
do $$
declare org uuid := test.t('org'); n0 bigint; n1 bigint;
begin
  perform test.has(test.errmsg(format($q$select public.tk_claim(%L, %L)$q$, org, test.t('k5'))), '%pertencer à equipe%', 'gestor fora da equipe não assume chamado dela');
  n0 := test.cnt(format($q$select count(*) from public.notifications where ticket_id = %L and recipient_user_id = 'ffffffff-0000-4000-8000-0000000000a1'$q$, test.t('k6')));
  perform public.tk_assign(org, test.t('k6'), 'ffffffff-0000-4000-8000-0000000000a1', null);
  n1 := test.cnt(format($q$select count(*) from public.notifications where ticket_id = %L and recipient_user_id = 'ffffffff-0000-4000-8000-0000000000a1'$q$, test.t('k6')));
  assert n1 = n0, 'quem atribui a si mesmo não é notificado da própria ação';
  raise notice 'PASS: assumir fora da equipe e autoatribuição (13)';
end $$;
reset role;
do $$
begin
  -- notificação só vai para quem TEM acesso ao chamado (chamada direta à função interna)
  perform private.tk_notify(test.t('org'), test.t('k5'), 'ffffffff-0000-4000-8000-0000000000a3', 'assigned');
  assert test.cnt(format($q$select count(*) from public.notifications where ticket_id = %L and recipient_user_id = 'ffffffff-0000-4000-8000-0000000000a3'$q$, test.t('k5'))) = 0, 'atendente de outra equipe não é notificado';
  -- marcos do ciclo registrados não são reescritos
  perform test.has(test.errmsg(format($q$update public.ticket_service_cycles set first_response_at = now() + interval '1 hour' where ticket_id = %L and cycle_number = 1$q$, test.t('k3'))), '%marcos do ciclo%', 'primeira resposta não é reescrita');
  perform test.has(test.errmsg(format($q$update public.ticket_service_cycles set resolved_at = now() + interval '1 hour' where ticket_id = %L and cycle_number = 1$q$, test.t('k3'))), '%marcos do ciclo%', 'resolução não é reescrita');
  -- responsável fora da equipe barrado também pelo gatilho (atualização direta)
  perform test.has(test.errmsg(format($q$update public.tickets set assigned_user_id = 'ffffffff-0000-4000-8000-0000000000a4' where id = %L$q$, test.t('k3'))), '%responsável inválido%', 'gatilho de responsável');
  -- integridade: número repetido, segundo ciclo ativo, mensagem do solicitante interna, categoria de outra empresa
  perform test.has(test.errmsg(format($q$insert into public.tickets (organization_id, ticket_number, requester_user_id, subject, created_by) values (%L, 1, 'ffffffff-0000-4000-8000-0000000000b1', 'número repetido', 'ffffffff-0000-4000-8000-0000000000b1')$q$, test.t('org'))), '%duplicate key%', 'número de chamado repetido');
  perform test.has(test.errmsg(format($q$insert into public.ticket_service_cycles (organization_id, ticket_id, cycle_number, sla_policy_version_id, priority_snapshot, first_response_target_minutes, resolution_target_minutes) select organization_id, ticket_id, 50, sla_policy_version_id, 'normal', 10, 20 from public.ticket_service_cycles where ticket_id = %L and closed_at is null$q$, test.t('k3'))), '%one_active%', 'segundo ciclo ativo');
  perform test.has(test.errmsg(format($q$insert into public.ticket_messages (organization_id, ticket_id, author_user_id, author_kind, visibility, body) values (%L, %L, 'ffffffff-0000-4000-8000-0000000000b1', 'requester', 'internal', 'x')$q$, test.t('org'), test.t('k3'))), '%violates check constraint%', 'mensagem do solicitante não pode ser interna');
  perform test.has(test.errmsg(format($q$insert into public.tickets (organization_id, ticket_number, requester_user_id, subject, category_id, created_by) values (%L, 777, 'ffffffff-0000-4000-8000-0000000000b1', 'categoria cruzada', %L, 'ffffffff-0000-4000-8000-0000000000b1')$q$, test.t('org2'), test.t('c1'))), '%violates foreign key%', 'FK composta nega categoria de outra empresa');
  raise notice 'PASS: marcos imutáveis, gatilho de responsável e integridade (13)';
end $$;

-- sair da equipe devolve à fila os chamados abertos da pessoa (auditado)
:as_o
do $$
declare org uuid := test.t('org');
begin
  perform public.tk_set_team_members(org, test.t('t1'), array['ffffffff-0000-4000-8000-0000000000a1', 'ffffffff-0000-4000-8000-0000000000a2']::uuid[]);
  raise notice 'PASS: membros da equipe redefinidos (13)';
end $$;
reset role;
do $$
begin
  assert (select assigned_user_id from public.tickets where id = test.t('k3')) is null, 'quem saiu da equipe deixa de ser responsável';
  assert (select count(*) from public.ticket_events where ticket_id = test.t('k3') and event_type = 'unassigned' and safe_metadata ->> 'reason' = 'team_membership') = 1, 'remoção por saída da equipe auditada';
  raise notice 'PASS: saída da equipe devolve os chamados à fila (13)';
end $$;

rollback;
