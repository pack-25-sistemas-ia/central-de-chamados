-- Central de Chamados — fila (filtros, busca, paginação e escopo no servidor), anexos (validação e herança de visibilidade), notificações, exportação, configurações e limite de abuso.

\set as_o 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000d0","aal":"aal2","email":"o@t.invalid"}'', true); set local role authenticated;'
\set as_m 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000d1","aal":"aal1","email":"m@t.invalid"}'', true); set local role authenticated;'
\set as_a1 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000d2","aal":"aal1","email":"a1@t.invalid"}'', true); set local role authenticated;'
\set as_a3 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000d4","aal":"aal1","email":"a3@t.invalid"}'', true); set local role authenticated;'
\set as_r1 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000e1","aal":"aal1","email":"r1@t.invalid"}'', true); set local role authenticated;'
\set as_r2 'select set_config(''request.jwt.claims'', ''{"sub":"ffffffff-0000-4000-8000-0000000000e2","aal":"aal1","email":"r2@t.invalid"}'', true); set local role authenticated;'

begin;

create function test.errmsg(q text) returns text language plpgsql as $$ begin execute q; return null; exception when others then return sqlerrm; end $$;
create function test.has(msg text, pat text, label text) returns void language plpgsql as $$ begin if msg is null or msg not like pat then raise exception 'FALHOU: % — esperado %, veio %', label, pat, coalesce(msg, '(sem erro)'); end if; end $$;
create function test.t(k text) returns uuid language sql as $$ select current_setting('t.' || k)::uuid $$;
create function test.cnt(q text) returns bigint language plpgsql security definer set search_path = '' as $$ declare n bigint; begin execute q into n; return n; end $$;
create function test.hex32() returns text language sql volatile as $$ select replace(gen_random_uuid()::text, '-', '') $$;
grant execute on all functions in schema test to anon, authenticated;

insert into auth.users (id, email) values
  ('ffffffff-0000-4000-8000-0000000000d0', 'o@t.invalid'), ('ffffffff-0000-4000-8000-0000000000d1', 'm@t.invalid'), ('ffffffff-0000-4000-8000-0000000000d2', 'a1@t.invalid'),
  ('ffffffff-0000-4000-8000-0000000000d4', 'a3@t.invalid'), ('ffffffff-0000-4000-8000-0000000000e1', 'r1@t.invalid'), ('ffffffff-0000-4000-8000-0000000000e2', 'r2@t.invalid');

-- ===================================================================== (1) empresa
:as_o
do $$
declare org uuid; t1 uuid; t2 uuid;
begin
  org := public.create_organization('Fila Teste', 'fila-teste');
  perform set_config('t.org', org::text, true);
  insert into public.organization_members (organization_id, user_id, role) values
    (org, 'ffffffff-0000-4000-8000-0000000000d1', 'manager'), (org, 'ffffffff-0000-4000-8000-0000000000d2', 'member'), (org, 'ffffffff-0000-4000-8000-0000000000d4', 'member'),
    (org, 'ffffffff-0000-4000-8000-0000000000e1', 'viewer'), (org, 'ffffffff-0000-4000-8000-0000000000e2', 'viewer');
  t1 := public.tk_save_team(org, null, 'Equipe 1', true); t2 := public.tk_save_team(org, null, 'Equipe 2', true);
  perform set_config('t.t1', t1::text, true); perform set_config('t.t2', t2::text, true);
  perform public.tk_set_team_members(org, t1, array['ffffffff-0000-4000-8000-0000000000d1', 'ffffffff-0000-4000-8000-0000000000d2']::uuid[]);
  perform public.tk_set_team_members(org, t2, array['ffffffff-0000-4000-8000-0000000000d4']::uuid[]);
  perform set_config('t.c1', public.tk_save_category(org, null, 'Impressoras', t1, true)::text, true);
  perform set_config('t.c2', public.tk_save_category(org, null, 'Rede', t2, true)::text, true);
  raise notice 'PASS: empresa (1)';
end $$;
reset role;

-- ===================================================================== (2) massa: 25 chamados do solicitante 1 (20 na equipe 1, 5 na equipe 2) e 2 do solicitante 2
:as_r1
do $$
declare org uuid := test.t('org'); i integer;
begin
  for i in 1 .. 20 loop
    perform public.tk_open_ticket(org, gen_random_uuid(), gen_random_uuid(), case when i = 7 then 'Impressora 100% travada' else 'Impressora com defeito ' || i end, test.t('c1'), 'Descrição ' || i, null, null, null, null, null);
  end loop;
  for i in 1 .. 5 loop
    perform public.tk_open_ticket(org, gen_random_uuid(), gen_random_uuid(), 'Rede lenta ' || i, test.t('c2'), 'Descrição de rede ' || i, null, null, null, null, null);
  end loop;
  raise notice 'PASS: 25 chamados abertos (2)';
end $$;
reset role;
:as_r2
do $$ begin perform public.tk_open_ticket(test.t('org'), gen_random_uuid(), gen_random_uuid(), 'Chamado do solicitante dois', test.t('c1'), 'texto', null, null, null, null, null); end $$;
reset role;

-- ===================================================================== (3) fila: paginação, busca, filtros e escopo
:as_m
do $$
declare org uuid := test.t('org'); q jsonb;
begin
  q := public.tk_queue(org, '{}', 1, 10);
  assert (q ->> 'total')::int = 26 and jsonb_array_length(q -> 'rows') = 10, 'gestor vê os 26; página 1 tem 10';
  assert jsonb_array_length(public.tk_queue(org, '{}', 3, 10) -> 'rows') = 6, 'página 3 tem 6';
  assert (public.tk_queue(org, '{}', 1, 500) ->> 'size')::int = 50, 'tamanho de página limitado a 50';
  assert (public.tk_queue(org, '{}', 1, 10) -> 'rows' -> 0 ->> 'number')::int = 26 and (public.tk_queue(org, '{}', 1, 10) -> 'rows' -> 9 ->> 'number')::int = 17, 'mais recentes primeiro';
  assert (public.tk_queue(org, '{"q":"#7"}', 1, 25) ->> 'total')::int = 1, 'busca pelo número (#7)';
  assert (public.tk_queue(org, '{"q":"100%"}', 1, 25) ->> 'total')::int = 1, 'busca trata % como texto literal';
  assert (public.tk_queue(org, '{"q":"%"}', 1, 25) ->> 'total')::int = 1 and (public.tk_queue(org, '{"q":"_"}', 1, 25) ->> 'total')::int = 0, 'curingas % e _ não casam tudo: valem como texto';
  assert (public.tk_queue(org, '{"q":"impressora"}', 1, 25) ->> 'total')::int = 20, 'busca por assunto sem diferenciar maiúsculas';
  assert (public.tk_queue(org, format('{"team":"%s"}', test.t('t2'))::jsonb, 1, 25) ->> 'total')::int = 5, 'filtro por equipe';
  assert (public.tk_queue(org, format('{"category":"%s"}', test.t('c1'))::jsonb, 1, 25) ->> 'total')::int = 21, 'filtro por categoria';
  assert (public.tk_queue(org, '{"view":"unassigned"}', 1, 25) ->> 'total')::int = 26 and (public.tk_queue(org, '{"view":"mine"}', 1, 25) ->> 'total')::int = 0, 'visões: sem responsável × meus';
  assert (public.tk_queue(org, '{"status":["resolved","closed"]}', 1, 25) ->> 'total')::int = 0, 'filtro por status';
  assert (public.tk_queue(org, '{"sort":"priority"}', 1, 5) -> 'rows' -> 0 ->> 'priority') is not null, 'ordenação por prioridade aceita';
  assert (public.tk_queue(org, '{"from":"2000-01-01","to":"2000-01-31"}', 1, 25) ->> 'total')::int = 0 and (public.tk_queue(org, format('{"from":"%s","to":"%s"}', current_date - 1, current_date + 1)::jsonb, 1, 25) ->> 'total')::int = 26, 'filtro por data de criação';
  assert public.tk_queue(org, '{"q":"x"}', 1, 25) -> 'rows' = '[]'::jsonb or true, 'consulta sem resultado não falha';
  raise notice 'PASS: fila do gestor (3)';
end $$;
reset role;
:as_a1
do $$
declare org uuid := test.t('org');
begin
  assert (public.tk_queue(org, '{}', 1, 50) ->> 'total')::int = 21, 'atendente da equipe 1 vê só os 21 da equipe';
  assert (public.tk_queue(org, format('{"team":"%s"}', test.t('t2'))::jsonb, 1, 50) ->> 'total')::int = 0, 'filtrar por outra equipe não amplia o acesso';
  perform public.tk_claim(org, (public.tk_queue(org, '{"q":"#7"}', 1, 5) -> 'rows' -> 0 ->> 'id')::uuid);
  assert (public.tk_queue(org, '{"view":"mine"}', 1, 25) ->> 'total')::int = 1 and (public.tk_queue(org, '{"assignee":"me"}', 1, 25) ->> 'total')::int = 1, 'meus chamados';
  assert (public.tk_queue(org, '{"view":"unassigned"}', 1, 50) ->> 'total')::int = 20, 'sem responsável diminui';
  assert public.tk_queue(org, '{"view":"mine"}', 1, 25) -> 'rows' -> 0 -> 'sla' ->> 'summary' = 'on_track' or public.tk_queue(org, '{"view":"mine"}', 1, 25) -> 'rows' -> 0 -> 'sla' ->> 'summary' in ('at_risk', 'paused', 'met', 'overdue'), 'equipe recebe o SLA na fila';
  raise notice 'PASS: fila do atendente respeita equipe (3)';
end $$;
reset role;
:as_a3
do $$
begin
  assert (public.tk_queue(test.t('org'), '{}', 1, 50) ->> 'total')::int = 5, 'atendente da equipe 2 vê só os 5';
  raise notice 'PASS: fila do atendente 2 (3)';
end $$;
reset role;
:as_r1
do $$
declare org uuid := test.t('org'); q jsonb;
begin
  q := public.tk_queue(org, format('{"requester":"ffffffff-0000-4000-8000-0000000000e2","team":"%s","assignee":"none","sla":"overdue","view":"mine"}', test.t('t2'))::jsonb, 1, 50);
  assert (q ->> 'total')::int = 25, 'filtros de equipe/solicitante/SLA/atribuição são ignorados para o solicitante: continua vendo só os próprios 25';
  assert q::text not like '%"assignee"%' or (q -> 'rows' -> 0 ->> 'assignee') is null, 'sem responsável no DTO do solicitante';
  assert (public.tk_queue(org, '{"status":["resolved"]}', 1, 50) ->> 'total')::int = 0, 'filtro por status funciona para o solicitante';
  raise notice 'PASS: fila do solicitante limitada aos próprios chamados (3)';
end $$;
reset role;

:as_m
do $$
declare org uuid := test.t('org');
begin
  assert (public.tk_queue(org, '{"view":"mine"}', 1, 25) ->> 'total')::int = 0, 'gestor não vê como «meus» os chamados que o atendente assumiu';
  assert (public.tk_queue(org, '{"assignee":"me"}', 1, 25) ->> 'total')::int = 0, 'filtro «responsável: eu» também';
  assert (public.tk_queue(org, '{"assignee":"none"}', 1, 50) ->> 'total')::int = 25, 'sem responsável: 25 (1 já foi assumido)';
  assert (public.tk_queue(org, format('{"requester":"%s"}', 'ffffffff-0000-4000-8000-0000000000e2')::jsonb, 1, 50) ->> 'total')::int = 1, 'filtro por solicitante devolve só os chamados dele';
  assert (public.tk_queue(org, format('{"requester":"%s"}', 'ffffffff-0000-4000-8000-0000000000e1')::jsonb, 1, 50) ->> 'total')::int = 25, 'e o outro solicitante tem 25';
  raise notice 'PASS: «meus» e filtro por solicitante (3)';
end $$;
reset role;

-- ===================================================================== (4) filtro e visão de SLA atrasado (chamado antigo inserido com data fixa)
do $$
declare org uuid := test.t('org'); tid uuid := gen_random_uuid(); pol public.sla_policy_versions;
begin
  select * into pol from public.sla_policy_versions where organization_id = org order by created_at desc limit 1;
  insert into public.tickets (id, organization_id, ticket_number, requester_user_id, subject, priority, status, team_id, created_by, created_at, last_public_activity_at)
  values (tid, org, 900, 'ffffffff-0000-4000-8000-0000000000e1', 'Chamado antigo atrasado', 'high', 'open', test.t('t1'), 'ffffffff-0000-4000-8000-0000000000e1', now() - interval '30 days', now() - interval '30 days');
  insert into public.ticket_service_cycles (organization_id, ticket_id, cycle_number, sla_policy_version_id, priority_snapshot, first_response_target_minutes, resolution_target_minutes, started_at)
  values (org, tid, 1, pol.id, 'high', 60, 480, now() - interval '30 days');
  perform set_config('t.old', tid::text, true);
end $$;
:as_m
do $$
declare org uuid := test.t('org');
begin
  assert (public.tk_queue(org, '{"sla":"overdue"}', 1, 25) ->> 'total')::int = 1 and public.tk_queue(org, '{"view":"overdue"}', 1, 25) -> 'rows' -> 0 ->> 'number' = '900', 'SLA atrasado aparece no filtro e na visão «SLA atrasado»';
  assert (public.tk_queue(org, '{"sla":"overdue"}', 1, 25) -> 'rows' -> 0 -> 'sla' -> 'first_response' ->> 'state') = 'overdue', 'estado calculado na leitura, sem depender de cron';
  assert (public.tk_queue(org, '{"sla":"paused"}', 1, 25) ->> 'total')::int = 0, 'nenhum pausado';
  assert (public.tk_queue(org, '{"sla":"on_track"}', 1, 50) ->> 'total')::int >= 20, 'os recém-abertos estão no prazo';
  assert (public.tk_dashboard(org, current_date - 40, current_date, null) -> 'overdue_open' ->> 'first_response')::int = 1, 'painel mostra o ciclo aberto já atrasado';
  raise notice 'PASS: SLA atrasado na fila e no painel (4)';
end $$;
reset role;

-- ===================================================================== (5) anexos: validação, herança de visibilidade e download autorizado
:as_r1
do $$
declare org uuid := test.t('org'); kid uuid := gen_random_uuid(); p1 text := org::text || '/' || kid::text || '/' || test.hex32() || '.png'; r jsonb; sid uuid;
begin
  r := public.tk_open_ticket(org, kid, gen_random_uuid(), 'Erro com captura de tela', test.t('c1'), 'Segue a imagem.', null, null, null, null,
    jsonb_build_array(jsonb_build_object('path', p1, 'filename', '..\..\captura "final".png', 'mime', 'image/png', 'size', 2048)));
  perform set_config('t.kA', kid::text, true); perform set_config('t.pA', p1, true);
  assert (select count(*) from public.ticket_attachments where ticket_id = kid) = 1, 'anexo vinculado à mensagem inicial';
  assert (select original_filename from public.ticket_attachments where ticket_id = kid) not like '%\%', 'nome de arquivo sanitizado (sem barras)';
  sid := gen_random_uuid();
  perform test.has(test.errmsg(format($q$select public.tk_open_ticket(%L, %L, gen_random_uuid(), 'Anexo SVG', null, 'texto', null, null, null, null, %L::jsonb)$q$, org, sid,
    jsonb_build_array(jsonb_build_object('path', org::text || '/' || sid::text || '/' || test.hex32() || '.png', 'filename', 'a.svg', 'mime', 'image/svg+xml', 'size', 10))::text)), '%tipo de anexo%', 'SVG recusado');
  perform test.has(test.errmsg(format($q$select public.tk_open_ticket(%L, %L, gen_random_uuid(), 'Anexo executável', null, 'texto', null, null, null, null, %L::jsonb)$q$, org, gen_random_uuid(),
    jsonb_build_array(jsonb_build_object('path', org::text || '/x/' || test.hex32() || '.exe', 'filename', 'a.exe', 'mime', 'application/x-msdownload', 'size', 10))::text)), '%anexo inválido%', 'caminho que não é do servidor recusado');
  perform test.has(test.errmsg(format($q$select public.tk_post_message(%L, %L, gen_random_uuid(), 'public', 'grande', %L::jsonb, null, null)$q$, org, kid,
    jsonb_build_array(jsonb_build_object('path', org::text || '/' || kid::text || '/' || test.hex32() || '.pdf', 'filename', 'g.pdf', 'mime', 'application/pdf', 'size', 6000000))::text)), '%tamanho máximo%', 'acima do limite (5 MB)');
  perform test.has(test.errmsg(format($q$select public.tk_post_message(%L, %L, gen_random_uuid(), 'public', 'outra empresa', %L::jsonb, null, null)$q$, org, kid,
    jsonb_build_array(jsonb_build_object('path', gen_random_uuid()::text || '/' || kid::text || '/' || test.hex32() || '.pdf', 'filename', 'g.pdf', 'mime', 'application/pdf', 'size', 100))::text)), '%anexo inválido%', 'caminho de outra empresa recusado');
  perform test.has(test.errmsg(format($q$select public.tk_post_message(%L, %L, gen_random_uuid(), 'public', 'muitos', %L::jsonb, null, null)$q$, org, kid,
    (select jsonb_agg(jsonb_build_object('path', org::text || '/' || kid::text || '/' || test.hex32() || '.pdf', 'filename', 'g.pdf', 'mime', 'application/pdf', 'size', 100)) from generate_series(1, 4))::text)), '%até 3 anexos%', 'mais de 3 anexos');
  assert (select count(*) from public.ticket_attachments where ticket_id = kid) = 1, 'nenhuma tentativa inválida deixou resíduo';
  raise notice 'PASS: anexos validados (5)';
end $$;
reset role;
:as_a1
do $$
declare org uuid := test.t('org'); kid uuid := test.t('kA'); pI text := org::text || '/' || kid::text || '/' || test.hex32() || '.pdf'; att uuid; r jsonb; d jsonb;
begin
  perform public.tk_post_message(org, kid, gen_random_uuid(), 'internal', 'Print confirma o erro; ver driver.', jsonb_build_array(jsonb_build_object('path', pI, 'filename', 'log-interno.pdf', 'mime', 'application/pdf', 'size', 500)), null, null);
  select id into att from public.ticket_attachments where storage_path = pI;
  perform set_config('t.attI', att::text, true);
  assert public.tk_attachment_info(org, att) ->> 'path' = pI, 'equipe obtém o caminho do anexo interno';
  d := public.tk_ticket_detail(org, kid);
  assert jsonb_array_length(d -> 'attachments') = 2, 'equipe vê os dois anexos';
  raise notice 'PASS: anexo interno visível à equipe (5)';
end $$;
reset role;
:as_r1
do $$
declare org uuid := test.t('org'); kid uuid := test.t('kA'); d jsonb;
begin
  perform set_config('t.attP', (select id::text from public.ticket_attachments where ticket_id = kid), true);
  assert (select count(*) from public.ticket_attachments where ticket_id = kid) = 1, 'RLS: solicitante lê só o anexo público';
  d := public.tk_ticket_detail(org, kid);
  assert jsonb_array_length(d -> 'attachments') = 1 and d::text not like '%log-interno%', 'DTO do solicitante não lista o anexo interno';
  perform test.has(test.errmsg(format($q$select public.tk_attachment_info(%L, %L)$q$, org, test.t('attI'))), '%anexo não encontrado%', 'anexo interno não pode ser baixado pelo solicitante');
  assert public.tk_attachment_info(org, (select id from public.ticket_attachments where ticket_id = kid)) ->> 'mime' = 'image/png', 'anexo público pode ser baixado pelo dono do chamado';
  raise notice 'PASS: anexo interno invisível ao solicitante (5)';
end $$;
reset role;
:as_r2
do $$
begin
  assert (select count(*) from public.ticket_attachments) = 0, 'outro solicitante não vê anexos alheios';
  perform test.has(test.errmsg(format($q$select public.tk_attachment_info(%L, %L)$q$, test.t('org'), test.t('attP'))), '%anexo não encontrado%', 'anexo público de outro solicitante não é baixável');
  perform test.has(test.errmsg(format($q$select public.tk_attachment_info(%L, %L)$q$, test.t('org'), test.t('attI'))), '%anexo não encontrado%', 'anexo interno não é baixável por outro solicitante');
  raise notice 'PASS: anexos alheios invisíveis (5)';
end $$;
reset role;

-- ===================================================================== (6) notificações
:as_a1
do $$
declare org uuid := test.t('org'); kid uuid := test.t('kA'); n integer;
begin
  perform public.tk_claim(org, kid);
  perform public.tk_post_message(org, kid, gen_random_uuid(), 'public', 'Recebemos a imagem, estamos analisando.', null, null, null);
  perform public.tk_post_message(org, kid, gen_random_uuid(), 'internal', 'Nota que ninguém de fora deve ver.', null, null, null);
  raise notice 'PASS: ações geram notificações (6)';
end $$;
reset role;
:as_r1
do $$
declare org uuid := test.t('org'); n jsonb;
begin
  n := public.tk_notifications(org, 20);
  assert (n ->> 'unread')::int = 1 and n -> 'items' -> 0 ->> 'type' = 'public_reply', 'solicitante recebe 1 notificação (resposta pública); nota interna não notifica';
  assert (select count(*) from public.notifications) = 1, 'só as próprias notificações (RLS)';
  assert public.tk_mark_notifications(org, null) = 1, 'marcar como lidas';
  assert (public.tk_notifications(org, 20) ->> 'unread')::int = 0, 'nenhuma não lida depois de marcar';
  raise notice 'PASS: notificações do solicitante (6)';
end $$;
reset role;
do $$
begin
  assert test.cnt(format($q$select count(*) from public.notifications where recipient_user_id = 'ffffffff-0000-4000-8000-0000000000e1' and event_type not in ('public_reply', 'resolved', 'reopened')$q$)) = 0, 'solicitante nunca recebe notificação de atribuição';
  assert test.cnt(format($q$select count(*) from public.notifications where recipient_user_id = 'ffffffff-0000-4000-8000-0000000000d4'$q$)) >= 5, 'atendente da equipe 2 recebe os chamados da equipe 2';
  assert test.cnt(format($q$select count(*) from public.notifications n join public.tickets t on t.id = n.ticket_id where n.recipient_user_id = 'ffffffff-0000-4000-8000-0000000000d4' and t.team_id = %L$q$, test.t('t1'))) = 0, 'sem notificação de chamados de outra equipe';
  raise notice 'PASS: destinatários com acesso ao chamado (6)';
end $$;

-- ===================================================================== (7) exportação (equipe) e configurações
:as_a1
do $$
declare org uuid := test.t('org'); rows jsonb;
begin
  rows := public.tk_export_rows(org, '{}');
  assert jsonb_array_length(rows) = 23 and rows -> 0 ? 'number' and not (rows -> 0 ? 'body') and not (rows -> 0 ? 'email'), 'exportação do atendente = só o que ele vê, sem corpo de mensagem nem e-mail';
  perform public.tk_log_export(org, jsonb_array_length(rows));
  assert test.cnt(format($q$select count(*) from public.audit_log where entity = 'tickets' and action = 'export'$q$)) = 1, 'exportação auditada';
  raise notice 'PASS: exportação (7)';
end $$;
reset role;
:as_r1
do $$
begin
  perform test.has(test.errmsg(format($q$select public.tk_export_rows(%L, '{}')$q$, test.t('org'))), '%sem permissão%', 'solicitante não exporta');
  perform test.has(test.errmsg(format($q$select public.tk_orphan_uploads(%L)$q$, test.t('org'))), '%sem permissão%', 'solicitante não lista uploads órfãos');
  raise notice 'PASS: solicitante sem exportação (7)';
end $$;
reset role;
:as_o
do $$
declare org uuid := test.t('org'); r jsonb;
begin
  perform public.tk_save_settings(org, '{"reopen_window_hours": 24, "primary_color": "#112233", "public_display_name": "Suporte Aurora", "attachment_max_size_bytes": 1048576}');
  assert (select reopen_window_hours from public.ticket_settings where organization_id = org) = 24 and (select attachment_max_size_bytes from public.ticket_settings where organization_id = org) = 1048576, 'configurações salvas';
  perform test.has(test.errmsg(format($q$select public.tk_save_settings(%L, '{"primary_color":"vermelho"}')$q$, org)), '%valor fora do permitido%', 'cor inválida');
  perform test.has(test.errmsg(format($q$select public.tk_save_settings(%L, '{"attachment_max_size_bytes":99999999}')$q$, org)), '%valor fora do permitido%', 'limite de anexo acima do teto de segurança (10 MB)');
  r := public.tk_publish_sla(org, 'America/Sao_Paulo', '{"weekly":{"1":[["08:00","18:00"]],"2":[["08:00","18:00"]]},"closed_dates":["2026-12-25"]}', '{"low":{"first_response":480,"resolution":2400},"normal":{"first_response":15,"resolution":1440},"high":{"first_response":60,"resolution":480},"urgent":{"first_response":30,"resolution":240}}');
  assert r ? 'policy_version_id', 'nova versão de SLA publicada';
  assert (select count(*) from public.sla_policy_versions where organization_id = org) = 2 and (select count(*) from public.business_calendar_versions where organization_id = org) = 2, 'versões anteriores preservadas';
  perform test.has(test.errmsg(format($q$select public.tk_publish_sla(%L, 'America/Sao_Paulo', '{"weekly":{"1":[["09:00","08:00"]]}}', '{"low":{"first_response":480,"resolution":2400},"normal":{"first_response":15,"resolution":1440},"high":{"first_response":60,"resolution":480},"urgent":{"first_response":30,"resolution":240}}'::jsonb)$q$, org)), '%fim deve ser depois%', 'calendário inválido não publica');
  perform test.has(test.errmsg(format($q$select public.tk_save_settings(%L, '[]')$q$, org)), '%inválidos%', 'payload inválido');
  assert (select count(*) from public.audit_log where entity = 'ticket_settings') >= 1 and (select count(*) from public.audit_log where entity = 'sla_policy_versions') >= 1, 'mudanças administrativas auditadas';
  raise notice 'PASS: configurações e publicação de SLA (7)';
end $$;
reset role;
:as_r2
do $$
declare org uuid := test.t('org'); id2 uuid := gen_random_uuid();
begin
  perform public.tk_open_ticket(org, id2, gen_random_uuid(), 'Depois da nova política', test.t('c1'), 'texto', null, null, null, null, null);
  assert test.cnt(format($q$select first_response_target_minutes from public.ticket_service_cycles where ticket_id = %L$q$, id2)) = 15, 'novo chamado usa a política publicada';
  raise notice 'PASS: ciclo novo com política vigente (7)';
end $$;
reset role;
do $$
begin
  assert (select first_response_target_minutes from public.ticket_service_cycles c join public.tickets t on t.id = c.ticket_id where t.ticket_number = 1) = 240, 'ciclos anteriores mantêm 240';
  raise notice 'PASS: ciclos antigos intactos (7)';
end $$;

-- ===================================================================== (8) limite de abuso no banco
do $$
begin
  insert into public.ticket_rate_limits (bucket, window_start, hits)
  values ('open:ffffffff-0000-4000-8000-0000000000e2', to_timestamp(floor(extract(epoch from now()) / 3600) * 3600), 60) on conflict (bucket, window_start) do update set hits = 60;
end $$;
:as_r2
do $$
begin
  perform test.has(test.errmsg(format($q$select public.tk_open_ticket(%L, gen_random_uuid(), gen_random_uuid(), 'Mais um chamado', null, 'texto', null, null, null, null, null)$q$, test.t('org'))), '%Muitas tentativas%', 'teto de aberturas por hora');
  raise notice 'PASS: limite de abuso por usuário (8)';
end $$;
reset role;

rollback;
