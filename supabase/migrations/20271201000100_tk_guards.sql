-- Central de Chamados — GUARDAS: autorização das funções, auditoria (só metadados), imutabilidade do histórico, regras de estado e responsável no próprio banco,
-- e criação automática das configurações iniciais (expediente e SLA DEMONSTRATIVOS, editáveis) junto com cada empresa.

begin;
set local check_function_bodies = off;

-- ======================================================================= autorização das funções tk_*
-- nível: owner | manager | staff (owner, gestor, atendente) | requester | any (qualquer perfil com acesso)
create function private.tk_guard(p_org uuid, p_level text) returns void
language plpgsql stable security definer set search_path = '' as $$
declare prof text; ok boolean;
begin
  if (select auth.uid()) is null then raise exception 'sessão inválida' using errcode = '28000'; end if;
  if not private.mfa_ok() then raise exception 'verificação em duas etapas necessária' using errcode = '42501'; end if;
  prof := private.tk_profile(p_org);
  ok := prof is not null and case p_level
    when 'owner' then prof = 'owner'
    when 'manager' then prof in ('owner', 'manager')
    when 'staff' then prof in ('owner', 'manager', 'agent')
    when 'requester' then prof = 'requester'
    else true end;
  if not ok then raise exception 'sem permissão' using errcode = '42501'; end if;
end $$;
revoke all on function private.tk_guard(uuid, text) from public, anon;
grant execute on function private.tk_guard(uuid, text) to authenticated;

create function private.tk_audit(p_org uuid, p_action text, p_entity text, p_entity_id text, p_changes jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_log (organization_id, actor_id, action, entity, entity_id, changes) values (p_org, (select auth.uid()), p_action, p_entity, p_entity_id, p_changes);
end $$;
revoke all on function private.tk_audit(uuid, text, text, text, jsonb) from public, anon, authenticated;

-- Limite de abuso compartilhado (no banco). Ao estourar, a transação é desfeita.
create function private.tk_rate_hit(p_bucket text, p_max integer, p_window_seconds integer) returns void
language plpgsql security definer set search_path = '' as $$
declare w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds); h integer;
begin
  insert into public.ticket_rate_limits as r (bucket, window_start, hits) values (left(p_bucket, 120), w, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1 returning hits into h;
  if h > p_max then raise exception 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente de novo.' using errcode = '54000'; end if;
  if random() < 0.02 then
    delete from public.ticket_rate_limits where window_start < now() - interval '2 days';
    delete from public.mutation_requests where created_at < now() - interval '2 days';
  end if;
end $$;
revoke all on function private.tk_rate_hit(text, integer, integer) from public, anon, authenticated;

-- ======================================================================= updated_at, auditoria (só metadados) e organização imutável
do $$
declare t text;
begin
  foreach t in array array['ticket_settings', 'teams', 'ticket_categories', 'tickets', 'canned_responses'] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()', 'upd_' || t, t);
  end loop;
  foreach t in array array['ticket_settings', 'teams', 'team_members', 'agent_status', 'ticket_categories', 'tickets', 'canned_responses', 'business_calendar_versions', 'sla_policy_versions'] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function private.audit_trigger(%L, %L)',
      'audit_' || t, t, 'organization_id', case t when 'ticket_settings' then 'organization_id' when 'team_members' then 'user_id' when 'agent_status' then 'user_id' else 'id' end);
  end loop;
end $$;

create function private.tk_org_immutable() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.organization_id is distinct from old.organization_id then raise exception 'a organização do registro não pode mudar' using errcode = '23514'; end if;
  return new;
end $$;
revoke all on function private.tk_org_immutable() from public, anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array['teams', 'ticket_categories', 'tickets', 'canned_responses', 'ticket_service_cycles', 'ticket_sla_pauses'] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.tk_org_immutable()', 'orgimm_' || t, t);
  end loop;
end $$;

-- ======================================================================= imutabilidade: histórico nunca se apaga nem se reescreve
create function private.tk_no_delete() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'registro não pode ser apagado (histórico preservado): %', tg_table_name using errcode = '23514'; end $$;
create function private.tk_append_only() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'registro imutável: %', tg_table_name using errcode = '23514'; end $$;
revoke all on function private.tk_no_delete() from public, anon, authenticated;
revoke all on function private.tk_append_only() from public, anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array['tickets', 'ticket_messages', 'ticket_attachments', 'ticket_events', 'ticket_service_cycles', 'ticket_sla_pauses', 'business_calendar_versions', 'sla_policy_versions', 'ticket_categories', 'teams'] loop
    execute format('create trigger %I before delete on public.%I for each row execute function private.tk_no_delete()', 'nodel_' || t, t);
  end loop;
  foreach t in array array['ticket_messages', 'ticket_attachments', 'ticket_events', 'business_calendar_versions', 'sla_policy_versions'] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.tk_append_only()', 'append_' || t, t);
  end loop;
end $$;

-- ======================================================================= chamado: campos imutáveis, transições de estado, versão e responsável
-- Pessoa atribuível: membro ATIVO com perfil de equipe (owner/admin/manager/member) que pertence à equipe do chamado.
create function private.tk_assignable(p_org uuid, p_team uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
    join public.team_members tm on tm.organization_id = m.organization_id and tm.user_id = m.user_id and tm.team_id = p_team
    where m.organization_id = p_org and m.user_id = p_user and m.role in ('owner', 'admin', 'manager', 'member')
      and not exists (select 1 from public.agent_status s where s.organization_id = p_org and s.user_id = p_user and not s.active));
$$;
revoke all on function private.tk_assignable(uuid, uuid, uuid) from public, anon, authenticated;

create function private.tk_ticket_guard() returns trigger language plpgsql set search_path = '' as $$
declare meta text[] := array['subject', 'category_id', 'priority', 'status', 'team_id', 'assigned_user_id'];
begin
  if new.id <> old.id or new.ticket_number <> old.ticket_number or new.requester_user_id <> old.requester_user_id or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'identidade do chamado (número, solicitante, autoria) é imutável' using errcode = '23514';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'open' and new.status in ('in_progress', 'waiting_requester', 'resolved'))
    or (old.status = 'in_progress' and new.status in ('waiting_requester', 'resolved'))
    or (old.status = 'waiting_requester' and new.status in ('in_progress', 'resolved'))
    or (old.status = 'resolved' and new.status in ('closed', 'open', 'in_progress'))
    or (old.status = 'closed' and new.status in ('open', 'in_progress'))) then
    raise exception 'transição de status inválida: % → %', old.status, new.status using errcode = '23514';
  end if;
  if new.assigned_user_id is not null and (tg_op = 'INSERT' or new.assigned_user_id is distinct from old.assigned_user_id or new.team_id is distinct from old.team_id) then
    if new.team_id is null or not private.tk_assignable(new.organization_id, new.team_id, new.assigned_user_id) then
      raise exception 'responsável inválido: precisa ser atendente ativo da equipe do chamado' using errcode = '23514';
    end if;
  end if;
  if (to_jsonb(new) - 'version' - 'updated_at' - 'last_public_activity_at') is distinct from (to_jsonb(old) - 'version' - 'updated_at' - 'last_public_activity_at') then
    new.version := old.version + 1;
  end if;
  return new;
end $$;
revoke all on function private.tk_ticket_guard() from public, anon, authenticated;
create trigger ticket_guard before update on public.tickets for each row execute function private.tk_ticket_guard();

create function private.tk_ticket_insert_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.assigned_user_id is not null and (new.team_id is null or not private.tk_assignable(new.organization_id, new.team_id, new.assigned_user_id)) then
    raise exception 'responsável inválido: precisa ser atendente ativo da equipe do chamado' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function private.tk_ticket_insert_guard() from public, anon, authenticated;
create trigger ticket_insert_guard before insert on public.tickets for each row execute function private.tk_ticket_insert_guard();

-- Ciclo: metas, política e prioridade-base são fixadas no início; só os três marcos (primeira resposta, resolução, encerramento) são preenchidos, uma vez.
create function private.tk_cycle_guard() returns trigger language plpgsql set search_path = '' as $$
declare keep text[] := array['first_response_at', 'resolved_at', 'closed_at'];
begin
  if (to_jsonb(new) - keep) is distinct from (to_jsonb(old) - keep) then
    raise exception 'metas, política e prioridade do ciclo são fixadas no início e não mudam' using errcode = '23514';
  end if;
  if (old.first_response_at is not null and new.first_response_at is distinct from old.first_response_at)
     or (old.resolved_at is not null and new.resolved_at is distinct from old.resolved_at)
     or (old.closed_at is not null and new.closed_at is distinct from old.closed_at) then
    raise exception 'marcos do ciclo já registrados não podem ser alterados' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function private.tk_cycle_guard() from public, anon, authenticated;
create trigger cycle_guard before update on public.ticket_service_cycles for each row execute function private.tk_cycle_guard();

create function private.tk_pause_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.service_cycle_id <> old.service_cycle_id or new.started_at <> old.started_at or old.ended_at is not null then
    raise exception 'pausa de SLA só pode ser encerrada, uma vez' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function private.tk_pause_guard() from public, anon, authenticated;
create trigger pause_guard before update on public.ticket_sla_pauses for each row execute function private.tk_pause_guard();

-- ======================================================================= configurações iniciais da empresa (expediente e SLA demonstrativos, editáveis)
create function private.tk_default_calendar() returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('weekly', jsonb_build_object(
    '1', jsonb_build_array(jsonb_build_array('09:00', '12:00'), jsonb_build_array('13:00', '18:00')),
    '2', jsonb_build_array(jsonb_build_array('09:00', '12:00'), jsonb_build_array('13:00', '18:00')),
    '3', jsonb_build_array(jsonb_build_array('09:00', '12:00'), jsonb_build_array('13:00', '18:00')),
    '4', jsonb_build_array(jsonb_build_array('09:00', '12:00'), jsonb_build_array('13:00', '18:00')),
    '5', jsonb_build_array(jsonb_build_array('09:00', '12:00'), jsonb_build_array('13:00', '18:00'))), 'closed_dates', '[]'::jsonb);
$$;
-- Valores iniciais DEMONSTRATIVOS (minutos úteis). Não são compromisso universal: cada empresa define os seus.
create function private.tk_default_targets() returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'low', jsonb_build_object('first_response', 480, 'resolution', 2400),
    'normal', jsonb_build_object('first_response', 240, 'resolution', 1440),
    'high', jsonb_build_object('first_response', 60, 'resolution', 480),
    'urgent', jsonb_build_object('first_response', 30, 'resolution', 240));
$$;
revoke all on function private.tk_default_calendar(), private.tk_default_targets() from public, anon, authenticated;

create function private.tk_bootstrap_org() returns trigger language plpgsql security definer set search_path = '' as $$
declare cal uuid;
begin
  insert into public.ticket_settings (organization_id) values (new.id) on conflict do nothing;
  insert into public.ticket_counters (organization_id) values (new.id) on conflict do nothing;
  insert into public.business_calendar_versions (organization_id, timezone, definition) values (new.id, 'America/Sao_Paulo', private.tk_default_calendar()) returning id into cal;
  insert into public.sla_policy_versions (organization_id, business_calendar_version_id, targets_by_priority) values (new.id, cal, private.tk_default_targets());
  return null;
end $$;
revoke all on function private.tk_bootstrap_org() from public, anon, authenticated;
create trigger tk_bootstrap_org after insert on public.organizations for each row execute function private.tk_bootstrap_org();

commit;
