-- Central de Chamados — MOTOR DE SLA no banco (fonte de verdade; o espelho TypeScript em lib/sla só explica, projeta vencimentos e fixa as regras em testes).
-- Tudo é calculado na LEITURA a partir de instantes (timestamptz) e dos snapshots do ciclo: não depende de cron para estar correto.
--  · tempo consumido = minutos ÚTEIS (interseção com o expediente do fuso da versão do calendário) entre o início do ciclo e o marco/agora, MENOS os minutos úteis das pausas;
--  · pausas não se sobrepõem (uma aberta por ciclo), então nenhum intervalo é descontado duas vezes;
--  · estados: met · breached (cumprido/descumprido) · overdue (atrasado, em aberto) · paused · at_risk (≥ 80% da meta consumida) · on_track;
--  · hora local inexistente/ambígua (horário de verão) segue a regra do Postgres para `timestamp AT TIME ZONE` (documentado em docs/SLA.md).

begin;
set local check_function_bodies = off;

create function private.tk_risk_ratio() returns numeric language sql immutable set search_path = '' as $$ select 0.8::numeric $$;
revoke all on function private.tk_risk_ratio() from public, anon, authenticated;

create function private.tk_parse_time(t text, what text) returns time
language plpgsql immutable set search_path = '' as $$
begin
  if t is null or t !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$|^24:00$' then raise exception '% inválido (use HH:MM)', what using errcode = '22023'; end if;
  return t::time;
end $$;
revoke all on function private.tk_parse_time(text, text) from public, anon, authenticated;

-- Valida o calendário inteiro (fuso, dias, intervalos ordenados e sem sobreposição, datas fechadas).
create function private.tk_validate_calendar(p_tz text, p_def jsonb) returns void
language plpgsql stable set search_path = '' as $$
declare k text; iv jsonb; prev time; s time; e time; n integer; d text;
begin
  begin perform now() at time zone p_tz; exception when others then raise exception 'fuso horário inválido' using errcode = '22023'; end;
  if jsonb_typeof(p_def) is distinct from 'object' or jsonb_typeof(p_def -> 'weekly') is distinct from 'object' then raise exception 'expediente inválido' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p_def -> 'weekly') loop
    if k !~ '^[0-6]$' then raise exception 'dia da semana inválido' using errcode = '22023'; end if;
    if jsonb_typeof(p_def -> 'weekly' -> k) is distinct from 'array' or jsonb_array_length(p_def -> 'weekly' -> k) > 6 then raise exception 'até 6 intervalos por dia' using errcode = '22023'; end if;
    prev := null;
    for iv in select value from jsonb_array_elements(p_def -> 'weekly' -> k) loop
      if jsonb_typeof(iv) is distinct from 'array' or jsonb_array_length(iv) <> 2 then raise exception 'intervalo inválido' using errcode = '22023'; end if;
      s := private.tk_parse_time(iv ->> 0, 'Início'); e := private.tk_parse_time(iv ->> 1, 'Fim');
      if e = '00:00'::time and (iv ->> 1) = '00:00' then raise exception 'use 24:00 para a meia-noite final' using errcode = '22023'; end if;
      if (iv ->> 1) <> '24:00' and s >= e then raise exception 'o fim deve ser depois do início' using errcode = '22023'; end if;
      if prev is not null and s < prev then raise exception 'intervalos do dia devem estar em ordem e sem sobreposição' using errcode = '22023'; end if;
      prev := case when (iv ->> 1) = '24:00' then '23:59:59.999999'::time else e end;
    end loop;
  end loop;
  if p_def ? 'closed_dates' then
    if jsonb_typeof(p_def -> 'closed_dates') is distinct from 'array' or jsonb_array_length(p_def -> 'closed_dates') > 400 then raise exception 'datas sem expediente inválidas' using errcode = '22023'; end if;
    for d in select value #>> '{}' from jsonb_array_elements(p_def -> 'closed_dates') loop
      if d is null or d !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'data sem expediente inválida' using errcode = '22023'; end if;
      perform d::date;
    end loop;
  end if;
  select count(*) into n from jsonb_object_keys(p_def -> 'weekly');
  if n = 0 or not exists (select 1 from jsonb_each(p_def -> 'weekly') w where jsonb_array_length(w.value) > 0) then raise exception 'defina ao menos um intervalo de atendimento' using errcode = '22023'; end if;
end $$;
revoke all on function private.tk_validate_calendar(text, jsonb) from public, anon, authenticated;

create function private.tk_validate_targets(p_targets jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare p text; k text;
begin
  if jsonb_typeof(p_targets) is distinct from 'object' then raise exception 'metas inválidas' using errcode = '22023'; end if;
  foreach p in array array['low', 'normal', 'high', 'urgent'] loop
    if jsonb_typeof(p_targets -> p) is distinct from 'object' then raise exception 'metas de SLA ausentes para a prioridade %', p using errcode = '22023'; end if;
    foreach k in array array['first_response', 'resolution'] loop
      if jsonb_typeof(p_targets -> p -> k) is distinct from 'number' or coalesce((p_targets -> p ->> k) !~ '^[0-9]{1,6}$', true) or (p_targets -> p ->> k)::integer not between 1 and 525600 then
        raise exception 'meta de % (%) deve ser um número inteiro de minutos úteis entre 1 e 525600', k, p using errcode = '22023';
      end if;
    end loop;
    if (p_targets -> p ->> 'first_response')::integer > (p_targets -> p ->> 'resolution')::integer then
      raise exception 'a meta de primeira resposta não pode ser maior que a de resolução (%)', p using errcode = '22023';
    end if;
  end loop;
end $$;
revoke all on function private.tk_validate_targets(jsonb) from public, anon, authenticated;

-- Intervalos de expediente de UM dia local, em instantes.
create function private.tk_cal_day(p_def jsonb, p_tz text, p_day date) returns table (s timestamptz, e timestamptz)
language sql stable set search_path = '' as $$
  select (p_day + (iv.value ->> 0)::time) at time zone p_tz,
         (case when (iv.value ->> 1) = '24:00' then (p_day + 1)::timestamp else (p_day + (iv.value ->> 1)::time) end) at time zone p_tz
  from jsonb_array_elements(coalesce(p_def -> 'weekly' -> (extract(dow from p_day)::integer)::text, '[]'::jsonb)) iv
  where not (coalesce(p_def -> 'closed_dates', '[]'::jsonb) ? p_day::text)
  order by 1;
$$;
revoke all on function private.tk_cal_day(jsonb, text, date) from public, anon, authenticated;

-- Minutos ÚTEIS entre dois instantes (fração preservada). Janela máxima de 800 dias (proteção).
create function private.tk_bminutes(p_def jsonb, p_tz text, p_a timestamptz, p_b timestamptz) returns numeric
language plpgsql stable set search_path = '' as $$
declare d date; last date; total numeric := 0; r record; lo timestamptz; hi timestamptz;
begin
  if p_a is null or p_b is null or p_b <= p_a then return 0; end if;
  d := (p_a at time zone p_tz)::date; last := (p_b at time zone p_tz)::date;
  if last - d > 800 then raise exception 'período longo demais para o cálculo de SLA' using errcode = '22023'; end if;
  while d <= last loop
    for r in select * from private.tk_cal_day(p_def, p_tz, d) loop
      lo := greatest(r.s, p_a); hi := least(r.e, p_b);
      if hi > lo then total := total + extract(epoch from (hi - lo)) / 60.0; end if;
    end loop;
    d := d + 1;
  end loop;
  return total;
end $$;
revoke all on function private.tk_bminutes(jsonb, text, timestamptz, timestamptz) from public, anon, authenticated;

-- Calendário e fuso fixados pela política do ciclo.
create function private.tk_cycle_calendar(p_cycle uuid) returns table (def jsonb, tz text)
language sql stable security definer set search_path = '' as $$
  select cv.definition, cv.timezone
  from public.ticket_service_cycles c
  join public.sla_policy_versions p on p.id = c.sla_policy_version_id and p.organization_id = c.organization_id
  join public.business_calendar_versions cv on cv.id = p.business_calendar_version_id and cv.organization_id = p.organization_id
  where c.id = p_cycle;
$$;
revoke all on function private.tk_cycle_calendar(uuid) from public, anon, authenticated;

-- Minutos úteis CONSUMIDOS de uma meta (kind: first_response | resolution) até `p_at` (ou até o marco, se já cumprido).
create function private.tk_consumed(p_cycle uuid, p_kind text, p_at timestamptz) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare c public.ticket_service_cycles; cal record; stop timestamptz; total numeric; paused numeric := 0; p record;
begin
  select * into c from public.ticket_service_cycles where id = p_cycle;
  if not found then return null; end if;
  select * into cal from private.tk_cycle_calendar(p_cycle);
  stop := least(p_at, coalesce(case p_kind when 'first_response' then c.first_response_at else c.resolved_at end, p_at));
  total := private.tk_bminutes(cal.def, cal.tz, c.started_at, stop);
  for p in select started_at, ended_at from public.ticket_sla_pauses where service_cycle_id = p_cycle loop
    paused := paused + private.tk_bminutes(cal.def, cal.tz, greatest(p.started_at, c.started_at), least(coalesce(p.ended_at, stop), stop));
  end loop;
  return greatest(total - paused, 0);
end $$;
revoke all on function private.tk_consumed(uuid, text, timestamptz) from public, anon, authenticated;

-- Estado de UMA meta no instante `p_at`.
create function private.tk_metric(p_cycle uuid, p_kind text, p_at timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.ticket_service_cycles; target integer; done_at timestamptz; used numeric; st text; is_paused boolean;
begin
  select * into c from public.ticket_service_cycles where id = p_cycle;
  target := case p_kind when 'first_response' then c.first_response_target_minutes else c.resolution_target_minutes end;
  done_at := case p_kind when 'first_response' then c.first_response_at else c.resolved_at end;
  used := private.tk_consumed(p_cycle, p_kind, p_at);
  select exists (select 1 from public.ticket_sla_pauses where service_cycle_id = p_cycle and ended_at is null) into is_paused;
  if done_at is not null and done_at <= p_at then st := case when used <= target then 'met' else 'breached' end;
  elsif used > target then st := 'overdue';
  elsif is_paused then st := 'paused';
  elsif used >= target * private.tk_risk_ratio() then st := 'at_risk';
  else st := 'on_track'; end if;
  return jsonb_build_object('target', target, 'consumed', round(used, 2), 'state', st, 'done_at', done_at);
end $$;
revoke all on function private.tk_metric(uuid, text, timestamptz) from public, anon, authenticated;

-- Resumo do ciclo: as duas metas + pior estado (overdue > breached > paused > at_risk > on_track > met).
create function private.tk_cycle_sla(p_cycle uuid, p_at timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare fr jsonb := private.tk_metric(p_cycle, 'first_response', p_at); rs jsonb := private.tk_metric(p_cycle, 'resolution', p_at); worst text; s text;
begin
  worst := 'met';
  foreach s in array array['met', 'on_track', 'at_risk', 'paused', 'breached', 'overdue'] loop
    if fr ->> 'state' = s or rs ->> 'state' = s then worst := s; end if;
  end loop;
  return jsonb_build_object('first_response', fr, 'resolution', rs, 'summary', worst);
end $$;
revoke all on function private.tk_cycle_sla(uuid, timestamptz) from public, anon, authenticated;

-- Abre um ciclo com a política VIGENTE: fixa política, prioridade e metas daquele momento.
create function private.tk_start_cycle(p_ticket uuid, p_at timestamptz) returns uuid
language plpgsql security definer set search_path = '' as $$
declare t public.tickets; pol public.sla_policy_versions; n integer; cid uuid;
begin
  select * into t from public.tickets where id = p_ticket;
  select * into pol from public.sla_policy_versions where organization_id = t.organization_id order by created_at desc, id desc limit 1;
  if not found then raise exception 'nenhuma política de SLA publicada' using errcode = 'P0002'; end if;
  select coalesce(max(cycle_number), 0) + 1 into n from public.ticket_service_cycles where ticket_id = p_ticket;
  insert into public.ticket_service_cycles (organization_id, ticket_id, cycle_number, sla_policy_version_id, priority_snapshot, first_response_target_minutes, resolution_target_minutes, started_at)
  values (t.organization_id, p_ticket, n, pol.id, t.priority, (pol.targets_by_priority -> t.priority ->> 'first_response')::integer, (pol.targets_by_priority -> t.priority ->> 'resolution')::integer, p_at)
  returning ticket_service_cycles.id into cid;
  return cid;
end $$;
revoke all on function private.tk_start_cycle(uuid, timestamptz) from public, anon, authenticated;

commit;
