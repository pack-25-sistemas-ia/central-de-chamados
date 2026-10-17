#!/usr/bin/env node
// Concorrência REAL: várias sessões psql simultâneas contra o mesmo banco (dados confirmados, sem rollback).
// Prova (§12, §21 e §24 do prompt mestre): número do chamado sem duplicação; duplo envio idempotente; duas pessoas assumindo o mesmo chamado (só uma vence);
// atualização com versão antiga rejeitada; pedir informação × resposta do solicitante deixam o estado e a pausa de SLA SEMPRE coerentes;
// resolução simultânea e reabertura simultânea têm um vencedor; troca de equipe × atribuição nunca deixa responsável fora da equipe.
// Uso: node scripts/test-concurrency.mjs   (requer Docker; banco descartável, sem porta publicada)
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbDir = join(root, 'supabase');
const name = `pack25-tk-conc-${randomBytes(4).toString('hex')}`;
const IMAGE = process.env.PG_TEST_IMAGE ?? 'postgres:17-alpine';
const U = { owner: 'ffffffff-0000-4000-8000-0000000000a0', mgr: 'ffffffff-0000-4000-8000-0000000000a1', a1: 'ffffffff-0000-4000-8000-0000000000a2', a2: 'ffffffff-0000-4000-8000-0000000000a3', a3: 'ffffffff-0000-4000-8000-0000000000a4', r1: 'ffffffff-0000-4000-8000-0000000000b1', r2: 'ffffffff-0000-4000-8000-0000000000b2' };
// 12 solicitantes extras: a abertura simultânea precisa vir de USUÁRIOS DIFERENTES (o limite de abuso é uma linha por usuário e serializaria as chamadas de um mesmo usuário)
for (let i = 3; i <= 14; i++) U[`r${i}`] = `ffffffff-0000-4000-8000-000000001${String(i).padStart(3, '0')}`;
const docker = (a, o = {}) => spawnSync('docker', a, { encoding: 'utf8', ...o });

// «Largada sincronizada»: toda chamada espera um alvo comum (advisory lock) liberado só quando o canhão termina — as sessões entram AO MESMO TEMPO.
const GUN_KEY = 7777012;
const GUN_MS = 3500;
let gunOn = false;
function psql(sql, who = 'owner') {
  const head = `select set_config('request.jwt.claims', '{"sub":"${U[who]}","aal":"${who === 'owner' ? 'aal2' : 'aal1'}","email":"${who}@t.invalid"}', true); set local role authenticated;`;
  const wrapped = `begin; ${head} ${gunOn ? `select pg_advisory_xact_lock_shared(${GUN_KEY});` : ''} ${sql}; commit`;
  return new Promise((resolve) => {
    const p = spawn('docker', ['exec', '-i', name, 'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'core'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    const t0 = Date.now();
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim(), ms: Date.now() - t0 }));
    p.stdin.end(wrapped);
  });
}
const raw = (sql) => new Promise((resolve) => {
  const p = spawn('docker', ['exec', '-i', name, 'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'core'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  p.stdin.end(sql);
});
async function armGun() {
  gunOn = true;
  spawn('docker', ['exec', '-i', name, 'psql', '-X', '-q', '-t', '-A', '-U', 'postgres', '-d', 'core', '-c', `select pg_advisory_lock(${GUN_KEY}); select pg_sleep(${GUN_MS / 1000});`], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    const r = await raw("select count(*) from pg_locks where locktype = 'advisory' and granted and mode = 'ExclusiveLock'");
    if (r.out.trim() === '1') return;
    await new Promise((res) => setTimeout(res, 100));
  }
}
const one = async (sql, who) => { const r = await psql(sql, who); if (r.code !== 0) throw new Error(r.err); return r.out.split('\n').filter(Boolean).pop(); };
const sa = async (sql) => { const r = await raw(sql); if (r.code !== 0) throw new Error(r.err); return r.out.split('\n').filter(Boolean).pop(); };
const fire = async (n, make) => { await armGun(); const rs = await Promise.all(Array.from({ length: n }, (_, k) => make(k))); gunOn = false; await new Promise((r) => setTimeout(r, GUN_MS + 200)); return rs; };
const oks = (rs) => rs.filter((r) => r.code === 0).length;
let failed = 0;
const check = (cond, label) => { console.log(`  ${cond ? 'PASS' : 'FALHOU'}: ${label}`); if (!cond) failed++; };
const why = (rs, n) => { if (oks(rs) !== n) console.log('   motivo: ' + rs.find((r) => r.code !== 0)?.err.split('\n')[0]); };

try {
  if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) throw new Error('Docker indisponível');
  const run = docker(['run', '-d', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${randomBytes(16).toString('hex')}`, '-e', 'POSTGRES_DB=core', IMAGE, '-c', 'max_connections=200']);
  if (run.status !== 0) throw new Error(run.stderr);
  for (let i = 0; i < 60; i++) {
    if (docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'core']).status === 0) break;
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
  }
  for (const f of ['tests/00_harness.sql', ...readdirSync(join(dbDir, 'migrations')).filter((x) => x.endsWith('.sql')).sort().map((x) => `migrations/${x}`)]) {
    const r = await raw(readFileSync(join(dbDir, f), 'utf8'));
    if (r.code !== 0) throw new Error(`${f}: ${r.err}`);
  }
  await raw(`insert into auth.users (id, email) values ${Object.entries(U).map(([k, v]) => `('${v}', '${k}@t.invalid')`).join(', ')}`);
  const org = await one(`select public.create_organization('Empresa Concorrência', 'empresa-conc-tk')`);
  const O = `'${org}'`;
  await raw(`insert into public.organization_members (organization_id, user_id, role) values ('${org}', '${U.mgr}', 'manager'), ('${org}', '${U.a1}', 'member'), ('${org}', '${U.a2}', 'member'), ('${org}', '${U.a3}', 'member'), ('${org}', '${U.r1}', 'viewer'), ('${org}', '${U.r2}', 'viewer')`);
  await raw(`insert into public.organization_members (organization_id, user_id, role) values ${Array.from({ length: 12 }, (_, i) => `('${org}', '${U[`r${i + 3}`]}', 'viewer')`).join(', ')}`);
  const t1 = await one(`select public.tk_save_team(${O}, null, 'Equipe 1', true)`);
  const t2 = await one(`select public.tk_save_team(${O}, null, 'Equipe 2', true)`);
  await one(`select public.tk_set_team_members(${O}, '${t1}', array['${U.mgr}', '${U.a1}', '${U.a2}']::uuid[])`);
  await one(`select public.tk_set_team_members(${O}, '${t2}', array['${U.a3}', '${U.a2}']::uuid[])`);
  const cat = await one(`select public.tk_save_category(${O}, null, 'Geral', '${t1}', true)`);
  const open = (id, idem, subj, who = 'r1', extra = {}) => psql(`select public.tk_open_ticket(${O}, '${id}', '${idem}', '${subj}', '${cat}', 'texto do chamado', ${extra.prio ? `'${extra.prio}'` : 'null'}, null, null, null, null)`, who);
  const mk = async (subj) => { const id = randomUUID(); await one(`select public.tk_open_ticket(${O}, '${id}', gen_random_uuid(), '${subj}', '${cat}', 'texto do chamado', null, null, null, null, null)`, 'r1'); return id; };
  const ver = async (id) => Number(await sa(`select version from public.tickets where id = '${id}'`));

  console.log('> 12 sessões abrem chamados ao mesmo tempo (número sem duplicação)');
  const rN = await fire(12, (k) => open(randomUUID(), randomUUID(), `Concorrente ${k}`, `r${k + 3}`));
  why(rN, 12);
  check(oks(rN) === 12, 'as 12 aberturas terminam bem');
  check((await sa(`select count(distinct ticket_number) from public.tickets`)) === '12', 'os 12 números são distintos');
  check((await sa(`select max(ticket_number) - min(ticket_number) + 1 from public.tickets`)) === '12', 'a sequência é contínua (sem buracos nem MAX+1)');
  check((await sa(`select count(*) from public.ticket_service_cycles where closed_at is null`)) === '12', 'cada chamado tem exatamente um ciclo ativo');

  console.log('> duplo envio: 8 sessões com a MESMA chave de idempotência');
  const dupId = randomUUID(); const dupKey = randomUUID();
  const before = Number(await sa(`select count(*) from public.tickets`));
  const rD = await fire(8, () => open(dupId, dupKey, 'Chamado do duplo clique'));
  why(rD, 8);
  check(oks(rD) === 8, 'todas as 8 chamadas terminam bem (reenvio devolve o mesmo chamado)');
  check(Number(await sa(`select count(*) from public.tickets`)) === before + 1, 'exatamente UM chamado novo');
  check((await sa(`select count(*) from public.ticket_messages where ticket_id = '${dupId}'`)) === '1', 'exatamente UMA mensagem inicial');
  check(rD.filter((r) => /"replayed":\s*true/.test(r.out)).length === 7, 'sete respostas marcadas como reenvio');

  console.log('> duas pessoas (3 atendentes × 2 sessões) tentam ASSUMIR o mesmo chamado');
  const c1 = await mk('Assumir concorrente');
  const claimers = ['a1', 'a2', 'mgr'];
  const rC = await fire(6, (k) => psql(`select public.tk_claim(${O}, '${c1}')`, claimers[k % 3]));
  check(oks(rC) === 1, 'somente UMA pessoa assume');
  check(rC.filter((r) => r.code !== 0).every((r) => /acabou de ser assumido/.test(r.err)), 'as demais recebem a mensagem amigável');
  check((await sa(`select (assigned_user_id is not null and status = 'in_progress')::int from public.tickets where id = '${c1}'`)) === '1', 'o chamado ficou atribuído e em atendimento');
  check((await sa(`select count(*) from public.ticket_events where ticket_id = '${c1}' and event_type = 'claimed'`)) === '1', 'um único evento «assumido»');

  console.log('> atualização com a MESMA versão por 6 sessões (versão antiga é rejeitada)');
  const c2 = await mk('Versão concorrente');
  const v = await ver(c2);
  const prios = ['low', 'high', 'urgent'];
  const rV = await fire(6, (k) => psql(`select public.tk_set_priority(${O}, '${c2}', '${prios[k % 3]}', ${v})`, 'mgr'));
  check(oks(rV) === 1, 'somente UMA alteração com a versão original é aceita');
  check(rV.filter((r) => r.code !== 0).every((r) => /alterado por outra pessoa/.test(r.err)), 'as outras recebem «alterado por outra pessoa»');
  check((await ver(c2)) === v + 1, 'a versão avançou exatamente uma vez');

  console.log('> pedir informação (equipe) × responder (solicitante) ao mesmo tempo, 6 rodadas: estado e pausa sempre coerentes');
  let incoh = 0; let waits = 0;
  for (let i = 0; i < 6; i++) {
    const t = await mk(`Pausa concorrente ${i}`);
    await one(`select public.tk_claim(${O}, '${t}')`, 'a1');
    const rr = await fire(2, (k) => (k === 0
      ? psql(`select public.tk_post_message(${O}, '${t}', gen_random_uuid(), 'public', 'Pode detalhar?', null, 'waiting_requester', null)`, 'a1')
      : psql(`select public.tk_post_message(${O}, '${t}', gen_random_uuid(), 'public', 'Mais detalhes do solicitante', null, null, null)`, 'r1')));
    why(rr, 2);
    const st = await sa(`select status from public.tickets where id = '${t}'`);
    const open1 = Number(await sa(`select count(*) from public.ticket_sla_pauses p join public.ticket_service_cycles c on c.id = p.service_cycle_id where c.ticket_id = '${t}' and p.ended_at is null`));
    if ((st === 'waiting_requester') !== (open1 === 1) || open1 > 1) incoh++;
    if (st === 'waiting_requester') waits++;
  }
  check(incoh === 0, `em todas as rodadas «aguardando solicitante» ⇔ exatamente uma pausa aberta (${waits} terminaram aguardando, ${6 - waits} em atendimento)`);

  console.log('> duas resoluções simultâneas do mesmo chamado');
  const c3 = await mk('Resolver concorrente');
  await one(`select public.tk_claim(${O}, '${c3}')`, 'a1');
  const rR = await fire(2, (k) => psql(`select public.tk_post_message(${O}, '${c3}', gen_random_uuid(), 'public', 'Resolvido por ${k}', null, 'resolved', null)`, k === 0 ? 'a1' : 'mgr'));
  check(oks(rR) === 1, 'somente UMA resolução é aceita (a segunda vê o chamado já encerrado)');
  check((await sa(`select count(*) from public.ticket_events where ticket_id = '${c3}' and event_type = 'resolved'`)) === '1', 'um único evento «resolvido»');
  check((await sa(`select (resolved_at is not null)::int from public.ticket_service_cycles where ticket_id = '${c3}' and closed_at is null`)) === '1', 'o ciclo registra a resolução uma vez');

  console.log('> reabertura simultânea: 4 sessões do solicitante');
  const rO = await fire(4, () => psql(`select public.tk_reopen(${O}, '${c3}', 'Voltou a falhar', null)`, 'r1'));
  check(oks(rO) === 1, 'somente UMA reabertura vence');
  check((await sa(`select count(*) from public.ticket_service_cycles where ticket_id = '${c3}'`)) === '2', 'exatamente 2 ciclos (o anterior preservado)');
  check((await sa(`select count(*) from public.ticket_service_cycles where ticket_id = '${c3}' and closed_at is null`)) === '1', 'um único ciclo ativo');

  console.log('> mover de equipe × atribuir ao mesmo tempo (o responsável nunca fica fora da equipe)');
  let bad = 0;
  for (let i = 0; i < 5; i++) {
    const t = await mk(`Equipe concorrente ${i}`);
    await one(`select public.tk_claim(${O}, '${t}')`, 'a1');
    const vv = await ver(t);
    await fire(2, (k) => (k === 0
      ? psql(`select public.tk_move_team(${O}, '${t}', '${t2}', null)`, 'mgr')
      : psql(`select public.tk_assign(${O}, '${t}', '${U.a2}', null)`, 'mgr')));
    void vv;
    const r = await sa(`select count(*) from public.tickets x where x.id = '${t}' and x.assigned_user_id is not null and not exists (select 1 from public.team_members m where m.team_id = x.team_id and m.user_id = x.assigned_user_id)`);
    if (r !== '0') bad++;
  }
  check(bad === 0, 'em todas as rodadas o responsável pertence à equipe do chamado');

  console.log('> invariantes finais');
  check((await sa(`select count(*) from (select ticket_id from public.ticket_service_cycles where closed_at is null group by ticket_id having count(*) > 1) x`)) === '0', 'nenhum chamado com mais de um ciclo ativo');
  check((await sa(`select count(*) from (select service_cycle_id from public.ticket_sla_pauses where ended_at is null group by service_cycle_id having count(*) > 1) x`)) === '0', 'nenhum ciclo com mais de uma pausa aberta');
  check((await sa(`select count(*) from public.tickets t where t.status = 'waiting_requester' and not exists (select 1 from public.ticket_sla_pauses p join public.ticket_service_cycles c on c.id = p.service_cycle_id where c.ticket_id = t.id and p.ended_at is null)`)) === '0', 'todo chamado aguardando solicitante tem pausa aberta');
  check((await sa(`select count(*) from public.tickets t where t.status <> 'waiting_requester' and exists (select 1 from public.ticket_sla_pauses p join public.ticket_service_cycles c on c.id = p.service_cycle_id where c.ticket_id = t.id and p.ended_at is null)`)) === '0', 'nenhuma pausa aberta fora de «aguardando solicitante»');
  check((await sa(`select count(*) from (select ticket_number from public.tickets group by ticket_number having count(*) > 1) x`)) === '0', 'nenhum número de chamado repetido');
} catch (e) {
  console.error('ERRO: ' + (e instanceof Error ? e.message : e));
  failed++;
} finally {
  docker(['rm', '-f', name]);
}
console.log(failed ? `CONCORRÊNCIA: ${failed} FALHA(S)` : 'CONCORRÊNCIA: TODOS OS TESTES PASSARAM');
process.exit(failed ? 1 : 0);
