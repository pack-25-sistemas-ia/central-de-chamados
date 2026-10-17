-- Central de Chamados — CADASTROS (RPCs tk_*): equipes, membros de equipe, categorias, respostas prontas, configurações, publicação de SLA e ativação de atendentes.
-- Toda função: SECURITY DEFINER, search_path vazio, valida sessão + MFA + perfil (private.tk_guard) e confere que os ids pertencem à MESMA empresa.

begin;
set local check_function_bodies = off;

create function private.tk_req_text(p text, p_min integer, p_max integer, p_what text) returns text
language plpgsql immutable set search_path = '' as $$
declare s text := btrim(coalesce(p, ''));
begin
  if char_length(s) < p_min or char_length(s) > p_max then raise exception '% deve ter entre % e % caracteres', p_what, p_min, p_max using errcode = '22023'; end if;
  return s;
end $$;
create function private.tk_opt_text(p text, p_max integer, p_what text) returns text
language plpgsql immutable set search_path = '' as $$
declare s text := nullif(btrim(coalesce(p, '')), '');
begin
  if s is not null and char_length(s) > p_max then raise exception '% deve ter no máximo % caracteres', p_what, p_max using errcode = '22023'; end if;
  return s;
end $$;
revoke all on function private.tk_req_text(text, integer, integer, text), private.tk_opt_text(text, integer, text) from public, anon, authenticated;

-- Perfil de um usuário QUALQUER (as helpers de RLS usam auth.uid(); notificações e validações precisam olhar para outras pessoas).
create function private.tk_profile_of(p_org uuid, p_uid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case m.role
    when 'owner' then 'owner' when 'admin' then 'owner'
    when 'manager' then case when private.tk_agent_active(p_org, p_uid) then 'manager' end
    when 'member' then case when private.tk_agent_active(p_org, p_uid) then 'agent' end
    when 'viewer' then 'requester' end
  from public.organization_members m where m.organization_id = p_org and m.user_id = p_uid;
$$;
revoke all on function private.tk_profile_of(uuid, uuid) from public, anon, authenticated;

-- Contexto do usuário (perfil e equipes) para a interface.
create function public.tk_my_context(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'sessão inválida' using errcode = '28000'; end if;
  return jsonb_build_object('profile', private.tk_profile(p_org), 'user_id', (select auth.uid()),
    'teams', coalesce((select jsonb_agg(t.team_id) from public.team_members t where t.organization_id = p_org and t.user_id = (select auth.uid())), '[]'::jsonb));
end $$;

-- Pessoas da empresa com nome (para filtros e atribuição). Só a equipe enxerga; o e-mail só aparece para quem é da equipe.
create function public.tk_people(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.tk_guard(p_org, 'staff');
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role, 'profile', private.tk_profile_of(p_org, m.user_id), 'name', coalesce(nullif(btrim(p.full_name), ''), p.email), 'email', p.email,
      'active', private.tk_agent_active(p_org, m.user_id), 'teams', coalesce((select jsonb_agg(tm.team_id) from public.team_members tm where tm.organization_id = p_org and tm.user_id = m.user_id), '[]'::jsonb))
      order by coalesce(nullif(btrim(p.full_name), ''), p.email))
    from public.organization_members m left join public.profiles p on p.id = m.user_id where m.organization_id = p_org), '[]'::jsonb);
end $$;

-- ======================================================================= equipes
create function public.tk_save_team(p_org uuid, p_id uuid, p_name text, p_active boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare nm text; rid uuid;
begin
  perform private.tk_guard(p_org, 'manager');
  nm := private.tk_req_text(p_name, 2, 60, 'Nome da equipe');
  if p_id is null then
    insert into public.teams (organization_id, name, active) values (p_org, nm, coalesce(p_active, true)) returning teams.id into rid;
  else
    update public.teams set name = nm, active = coalesce(p_active, active) where teams.id = p_id and organization_id = p_org returning teams.id into rid;
    if rid is null then raise exception 'equipe não encontrada' using errcode = 'P0002'; end if;
  end if;
  return rid;
exception when unique_violation then raise exception 'já existe uma equipe com este nome' using errcode = '22023';
end $$;

-- Define o conjunto de atendentes da equipe. Quem sai deixa de ser responsável pelos chamados abertos da equipe (desatribuição auditada).
create function public.tk_set_team_members(p_org uuid, p_team uuid, p_users uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid; removed uuid[]; t record;
begin
  perform private.tk_guard(p_org, 'manager');
  if not exists (select 1 from public.teams where id = p_team and organization_id = p_org) then raise exception 'equipe não encontrada' using errcode = 'P0002'; end if;
  p_users := coalesce(p_users, '{}'::uuid[]);
  if cardinality(p_users) > 100 then raise exception 'equipe grande demais' using errcode = '22023'; end if;
  foreach u in array p_users loop
    if not exists (select 1 from public.organization_members m where m.organization_id = p_org and m.user_id = u and m.role in ('owner', 'admin', 'manager', 'member')) then
      raise exception 'só atendentes da empresa podem entrar em uma equipe' using errcode = '22023';
    end if;
  end loop;
  select coalesce(array_agg(user_id), '{}') into removed from public.team_members where team_id = p_team and not (user_id = any (p_users));
  delete from public.team_members where team_id = p_team and not (user_id = any (p_users));
  insert into public.team_members (organization_id, team_id, user_id) select p_org, p_team, x from unnest(p_users) x on conflict do nothing;
  for t in select id from public.tickets where organization_id = p_org and team_id = p_team and assigned_user_id = any (removed) and status <> 'closed' loop
    update public.tickets set assigned_user_id = null where id = t.id;
    perform private.tk_event(p_org, t.id, 'unassigned', (select auth.uid()), jsonb_build_object('reason', 'team_membership'));
  end loop;
end $$;

-- ======================================================================= categorias e respostas prontas
create function public.tk_save_category(p_org uuid, p_id uuid, p_name text, p_default_team uuid, p_active boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare nm text; rid uuid;
begin
  perform private.tk_guard(p_org, 'manager');
  nm := private.tk_req_text(p_name, 2, 60, 'Nome da categoria');
  if p_default_team is not null and not exists (select 1 from public.teams where id = p_default_team and organization_id = p_org and active) then raise exception 'equipe padrão inválida' using errcode = '22023'; end if;
  if p_id is null then
    insert into public.ticket_categories (organization_id, name, default_team_id, active) values (p_org, nm, p_default_team, coalesce(p_active, true)) returning ticket_categories.id into rid;
  else
    update public.ticket_categories set name = nm, default_team_id = p_default_team, active = coalesce(p_active, active) where ticket_categories.id = p_id and organization_id = p_org returning ticket_categories.id into rid;
    if rid is null then raise exception 'categoria não encontrada' using errcode = 'P0002'; end if;
  end if;
  return rid;
exception when unique_violation then raise exception 'já existe uma categoria com este nome' using errcode = '22023';
end $$;

create function public.tk_save_canned(p_org uuid, p_id uuid, p_title text, p_body text, p_active boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare rid uuid; ti text; bo text;
begin
  perform private.tk_guard(p_org, 'manager');
  ti := private.tk_req_text(p_title, 2, 80, 'Título'); bo := private.tk_req_text(p_body, 1, 5000, 'Texto');
  if p_id is null then
    insert into public.canned_responses (organization_id, title, body, active) values (p_org, ti, bo, coalesce(p_active, true)) returning canned_responses.id into rid;
  else
    update public.canned_responses set title = ti, body = bo, active = coalesce(p_active, active) where canned_responses.id = p_id and organization_id = p_org returning canned_responses.id into rid;
    if rid is null then raise exception 'resposta pronta não encontrada' using errcode = 'P0002'; end if;
  end if;
  return rid;
end $$;

-- ======================================================================= configurações e SLA
create function public.tk_save_settings(p_org uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare st public.ticket_settings;
begin
  perform private.tk_guard(p_org, 'owner');
  if jsonb_typeof(p) <> 'object' then raise exception 'dados inválidos' using errcode = '22023'; end if;
  select * into st from public.ticket_settings where organization_id = p_org;
  update public.ticket_settings set
    public_display_name = case when p ? 'public_display_name' then private.tk_opt_text(p ->> 'public_display_name', 80, 'Nome exibido') else public_display_name end,
    primary_color = coalesce(p ->> 'primary_color', primary_color),
    reopen_window_hours = coalesce((p ->> 'reopen_window_hours')::integer, reopen_window_hours),
    attachment_max_size_bytes = coalesce((p ->> 'attachment_max_size_bytes')::integer, attachment_max_size_bytes),
    retention_policy_text = case when p ? 'retention_policy_text' then private.tk_opt_text(p ->> 'retention_policy_text', 1000, 'Política de retenção') else retention_policy_text end
  where organization_id = p_org;
exception when check_violation then raise exception 'valor fora do permitido (cor #RRGGBB, janela de reabertura 0–8760 h, anexos 10 KB–10 MB)' using errcode = '22023';
end $$;

create function public.tk_set_logo(p_org uuid, p_path text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.tk_guard(p_org, 'owner');
  if p_path is not null and (p_path !~ ('^' || p_org::text || '/logo-[0-9a-f]{8,32}\.(png|jpg|webp)$')) then raise exception 'caminho de logotipo inválido' using errcode = '22023'; end if;
  update public.ticket_settings set logo_path = p_path where organization_id = p_org;
end $$;

-- Publica uma NOVA versão de expediente + metas. Ciclos já abertos mantêm a anterior; os próximos usam esta.
create function public.tk_publish_sla(p_org uuid, p_timezone text, p_calendar jsonb, p_targets jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cal uuid; pol uuid;
begin
  perform private.tk_guard(p_org, 'owner');
  perform private.tk_validate_calendar(p_timezone, p_calendar);
  perform private.tk_validate_targets(p_targets);
  -- clock_timestamp(): a «versão vigente» é a mais recente; mesmo dentro de uma única transação a nova versão sempre fica depois da anterior
  insert into public.business_calendar_versions (organization_id, timezone, definition, created_by, created_at) values (p_org, p_timezone, p_calendar, (select auth.uid()), clock_timestamp()) returning id into cal;
  insert into public.sla_policy_versions (organization_id, business_calendar_version_id, targets_by_priority, created_by, created_at) values (p_org, cal, p_targets, (select auth.uid()), clock_timestamp()) returning id into pol;
  update public.ticket_settings set timezone = p_timezone where organization_id = p_org;
  return jsonb_build_object('calendar_version_id', cal, 'policy_version_id', pol);
end $$;

-- ======================================================================= atendentes: desativar/reativar com tratamento explícito dos chamados abertos
-- p_mode: 'unassign' (devolve à fila) ou 'reassign' (p_to precisa ser atribuível em CADA equipe afetada).
create function public.tk_set_agent_active(p_org uuid, p_user uuid, p_active boolean, p_mode text, p_to uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t record; n integer := 0;
begin
  perform private.tk_guard(p_org, 'manager');
  if not exists (select 1 from public.organization_members m where m.organization_id = p_org and m.user_id = p_user and m.role in ('manager', 'member')) then
    raise exception 'só gestores e atendentes podem ser desativados aqui' using errcode = '22023';
  end if;
  if p_user = (select auth.uid()) then raise exception 'você não pode desativar o próprio acesso' using errcode = '22023'; end if;
  if not coalesce(p_active, true) then
    if p_mode is null or p_mode not in ('unassign', 'reassign') then raise exception 'informe o que fazer com os chamados abertos (desatribuir ou reatribuir)' using errcode = '22023'; end if;
    if p_mode = 'reassign' and (p_to is null or p_to = p_user) then raise exception 'escolha outra pessoa para receber os chamados' using errcode = '22023'; end if;
    insert into public.agent_status (organization_id, user_id, active, deactivated_at) values (p_org, p_user, false, now())
      on conflict (organization_id, user_id) do update set active = false, deactivated_at = now();
    for t in select id, team_id from public.tickets where organization_id = p_org and assigned_user_id = p_user and status in ('open', 'in_progress', 'waiting_requester') for update loop
      if p_mode = 'reassign' then
        if not private.tk_assignable(p_org, t.team_id, p_to) then raise exception 'a pessoa escolhida não pertence à equipe de todos os chamados (reatribua manualmente)' using errcode = '22023'; end if;
        update public.tickets set assigned_user_id = p_to where id = t.id;
        perform private.tk_event(p_org, t.id, 'assigned', (select auth.uid()), jsonb_build_object('to', p_to, 'reason', 'agent_deactivated'));
        perform private.tk_notify(p_org, t.id, p_to, 'assigned');
      else
        update public.tickets set assigned_user_id = null where id = t.id;
        perform private.tk_event(p_org, t.id, 'unassigned', (select auth.uid()), jsonb_build_object('reason', 'agent_deactivated'));
      end if;
      n := n + 1;
    end loop;
  else
    insert into public.agent_status (organization_id, user_id, active) values (p_org, p_user, true)
      on conflict (organization_id, user_id) do update set active = true, deactivated_at = null;
  end if;
  return jsonb_build_object('tickets_changed', n);
end $$;

-- Notificações: marcar como lidas (só as próprias).
create function public.tk_mark_notifications(p_org uuid, p_ids bigint[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform private.tk_guard(p_org, 'any');
  update public.notifications set read_at = now() where organization_id = p_org and recipient_user_id = (select auth.uid()) and read_at is null and (p_ids is null or id = any (p_ids));
  get diagnostics n = row_count;
  return n;
end $$;

commit;
