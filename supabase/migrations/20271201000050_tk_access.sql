-- Central de Chamados — ACESSO: perfis derivados do papel do Core + RLS somente de LEITURA. Escrita: exclusivamente funções tk_* (SECURITY DEFINER).
-- Perfis: owner (owner/admin do Core) · manager (gestor) · agent (member ativo: atende chamados atribuídos a ele ou às suas equipes) · requester (viewer: só os próprios chamados).
-- O solicitante NÃO é um atendente com menus ocultos: o banco nunca lhe entrega notas internas, SLA, equipes nem chamados alheios.

begin;
set local check_function_bodies = off;

create function private.tk_role(org uuid) returns public.org_role
language sql stable security definer set search_path = '' as $$
  select m.role from public.organization_members m where m.organization_id = org and m.user_id = (select auth.uid());
$$;

create function private.tk_agent_active(org uuid, uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.agent_status s where s.organization_id = org and s.user_id = uid and not s.active);
$$;

-- owner | manager | agent | requester | null
create function private.tk_profile(org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case private.tk_role(org)
    when 'owner' then 'owner' when 'admin' then 'owner'
    when 'manager' then case when private.tk_agent_active(org, (select auth.uid())) then 'manager' end
    when 'member' then case when private.tk_agent_active(org, (select auth.uid())) then 'agent' end
    when 'viewer' then 'requester'
  end;
$$;
create function private.tk_is_owner(org uuid) returns boolean language sql stable security definer set search_path = '' as $$ select coalesce(private.tk_profile(org) = 'owner', false); $$;
create function private.tk_is_manager(org uuid) returns boolean language sql stable security definer set search_path = '' as $$ select coalesce(private.tk_profile(org) in ('owner', 'manager'), false); $$;
create function private.tk_is_staff(org uuid) returns boolean language sql stable security definer set search_path = '' as $$ select coalesce(private.tk_profile(org) in ('owner', 'manager', 'agent'), false); $$;

create function private.tk_in_team(org uuid, team uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select team is not null and exists (select 1 from public.team_members t where t.organization_id = org and t.team_id = team and t.user_id = (select auth.uid()));
$$;

-- Quem enxerga o chamado: gestão vê todos; atendente vê os atribuídos a ele ou às suas equipes; solicitante vê só os próprios.
create function private.tk_ticket_visible(org uuid, team uuid, assignee uuid, requester uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(case private.tk_profile(org)
    when 'owner' then true when 'manager' then true
    when 'agent' then coalesce(assignee = (select auth.uid()), false) or private.tk_in_team(org, team)
    when 'requester' then requester = (select auth.uid())
    else false end, false);
$$;

-- 'staff' | 'requester' | null para um chamado específico.
create function private.tk_ticket_access(org uuid, ticket uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when private.tk_profile(org) = 'requester' then 'requester' else 'staff' end
  from public.tickets t where t.id = ticket and t.organization_id = org and private.tk_ticket_visible(org, t.team_id, t.assigned_user_id, t.requester_user_id);
$$;

-- Visibilidade de uma mensagem (ou de um anexo, que herda a da mensagem).
create function private.tk_message_visible(org uuid, ticket uuid, vis text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.tk_ticket_access(org, ticket) when 'staff' then true when 'requester' then vis = 'public' else false end;
$$;
create function private.tk_attachment_visible(org uuid, ticket uuid, msg uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.ticket_messages m where m.id = msg and m.ticket_id = ticket and m.organization_id = org and private.tk_message_visible(org, ticket, m.visibility));
$$;

revoke all on function private.tk_role(uuid), private.tk_agent_active(uuid, uuid), private.tk_profile(uuid), private.tk_is_owner(uuid), private.tk_is_manager(uuid), private.tk_is_staff(uuid),
  private.tk_in_team(uuid, uuid), private.tk_ticket_visible(uuid, uuid, uuid, uuid), private.tk_ticket_access(uuid, uuid), private.tk_message_visible(uuid, uuid, text),
  private.tk_attachment_visible(uuid, uuid, uuid) from public, anon;
grant execute on function private.tk_role(uuid), private.tk_agent_active(uuid, uuid), private.tk_profile(uuid), private.tk_is_owner(uuid), private.tk_is_manager(uuid), private.tk_is_staff(uuid),
  private.tk_in_team(uuid, uuid), private.tk_ticket_visible(uuid, uuid, uuid, uuid), private.tk_ticket_access(uuid, uuid), private.tk_message_visible(uuid, uuid, text),
  private.tk_attachment_visible(uuid, uuid, uuid) to authenticated;

-- ======================================================================= RLS: leitura por perfil
do $$
declare t text;
begin
  foreach t in array array['ticket_settings', 'teams', 'team_members', 'agent_status', 'ticket_categories', 'business_calendar_versions', 'sla_policy_versions', 'ticket_counters', 'tickets',
    'ticket_messages', 'ticket_attachments', 'ticket_events', 'ticket_service_cycles', 'ticket_sla_pauses', 'canned_responses', 'notifications', 'mutation_requests', 'ticket_rate_limits'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

create policy tk_settings_read on public.ticket_settings for select to authenticated using (private.tk_profile(organization_id) is not null);
create policy tk_teams_read on public.teams for select to authenticated using (private.tk_is_staff(organization_id));
create policy tk_team_members_read on public.team_members for select to authenticated using (private.tk_is_manager(organization_id) or user_id = (select auth.uid()));
create policy tk_agent_status_read on public.agent_status for select to authenticated using (private.tk_is_manager(organization_id));
create policy tk_categories_read on public.ticket_categories for select to authenticated using (private.tk_is_staff(organization_id) or (private.tk_profile(organization_id) = 'requester' and active));
create policy tk_calendars_read on public.business_calendar_versions for select to authenticated using (private.tk_is_staff(organization_id));
create policy tk_policies_read on public.sla_policy_versions for select to authenticated using (private.tk_is_staff(organization_id));
create policy tk_tickets_read on public.tickets for select to authenticated using (private.tk_ticket_visible(organization_id, team_id, assigned_user_id, requester_user_id));
create policy tk_messages_read on public.ticket_messages for select to authenticated using (private.tk_message_visible(organization_id, ticket_id, visibility));
create policy tk_attachments_read on public.ticket_attachments for select to authenticated using (private.tk_attachment_visible(organization_id, ticket_id, message_id));
create policy tk_events_read on public.ticket_events for select to authenticated using (private.tk_is_staff(organization_id) and private.tk_ticket_access(organization_id, ticket_id) = 'staff');
create policy tk_cycles_read on public.ticket_service_cycles for select to authenticated using (private.tk_is_staff(organization_id) and private.tk_ticket_access(organization_id, ticket_id) = 'staff');
create policy tk_pauses_read on public.ticket_sla_pauses for select to authenticated using (private.tk_is_staff(organization_id) and exists (
  select 1 from public.ticket_service_cycles c where c.id = service_cycle_id and private.tk_ticket_access(c.organization_id, c.ticket_id) = 'staff'));
create policy tk_canned_read on public.canned_responses for select to authenticated using (private.tk_is_staff(organization_id));
create policy tk_notifications_read on public.notifications for select to authenticated using (recipient_user_id = (select auth.uid()) and private.tk_profile(organization_id) is not null);
-- ticket_counters, mutation_requests e ticket_rate_limits: SEM política (ninguém lê pela API; só as funções tk_*).

-- Nenhum privilégio de escrita direta; leitura só nas tabelas com política.
do $$
declare t text;
begin
  foreach t in array array['ticket_settings', 'teams', 'team_members', 'agent_status', 'ticket_categories', 'business_calendar_versions', 'sla_policy_versions', 'ticket_counters', 'tickets',
    'ticket_messages', 'ticket_attachments', 'ticket_events', 'ticket_service_cycles', 'ticket_sla_pauses', 'canned_responses', 'notifications', 'mutation_requests', 'ticket_rate_limits'] loop
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
  foreach t in array array['ticket_settings', 'teams', 'team_members', 'agent_status', 'ticket_categories', 'business_calendar_versions', 'sla_policy_versions', 'tickets',
    'ticket_messages', 'ticket_attachments', 'ticket_events', 'ticket_service_cycles', 'ticket_sla_pauses', 'canned_responses', 'notifications'] loop
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

commit;
