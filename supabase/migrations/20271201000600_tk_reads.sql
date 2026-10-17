-- Central de Chamados — LEITURAS (RPCs tk_*): fila com filtros e paginação no servidor, detalhe do chamado, painel, exportação, anexos e notificações.
-- O DTO do solicitante é montado AQUI, no banco: notas internas, eventos, SLA, equipes e e-mails de colegas nunca saem para quem não é equipe.

begin;
set local check_function_bodies = off;

create function private.tk_pname(p_uid uuid, p_staff_view boolean) returns text
language sql stable security definer set search_path = '' as $$
  select case when p_staff_view then coalesce(nullif(btrim(p.full_name), ''), p.email) else coalesce(nullif(btrim(p.full_name), ''), 'Atendimento') end
  from public.profiles p where p.id = p_uid;
$$;
revoke all on function private.tk_pname(uuid, boolean) from public, anon, authenticated;

-- Chamados que o usuário atual enxerga, com os filtros pedidos (sem paginação). Solicitante: sempre limitado aos próprios e sem filtros de equipe/SLA.
-- Filtros (jsonb): q · status[] · priority · category · team · assignee ('none' | 'me' | uuid) · requester · from · to (datas no fuso da empresa) · sla · view (mine|unassigned|waiting|overdue|resolved|all)
create function private.tk_filtered(p_org uuid, f jsonb, p_limit integer) returns setof public.tickets
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid()); prof text := private.tk_profile(p_org); tz text; q text; st text[]; pr text; cat uuid; team uuid; asg text; req uuid; d_from timestamptz; d_to timestamptz; sla text; vw text;
begin
  if prof is null then return; end if;
  select timezone into tz from public.ticket_settings where organization_id = p_org;
  f := coalesce(f, '{}'::jsonb);
  q := nullif(btrim(coalesce(f ->> 'q', '')), ''); q := left(q, 100);
  st := array(select jsonb_array_elements_text(case when jsonb_typeof(f -> 'status') = 'array' then f -> 'status' else '[]'::jsonb end));
  pr := nullif(f ->> 'priority', ''); vw := coalesce(nullif(f ->> 'view', ''), 'all');
  cat := nullif(f ->> 'category', '')::uuid;
  if prof = 'requester' then
    req := uid; asg := null; team := null; sla := null; if vw not in ('all', 'resolved', 'waiting') then vw := 'all'; end if;
  else
    team := nullif(f ->> 'team', '')::uuid; asg := nullif(f ->> 'assignee', ''); req := nullif(f ->> 'requester', '')::uuid; sla := nullif(f ->> 'sla', '');
  end if;
  if nullif(f ->> 'from', '') is not null then d_from := ((f ->> 'from')::date)::timestamp at time zone tz; end if;
  if nullif(f ->> 'to', '') is not null then d_to := (((f ->> 'to')::date) + 1)::timestamp at time zone tz; end if;
  return query
  select t.* from public.tickets t
  left join lateral (select c.id from public.ticket_service_cycles c where c.ticket_id = t.id and c.closed_at is null limit 1) ac on true
  where t.organization_id = p_org
    and private.tk_ticket_visible(p_org, t.team_id, t.assigned_user_id, t.requester_user_id)
    and (req is null or t.requester_user_id = req)
    and (q is null or t.ticket_number::text = ltrim(q, '#') or t.subject ilike '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%')
    and (cardinality(st) = 0 or t.status = any (st))
    and (pr is null or t.priority = pr)
    and (cat is null or t.category_id = cat)
    and (team is null or t.team_id = team)
    and (asg is null or (asg = 'none' and t.assigned_user_id is null) or (asg = 'me' and t.assigned_user_id = uid) or (asg ~ '^[0-9a-f-]{36}$' and t.assigned_user_id = asg::uuid))
    and (d_from is null or t.created_at >= d_from) and (d_to is null or t.created_at < d_to)
    and case vw
      when 'mine' then t.assigned_user_id = uid and t.status in ('open', 'in_progress', 'waiting_requester')
      when 'unassigned' then t.assigned_user_id is null and t.status in ('open', 'in_progress', 'waiting_requester')
      when 'waiting' then t.status = 'waiting_requester'
      when 'resolved' then t.status in ('resolved', 'closed')
      when 'overdue' then t.status in ('open', 'in_progress', 'waiting_requester') and ac.id is not null and private.tk_cycle_sla(ac.id, now()) ->> 'summary' = 'overdue'
      else true end
    and case when sla is null then true else ac.id is not null and private.tk_cycle_sla(ac.id, now()) ->> 'summary' = sla end
  limit p_limit;
end $$;
revoke all on function private.tk_filtered(uuid, jsonb, integer) from public, anon, authenticated;

create function public.tk_queue(p_org uuid, p_filters jsonb, p_page integer, p_size integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare prof text; size integer := least(greatest(coalesce(p_size, 25), 1), 50); pg integer := greatest(coalesce(p_page, 1), 1); total integer; rows jsonb; sort text; staff boolean;
begin
  perform private.tk_guard(p_org, 'any');
  prof := private.tk_profile(p_org); staff := prof <> 'requester';
  sort := coalesce(p_filters ->> 'sort', 'created');
  select count(*) into total from private.tk_filtered(p_org, p_filters, 5000);
  select coalesce(jsonb_agg(q.r order by q.ord), '[]'::jsonb) into rows from (
    select t.ord, jsonb_build_object(
      'id', t.id, 'number', t.ticket_number, 'subject', t.subject, 'status', t.status, 'priority', t.priority, 'version', t.version,
      'category_id', t.category_id, 'category', c.name, 'created_at', t.created_at, 'last_public_activity_at', t.last_public_activity_at,
      'requester_id', t.requester_user_id, 'requester', private.tk_pname(t.requester_user_id, true),
      'team_id', case when staff then t.team_id end, 'team', case when staff then tm.name end,
      'assigned_user_id', case when staff then t.assigned_user_id end, 'assignee', case when staff then private.tk_pname(t.assigned_user_id, true) end,
      'sla', case when staff then (select private.tk_cycle_sla(ac.id, now()) from public.ticket_service_cycles ac where ac.ticket_id = t.id and ac.closed_at is null) end) as r
    from (select * from (select x.*, row_number() over (order by case when sort = 'priority' then array_position(array['urgent', 'high', 'normal', 'low'], x.priority) end,
                   case when sort = 'activity' then x.last_public_activity_at end desc, x.created_at desc, x.ticket_number desc) as ord
                from private.tk_filtered(p_org, p_filters, 5000) x) o where o.ord > (pg - 1) * size and o.ord <= pg * size) t
    left join public.ticket_categories c on c.id = t.category_id
    left join public.teams tm on tm.id = t.team_id) q;
  return jsonb_build_object('rows', rows, 'total', total, 'page', pg, 'size', size);
end $$;

-- Detalhe: chamado + conversa (já filtrada pela visibilidade) + anexos + (equipe) eventos, ciclos com SLA e calendário vigente do ciclo.
create function public.tk_ticket_detail(p_org uuid, p_ticket uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare prof text; staff boolean; t public.tickets; st public.ticket_settings; out jsonb; msgs jsonb; atts jsonb; evs jsonb := '[]'::jsonb; cycles jsonb := '[]'::jsonb; cal jsonb := null; ac uuid; oc public.ticket_service_cycles;
begin
  perform private.tk_guard(p_org, 'any');
  prof := private.tk_profile(p_org); staff := prof <> 'requester';
  t := private.tk_load_ticket(p_org, p_ticket, false, null);
  select * into st from public.ticket_settings where organization_id = p_org;
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.author_kind, 'visibility', m.visibility, 'body', m.body, 'created_at', m.created_at,
    'author_id', case when staff or m.author_kind = 'requester' then m.author_user_id end, 'author', private.tk_pname(m.author_user_id, staff or m.author_kind = 'requester'),
    'on_behalf', m.author_kind = 'requester' and m.author_user_id <> t.requester_user_id) order by m.created_at, m.id), '[]'::jsonb)
    into msgs from public.ticket_messages m where m.ticket_id = p_ticket and (staff or m.visibility = 'public');
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'message_id', a.message_id, 'filename', a.original_filename, 'mime', a.mime_type, 'size', a.size_bytes) order by a.created_at), '[]'::jsonb)
    into atts from public.ticket_attachments a join public.ticket_messages m on m.id = a.message_id where a.ticket_id = p_ticket and (staff or m.visibility = 'public');
  select * into oc from public.ticket_service_cycles where ticket_id = p_ticket order by cycle_number desc limit 1;
  if staff then
    select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'type', e.event_type, 'actor', private.tk_pname(e.actor_user_id, true), 'meta', e.safe_metadata, 'created_at', e.created_at) order by e.id), '[]'::jsonb)
      into evs from public.ticket_events e where e.ticket_id = p_ticket;
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'cycle', c.cycle_number, 'priority', c.priority_snapshot, 'started_at', c.started_at, 'first_response_at', c.first_response_at,
      'resolved_at', c.resolved_at, 'closed_at', c.closed_at, 'sla', private.tk_cycle_sla(c.id, now()),
      'paused', exists (select 1 from public.ticket_sla_pauses p where p.service_cycle_id = c.id and p.ended_at is null),
      'pauses', coalesce((select jsonb_agg(jsonb_build_object('started_at', p.started_at, 'ended_at', p.ended_at) order by p.started_at) from public.ticket_sla_pauses p where p.service_cycle_id = c.id), '[]'::jsonb)) order by c.cycle_number desc), '[]'::jsonb)
      into cycles from public.ticket_service_cycles c where c.ticket_id = p_ticket;
    ac := private.tk_active_cycle(p_ticket);
    if ac is not null then select jsonb_build_object('definition', x.def, 'timezone', x.tz) into cal from private.tk_cycle_calendar(ac) x; end if;
  end if;
  out := jsonb_build_object(
    'ticket', jsonb_build_object('id', t.id, 'number', t.ticket_number, 'subject', t.subject, 'status', t.status, 'priority', t.priority, 'version', t.version, 'category_id', t.category_id,
      'category', (select name from public.ticket_categories where id = t.category_id), 'created_at', t.created_at, 'updated_at', t.updated_at,
      'requester_id', t.requester_user_id, 'requester', private.tk_pname(t.requester_user_id, true),
      'team_id', case when staff then t.team_id end, 'team', case when staff then (select name from public.teams where id = t.team_id) end,
      'assigned_user_id', case when staff then t.assigned_user_id end, 'assignee', case when staff then private.tk_pname(t.assigned_user_id, true) end),
    'messages', msgs, 'attachments', atts, 'events', evs, 'cycles', cycles, 'calendar', cal,
    'reopen', jsonb_build_object('window_hours', st.reopen_window_hours, 'until', case when oc.resolved_at is not null then oc.resolved_at + make_interval(hours => st.reopen_window_hours) end,
      'allowed', t.status in ('resolved', 'closed') and oc.resolved_at is not null and now() <= oc.resolved_at + make_interval(hours => st.reopen_window_hours)),
    'viewer', jsonb_build_object('profile', prof, 'user_id', (select auth.uid())));
  return out;
end $$;

-- Anexo: devolve o caminho SOMENTE se o usuário pode ver a mensagem dona do anexo (a URL assinada é gerada pelo servidor DEPOIS disto).
create function public.tk_attachment_info(p_org uuid, p_attachment uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.ticket_attachments;
begin
  perform private.tk_guard(p_org, 'any');
  select * into a from public.ticket_attachments where id = p_attachment and organization_id = p_org;
  if not found or not private.tk_attachment_visible(p_org, a.ticket_id, a.message_id) then raise exception 'anexo não encontrado' using errcode = 'P0002'; end if;
  return jsonb_build_object('path', a.storage_path, 'filename', a.original_filename, 'mime', a.mime_type);
end $$;

-- Uploads órfãos (enviados ao Storage mas nunca vinculados a uma mensagem), com mais de 2 horas. Só lista; quem remove é a gestão, pela API do Storage.
create function public.tk_orphan_uploads(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.tk_guard(p_org, 'manager');
  if to_regclass('storage.objects') is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(o.name) from (
    select name from storage.objects where bucket_id = 'tk-attachments' and name like p_org::text || '/%' and created_at < now() - interval '2 hours'
      and not exists (select 1 from public.ticket_attachments a where a.storage_path = storage.objects.name) limit 200) o), '[]'::jsonb);
end $$;

create function public.tk_notifications(p_org uuid, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  perform private.tk_guard(p_org, 'any');
  return jsonb_build_object(
    'unread', (select count(*) from public.notifications n where n.organization_id = p_org and n.recipient_user_id = uid and n.read_at is null),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'type', n.event_type, 'ticket_id', n.ticket_id, 'number', t.ticket_number, 'subject', t.subject, 'read', n.read_at is not null, 'created_at', n.created_at) order by n.id desc)
      from (select * from public.notifications x where x.organization_id = p_org and x.recipient_user_id = uid order by x.id desc limit least(greatest(coalesce(p_limit, 20), 1), 100)) n
      join public.tickets t on t.id = n.ticket_id), '[]'::jsonb));
end $$;

-- ======================================================================= painel (dados reais; denominador zero = null → «Sem dados»)
-- Por CICLO: ciclos resolvidos, reabertos e cumprimento de SLA. Por CHAMADO: criados, backlog e distribuições.
create function public.tk_dashboard(p_org uuid, p_from date, p_to date, p_team uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid()); prof text; tz text; a timestamptz; b timestamptz; created integer; backlog jsonb; bycat jsonb; bypri jsonb; load jsonb;
  fr_n integer := 0; fr_in integer := 0; fr_sum numeric := 0; fr_vals numeric[] := '{}'; rs_n integer := 0; rs_in integer := 0; rs_sum numeric := 0; rs_vals numeric[] := '{}';
  reopened_cycles integer; reopened_tickets integer; od_fr integer := 0; od_rs integer := 0; c record; used numeric; m jsonb; scope uuid[];
begin
  perform private.tk_guard(p_org, 'staff');
  prof := private.tk_profile(p_org);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'período inválido (máximo de 400 dias)' using errcode = '22023'; end if;
  select timezone into tz from public.ticket_settings where organization_id = p_org;
  a := p_from::timestamp at time zone tz; b := (p_to + 1)::timestamp at time zone tz;

  select coalesce(array_agg(t.id), '{}') into scope from public.tickets t where t.organization_id = p_org and (p_team is null or t.team_id = p_team)
    and private.tk_ticket_visible(p_org, t.team_id, t.assigned_user_id, t.requester_user_id);

  select count(*) into created from public.tickets t where t.id = any (scope) and t.created_at >= a and t.created_at < b;
  select jsonb_build_object(
    'open', count(*) filter (where t.status = 'open'), 'in_progress', count(*) filter (where t.status = 'in_progress'), 'waiting_requester', count(*) filter (where t.status = 'waiting_requester'),
    'unassigned', count(*) filter (where t.assigned_user_id is null), 'total', count(*)) into backlog
    from public.tickets t where t.id = any (scope) and t.status in ('open', 'in_progress', 'waiting_requester');
  select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'count', x.n) order by x.n desc, x.name), '[]'::jsonb) into bycat from (
    select coalesce(c2.name, 'Sem categoria') as name, count(*) as n from public.tickets t left join public.ticket_categories c2 on c2.id = t.category_id
    where t.id = any (scope) and t.created_at >= a and t.created_at < b group by 1) x;
  select coalesce(jsonb_object_agg(x.priority, x.n), '{}'::jsonb) into bypri from (
    select t.priority, count(*) as n from public.tickets t where t.id = any (scope) and t.created_at >= a and t.created_at < b group by 1) x;
  -- carga ATUAL por atendente (informação de distribuição, não avaliação de qualidade): ordem alfabética; atendente vê só a própria
  select coalesce(jsonb_agg(jsonb_build_object('user_id', x.u, 'name', x.name, 'open', x.n) order by x.name), '[]'::jsonb) into load from (
    select t.assigned_user_id as u, private.tk_pname(t.assigned_user_id, true) as name, count(*) as n from public.tickets t where t.id = any (scope)
    and t.assigned_user_id is not null and t.status in ('open', 'in_progress', 'waiting_requester') and (prof <> 'agent' or t.assigned_user_id = uid) group by t.assigned_user_id) x;

  for c in select cy.* from public.ticket_service_cycles cy where cy.ticket_id = any (scope) and cy.first_response_at >= a and cy.first_response_at < b loop
    used := private.tk_consumed(c.id, 'first_response', c.first_response_at);
    fr_n := fr_n + 1; fr_sum := fr_sum + used; fr_vals := fr_vals || used; if used <= c.first_response_target_minutes then fr_in := fr_in + 1; end if;
  end loop;
  for c in select cy.* from public.ticket_service_cycles cy where cy.ticket_id = any (scope) and cy.resolved_at >= a and cy.resolved_at < b loop
    used := private.tk_consumed(c.id, 'resolution', c.resolved_at);
    rs_n := rs_n + 1; rs_sum := rs_sum + used; rs_vals := rs_vals || used; if used <= c.resolution_target_minutes then rs_in := rs_in + 1; end if;
  end loop;
  select count(*), count(distinct cy.ticket_id) into reopened_cycles, reopened_tickets from public.ticket_service_cycles cy where cy.ticket_id = any (scope)
    and cy.cycle_number > 1 and cy.started_at >= a and cy.started_at < b;
  -- ciclos ABERTOS já atrasados (não ficam escondidos por só contar ciclos concluídos)
  for c in select cy.* from public.ticket_service_cycles cy where cy.ticket_id = any (scope) and cy.closed_at is null loop
    m := private.tk_cycle_sla(c.id, now());
    if m -> 'first_response' ->> 'state' = 'overdue' then od_fr := od_fr + 1; end if;
    if m -> 'resolution' ->> 'state' = 'overdue' then od_rs := od_rs + 1; end if;
  end loop;

  return jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', tz),
    'created_tickets', created, 'backlog', backlog, 'resolved_cycles', rs_n, 'reopened_cycles', reopened_cycles, 'reopened_tickets', reopened_tickets,
    'by_category', bycat, 'by_priority', bypri, 'workload', load,
    'first_response', jsonb_build_object('cycles', fr_n, 'within_target', fr_in, 'rate', case when fr_n = 0 then null else round(fr_in * 100.0 / fr_n, 1) end,
      'avg_minutes', case when fr_n = 0 then null else round(fr_sum / fr_n, 1) end,
      'median_minutes', (select case when fr_n = 0 then null else round(percentile_cont(0.5) within group (order by v)::numeric, 1) end from unnest(fr_vals) v)),
    'resolution', jsonb_build_object('cycles', rs_n, 'within_target', rs_in, 'rate', case when rs_n = 0 then null else round(rs_in * 100.0 / rs_n, 1) end,
      'avg_minutes', case when rs_n = 0 then null else round(rs_sum / rs_n, 1) end,
      'median_minutes', (select case when rs_n = 0 then null else round(percentile_cont(0.5) within group (order by v)::numeric, 1) end from unnest(rs_vals) v)),
    'overdue_open', jsonb_build_object('first_response', od_fr, 'resolution', od_rs));
end $$;

-- Linhas para o CSV (mesmos filtros e permissões da fila; no máximo 5000). Sem e-mail nem corpo de mensagem: só o necessário para acompanhamento.
create function public.tk_export_rows(p_org uuid, p_filters jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare staff boolean;
begin
  perform private.tk_guard(p_org, 'staff');
  return coalesce((select jsonb_agg(r) from (
    select jsonb_build_object('number', t.ticket_number, 'subject', t.subject, 'status', t.status, 'priority', t.priority, 'category', c.name, 'team', tm.name,
      'assignee', private.tk_pname(t.assigned_user_id, true), 'requester', private.tk_pname(t.requester_user_id, true), 'created_at', t.created_at, 'last_public_activity_at', t.last_public_activity_at,
      'cycles', (select count(*) from public.ticket_service_cycles cy where cy.ticket_id = t.id),
      'resolved_at', (select max(cy.resolved_at) from public.ticket_service_cycles cy where cy.ticket_id = t.id),
      'sla', (select private.tk_cycle_sla(cy.id, now()) ->> 'summary' from public.ticket_service_cycles cy where cy.ticket_id = t.id order by cy.cycle_number desc limit 1)) as r
    from private.tk_filtered(p_org, p_filters, 5000) t left join public.ticket_categories c on c.id = t.category_id left join public.teams tm on tm.id = t.team_id
    order by t.created_at desc) q), '[]'::jsonb);
end $$;

create function public.tk_log_export(p_org uuid, p_rows integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.tk_guard(p_org, 'staff');
  perform private.tk_audit(p_org, 'export', 'tickets', null, jsonb_build_object('rows', greatest(coalesce(p_rows, 0), 0)));
end $$;

commit;
