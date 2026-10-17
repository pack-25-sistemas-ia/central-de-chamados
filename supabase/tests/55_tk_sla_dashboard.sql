-- Central de Chamados — SLA no banco: minutos úteis (expediente, almoço, fim de semana, dias sem expediente, fuso e horário de verão), pausas, estados (limiar de 80%),
-- snapshots de política/calendário/prioridade por ciclo, validação de calendário e metas, e as FÓRMULAS do painel com números conferidos à mão.
-- Os valores de TS (tests/unit/sla-*.test.ts) são OS MESMOS: o espelho e o banco não podem divergir.

\set as_o 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000a0","aal":"aal2","email":"o@t.invalid"}'', true); set local role authenticated;'
\set as_a2 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000a3","aal":"aal1","email":"a2@t.invalid"}'', true); set local role authenticated;'

begin;

create function test.errmsg(q text) returns text language plpgsql as $$ begin execute q; return null; exception when others then return sqlerrm; end $$;
create function test.has(msg text, pat text, label text) returns void language plpgsql as $$ begin if msg is null or msg not like pat then raise exception 'FALHOU: % — esperado %, veio %', label, pat, coalesce(msg, '(sem erro)'); end if; end $$;
create function test.t(k text) returns uuid language sql as $$ select current_setting('t.' || k)::uuid $$;
-- instante do horário LOCAL de São Paulo
create function test.sp(d date, hhmm text) returns timestamptz language sql immutable as $$ select (d + hhmm::time) at time zone 'America/Sao_Paulo' $$;
grant execute on all functions in schema test to anon, authenticated;

create function test.cal() returns jsonb language sql immutable as $$ select private.tk_default_calendar() $$;
create function test.bm(a timestamptz, b timestamptz) returns numeric language sql stable as $$ select private.tk_bminutes(test.cal(), 'America/Sao_Paulo', a, b) $$;

-- ===================================================================== (1) minutos úteis
do $$
declare mon date := '2026-10-19'; fri date := '2026-10-23'; nxt date := '2026-10-26'; ny jsonb := test.cal(); def jsonb;
begin
  assert extract(isodow from mon) = 1, 'segunda-feira de referência';
  assert test.bm(test.sp(mon, '08:00'), test.sp(mon, '09:30')) = 30, 'antes do expediente não conta; só 09:00–09:30';
  assert test.bm(test.sp(mon, '11:00'), test.sp(mon, '14:00')) = 120, 'intervalo de almoço (12–13) não conta';
  assert test.bm(test.sp(fri, '17:00'), test.sp(nxt, '10:00')) = 120, 'sexta 17–18 + segunda 09–10; fim de semana não conta';
  assert test.bm(test.sp('2026-10-24', '10:00'), test.sp('2026-10-25', '18:00')) = 0, 'sábado e domingo: zero';
  assert test.bm(test.sp(mon, '09:00'), test.sp(fri, '18:00')) = 2400, 'semana útil inteira = 5 × 480';
  assert test.bm(test.sp(mon, '10:00'), test.sp(mon, '10:00')) = 0 and test.bm(test.sp(mon, '11:00'), test.sp(mon, '10:00')) = 0, 'intervalo vazio ou invertido = 0';
  assert test.bm(test.sp(mon, '09:00'), test.sp(mon, '09:00') + interval '30 seconds') = 0.5, 'fração de minuto preservada';
  def := jsonb_set(test.cal(), '{closed_dates}', '["2026-10-21"]');
  assert private.tk_bminutes(def, 'America/Sao_Paulo', test.sp(mon, '09:00'), test.sp('2026-10-21', '18:00')) = 960, 'dia sem expediente (quarta) não conta';
  -- fuso: o mesmo instante cai em horas diferentes
  assert private.tk_bminutes(test.cal(), 'America/Sao_Paulo', '2026-10-23 12:00:00+00', '2026-10-23 14:00:00+00') = 120, 'São Paulo: 09:00–11:00 locais';
  assert private.tk_bminutes(test.cal(), 'America/New_York', '2026-10-23 12:00:00+00', '2026-10-23 14:00:00+00') = 60, 'Nova York: 08:00–10:00 locais (só 09–10 é expediente)';
  -- horário de verão (fim em 01/11/2026 em Nova York): sexta 16:00 → segunda 10:00 locais
  def := '{"weekly":{"1":[["09:00","17:00"]],"5":[["09:00","17:00"]]},"closed_dates":[]}';
  assert private.tk_bminutes(def, 'America/New_York', ('2026-10-30 16:00')::timestamp at time zone 'America/New_York', ('2026-11-02 10:00')::timestamp at time zone 'America/New_York') = 120, 'virada do horário de verão: sexta 16–17 + segunda 09–10';
  def := '{"weekly":{"1":[["22:00","24:00"]]},"closed_dates":[]}';
  assert private.tk_bminutes(def, 'America/Sao_Paulo', test.sp(mon, '21:00'), test.sp('2026-10-20', '01:00')) = 120, '«24:00» é a meia-noite seguinte';
  perform test.has(test.errmsg(format($q$select private.tk_bminutes(%L::jsonb, 'America/Sao_Paulo', %L::timestamptz, %L::timestamptz)$q$, test.cal()::text, '2020-01-01T00:00:00Z', '2026-01-01T00:00:00Z')), '%longo demais%', 'período de mais de 800 dias é recusado');
  assert private.tk_bminutes(test.cal(), 'America/Sao_Paulo', '2025-01-01T00:00:00Z', '2026-12-01T00:00:00Z') > 0, 'período de até 800 dias é calculado';
  raise notice 'PASS: minutos úteis (1)';
end $$;

-- ===================================================================== (2) validação de calendário e metas
do $$
begin
  perform test.has(test.errmsg($q$select private.tk_validate_calendar('Mars/Olympus', '{"weekly":{"1":[["09:00","12:00"]]}}')$q$), '%fuso%', 'fuso inválido');
  perform test.has(test.errmsg($q$select private.tk_validate_calendar('America/Sao_Paulo', '{"weekly":{"1":[["12:00","09:00"]]}}')$q$), '%fim deve ser depois%', 'fim antes do início');
  perform test.has(test.errmsg($q$select private.tk_validate_calendar('America/Sao_Paulo', '{"weekly":{"1":[["09:00","12:00"],["11:00","13:00"]]}}')$q$), '%sem sobreposição%', 'sobreposição');
  perform test.has(test.errmsg($q$select private.tk_validate_calendar('America/Sao_Paulo', '{"weekly":{"9":[["09:00","12:00"]]}}')$q$), '%dia da semana%', 'dia inválido');
  perform test.has(test.errmsg($q$select private.tk_validate_calendar('America/Sao_Paulo', '{"weekly":{"1":[["9:00","12:00"]]}}')$q$), '%HH:MM%', 'formato de hora');
  perform test.has(test.errmsg($q$select private.tk_validate_calendar('America/Sao_Paulo', '{"weekly":{"1":[]}}')$q$), '%ao menos um intervalo%', 'calendário vazio');
  perform test.has(test.errmsg($q$select private.tk_validate_calendar('America/Sao_Paulo', '{"weekly":{"1":[["09:00","12:00"]]},"closed_dates":["2026-02-31"]}')$q$), '%date%', 'data inexistente');
  perform private.tk_validate_calendar('America/Sao_Paulo', '{"weekly":{"1":[["09:00","12:00"],["13:00","24:00"]]},"closed_dates":["2026-12-25"]}');
  perform private.tk_validate_targets(private.tk_default_targets());
  perform test.has(test.errmsg($q$select private.tk_validate_targets('{"low":{"first_response":10,"resolution":50}}')$q$), '%ausentes%', 'prioridades faltando');
  perform test.has(test.errmsg($q$select private.tk_validate_targets((private.tk_default_targets() #- '{normal,first_response}'))$q$), '%número inteiro%', 'meta ausente');
  perform test.has(test.errmsg($q$select private.tk_validate_targets(jsonb_set(private.tk_default_targets(), '{normal,first_response}', '5000'))$q$), '%maior que a de resolução%', 'primeira resposta > resolução');
  perform test.has(test.errmsg($q$select private.tk_validate_targets(jsonb_set(private.tk_default_targets(), '{high,resolution}', '0'))$q$), '%entre 1 e 525600%', 'meta zero');
  raise notice 'PASS: validação de calendário e metas (2)';
end $$;

-- ===================================================================== (3) ciclos: fixture com instantes fixos
insert into auth.users (id, email) values ('ffffffff-0000-4000-8000-0000000000a0', 'o@t.invalid'), ('ffffffff-0000-4000-8000-0000000000a3', 'a2@t.invalid'), ('ffffffff-0000-4000-8000-0000000000a1', 'm@t.invalid');
create function test.mk(num bigint, prio text, started timestamptz, fr timestamptz, res timestamptz, closed timestamptz, status text) returns uuid
language plpgsql as $$
declare tid uuid := gen_random_uuid(); cid uuid; pol public.sla_policy_versions;
begin
  insert into public.tickets (id, organization_id, ticket_number, requester_user_id, subject, priority, status, created_by, created_at, last_public_activity_at)
  values (tid, test.t('org'), num, 'ffffffff-0000-4000-8000-0000000000b1', 'Chamado de teste ' || num, prio, status, 'ffffffff-0000-4000-8000-0000000000b1', started, started);
  select * into pol from public.sla_policy_versions where organization_id = test.t('org') order by created_at desc, id desc limit 1;
  insert into public.ticket_service_cycles (organization_id, ticket_id, cycle_number, sla_policy_version_id, priority_snapshot, first_response_target_minutes, resolution_target_minutes, started_at, first_response_at, resolved_at, closed_at)
  values (test.t('org'), tid, 1, pol.id, prio, (pol.targets_by_priority -> prio ->> 'first_response')::int, (pol.targets_by_priority -> prio ->> 'resolution')::int, started, fr, res, closed) returning id into cid;
  perform set_config('t.cy' || num, cid::text, true);
  perform set_config('t.tk' || num, tid::text, true);
  return cid;
end $$;

:as_o
do $$ begin perform set_config('t.org', public.create_organization('SLA Teste', 'sla-teste')::text, true); end $$;
reset role;

do $$
declare mon date := '2026-10-19'; c uuid; m jsonb;
begin
  -- aberto fora do expediente (sábado 10:00), respondido na segunda 09:30: só 30 min úteis
  c := test.mk(1, 'normal', test.sp('2026-10-17', '10:00'), test.sp(mon, '09:30'), null, null, 'in_progress');
  assert private.tk_consumed(c, 'first_response', test.sp('2026-10-30', '12:00')) = 30, 'sábado 10:00 → segunda 09:30 = 30 min úteis';
  m := private.tk_metric(c, 'first_response', test.sp('2026-10-30', '12:00'));
  assert m ->> 'state' = 'met' and (m ->> 'consumed')::numeric = 30 and (m ->> 'target')::int = 240, 'primeira resposta cumprida (o relógio para no marco)';
  assert private.tk_metric(c, 'resolution', test.sp(mon, '10:00')) ->> 'state' = 'on_track', 'resolução ainda no prazo';

  -- limiar de 80%: meta 240; iniciado segunda 09:00
  c := test.mk(2, 'normal', test.sp(mon, '09:00'), null, null, null, 'open');
  assert private.tk_metric(c, 'first_response', test.sp(mon, '12:00')) ->> 'state' = 'on_track' and (private.tk_metric(c, 'first_response', test.sp(mon, '12:00')) ->> 'consumed')::numeric = 180, '180 min = 75%: no prazo';
  assert private.tk_metric(c, 'first_response', test.sp(mon, '13:11')) ->> 'state' = 'on_track', '191 min: ainda abaixo de 80%';
  assert private.tk_metric(c, 'first_response', test.sp(mon, '13:12')) ->> 'state' = 'at_risk', '192 min = 80%: próximo do limite';
  assert private.tk_metric(c, 'first_response', test.sp(mon, '14:00')) ->> 'state' = 'at_risk', 'exatamente na meta (240) ainda não é atraso';
  assert private.tk_metric(c, 'first_response', test.sp(mon, '14:01')) ->> 'state' = 'overdue', 'um minuto depois: atrasado';
  assert private.tk_cycle_sla(c, test.sp(mon, '14:01')) ->> 'summary' = 'overdue', 'resumo do ciclo = pior estado';
  assert private.tk_cycle_sla(c, test.sp(mon, '10:00')) ->> 'summary' = 'on_track', 'resumo no prazo';

  -- cumprida × descumprida
  c := test.mk(3, 'high', test.sp(mon, '09:00'), test.sp(mon, '10:00'), test.sp(mon, '16:00'), null, 'resolved');
  assert private.tk_metric(c, 'first_response', test.sp('2026-10-30', '12:00')) ->> 'state' = 'met', 'alta: 60 min na meta de 60 = cumprida';
  raise notice 'PASS: estados de SLA (3)';
end $$;
do $$
declare c uuid := test.t('cy3'); m jsonb;
begin
  m := private.tk_metric(c, 'resolution', test.sp('2026-10-30', '12:00'));
  assert (m ->> 'consumed')::numeric = 360 and m ->> 'state' = 'met', 'resolução alta: 360 min úteis ≤ 480 → cumprida';
  -- descumprida: urgente, primeira resposta 30 min, respondida com 60
  c := test.mk(4, 'urgent', test.sp('2026-10-19', '09:00'), test.sp('2026-10-19', '10:00'), null, null, 'in_progress');
  assert private.tk_metric(c, 'first_response', test.sp('2026-10-30', '12:00')) ->> 'state' = 'breached', 'urgente respondida em 60 min (meta 30): descumprida';
  assert private.tk_cycle_sla(c, test.sp('2026-10-19', '10:00')) ->> 'summary' in ('breached', 'overdue'), 'resumo reflete a falha';
  raise notice 'PASS: cumprida e descumprida (3)';
end $$;

-- ===================================================================== (4) pausas: várias, sem contar duas vezes, aberta
do $$
declare mon date := '2026-10-19'; tue date := '2026-10-20'; c uuid := test.mk(5, 'normal', test.sp('2026-10-19', '10:00'), test.sp('2026-10-19', '10:30'), null, null, 'waiting_requester');
begin
  insert into public.ticket_sla_pauses (organization_id, service_cycle_id, started_at, ended_at) values (test.t('org'), c, test.sp(mon, '11:00'), test.sp(tue, '10:00'));
  assert private.tk_consumed(c, 'resolution', test.sp(tue, '12:00')) = 180, 'seg 10:00 → ter 12:00 = 600 úteis; pausa seg 11:00 → ter 10:00 = 420 úteis; consumo 180';
  insert into public.ticket_sla_pauses (organization_id, service_cycle_id, started_at, ended_at) values (test.t('org'), c, test.sp(tue, '10:30'), test.sp(tue, '11:00'));
  assert private.tk_consumed(c, 'resolution', test.sp(tue, '12:00')) = 150, 'segunda pausa (30 min úteis) também é descontada';
  insert into public.ticket_sla_pauses (organization_id, service_cycle_id, started_at) values (test.t('org'), c, test.sp(tue, '11:30'));
  assert private.tk_consumed(c, 'resolution', test.sp(tue, '12:00')) = 120, 'pausa aberta desconta até o instante consultado';
  assert private.tk_metric(c, 'resolution', test.sp(tue, '12:00')) ->> 'state' = 'paused', 'estado pausado';
  perform test.has(test.errmsg(format($q$insert into public.ticket_sla_pauses (organization_id, service_cycle_id, started_at) values (%L, %L, now())$q$, test.t('org'), c)), '%ticket_sla_pauses_one_open_uq%', 'uma única pausa aberta por ciclo');
  -- pausa fora do expediente não desconta nada
  update public.ticket_sla_pauses set ended_at = test.sp(tue, '12:00') where service_cycle_id = c and ended_at is null;
  insert into public.ticket_sla_pauses (organization_id, service_cycle_id, started_at, ended_at) values (test.t('org'), c, test.sp(tue, '18:00'), test.sp('2026-10-21', '09:00'));
  assert private.tk_consumed(c, 'resolution', test.sp('2026-10-21', '09:00')) = private.tk_consumed(c, 'resolution', test.sp(tue, '18:00')), 'pausa noturna (sem expediente) não altera o consumo';
  raise notice 'PASS: pausas de SLA (4)';
end $$;
do $$
declare c uuid := test.mk(6, 'urgent', test.sp('2026-10-19', '09:00'), null, null, null, 'waiting_requester');
begin
  insert into public.ticket_sla_pauses (organization_id, service_cycle_id, started_at) values (test.t('org'), c, test.sp('2026-10-19', '09:10'));
  assert (private.tk_metric(c, 'first_response', test.sp('2026-10-19', '09:25')) ->> 'consumed')::numeric = 10 and private.tk_metric(c, 'first_response', test.sp('2026-10-19', '09:25')) ->> 'state' = 'paused', 'pausada dentro da meta: 25 úteis − 15 de pausa = 10';
  assert private.tk_metric(c, 'resolution', test.sp('2026-10-19', '09:25')) ->> 'state' = 'paused', 'resolução pausada';
  -- atraso que já existia antes da pausa continua atraso
  c := test.mk(7, 'urgent', test.sp('2026-10-19', '09:00'), null, null, null, 'waiting_requester');
  insert into public.ticket_sla_pauses (organization_id, service_cycle_id, started_at) values (test.t('org'), c, test.sp('2026-10-19', '11:00'));
  assert private.tk_metric(c, 'first_response', test.sp('2026-10-19', '11:30')) ->> 'state' = 'overdue', 'atrasado antes de pausar: continua atrasado (não esconde o atraso)';
  raise notice 'PASS: pausa não esconde atraso (4)';
end $$;

-- resumo do ciclo: marco descumprido + outra meta pausada = «descumprido» (descumprido vale mais que pausado)
do $$
declare c uuid := test.mk(9, 'urgent', test.sp('2026-10-19', '09:00'), test.sp('2026-10-19', '10:00'), null, null, 'waiting_requester');
begin
  insert into public.ticket_sla_pauses (organization_id, service_cycle_id, started_at) values (test.t('org'), c, test.sp('2026-10-19', '10:05'));
  assert private.tk_metric(c, 'first_response', test.sp('2026-10-19', '10:30')) ->> 'state' = 'breached' and private.tk_metric(c, 'resolution', test.sp('2026-10-19', '10:30')) ->> 'state' = 'paused', 'um marco descumprido e o outro pausado';
  assert private.tk_cycle_sla(c, test.sp('2026-10-19', '10:30')) ->> 'summary' = 'breached', 'resumo = descumprido';
  raise notice 'PASS: resumo do ciclo (4)';
end $$;

-- ===================================================================== (5) snapshots: política, calendário e prioridade valem por ciclo
do $$
declare c1 uuid := test.mk(8, 'normal', test.sp('2026-10-19', '09:00'), null, null, null, 'open'); cal2 uuid; pol2 uuid; c2 uuid; t8 uuid := test.t('tk8'); b1 numeric; b2 numeric;
begin
  b1 := private.tk_consumed(c1, 'first_response', test.sp('2026-10-19', '12:00'));
  insert into public.business_calendar_versions (organization_id, timezone, definition, created_at) values (test.t('org'), 'America/Sao_Paulo', '{"weekly":{"1":[["10:00","11:00"]]},"closed_dates":[]}', now() + interval '1 second') returning id into cal2;
  insert into public.sla_policy_versions (organization_id, business_calendar_version_id, targets_by_priority, created_at)
    values (test.t('org'), cal2, jsonb_set(jsonb_set(private.tk_default_targets(), '{normal,first_response}', '60'), '{normal,resolution}', '120'), now() + interval '1 second') returning id into pol2;
  assert private.tk_consumed(c1, 'first_response', test.sp('2026-10-19', '12:00')) = b1 and b1 = 180, 'o ciclo em andamento continua no calendário e nas metas antigos';
  assert (select first_response_target_minutes from public.ticket_service_cycles where id = c1) = 240, 'meta do ciclo antigo inalterada';
  -- reabrir/novo ciclo usa a política VIGENTE
  update public.ticket_service_cycles set closed_at = test.sp('2026-10-19', '12:30') where id = c1;
  c2 := private.tk_start_cycle(t8, test.sp('2026-10-19', '12:30'));
  assert (select sla_policy_version_id from public.ticket_service_cycles where id = c2) = pol2 and (select first_response_target_minutes from public.ticket_service_cycles where id = c2) = 60, 'novo ciclo pega a política mais recente';
  assert private.tk_consumed(c2, 'first_response', test.sp('2026-10-19', '12:30') + interval '2 days') = 0 and private.tk_consumed(c2, 'first_response', test.sp('2026-10-26', '12:00')) = 60, 'novo calendário: só segundas 10–11 (nada na terça/quarta; 60 min na segunda seguinte)';
  -- prioridade alterada não muda a meta já fixada
  update public.tickets set priority = 'urgent' where id = t8;
  assert (select priority_snapshot from public.ticket_service_cycles where id = c2) = 'normal' and (select first_response_target_minutes from public.ticket_service_cycles where id = c2) = 60, 'prioridade operacional não reescreve a meta do ciclo';
  assert (select cycle_number from public.ticket_service_cycles where id = c2) = 2, 'ciclo 2';
  raise notice 'PASS: snapshots por ciclo (5)';
end $$;

-- ===================================================================== (6) painel: fórmulas com números conferidos à mão
-- base: segunda-feira de 2 a 3 semanas atrás (instantes no passado)
:as_o
do $$ begin perform set_config('t.org3', public.create_organization('Painel Teste', 'painel-teste')::text, true); end $$;
reset role;
do $$
declare
  org uuid := test.t('org3'); base date := (current_date - 21) - (extract(isodow from current_date - 21)::int - 1); pol public.sla_policy_versions; tid uuid; c uuid; team uuid := gen_random_uuid(); team2 uuid := gen_random_uuid();
begin
  assert extract(isodow from base) = 1, 'base é segunda-feira';
  perform set_config('t.base', base::text, true);
  insert into public.teams (id, organization_id, name) values (team, org, 'Equipe A'), (team2, org, 'Equipe B');
  perform set_config('t.teamA', team::text, true); perform set_config('t.teamB', team2::text, true);
  select * into pol from public.sla_policy_versions where organization_id = org order by created_at desc limit 1;
  -- T1: normal, equipe A, resposta em 30 min úteis, resolvido em 120; encerrado
  tid := gen_random_uuid();
  insert into public.tickets (id, organization_id, ticket_number, requester_user_id, subject, priority, status, team_id, created_by, created_at, last_public_activity_at) values (tid, org, 1, 'ffffffff-0000-4000-8000-0000000000b1', 'Chamado T1', 'normal', 'closed', team, 'ffffffff-0000-4000-8000-0000000000b1', test.sp(base, '09:00'), test.sp(base, '11:00'));
  insert into public.ticket_service_cycles (organization_id, ticket_id, cycle_number, sla_policy_version_id, priority_snapshot, first_response_target_minutes, resolution_target_minutes, started_at, first_response_at, resolved_at, closed_at)
    values (org, tid, 1, pol.id, 'normal', 240, 1440, test.sp(base, '09:00'), test.sp(base, '09:30'), test.sp(base, '11:00'), test.sp(base, '11:05'));
  -- T2: normal, equipe A, atribuído ao atendente 2, em atendimento; resposta em 300 (> 240); sem resolução
  tid := gen_random_uuid();
  insert into public.tickets (id, organization_id, ticket_number, requester_user_id, subject, priority, status, team_id, assigned_user_id, created_by, created_at, last_public_activity_at) values (tid, org, 2, 'ffffffff-0000-4000-8000-0000000000b1', 'Chamado T2', 'normal', 'in_progress', team, null, 'ffffffff-0000-4000-8000-0000000000b1', test.sp(base, '10:00'), test.sp(base, '16:00'));
  insert into public.ticket_service_cycles (organization_id, ticket_id, cycle_number, sla_policy_version_id, priority_snapshot, first_response_target_minutes, resolution_target_minutes, started_at, first_response_at)
    values (org, tid, 1, pol.id, 'normal', 240, 1440, test.sp(base, '10:00'), test.sp(base, '16:00'));
  -- T3: urgente, equipe B, aberto, sem resposta
  tid := gen_random_uuid();
  insert into public.tickets (id, organization_id, ticket_number, requester_user_id, subject, priority, status, team_id, created_by, created_at, last_public_activity_at) values (tid, org, 3, 'ffffffff-0000-4000-8000-0000000000b1', 'Chamado T3', 'urgent', 'open', team2, 'ffffffff-0000-4000-8000-0000000000b1', test.sp(base + 1, '09:00'), test.sp(base + 1, '09:00'));
  insert into public.ticket_service_cycles (organization_id, ticket_id, cycle_number, sla_policy_version_id, priority_snapshot, first_response_target_minutes, resolution_target_minutes, started_at)
    values (org, tid, 1, pol.id, 'urgent', 30, 240, test.sp(base + 1, '09:00'));
  -- T4: reaberto: ciclo 1 (resposta 20, resolvido em 60) e ciclo 2 (resposta em 10)
  tid := gen_random_uuid();
  insert into public.tickets (id, organization_id, ticket_number, requester_user_id, subject, priority, status, team_id, created_by, created_at, last_public_activity_at) values (tid, org, 4, 'ffffffff-0000-4000-8000-0000000000b1', 'Chamado T4', 'normal', 'in_progress', team, 'ffffffff-0000-4000-8000-0000000000b1', test.sp(base, '09:00'), test.sp(base + 2, '09:10'));
  insert into public.ticket_service_cycles (organization_id, ticket_id, cycle_number, sla_policy_version_id, priority_snapshot, first_response_target_minutes, resolution_target_minutes, started_at, first_response_at, resolved_at, closed_at)
    values (org, tid, 1, pol.id, 'normal', 240, 1440, test.sp(base, '09:00'), test.sp(base, '09:20'), test.sp(base, '10:00'), test.sp(base + 2, '09:00'));
  insert into public.ticket_service_cycles (organization_id, ticket_id, cycle_number, sla_policy_version_id, priority_snapshot, first_response_target_minutes, resolution_target_minutes, started_at, first_response_at)
    values (org, tid, 2, pol.id, 'normal', 240, 1440, test.sp(base + 2, '09:00'), test.sp(base + 2, '09:10'));
  -- T5: respostas e resolução EXATAMENTE na meta (240 e 1440 min úteis) contam como cumpridas
  tid := gen_random_uuid();
  insert into public.tickets (id, organization_id, ticket_number, requester_user_id, subject, priority, status, team_id, created_by, created_at, last_public_activity_at) values (tid, org, 5, 'ffffffff-0000-4000-8000-0000000000b1', 'Chamado T5', 'normal', 'closed', team, 'ffffffff-0000-4000-8000-0000000000b1', test.sp(base, '09:00'), test.sp(base + 2, '18:05'));
  insert into public.ticket_service_cycles (organization_id, ticket_id, cycle_number, sla_policy_version_id, priority_snapshot, first_response_target_minutes, resolution_target_minutes, started_at, first_response_at, resolved_at, closed_at)
    values (org, tid, 1, pol.id, 'normal', 240, 1440, test.sp(base, '09:00'), test.sp(base, '14:00'), test.sp(base + 2, '18:00'), test.sp(base + 2, '18:05'));
  -- T6: aguardando solicitante, sem responsável, ciclo em aberto (entra no backlog)
  tid := gen_random_uuid();
  insert into public.tickets (id, organization_id, ticket_number, requester_user_id, subject, priority, status, team_id, created_by, created_at, last_public_activity_at) values (tid, org, 6, 'ffffffff-0000-4000-8000-0000000000b1', 'Chamado T6', 'normal', 'waiting_requester', team, 'ffffffff-0000-4000-8000-0000000000b1', test.sp(base + 3, '09:00'), test.sp(base + 3, '09:00'));
  insert into public.ticket_service_cycles (organization_id, ticket_id, cycle_number, sla_policy_version_id, priority_snapshot, first_response_target_minutes, resolution_target_minutes, started_at)
    values (org, tid, 1, pol.id, 'normal', 240, 1440, test.sp(base + 3, '09:00'));
  raise notice 'PASS: massa do painel criada (6)';
end $$;
-- o atendente 2 entra como membro/atendente da equipe A (precisa existir como membro para ser responsável do T2 e para o escopo)
do $$
begin
  insert into public.organization_members (organization_id, user_id, role) values (test.t('org3'), 'ffffffff-0000-4000-8000-0000000000a3', 'member');
  insert into public.team_members (organization_id, team_id, user_id) values (test.t('org3'), test.t('teamA'), 'ffffffff-0000-4000-8000-0000000000a3');
  insert into public.organization_members (organization_id, user_id, role) values (test.t('org3'), 'ffffffff-0000-4000-8000-0000000000a1', 'manager');
  insert into public.team_members (organization_id, team_id, user_id) values (test.t('org3'), test.t('teamA'), 'ffffffff-0000-4000-8000-0000000000a1');
  update public.tickets set assigned_user_id = 'ffffffff-0000-4000-8000-0000000000a3' where organization_id = test.t('org3') and ticket_number = 2;
  update public.tickets set assigned_user_id = 'ffffffff-0000-4000-8000-0000000000a1' where organization_id = test.t('org3') and ticket_number = 4;
end $$;
:as_o
do $$
declare org uuid := test.t('org3'); base date := current_setting('t.base')::date; d jsonb;
begin
  d := public.tk_dashboard(org, base, base + 4, null);
  assert (d ->> 'created_tickets')::int = 6, 'chamados criados no período (por chamado)';
  assert d -> 'backlog' = '{"open": 1, "in_progress": 2, "waiting_requester": 1, "unassigned": 2, "total": 4}'::jsonb, 'backlog atual = open + in_progress + waiting; não atribuídos = 2 (T3 e T6)';
  assert (d -> 'first_response' ->> 'cycles')::int = 5 and (d -> 'first_response' ->> 'within_target')::int = 4, 'primeira resposta: 5 ciclos, 4 dentro da meta (T2 gastou 300 > 240; T5 gastou exatamente 240)';
  assert (d -> 'first_response' ->> 'rate')::numeric = 80.0 and (d -> 'first_response' ->> 'avg_minutes')::numeric = 120.0 and (d -> 'first_response' ->> 'median_minutes')::numeric = 30.0, 'taxa 80%, média 120 min, mediana 30 (10, 20, 30, 240, 300)';
  assert (d -> 'resolution' ->> 'cycles')::int = 3 and (d -> 'resolution' ->> 'rate')::numeric = 100.0 and (d -> 'resolution' ->> 'avg_minutes')::numeric = 540.0, 'resolução: 3 ciclos (120, 60 e exatamente 1440 min) dentro da meta';
  assert (d ->> 'resolved_cycles')::int = 3 and (d ->> 'reopened_cycles')::int = 1 and (d ->> 'reopened_tickets')::int = 1, 'reaberturas contam NOVOS ciclos iniciados no período';
  assert (d -> 'by_priority') = '{"normal": 5, "urgent": 1}'::jsonb, 'distribuição por prioridade';
  assert (d -> 'overdue_open' ->> 'first_response')::int = 2 and (d -> 'overdue_open' ->> 'resolution')::int = 4, 'ciclos ABERTOS já atrasados são mostrados à parte (T3 e T6 sem resposta; T2, T3, T4/2 e T6 sem resolução)';
  assert jsonb_array_length(d -> 'workload') = 2 and d -> 'workload' -> 0 ->> 'open' = '1', 'carga atual: um chamado do gestor e um do atendente 2';
  assert d -> 'period' ->> 'timezone' = 'America/Sao_Paulo', 'fuso do relatório informado';
  -- recorte por equipe e período sem dados («Sem dados» = null)
  assert (public.tk_dashboard(org, base, base + 4, test.t('teamB')) ->> 'created_tickets')::int = 1, 'filtro por equipe';
  d := public.tk_dashboard(org, base - 30, base - 20, null);
  assert (d -> 'first_response' -> 'rate') = 'null'::jsonb and (d -> 'first_response' -> 'avg_minutes') = 'null'::jsonb and (d -> 'resolution' -> 'rate') = 'null'::jsonb, 'denominador zero = null (Sem dados), nunca 0%';
  perform test.has(test.errmsg(format($q$select public.tk_dashboard(%L, %L, %L, null)$q$, org, base, base - 1)), '%período inválido%', 'período invertido');
  perform test.has(test.errmsg(format($q$select public.tk_dashboard(%L, %L, %L, null)$q$, org, base, base + 500)), '%período inválido%', 'período longo demais');
  raise notice 'PASS: fórmulas do painel (6)';
end $$;
reset role;
:as_a2
do $$
declare org uuid := test.t('org3'); base date := current_setting('t.base')::date; d jsonb;
begin
  d := public.tk_dashboard(org, base, base + 4, null);
  assert (d ->> 'created_tickets')::int = 5, 'atendente da equipe A vê só os chamados visíveis (T1, T2, T4, T5 e T6; T3 é da equipe B)';
  assert jsonb_array_length(d -> 'workload') = 1, 'atendente vê só a própria carga (não a do gestor)';
  perform test.has(test.errmsg(format($q$select public.tk_publish_sla(%L, 'America/Sao_Paulo', '{}', '{}')$q$, org)), '%sem permissão%', 'atendente não publica SLA');
  raise notice 'PASS: painel respeita o escopo do atendente (6)';
end $$;
reset role;

rollback;
