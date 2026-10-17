-- DEMONSTRAÇÃO «Suporte Aurora TI» — dados 100% fictícios, determinísticos e RELATIVOS à data/hora de execução (nada fica no futuro; nada é temporalmente impossível).
-- Aplicado por `node scripts/seed-demo.mjs` (senha aleatória gerada na hora e exibida só no seu terminal; nenhuma credencial fixa é publicada).
-- Somente para uso LOCAL. NUNCA aplique em produção. Variável psql: pw (senha dos usuários @demo.exemplo).
-- Usuários: dono (proprietário), gestor, atendente1…3 (atendentes) e solicitante1…4 (solicitantes) @demo.exemplo. O proprietário cadastra o 2º fator (TOTP) no primeiro acesso.
-- O histórico é inserido com instantes explícitos (a API de escrita usa o relógio do banco); as regras de integridade e os gatilhos continuam valendo.

select set_config('demo.pw', :'pw', false);
select set_config('request.jwt.claims', '', false);
begin;

do $$
declare pw text := extensions.crypt(current_setting('demo.pw'), extensions.gen_salt('bf'));
begin
  if exists (select 1 from public.organizations where slug = 'suporte-aurora') then raise exception 'a demonstração já existe neste banco (rode supabase db reset antes)'; end if;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token)
  select '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', e.email, pw, now(), '{"provider":"email","providers":["email"]}'::jsonb,
         jsonb_build_object('full_name', e.nome), now(), now(), '', '', '', ''
  from (values ('dono@demo.exemplo', 'Helena Costa'), ('gestor@demo.exemplo', 'Marcos Gestor'), ('atendente1@demo.exemplo', 'Bia Atendente'), ('atendente2@demo.exemplo', 'Caio Atendente'),
    ('atendente3@demo.exemplo', 'Dani Atendente'), ('solicitante1@demo.exemplo', 'Fernanda Lima'), ('solicitante2@demo.exemplo', 'Roberto Alves'), ('solicitante3@demo.exemplo', 'Juliana Prado'),
    ('solicitante4@demo.exemplo', 'Tiago Moreira')) as e(email, nome);
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  select gen_random_uuid(), u.id, u.email, jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true), 'email', now(), now(), now() from auth.users u where u.email like '%@demo.exemplo';
  update public.profiles p set full_name = u.raw_user_meta_data ->> 'full_name' from auth.users u where u.id = p.id and u.email like '%@demo.exemplo';
end $$;

-- empresa e papéis (a partir daqui o proprietário «assina» como AAL2, como faria no app depois de cadastrar o 2º fator)
select set_config('request.jwt.claims', json_build_object('sub', (select id::text from auth.users where email = 'dono@demo.exemplo'), 'aal', 'aal2', 'role', 'authenticated')::text, false);
select public.create_organization('Suporte Aurora TI (demonstração)', 'suporte-aurora') as org \gset
insert into public.organization_members (organization_id, user_id, role)
select :'org', u.id, case when u.email = 'gestor@demo.exemplo' then 'manager'::public.org_role when u.email like 'atendente%' then 'member'::public.org_role else 'viewer'::public.org_role end
from auth.users u where u.email like '%@demo.exemplo' and u.email <> 'dono@demo.exemplo';
select set_config('demo.org', :'org', false);

select public.tk_save_settings(:'org', '{"public_display_name":"Suporte Aurora TI — demonstração","primary_color":"#0f766e","reopen_window_hours":72,"retention_policy_text":"DEMONSTRAÇÃO: chamados são mantidos por 24 meses após o encerramento; pedidos de exclusão ou anonimização são tratados pelo administrador diretamente no banco."}');
update public.organization_settings set display_name = 'Suporte Aurora TI (demonstração)', theme = jsonb_build_object('primary', '#0f766e') where organization_id = :'org';

-- equipes, categorias e respostas prontas
select public.tk_save_team(:'org', null, 'Suporte Nível 1', true) as t1 \gset
select public.tk_save_team(:'org', null, 'Infraestrutura', true) as t2 \gset
select public.tk_set_team_members(:'org', :'t1', array[(select id from auth.users where email = 'gestor@demo.exemplo'), (select id from auth.users where email = 'atendente1@demo.exemplo'), (select id from auth.users where email = 'atendente2@demo.exemplo')]);
select public.tk_set_team_members(:'org', :'t2', array[(select id from auth.users where email = 'gestor@demo.exemplo'), (select id from auth.users where email = 'atendente2@demo.exemplo'), (select id from auth.users where email = 'atendente3@demo.exemplo')]);
select public.tk_save_category(:'org', null, 'Acesso e senhas', :'t1', true) as c_acesso \gset
select public.tk_save_category(:'org', null, 'Impressoras e periféricos', :'t1', true) as c_imp \gset
select public.tk_save_category(:'org', null, 'Dúvidas gerais', :'t1', true) as c_duv \gset
select public.tk_save_category(:'org', null, 'Rede e internet', :'t2', true) as c_rede \gset
select public.tk_save_category(:'org', null, 'Servidores', :'t2', true) as c_srv \gset
select public.tk_save_canned(:'org', null, 'Pedir mais informações', 'Olá! Para continuar a análise, pode nos informar o horário aproximado em que o problema aconteceu e se aparece alguma mensagem de erro? Se puder, anexe uma captura de tela.', true);
select public.tk_save_canned(:'org', null, 'Redefinição de senha', 'Olá! Redefinimos a sua senha e enviamos a orientação para o primeiro acesso. Por favor, confirme se conseguiu entrar. Se ainda houver erro, responda por aqui.', true);
select public.tk_save_canned(:'org', null, 'Encerramento por solução', 'Olá! Concluímos o atendimento e o problema foi resolvido. Confirme por aqui se está tudo certo; se precisar, é só reabrir o chamado dentro do prazo.', true);
select public.tk_save_canned(:'org', null, 'Chamado recebido', 'Olá! Recebemos o seu chamado e já está com a nossa equipe. Retornaremos por aqui assim que houver novidades.', true);
select public.tk_save_canned(:'org', null, 'Fora do escopo', 'Olá! Este tipo de solicitação está fora do escopo do nosso atendimento. Pode abrir um novo chamado descrevendo o que precisa dentro do suporte técnico?', true);

reset role;

-- ===================================================================== histórico de chamados (instantes explícitos, tudo no passado)
create function pg_temp.u(p_email text) returns uuid language sql stable as $$ select id from auth.users where email = p_email $$;

-- instante `t` tal que existem `m` minutos úteis entre `t` e agora (bissecção; o calendário/fuso são os da política vigente)
create function pg_temp.back(m numeric) returns timestamptz language plpgsql stable as $$
declare cal record; lo timestamptz := now() - interval '120 days'; hi timestamptz := now(); mid timestamptz; i integer;
begin
  select cv.definition as def, cv.timezone as tz into cal from public.sla_policy_versions p join public.business_calendar_versions cv on cv.id = p.business_calendar_version_id
    where p.organization_id = current_setting('demo.org')::uuid order by p.created_at desc limit 1;
  for i in 1 .. 40 loop
    mid := lo + (hi - lo) / 2;
    if private.tk_bminutes(cal.def, cal.tz, mid, now()) >= m then lo := mid; else hi := mid; end if;
  end loop;
  return date_trunc('second', lo);
end $$;

create function pg_temp.event(p_ticket uuid, p_type text, p_actor uuid, p_meta jsonb, p_at timestamptz) returns void language sql as $$
  insert into public.ticket_events (organization_id, ticket_id, event_type, actor_user_id, safe_metadata, created_at) values (current_setting('demo.org')::uuid, p_ticket, p_type, p_actor, p_meta, p_at);
$$;
create function pg_temp.msg(p_ticket uuid, p_author uuid, p_kind text, p_vis text, p_body text, p_at timestamptz) returns void language sql as $$
  insert into public.ticket_messages (organization_id, ticket_id, author_user_id, author_kind, visibility, body, created_at) values (current_setting('demo.org')::uuid, p_ticket, p_author, p_kind, p_vis, p_body, p_at);
$$;

-- Cria o chamado já com sua mensagem inicial, ciclo 1 (política vigente) e evento de abertura. Estados finais são ajustados pelos auxiliares abaixo.
create function pg_temp.mk(p_num bigint, p_req text, p_subject text, p_desc text, p_cat uuid, p_prio text, p_team uuid, p_created timestamptz) returns uuid language plpgsql as $$
declare org uuid := current_setting('demo.org')::uuid; tid uuid := gen_random_uuid(); pol public.sla_policy_versions; r uuid := pg_temp.u(p_req);
begin
  select * into pol from public.sla_policy_versions where organization_id = org order by created_at desc limit 1;
  insert into public.tickets (id, organization_id, ticket_number, requester_user_id, subject, category_id, priority, status, team_id, created_by, created_at, last_public_activity_at)
  values (tid, org, p_num, r, p_subject, p_cat, p_prio, 'open', p_team, r, p_created, p_created);
  perform pg_temp.msg(tid, r, 'requester', 'public', p_desc, p_created);
  insert into public.ticket_service_cycles (organization_id, ticket_id, cycle_number, sla_policy_version_id, priority_snapshot, first_response_target_minutes, resolution_target_minutes, started_at)
  values (org, tid, 1, pol.id, p_prio, (pol.targets_by_priority -> p_prio ->> 'first_response')::int, (pol.targets_by_priority -> p_prio ->> 'resolution')::int, p_created);
  perform pg_temp.event(tid, 'created', r, jsonb_build_object('priority', p_prio, 'on_behalf', false, 'team', p_team is not null, 'assigned', false), p_created);
  return tid;
end $$;

-- Resposta pública da equipe (marca a primeira resposta do ciclo ativo, se ainda não houver), com o responsável assumindo antes.
create function pg_temp.assume(p_ticket uuid, p_agent text, p_at timestamptz) returns void language plpgsql as $$
begin
  update public.tickets set assigned_user_id = pg_temp.u(p_agent), status = case when status = 'open' then 'in_progress' else status end where id = p_ticket;
  perform pg_temp.event(p_ticket, 'claimed', pg_temp.u(p_agent), jsonb_build_object('from', 'open'), p_at);
end $$;
create function pg_temp.reply(p_ticket uuid, p_agent text, p_body text, p_at timestamptz) returns void language plpgsql as $$
begin
  perform pg_temp.msg(p_ticket, pg_temp.u(p_agent), 'staff', 'public', p_body, p_at);
  update public.ticket_service_cycles set first_response_at = p_at where ticket_id = p_ticket and closed_at is null and first_response_at is null;
  update public.tickets set last_public_activity_at = greatest(last_public_activity_at, p_at) where id = p_ticket;
  perform pg_temp.event(p_ticket, 'public_reply', pg_temp.u(p_agent), '{}', p_at);
end $$;
create function pg_temp.note(p_ticket uuid, p_agent text, p_body text, p_at timestamptz) returns void language plpgsql as $$
begin
  perform pg_temp.msg(p_ticket, pg_temp.u(p_agent), 'staff', 'internal', p_body, p_at);
  perform pg_temp.event(p_ticket, 'internal_note', pg_temp.u(p_agent), '{}', p_at);
end $$;
create function pg_temp.requester_reply(p_ticket uuid, p_req text, p_body text, p_at timestamptz) returns void language plpgsql as $$
begin
  perform pg_temp.msg(p_ticket, pg_temp.u(p_req), 'requester', 'public', p_body, p_at);
  update public.tickets set last_public_activity_at = greatest(last_public_activity_at, p_at) where id = p_ticket;
  perform pg_temp.event(p_ticket, 'requester_reply', pg_temp.u(p_req), '{}', p_at);
end $$;
-- pede informação: pausa o SLA
create function pg_temp.ask(p_ticket uuid, p_agent text, p_body text, p_at timestamptz) returns uuid language plpgsql as $$
declare cyc uuid;
begin
  perform pg_temp.reply(p_ticket, p_agent, p_body, p_at);
  select id into cyc from public.ticket_service_cycles where ticket_id = p_ticket and closed_at is null;
  insert into public.ticket_sla_pauses (organization_id, service_cycle_id, started_at) values (current_setting('demo.org')::uuid, cyc, p_at);
  update public.tickets set status = 'waiting_requester' where id = p_ticket;
  perform pg_temp.event(p_ticket, 'status_changed', pg_temp.u(p_agent), jsonb_build_object('from', 'in_progress', 'to', 'waiting_requester'), p_at);
  perform pg_temp.event(p_ticket, 'sla_paused', pg_temp.u(p_agent), '{}', p_at);
  return cyc;
end $$;
-- o solicitante responde: retoma o SLA
create function pg_temp.resume(p_ticket uuid, p_req text, p_body text, p_at timestamptz) returns void language plpgsql as $$
begin
  perform pg_temp.requester_reply(p_ticket, p_req, p_body, p_at);
  update public.ticket_sla_pauses set ended_at = p_at where ended_at is null and service_cycle_id = (select id from public.ticket_service_cycles where ticket_id = p_ticket and closed_at is null);
  update public.tickets set status = 'in_progress' where id = p_ticket;
  perform pg_temp.event(p_ticket, 'status_changed', pg_temp.u(p_req), jsonb_build_object('from', 'waiting_requester', 'to', 'in_progress'), p_at);
  perform pg_temp.event(p_ticket, 'sla_resumed', pg_temp.u(p_req), '{}', p_at);
end $$;
create function pg_temp.resolve(p_ticket uuid, p_agent text, p_body text, p_at timestamptz) returns void language plpgsql as $$
begin
  perform pg_temp.reply(p_ticket, p_agent, p_body, p_at);
  update public.ticket_service_cycles set resolved_at = p_at where ticket_id = p_ticket and closed_at is null and resolved_at is null;
  update public.tickets set status = 'resolved' where id = p_ticket;
  perform pg_temp.event(p_ticket, 'status_changed', pg_temp.u(p_agent), jsonb_build_object('from', 'in_progress', 'to', 'resolved'), p_at);
  perform pg_temp.event(p_ticket, 'resolved', pg_temp.u(p_agent), '{}', p_at);
end $$;
create function pg_temp.close(p_ticket uuid, p_actor text, p_at timestamptz, p_by text) returns void language plpgsql as $$
begin
  update public.ticket_service_cycles set closed_at = p_at where ticket_id = p_ticket and closed_at is null;
  update public.tickets set status = 'closed', last_public_activity_at = greatest(last_public_activity_at, p_at) where id = p_ticket;
  perform pg_temp.event(p_ticket, 'closed', pg_temp.u(p_actor), jsonb_build_object('from', 'resolved', 'to', 'closed', 'by', p_by), p_at);
end $$;
create function pg_temp.notify(p_ticket uuid, p_to text, p_type text, p_at timestamptz, p_read boolean) returns void language sql as $$
  insert into public.notifications (organization_id, recipient_user_id, ticket_id, event_type, read_at, created_at) values (current_setting('demo.org')::uuid, pg_temp.u(p_to), p_ticket, p_type, case when p_read then p_at + interval '5 minutes' end, p_at);
$$;

do $$
declare
  org uuid := current_setting('demo.org')::uuid; t1 uuid; t2 uuid; c_acesso uuid; c_imp uuid; c_duv uuid; c_rede uuid; c_srv uuid; k uuid; c timestamptz; n bigint := 0; i integer; hh integer; rq text; ag text; pr text; cat uuid; tm uuid;
  subj text[] := array['Não consigo acessar o e-mail', 'Impressora do financeiro não imprime', 'Wi-Fi caindo na sala de reuniões', 'Solicitar acesso à pasta compartilhada', 'Computador muito lento',
    'Erro ao abrir a planilha de custos', 'Instalar o programa de edição de PDF', 'VPN não conecta em casa', 'Mouse sem fio parou de funcionar', 'Dúvida sobre troca de senha',
    'Servidor de arquivos fora do ar', 'Cadastro de novo funcionário no sistema'];
begin
  select id into t1 from public.teams where organization_id = org and name = 'Suporte Nível 1';
  select id into t2 from public.teams where organization_id = org and name = 'Infraestrutura';
  select id into c_acesso from public.ticket_categories where organization_id = org and name = 'Acesso e senhas';
  select id into c_imp from public.ticket_categories where organization_id = org and name = 'Impressoras e periféricos';
  select id into c_duv from public.ticket_categories where organization_id = org and name = 'Dúvidas gerais';
  select id into c_rede from public.ticket_categories where organization_id = org and name = 'Rede e internet';
  select id into c_srv from public.ticket_categories where organization_id = org and name = 'Servidores';

  -- ---------- 1) fechado dentro do prazo (pedido de informação, nota interna, resolução e confirmação)
  n := n + 1; c := now() - interval '9 days 3 hours';
  k := pg_temp.mk(n, 'solicitante1@demo.exemplo', 'Não consigo entrar no sistema financeiro', 'Aparece "senha inválida" mesmo digitando a senha correta desde hoje cedo.', c_acesso, 'normal', t1, c);
  perform pg_temp.assume(k, 'atendente1@demo.exemplo', c + interval '10 minutes');
  perform pg_temp.note(k, 'atendente1@demo.exemplo', 'Conta bloqueada por tentativas. Desbloqueio no AD feito às ' || to_char(c + interval '25 minutes', 'HH24:MI') || '.', c + interval '25 minutes');
  perform pg_temp.reply(k, 'atendente1@demo.exemplo', 'Olá! Desbloqueamos a sua conta. Pode tentar entrar novamente?', c + interval '30 minutes');
  perform pg_temp.resolve(k, 'atendente1@demo.exemplo', 'Confirmamos o acesso pelo nosso lado e o problema foi resolvido.', c + interval '2 hours');
  perform pg_temp.close(k, 'solicitante1@demo.exemplo', c + interval '2 hours 40 minutes', 'requester');

  -- ---------- 2) fechado com resolução DESCUMPRIDA (levou dias úteis a mais que a meta)
  n := n + 1; c := now() - interval '14 days';
  k := pg_temp.mk(n, 'solicitante2@demo.exemplo', 'Servidor de arquivos lento e fora do ar', 'A pasta da diretoria demora minutos para abrir e às vezes não abre.', c_srv, 'high', t2, c);
  perform pg_temp.assume(k, 'atendente3@demo.exemplo', c + interval '35 minutes');
  perform pg_temp.reply(k, 'atendente3@demo.exemplo', 'Estamos investigando a lentidão no servidor.', c + interval '40 minutes');
  perform pg_temp.note(k, 'atendente3@demo.exemplo', 'Disco com 97% de uso; precisa de limpeza e expansão (aguardando compra).', c + interval '3 hours');
  perform pg_temp.resolve(k, 'atendente3@demo.exemplo', 'Expandimos o volume e normalizamos o desempenho. Monitoramos nas próximas 48 horas.', c + interval '6 days');
  perform pg_temp.close(k, 'gestor@demo.exemplo', c + interval '6 days 2 hours', 'staff');

  -- ---------- 3) REABERTO: ciclo 1 resolvido/encerrado e ciclo 2 em andamento
  n := n + 1; c := now() - interval '8 days 2 hours';
  k := pg_temp.mk(n, 'solicitante3@demo.exemplo', 'Impressora da recepção imprime em branco', 'Todas as páginas saem em branco desde ontem.', c_imp, 'normal', t1, c);
  perform pg_temp.assume(k, 'atendente2@demo.exemplo', c + interval '15 minutes');
  perform pg_temp.reply(k, 'atendente2@demo.exemplo', 'Vamos verificar o toner e a conexão da impressora.', c + interval '20 minutes');
  perform pg_temp.resolve(k, 'atendente2@demo.exemplo', 'Trocamos o cartucho e a impressão voltou ao normal.', c + interval '3 hours');
  perform pg_temp.close(k, 'solicitante3@demo.exemplo', c + interval '3 hours 30 minutes', 'requester');
  -- reabertura há ~30 horas: novo ciclo com a política vigente
  update public.tickets set status = 'in_progress', last_public_activity_at = now() - interval '30 hours' where id = k;
  insert into public.ticket_service_cycles (organization_id, ticket_id, cycle_number, sla_policy_version_id, priority_snapshot, first_response_target_minutes, resolution_target_minutes, started_at)
    select org, k, 2, p.id, 'normal', (p.targets_by_priority -> 'normal' ->> 'first_response')::int, (p.targets_by_priority -> 'normal' ->> 'resolution')::int, now() - interval '30 hours'
    from public.sla_policy_versions p where p.organization_id = org order by p.created_at desc limit 1;
  perform pg_temp.msg(k, pg_temp.u('solicitante3@demo.exemplo'), 'requester', 'public', 'Reabertura: voltou a imprimir em branco hoje de manhã.', now() - interval '30 hours');
  perform pg_temp.event(k, 'reopened', pg_temp.u('solicitante3@demo.exemplo'), jsonb_build_object('from', 'closed', 'to', 'in_progress', 'cycle', 2), now() - interval '30 hours');
  perform pg_temp.reply(k, 'atendente2@demo.exemplo', 'Entendido! Vamos trocar a unidade de imagem. Passamos aí ainda hoje.', now() - interval '29 hours 30 minutes');
  perform pg_temp.note(k, 'atendente2@demo.exemplo', 'Segunda ocorrência: provável defeito na unidade de imagem. Pedir peça.', now() - interval '29 hours');
  perform pg_temp.notify(k, 'atendente2@demo.exemplo', 'reopened', now() - interval '30 hours', true);

  -- ---------- 4) RESOLVIDO aguardando confirmação do solicitante (dentro da janela de reabertura)
  n := n + 1; c := now() - interval '26 hours';
  k := pg_temp.mk(n, 'solicitante4@demo.exemplo', 'Acesso à pasta de projetos', 'Preciso de acesso de leitura à pasta Projetos 2026.', c_acesso, 'low', t1, c);
  perform pg_temp.assume(k, 'atendente1@demo.exemplo', c + interval '40 minutes');
  perform pg_temp.reply(k, 'atendente1@demo.exemplo', 'Recebido. Vamos solicitar a aprovação do responsável pela pasta.', c + interval '50 minutes');
  perform pg_temp.resolve(k, 'atendente1@demo.exemplo', 'Acesso liberado. Pode testar e confirmar por aqui.', now() - interval '20 hours');
  perform pg_temp.notify(k, 'solicitante4@demo.exemplo', 'resolved', now() - interval '20 hours', false);

  -- ---------- 5) AGUARDANDO SOLICITANTE (SLA pausado, dentro do prazo)
  n := n + 1; c := pg_temp.back(320);
  k := pg_temp.mk(n, 'solicitante1@demo.exemplo', 'Wi-Fi cai toda hora na sala de reuniões', 'A conexão cai a cada poucos minutos durante as reuniões.', c_rede, 'normal', t2, c);
  perform pg_temp.assume(k, 'atendente3@demo.exemplo', c + interval '12 minutes');
  perform pg_temp.ask(k, 'atendente3@demo.exemplo', 'Olá! Em quais dias e horários a queda acontece com mais frequência? Se puder, informe o modelo do notebook.', pg_temp.back(60));
  perform pg_temp.notify(k, 'solicitante1@demo.exemplo', 'public_reply', pg_temp.back(60), false);

  -- ---------- 6) AGUARDANDO SOLICITANTE, mas JÁ ATRASADO antes de pausar (a pausa não esconde o atraso)
  n := n + 1; c := pg_temp.back(520);
  k := pg_temp.mk(n, 'solicitante2@demo.exemplo', 'VPN não conecta (urgente)', 'Não consigo conectar na VPN e preciso fechar um relatório hoje.', c_rede, 'urgent', t2, c);
  perform pg_temp.assume(k, 'atendente3@demo.exemplo', c + interval '5 minutes');
  perform pg_temp.ask(k, 'atendente3@demo.exemplo', 'Pode enviar uma captura da mensagem de erro da VPN?', pg_temp.back(200));
  perform pg_temp.notify(k, 'solicitante2@demo.exemplo', 'public_reply', pg_temp.back(200), false);

  -- ---------- 7) EM ATENDIMENTO, no prazo (aberto agora há pouco)
  n := n + 1; c := now() - interval '40 minutes';
  k := pg_temp.mk(n, 'solicitante3@demo.exemplo', 'Planilha de custos não abre', 'O Excel mostra erro de arquivo corrompido ao abrir a planilha de custos.', c_duv, 'normal', t1, c);
  perform pg_temp.assume(k, 'atendente1@demo.exemplo', c + interval '6 minutes');
  perform pg_temp.reply(k, 'atendente1@demo.exemplo', 'Olá! Já estamos verificando. Vamos tentar recuperar uma versão anterior do arquivo.', c + interval '12 minutes');
  perform pg_temp.note(k, 'atendente1@demo.exemplo', 'Versão anterior existe no backup de ontem; testar restauração.', c + interval '20 minutes');

  -- ---------- 8) EM ATENDIMENTO com resolução ATRASADA (alta, 900 min úteis desde a abertura; meta 480)
  n := n + 1; c := pg_temp.back(900);
  k := pg_temp.mk(n, 'solicitante4@demo.exemplo', 'Sistema de pedidos travando todo dia', 'O sistema de pedidos trava por alguns minutos várias vezes ao dia.', c_srv, 'high', t2, c);
  perform pg_temp.assume(k, 'atendente2@demo.exemplo', c + interval '20 minutes');
  perform pg_temp.reply(k, 'atendente2@demo.exemplo', 'Estamos coletando logs do servidor de aplicação para achar a causa.', c + interval '25 minutes');
  perform pg_temp.note(k, 'atendente2@demo.exemplo', 'Picos de memória às 10h e 15h. Aumentar limite do pool e monitorar.', c + interval '2 hours');

  -- ---------- 9) ABERTO e sem responsável: PRÓXIMO DO LIMITE (85% da meta de 240 min)
  n := n + 1; c := pg_temp.back(204);
  k := pg_temp.mk(n, 'solicitante1@demo.exemplo', 'Instalar programa de edição de PDF', 'Preciso do programa de edição de PDF no meu computador.', c_duv, 'normal', t1, c);

  -- ---------- 10) ABERTO e sem responsável: ATRASADO (alta, meta de 60 min; 150 consumidos)
  n := n + 1; c := pg_temp.back(150);
  k := pg_temp.mk(n, 'solicitante2@demo.exemplo', 'Sem internet no escritório inteiro', 'Ninguém consegue acessar a internet desde cedo.', c_rede, 'high', t2, c);

  -- ---------- 11) ABERTO e sem responsável: no prazo (baixa)
  n := n + 1; c := pg_temp.back(25);
  k := pg_temp.mk(n, 'solicitante3@demo.exemplo', 'Mouse sem fio parou de funcionar', 'O mouse sem fio não responde, mesmo trocando a pilha.', c_imp, 'low', t1, c);

  -- ---------- 12) EM ATENDIMENTO: primeira resposta DESCUMPRIDA e resolução ainda no prazo
  n := n + 1; c := pg_temp.back(400);
  k := pg_temp.mk(n, 'solicitante4@demo.exemplo', 'Dados do cliente sumiram do cadastro', 'Alguns clientes sumiram da listagem do cadastro desde ontem.', c_srv, 'urgent', t2, c);
  perform pg_temp.assume(k, 'atendente3@demo.exemplo', c + interval '1 hour 50 minutes');
  perform pg_temp.reply(k, 'atendente3@demo.exemplo', 'Desculpe a demora. Estamos restaurando os dados a partir do backup.', c + interval '2 hours');

  -- ---------- 13..32) chamados de fundo (determinísticos): fechados e resolvidos nos últimos 12 dias, com durações variadas
  for i in 1 .. 20 loop
    n := n + 1;
    hh := 9 + (i * 7) % 8;
    c := date_trunc('day', now() - make_interval(days => 2 + (i * 5) % 11)) + make_interval(hours => hh, mins => (i * 13) % 50);
    if c > now() - interval '3 hours' then c := c - interval '1 day'; end if;
    if i > 16 then c := now() - make_interval(hours => (i - 16) * 4); end if; -- os 4 últimos ficam em atendimento, recentes (carga atual realista)
    rq := 'solicitante' || (1 + i % 4) || '@demo.exemplo';
    ag := 'atendente' || (1 + i % 3) || '@demo.exemplo';
    pr := (array['low', 'normal', 'normal', 'high'])[1 + i % 4];
    cat := (array[c_acesso, c_imp, c_duv, c_rede, c_srv])[1 + i % 5];
    tm := case when cat in (c_rede, c_srv) then t2 else t1 end;
    if tm = t2 and ag = 'atendente1@demo.exemplo' then ag := 'atendente3@demo.exemplo'; end if;
    if tm = t1 and ag = 'atendente3@demo.exemplo' then ag := 'atendente1@demo.exemplo'; end if;
    k := pg_temp.mk(n, rq, subj[1 + i % 12] || ' (#' || n || ')', 'Descrição do problema relatado pelo solicitante, com os detalhes do que aconteceu e do que já foi tentado.', cat, pr, tm, c);
    perform pg_temp.assume(k, ag, c + make_interval(mins => 8 + i % 20));
    perform pg_temp.reply(k, ag, 'Olá! Recebemos o seu chamado e já estamos analisando.', c + make_interval(mins => 15 + (i * 3) % 40));
    if i % 3 = 0 then perform pg_temp.note(k, ag, 'Conferido o histórico do usuário: sem ocorrências anteriores.', c + make_interval(mins => 30 + i)); end if;
    if i % 5 = 0 then
      perform pg_temp.ask(k, ag, 'Pode nos passar mais detalhes para continuar?', c + make_interval(mins => 60 + i));
      perform pg_temp.resume(k, rq, 'Segue o que foi pedido: aconteceu hoje de manhã e continua igual.', c + make_interval(hours => 5 + i % 3));
    end if;
    if i <= 16 then
      perform pg_temp.resolve(k, ag, 'Problema resolvido. Qualquer dúvida, é só responder por aqui.', c + make_interval(hours => 8 + i % 5, mins => (i * 7) % 50));
      if i % 4 <> 0 then perform pg_temp.close(k, rq, c + make_interval(hours => 9 + i % 5, mins => (i * 7) % 50 + 20), 'requester'); end if;
    end if;
  end loop;

  -- chamados em andamento atribuídos (carga atual)
  update public.tickets set assigned_user_id = pg_temp.u('atendente1@demo.exemplo') where organization_id = org and assigned_user_id is null and status = 'in_progress' and team_id = t1 and ticket_number % 2 = 0;

  update public.ticket_counters set last_number = (select max(ticket_number) from public.tickets where organization_id = org) where organization_id = org;
end $$;
-- Instantes explícitos: confere que nada ficou à frente do relógio (ver scripts/seed-demo.mjs para as demais conferências).
commit;
