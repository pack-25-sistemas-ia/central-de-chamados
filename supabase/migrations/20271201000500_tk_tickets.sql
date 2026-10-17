-- Central de Chamados — CICLO DE VIDA DO CHAMADO (RPCs tk_*): abrir, responder, notas internas, assumir, atribuir, mover de equipe, prioridade, categoria, estados, confirmar e reabrir.
-- Regras no banco (a interface só reflete): número sem MAX+1 (contador com trava de linha), idempotência por chave, versão otimista, uma pessoa vence ao assumir,
-- nota interna nunca conta como resposta, pausa de SLA aberta/fechada junto com o estado, reabertura cria NOVO ciclo e preserva os anteriores.

begin;
set local check_function_bodies = off;

-- ======================================================================= auxiliares
create function private.tk_event(p_org uuid, p_ticket uuid, p_type text, p_actor uuid, p_meta jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.ticket_events (organization_id, ticket_id, event_type, actor_user_id, safe_metadata) values (p_org, p_ticket, p_type, p_actor, coalesce(p_meta, '{}'::jsonb));
end $$;
revoke all on function private.tk_event(uuid, uuid, text, uuid, jsonb) from public, anon, authenticated;

-- O usuário `p_uid` teria acesso a este chamado? (espelho de tk_ticket_visible para OUTRAS pessoas)
create function private.tk_visible_for(p_org uuid, p_uid uuid, p_team uuid, p_assignee uuid, p_requester uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(case private.tk_profile_of(p_org, p_uid)
    when 'owner' then true when 'manager' then true
    when 'agent' then coalesce(p_assignee = p_uid, false) or exists (select 1 from public.team_members tm where tm.organization_id = p_org and tm.team_id = p_team and tm.user_id = p_uid)
    when 'requester' then p_requester = p_uid
    else false end, false);
$$;
revoke all on function private.tk_visible_for(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- Notificação interna (mesma transação da ação). Só para quem TEM acesso; nunca para o autor.
create function private.tk_notify(p_org uuid, p_ticket uuid, p_to uuid, p_type text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tickets;
begin
  if p_to is null or p_to = (select auth.uid()) then return; end if;
  select * into t from public.tickets where id = p_ticket;
  if not private.tk_visible_for(p_org, p_to, t.team_id, t.assigned_user_id, t.requester_user_id) then return; end if;
  insert into public.notifications (organization_id, recipient_user_id, ticket_id, event_type) values (p_org, p_to, p_ticket, p_type);
end $$;
revoke all on function private.tk_notify(uuid, uuid, uuid, text) from public, anon, authenticated;

-- Fila de trabalho do chamado: o responsável; sem responsável, a equipe.
create function private.tk_notify_work(p_org uuid, p_ticket uuid, p_type text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tickets; u uuid;
begin
  select * into t from public.tickets where id = p_ticket;
  if t.assigned_user_id is not null then perform private.tk_notify(p_org, p_ticket, t.assigned_user_id, p_type); return; end if;
  for u in select tm.user_id from public.team_members tm where tm.organization_id = p_org and tm.team_id = t.team_id loop
    perform private.tk_notify(p_org, p_ticket, u, p_type);
  end loop;
end $$;
revoke all on function private.tk_notify_work(uuid, uuid, text) from public, anon, authenticated;

create function private.tk_conflict() returns void language plpgsql immutable set search_path = '' as $$
begin raise exception 'Este chamado foi alterado por outra pessoa. Atualize a página para ver a versão mais recente antes de continuar.' using errcode = '40001'; end $$;
revoke all on function private.tk_conflict() from public, anon, authenticated;

-- Carrega o chamado (com trava de linha quando `p_lock`), conferindo acesso do usuário atual e a versão esperada.
create function private.tk_load_ticket(p_org uuid, p_ticket uuid, p_lock boolean, p_expected integer) returns public.tickets
language plpgsql security definer set search_path = '' as $$
declare t public.tickets;
begin
  if p_lock then select * into t from public.tickets where id = p_ticket and organization_id = p_org for update;
  else select * into t from public.tickets where id = p_ticket and organization_id = p_org; end if;
  if not found or not private.tk_ticket_visible(p_org, t.team_id, t.assigned_user_id, t.requester_user_id) then raise exception 'chamado não encontrado' using errcode = 'P0002'; end if;
  if p_expected is not null and t.version <> p_expected then perform private.tk_conflict(); end if;
  return t;
end $$;
revoke all on function private.tk_load_ticket(uuid, uuid, boolean, integer) from public, anon, authenticated;

create function private.tk_active_cycle(p_ticket uuid) returns uuid
language sql stable security definer set search_path = '' as $$ select id from public.ticket_service_cycles where ticket_id = p_ticket and closed_at is null; $$;
revoke all on function private.tk_active_cycle(uuid) from public, anon, authenticated;

create function private.tk_close_pause(p_cycle uuid, p_at timestamptz) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.ticket_sla_pauses set ended_at = greatest(p_at, started_at) where service_cycle_id = p_cycle and ended_at is null;
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function private.tk_close_pause(uuid, timestamptz) from public, anon, authenticated;

-- Idempotência: devolve o resultado guardado se a MESMA chave já concluiu; NULL se esta chamada é a primeira (e reserva a chave).
create function private.tk_idem(p_org uuid, p_uid uuid, p_key uuid, p_scope text, p_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n integer; r public.mutation_requests;
begin
  if p_key is null then raise exception 'solicitação inválida (chave ausente)' using errcode = '22023'; end if;
  insert into public.mutation_requests (organization_id, user_id, idempotency_key, scope, request_hash) values (p_org, p_uid, p_key, p_scope, p_hash) on conflict do nothing;
  get diagnostics n = row_count;
  if n = 1 then return null; end if;
  select * into r from public.mutation_requests where organization_id = p_org and user_id = p_uid and idempotency_key = p_key;
  if r.scope <> p_scope or r.request_hash <> p_hash then raise exception 'esta solicitação já foi usada com outros dados; recarregue a página' using errcode = '22023'; end if;
  if r.result is null then raise exception 'solicitação em andamento; aguarde alguns segundos' using errcode = '55000'; end if;
  return r.result;
end $$;
revoke all on function private.tk_idem(uuid, uuid, uuid, text, text) from public, anon, authenticated;

create function private.tk_hash(p_parts text[]) returns text
language sql immutable set search_path = '' as $$ select encode(sha256(convert_to(array_to_string(p_parts, '|'), 'UTF8')), 'hex'); $$;
revoke all on function private.tk_hash(text[]) from public, anon, authenticated;

-- Anexos já enviados ao Storage: confere caminho (gerado pelo servidor), tipo, tamanho e vincula à mensagem. Herdam a visibilidade da mensagem.
create function private.tk_add_attachments(p_org uuid, p_ticket uuid, p_msg uuid, p_att jsonb, p_uid uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare a jsonb; maxb integer; n integer := 0; fname text; mime text; sz integer; path text;
begin
  if p_att is null or jsonb_typeof(p_att) = 'null' then return 0; end if;
  if jsonb_typeof(p_att) <> 'array' or jsonb_array_length(p_att) > 3 then raise exception 'envie até 3 anexos por mensagem' using errcode = '22023'; end if;
  select attachment_max_size_bytes into maxb from public.ticket_settings where organization_id = p_org;
  if (select count(*) from public.ticket_attachments where ticket_id = p_ticket) + jsonb_array_length(p_att) > 50 then raise exception 'limite de anexos do chamado atingido' using errcode = '22023'; end if;
  for a in select value from jsonb_array_elements(p_att) loop
    path := a ->> 'path'; mime := a ->> 'mime'; fname := a ->> 'filename';
    if path is null or path !~ ('^' || p_org::text || '/' || p_ticket::text || '/[0-9a-f]{32}\.[a-z0-9]{1,5}$') then raise exception 'anexo inválido' using errcode = '22023'; end if;
    if mime is null or mime not in ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv') then raise exception 'tipo de anexo não permitido' using errcode = '22023'; end if;
    if jsonb_typeof(a -> 'size') <> 'number' then raise exception 'anexo inválido' using errcode = '22023'; end if;
    sz := (a ->> 'size')::integer;
    if sz < 1 or sz > maxb then raise exception 'anexo acima do tamanho máximo permitido (% KB)', maxb / 1024 using errcode = '22023'; end if;
    fname := left(regexp_replace(btrim(coalesce(fname, 'arquivo')), '[\\/\x00-\x1f]', '_', 'g'), 180);
    if fname = '' then fname := 'arquivo'; end if;
    insert into public.ticket_attachments (organization_id, ticket_id, message_id, storage_path, original_filename, mime_type, size_bytes, uploaded_by) values (p_org, p_ticket, p_msg, path, fname, mime, sz, p_uid);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function private.tk_add_attachments(uuid, uuid, uuid, jsonb, uuid) from public, anon, authenticated;

create function private.tk_att_paths(p_att jsonb) returns text
language sql immutable set search_path = '' as $$
  select coalesce(string_agg((v ->> 'path') || ':' || coalesce(v ->> 'size', ''), ',' order by v ->> 'path'), '') from jsonb_array_elements(case when jsonb_typeof(p_att) = 'array' then p_att else '[]'::jsonb end) v;
$$;
revoke all on function private.tk_att_paths(jsonb) from public, anon, authenticated;

-- ======================================================================= abrir chamado
-- Solicitante: prioridade normal, status open, sem responsável, solicitante = sessão. Equipe: escolhe solicitante (membro «solicitante» da empresa), prioridade, equipe e responsável.
create function public.tk_open_ticket(p_org uuid, p_id uuid, p_idem uuid, p_subject text, p_category uuid, p_description text, p_priority text, p_requester uuid,
  p_team uuid, p_assignee uuid, p_attachments jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid()); prof text; subj text; descr text; cat public.ticket_categories; req uuid; prio text; team uuid; asg uuid; num bigint; msg uuid; hash text; prev jsonb; res jsonb; nclosed integer;
begin
  perform private.tk_guard(p_org, 'any');
  prof := private.tk_profile(p_org);
  if p_id is null then raise exception 'solicitação inválida' using errcode = '22023'; end if;
  subj := private.tk_req_text(p_subject, 3, 160, 'Assunto'); descr := private.tk_req_text(p_description, 1, 10000, 'Descrição');
  perform private.tk_rate_hit('open:' || uid::text, 60, 3600);
  hash := private.tk_hash(array[p_id::text, subj, descr, coalesce(p_category::text, ''), coalesce(p_priority, ''), coalesce(p_requester::text, ''), coalesce(p_team::text, ''), coalesce(p_assignee::text, ''), private.tk_att_paths(p_attachments)]);
  prev := private.tk_idem(p_org, uid, p_idem, 'open_ticket', hash);
  if prev is not null then return prev || jsonb_build_object('replayed', true); end if;
  if exists (select 1 from public.tickets where id = p_id) then raise exception 'identificador de chamado já utilizado' using errcode = '22023'; end if;

  if p_category is not null then
    select * into cat from public.ticket_categories where id = p_category and organization_id = p_org and active;
    if not found then raise exception 'categoria inválida' using errcode = '22023'; end if;
  end if;

  if prof = 'requester' then
    req := uid; prio := 'normal'; team := cat.default_team_id; asg := null;
  else
    prio := coalesce(p_priority, 'normal');
    if prio not in ('low', 'normal', 'high', 'urgent') then raise exception 'prioridade inválida' using errcode = '22023'; end if;
    req := p_requester;
    if req is null or private.tk_profile_of(p_org, req) is distinct from 'requester' then raise exception 'escolha um solicitante cadastrado na empresa' using errcode = '22023'; end if;
    team := coalesce(p_team, cat.default_team_id);
    if p_team is not null and not exists (select 1 from public.teams where id = p_team and organization_id = p_org and active) then raise exception 'equipe inválida' using errcode = '22023'; end if;
    asg := p_assignee;
    if asg is not null then
      if prof = 'agent' and asg <> uid then raise exception 'atendentes só podem atribuir a si mesmos; peça a um gestor' using errcode = '42501'; end if;
      if team is null or not private.tk_assignable(p_org, team, asg) then raise exception 'responsável inválido: precisa ser atendente ativo da equipe do chamado' using errcode = '22023'; end if;
    end if;
  end if;

  update public.ticket_counters set last_number = last_number + 1 where organization_id = p_org returning last_number into num;
  insert into public.tickets (id, organization_id, ticket_number, requester_user_id, subject, category_id, priority, status, team_id, assigned_user_id, created_by)
  values (p_id, p_org, num, req, subj, p_category, prio, 'open', team, asg, uid);
  insert into public.ticket_messages (organization_id, ticket_id, author_user_id, author_kind, visibility, body) values (p_org, p_id, uid, 'requester', 'public', descr) returning id into msg;
  perform private.tk_add_attachments(p_org, p_id, msg, p_attachments, uid);
  perform private.tk_start_cycle(p_id, now());
  perform private.tk_event(p_org, p_id, 'created', uid, jsonb_build_object('priority', prio, 'on_behalf', prof <> 'requester', 'team', team is not null, 'assigned', asg is not null));
  if asg is not null then
    perform private.tk_event(p_org, p_id, 'assigned', uid, jsonb_build_object('to', asg));
    perform private.tk_notify(p_org, p_id, asg, 'assigned');
  elsif prof = 'requester' then
    perform private.tk_notify_work(p_org, p_id, 'assigned');
  end if;
  res := jsonb_build_object('id', p_id, 'ticket_number', num, 'replayed', false);
  update public.mutation_requests set result = res where organization_id = p_org and user_id = uid and idempotency_key = p_idem;
  return res;
end $$;

-- ======================================================================= mensagens (públicas e notas internas)
-- p_next_status: NULL, 'waiting_requester' (pede informação e PAUSA o SLA) ou 'resolved' (resolve e encerra a pausa). Tudo na mesma transação da mensagem.
create function public.tk_post_message(p_org uuid, p_ticket uuid, p_idem uuid, p_visibility text, p_body text, p_attachments jsonb, p_next_status text, p_expected integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid()); prof text; t public.tickets; body text; msg uuid; kind text; cyc uuid; hash text; prev jsonb; res jsonb; at timestamptz := now(); newst text; was_paused boolean;
begin
  perform private.tk_guard(p_org, 'any');
  prof := private.tk_profile(p_org);
  if p_visibility not in ('public', 'internal') then raise exception 'visibilidade inválida' using errcode = '22023'; end if;
  if p_next_status is not null and p_next_status not in ('waiting_requester', 'resolved') then raise exception 'estado inválido para esta ação' using errcode = '22023'; end if;
  body := private.tk_req_text(p_body, 1, 10000, 'Mensagem');
  perform private.tk_rate_hit('msg:' || uid::text, 300, 3600);
  hash := private.tk_hash(array[p_ticket::text, p_visibility, body, coalesce(p_next_status, ''), private.tk_att_paths(p_attachments)]);
  prev := private.tk_idem(p_org, uid, p_idem, 'post_message', hash);
  if prev is not null then return prev || jsonb_build_object('replayed', true); end if;

  t := private.tk_load_ticket(p_org, p_ticket, true, case when p_next_status is not null then p_expected else null end);
  cyc := private.tk_active_cycle(p_ticket);
  newst := t.status;

  if prof = 'requester' then
    if p_visibility <> 'public' or p_next_status is not null then raise exception 'sem permissão' using errcode = '42501'; end if;
    if t.status in ('resolved', 'closed') then raise exception 'este chamado está encerrado; use «Reabrir» (dentro do prazo) ou abra um novo chamado' using errcode = '22023'; end if;
    kind := 'requester';
  else
    kind := 'staff';
    if p_visibility = 'internal' and p_next_status is not null then raise exception 'nota interna não altera o estado do chamado' using errcode = '22023'; end if;
    if p_visibility = 'public' and t.status in ('resolved', 'closed') then raise exception 'este chamado está encerrado; reabra antes de responder ao solicitante' using errcode = '22023'; end if;
  end if;

  insert into public.ticket_messages (organization_id, ticket_id, author_user_id, author_kind, visibility, body) values (p_org, p_ticket, uid, kind, p_visibility, body) returning id into msg;
  perform private.tk_add_attachments(p_org, p_ticket, msg, p_attachments, uid);

  if p_visibility = 'internal' then
    perform private.tk_event(p_org, p_ticket, 'internal_note', uid, '{}'::jsonb);
  elsif kind = 'requester' then
    if t.status = 'waiting_requester' then
      newst := 'in_progress';
      if private.tk_close_pause(cyc, at) then perform private.tk_event(p_org, p_ticket, 'sla_resumed', uid, '{}'::jsonb); end if;
      perform private.tk_event(p_org, p_ticket, 'status_changed', uid, jsonb_build_object('from', t.status, 'to', newst));
    end if;
    update public.tickets set status = newst, last_public_activity_at = at where id = p_ticket;
    perform private.tk_event(p_org, p_ticket, 'requester_reply', uid, '{}'::jsonb);
    perform private.tk_notify_work(p_org, p_ticket, 'public_reply');
  else
    -- primeira resposta PÚBLICA da equipe (nota interna, mensagem de sistema e abertura administrativa NÃO contam)
    update public.ticket_service_cycles set first_response_at = at where id = cyc and first_response_at is null;
    perform private.tk_event(p_org, p_ticket, 'public_reply', uid, '{}'::jsonb);
    if t.status = 'open' then newst := 'in_progress'; end if;
    if p_next_status = 'waiting_requester' and newst <> 'waiting_requester' then
      newst := 'waiting_requester';
      insert into public.ticket_sla_pauses (organization_id, service_cycle_id, started_at) values (p_org, cyc, at);
      perform private.tk_event(p_org, p_ticket, 'sla_paused', uid, '{}'::jsonb);
    elsif p_next_status = 'resolved' then
      newst := 'resolved';
      was_paused := private.tk_close_pause(cyc, at);
      if was_paused then perform private.tk_event(p_org, p_ticket, 'sla_resumed', uid, '{}'::jsonb); end if;
      update public.ticket_service_cycles set resolved_at = at where id = cyc and resolved_at is null;
      perform private.tk_event(p_org, p_ticket, 'resolved', uid, '{}'::jsonb);
    elsif newst = 'waiting_requester' and t.status = 'waiting_requester' then
      newst := 'waiting_requester';
    end if;
    if newst is distinct from t.status then perform private.tk_event(p_org, p_ticket, 'status_changed', uid, jsonb_build_object('from', t.status, 'to', newst)); end if;
    update public.tickets set status = newst, last_public_activity_at = at where id = p_ticket;
    perform private.tk_notify(p_org, p_ticket, t.requester_user_id, case when newst = 'resolved' then 'resolved' else 'public_reply' end);
  end if;

  res := jsonb_build_object('message_id', msg, 'status', newst, 'replayed', false);
  update public.mutation_requests set result = res where organization_id = p_org and user_id = uid and idempotency_key = p_idem;
  return res;
end $$;

-- ======================================================================= atribuição
-- Assumir: só UMA pessoa vence (trava de linha). Assumir leva o chamado a «em atendimento».
create function public.tk_claim(p_org uuid, p_ticket uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); t public.tickets;
begin
  perform private.tk_guard(p_org, 'staff');
  t := private.tk_load_ticket(p_org, p_ticket, true, null);
  if t.status in ('resolved', 'closed') then raise exception 'este chamado já foi encerrado' using errcode = '22023'; end if;
  if t.assigned_user_id is not null then raise exception 'Este chamado acabou de ser assumido por outra pessoa.' using errcode = '40001'; end if;
  if t.team_id is null then raise exception 'defina a equipe do chamado antes de assumir (peça a um gestor)' using errcode = '22023'; end if;
  if not private.tk_assignable(p_org, t.team_id, uid) then raise exception 'você precisa pertencer à equipe do chamado para assumi-lo' using errcode = '42501'; end if;
  update public.tickets set assigned_user_id = uid, status = case when status = 'open' then 'in_progress' else status end where id = p_ticket;
  perform private.tk_event(p_org, p_ticket, 'claimed', uid, jsonb_build_object('from', t.status));
end $$;

-- Atribuir a outra pessoa (gestão) ou devolver à fila (gestão, ou o atendente que é o responsável). NULL = sem responsável.
create function public.tk_assign(p_org uuid, p_ticket uuid, p_user uuid, p_expected integer) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); prof text; t public.tickets;
begin
  perform private.tk_guard(p_org, 'staff');
  prof := private.tk_profile(p_org);
  t := private.tk_load_ticket(p_org, p_ticket, true, p_expected);
  if t.status in ('resolved', 'closed') then raise exception 'este chamado já foi encerrado' using errcode = '22023'; end if;
  if prof = 'agent' and not (p_user is null and t.assigned_user_id = uid) then raise exception 'sem permissão: atribuir a outras pessoas é função da gestão' using errcode = '42501'; end if;
  if p_user is not null and (t.team_id is null or not private.tk_assignable(p_org, t.team_id, p_user)) then raise exception 'responsável inválido: precisa ser atendente ativo da equipe do chamado' using errcode = '22023'; end if;
  if p_user is not distinct from t.assigned_user_id then return; end if;
  update public.tickets set assigned_user_id = p_user where id = p_ticket;
  if p_user is null then perform private.tk_event(p_org, p_ticket, 'unassigned', uid, jsonb_build_object('reason', 'manual'));
  else
    perform private.tk_event(p_org, p_ticket, 'assigned', uid, jsonb_build_object('to', p_user));
    perform private.tk_notify(p_org, p_ticket, p_user, 'assigned');
  end if;
end $$;

-- Mover para equipe (gestão): remove o responsável que não pertence à nova equipe, com evento auditado.
create function public.tk_move_team(p_org uuid, p_ticket uuid, p_team uuid, p_expected integer) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); t public.tickets; drop_asg boolean := false;
begin
  perform private.tk_guard(p_org, 'manager');
  t := private.tk_load_ticket(p_org, p_ticket, true, p_expected);
  if t.status in ('resolved', 'closed') then raise exception 'este chamado já foi encerrado' using errcode = '22023'; end if;
  if not exists (select 1 from public.teams where id = p_team and organization_id = p_org and active) then raise exception 'equipe inválida' using errcode = '22023'; end if;
  if p_team is not distinct from t.team_id then return; end if;
  drop_asg := t.assigned_user_id is not null and not private.tk_assignable(p_org, p_team, t.assigned_user_id);
  update public.tickets set team_id = p_team, assigned_user_id = case when drop_asg then null else assigned_user_id end where id = p_ticket;
  perform private.tk_event(p_org, p_ticket, 'team_changed', uid, jsonb_build_object('to', p_team));
  if drop_asg then perform private.tk_event(p_org, p_ticket, 'unassigned', uid, jsonb_build_object('reason', 'team_change')); end if;
  perform private.tk_notify_work(p_org, p_ticket, 'assigned');
end $$;

create function public.tk_set_priority(p_org uuid, p_ticket uuid, p_priority text, p_expected integer) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); t public.tickets;
begin
  perform private.tk_guard(p_org, 'staff');
  if p_priority not in ('low', 'normal', 'high', 'urgent') then raise exception 'prioridade inválida' using errcode = '22023'; end if;
  t := private.tk_load_ticket(p_org, p_ticket, true, p_expected);
  if t.status in ('resolved', 'closed') then raise exception 'este chamado já foi encerrado' using errcode = '22023'; end if;
  if p_priority = t.priority then return; end if;
  -- a meta do ciclo em andamento NÃO muda (fixada no início); a nova prioridade vale para os próximos ciclos
  update public.tickets set priority = p_priority where id = p_ticket;
  perform private.tk_event(p_org, p_ticket, 'priority_changed', uid, jsonb_build_object('from', t.priority, 'to', p_priority));
end $$;

create function public.tk_set_category(p_org uuid, p_ticket uuid, p_category uuid, p_expected integer) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); t public.tickets; cat public.ticket_categories;
begin
  perform private.tk_guard(p_org, 'staff');
  t := private.tk_load_ticket(p_org, p_ticket, true, p_expected);
  if t.status in ('resolved', 'closed') then raise exception 'este chamado já foi encerrado' using errcode = '22023'; end if;
  if p_category is not null then
    select * into cat from public.ticket_categories where id = p_category and organization_id = p_org and active;
    if not found then raise exception 'categoria inválida' using errcode = '22023'; end if;
  end if;
  if p_category is not distinct from t.category_id then return; end if;
  update public.tickets set category_id = p_category, team_id = case when t.team_id is null then cat.default_team_id else t.team_id end where id = p_ticket;
  perform private.tk_event(p_org, p_ticket, 'category_changed', uid, '{}'::jsonb);
end $$;

-- ======================================================================= estados
-- Só: in_progress (retomar, inclusive a partir de «aguardando solicitante») e closed (a partir de resolvido). Pedir informação e resolver exigem mensagem (tk_post_message).
create function public.tk_set_status(p_org uuid, p_ticket uuid, p_status text, p_expected integer) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); t public.tickets; cyc uuid; at timestamptz := now();
begin
  perform private.tk_guard(p_org, 'staff');
  if p_status not in ('in_progress', 'closed') then raise exception 'use as ações próprias para pedir informação, resolver ou reabrir' using errcode = '22023'; end if;
  t := private.tk_load_ticket(p_org, p_ticket, true, p_expected);
  cyc := private.tk_active_cycle(p_ticket);
  if p_status = 'in_progress' then
    if t.status not in ('open', 'waiting_requester') then raise exception 'transição de status inválida' using errcode = '22023'; end if;
    if private.tk_close_pause(cyc, at) then perform private.tk_event(p_org, p_ticket, 'sla_resumed', uid, '{}'::jsonb); end if;
  else
    if t.status <> 'resolved' then raise exception 'só é possível encerrar um chamado já resolvido' using errcode = '22023'; end if;
    update public.ticket_service_cycles set closed_at = at where id = cyc;
  end if;
  update public.tickets set status = p_status where id = p_ticket;
  perform private.tk_event(p_org, p_ticket, case when p_status = 'closed' then 'closed' else 'status_changed' end, uid, jsonb_build_object('from', t.status, 'to', p_status));
end $$;

-- Solicitante confirma a solução: resolved → closed.
create function public.tk_confirm(p_org uuid, p_ticket uuid, p_expected integer) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); t public.tickets; cyc uuid;
begin
  perform private.tk_guard(p_org, 'requester');
  t := private.tk_load_ticket(p_org, p_ticket, true, p_expected);
  if t.status <> 'resolved' then raise exception 'só é possível confirmar um chamado resolvido' using errcode = '22023'; end if;
  cyc := private.tk_active_cycle(p_ticket);
  update public.ticket_service_cycles set closed_at = now() where id = cyc;
  update public.tickets set status = 'closed' where id = p_ticket;
  perform private.tk_event(p_org, p_ticket, 'closed', uid, jsonb_build_object('from', 'resolved', 'to', 'closed', 'by', 'requester'));
end $$;

-- Reabrir (solicitante do chamado ou equipe com acesso): dentro da janela, com motivo; cria NOVO ciclo com a política vigente e preserva os anteriores.
create function public.tk_reopen(p_org uuid, p_ticket uuid, p_reason text, p_expected integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid()); prof text; t public.tickets; st public.ticket_settings; why text; old uuid; oc public.ticket_service_cycles; newcyc uuid; newst text; n integer; at timestamptz := now();
begin
  perform private.tk_guard(p_org, 'any');
  prof := private.tk_profile(p_org);
  why := private.tk_req_text(p_reason, 3, 1000, 'Motivo da reabertura');
  perform private.tk_rate_hit('reopen:' || uid::text, 30, 3600);
  t := private.tk_load_ticket(p_org, p_ticket, true, p_expected);
  if t.status not in ('resolved', 'closed') then raise exception 'só é possível reabrir um chamado resolvido ou encerrado' using errcode = '22023'; end if;
  select * into st from public.ticket_settings where organization_id = p_org;
  select * into oc from public.ticket_service_cycles where ticket_id = p_ticket order by cycle_number desc limit 1;
  if oc.resolved_at is null or at > oc.resolved_at + make_interval(hours => st.reopen_window_hours) then
    raise exception 'O prazo para reabrir este chamado terminou (% h após a solução). Abra um novo chamado e cite o número #%.', st.reopen_window_hours, t.ticket_number using errcode = '22023';
  end if;
  if oc.closed_at is null then update public.ticket_service_cycles set closed_at = at where id = oc.id; end if;
  newst := case when t.assigned_user_id is not null and t.team_id is not null and private.tk_assignable(p_org, t.team_id, t.assigned_user_id) then 'in_progress' else 'open' end;
  update public.tickets set status = newst, assigned_user_id = case when newst = 'open' then null else assigned_user_id end, last_public_activity_at = at where id = p_ticket;
  newcyc := private.tk_start_cycle(p_ticket, at);
  -- o motivo fica no histórico: público quando é o solicitante, interno quando é a equipe
  insert into public.ticket_messages (organization_id, ticket_id, author_user_id, author_kind, visibility, body)
  values (p_org, p_ticket, uid, case when prof = 'requester' then 'requester' else 'staff' end, case when prof = 'requester' then 'public' else 'internal' end, 'Reabertura: ' || why);
  select cycle_number into n from public.ticket_service_cycles where id = newcyc;
  perform private.tk_event(p_org, p_ticket, 'reopened', uid, jsonb_build_object('from', t.status, 'to', newst, 'cycle', n));
  perform private.tk_notify_work(p_org, p_ticket, 'reopened');
  if prof <> 'requester' then perform private.tk_notify(p_org, p_ticket, t.requester_user_id, 'reopened'); end if;
  return jsonb_build_object('status', newst, 'cycle', n);
end $$;

commit;
