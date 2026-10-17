#!/usr/bin/env node
// Carrega a empresa de DEMONSTRAÇÃO («Suporte Aurora TI», dados fictícios) no Supabase LOCAL em execução.
//   node scripts/seed-demo.mjs                      → senha aleatória (mostrada uma vez e guardada em node_modules/.cache)
//   DEMO_PASSWORD='...' node scripts/seed-demo.mjs  → senha informada por você
// Segurança: nenhuma credencial fixa fica no repositório. Recusa rodar sem o container do Supabase LOCAL (nunca toca em banco remoto).
// Depois de aplicar, confere a coerência (nada no futuro, ordem temporal, todos os estados e situações de SLA presentes) e sai com erro se algo estiver errado.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync(join(root, 'supabase', 'config.toml'), 'utf8'))?.[1];
if (!projectId) { console.error('project_id não encontrado em supabase/config.toml'); process.exit(2); }
const container = `supabase_db_${projectId}`;
const running = spawnSync('docker', ['ps', '--filter', `name=^${container}$`, '--format', '{{.Names}}'], { encoding: 'utf8' });
if (running.status !== 0 || running.stdout.trim() !== container) {
  console.error(`Container ${container} não está em execução. Suba o Supabase local (supabase start) e rode de novo.`);
  process.exit(2);
}
const password = process.env.DEMO_PASSWORD ?? `${randomBytes(9).toString('base64url')}-Aa1`;
if (password.length < 12) { console.error('A senha precisa ter 12 caracteres ou mais.'); process.exit(2); }

const sql = readFileSync(join(root, 'supabase', 'seed-demo.sql'), 'utf8');
const psql = (input, vars = []) => spawnSync('docker', ['exec', '-i', container, 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...vars.flatMap((v) => ['-v', v]), '-U', 'postgres', '-d', 'postgres'], { input, encoding: 'utf8' });
const r = psql(sql, [`pw=${password}`]);
if (r.status !== 0) { console.error('Falha ao aplicar a demonstração:\n' + r.stderr); process.exit(1); }

// coerência dos dados gerados
const check = psql(`
with org as (select id from public.organizations where slug = 'suporte-aurora'),
t as (select t.* from public.tickets t join org on org.id = t.organization_id),
cy as (select c.* from public.ticket_service_cycles c join t on t.id = c.ticket_id),
act as (select c.id, private.tk_cycle_sla(c.id, now()) as s from cy c where c.closed_at is null),
done as (select c.id, private.tk_metric(c.id, 'resolution', now()) as m from cy c where c.resolved_at is not null)
select 'chamados', count(*) from t
union all select 'futuro', (select count(*) from t where created_at > now() + interval '1 minute' or last_public_activity_at > now() + interval '1 minute')
  + (select count(*) from public.ticket_messages m join t on t.id = m.ticket_id where m.created_at > now() + interval '1 minute')
  + (select count(*) from public.ticket_events e join t on t.id = e.ticket_id where e.created_at > now() + interval '1 minute')
  + (select count(*) from cy where first_response_at > now() + interval '1 minute' or resolved_at > now() + interval '1 minute' or closed_at > now() + interval '1 minute')
union all select 'mensagem_antes_da_abertura', count(*) from public.ticket_messages m join t on t.id = m.ticket_id where m.created_at < t.created_at
union all select 'marcos_fora_de_ordem', count(*) from cy where (first_response_at is not null and first_response_at < started_at) or (resolved_at is not null and resolved_at < started_at) or (closed_at is not null and resolved_at is not null and closed_at < resolved_at)
  or (resolved_at is not null and first_response_at is null) or (resolved_at is not null and first_response_at > resolved_at)
union all select 'pausas_invalidas', count(*) from public.ticket_sla_pauses p join cy on cy.id = p.service_cycle_id where p.ended_at is not null and p.ended_at < p.started_at
union all select 'sem_primeira_mensagem_publica', count(*) from t where not exists (select 1 from public.ticket_messages m where m.ticket_id = t.id and m.visibility = 'public' and m.author_kind = 'requester')
union all select 'aberto', count(*) from t where status = 'open'
union all select 'em_atendimento', count(*) from t where status = 'in_progress'
union all select 'aguardando', count(*) from t where status = 'waiting_requester'
union all select 'resolvido', count(*) from t where status = 'resolved'
union all select 'encerrado', count(*) from t where status = 'closed'
union all select 'sla_atrasado', count(*) from act where s ->> 'summary' = 'overdue'
union all select 'sla_pausado', count(*) from act where s ->> 'summary' = 'paused' or (s -> 'resolution' ->> 'state') = 'paused'
union all select 'sla_proximo', count(*) from act where s ->> 'summary' = 'at_risk'
union all select 'sla_no_prazo', count(*) from act where s ->> 'summary' in ('on_track', 'met')
union all select 'resolucao_cumprida', count(*) from done where m ->> 'state' = 'met'
union all select 'resolucao_descumprida', count(*) from done where m ->> 'state' = 'breached'
union all select 'reaberto_2_ciclos', count(*) from (select ticket_id from cy group by ticket_id having count(*) >= 2) x
union all select 'notas_internas', count(*) from public.ticket_messages m join t on t.id = m.ticket_id where m.visibility = 'internal'
union all select 'sem_responsavel_abertos', count(*) from t where assigned_user_id is null and status in ('open', 'in_progress', 'waiting_requester')
union all select 'notificacoes_nao_lidas', count(*) from public.notifications n join t on t.id = n.ticket_id where n.read_at is null;
`);
if (check.status !== 0) { console.error('Falha na conferência:\n' + check.stderr); process.exit(1); }
const rows = Object.fromEntries(check.stdout.split('\n').map((l) => l.trim()).filter((l) => l.includes('|')).map((l) => l.split('|').map((x) => x.trim())));
const zero = ['futuro', 'mensagem_antes_da_abertura', 'marcos_fora_de_ordem', 'pausas_invalidas', 'sem_primeira_mensagem_publica'];
const atLeast1 = ['aberto', 'em_atendimento', 'aguardando', 'resolvido', 'encerrado', 'sla_atrasado', 'sla_pausado', 'sla_proximo', 'sla_no_prazo', 'resolucao_cumprida', 'resolucao_descumprida', 'reaberto_2_ciclos', 'sem_responsavel_abertos', 'notificacoes_nao_lidas'];
const bad = [...zero.filter((k) => rows[k] !== '0'), ...atLeast1.filter((k) => !(Number(rows[k]) >= 1))];
if (bad.length || Number(rows.chamados) < 25 || Number(rows.notas_internas) < 3) {
  console.error('Demonstração incoerente (' + bad.join(', ') + '):', JSON.stringify(rows));
  process.exit(1);
}
mkdirSync(join(root, 'node_modules', '.cache'), { recursive: true });
// um banco recém-criado não tem o segundo fator do proprietário: descarta o segredo TOTP de uma instalação anterior
rmSync(join(root, 'node_modules', '.cache', 'tk-e2e-owner-secret.txt'), { force: true });
writeFileSync(join(root, 'node_modules', '.cache', 'tk-demo-credentials.json'), JSON.stringify({ password, users: ['dono', 'gestor', 'atendente1', 'atendente2', 'atendente3', 'solicitante1', 'solicitante2', 'solicitante3', 'solicitante4'].map((u) => `${u}@demo.exemplo`) }));
console.log(`Demonstração carregada: ${rows.chamados} chamados (${rows.aberto} abertos, ${rows.em_atendimento} em atendimento, ${rows.aguardando} aguardando, ${rows.resolvido} resolvidos, ${rows.encerrado} encerrados); SLA: ${rows.sla_atrasado} atrasado(s), ${rows.sla_pausado} pausado(s), ${rows.sla_proximo} próximo(s) do limite.`);
console.log('Usuários (@demo.exemplo): dono (proprietário), gestor, atendente1…3, solicitante1…4.');
console.log(`Senha desta instalação: ${password}`);
console.log('(Guardada só em node_modules/.cache. O proprietário cadastra o 2º fator no primeiro acesso.)');
