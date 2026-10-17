#!/usr/bin/env node
// Teste de mutação das regras críticas (motor TypeScript E banco): quebra cada regra DE PROPÓSITO numa cópia do código
// e exige que a suíte reprove. Se alguma mutação sobreviver, falta teste.
//   suite 'unit' → vitest nos testes do motor (tests/unit/sla-*, ticket-*, csv, attachments)
//   suite 'db'   → pnpm test:db (testes SQL com fixtures à mão)
//   suite 'conc' → pnpm test:concurrency (sessões simultâneas reais; rode SEM outra carga na máquina)
// Cada mutação aponta para a definição VIVA (as migrações não redefinem funções umas das outras).
// Uso: node scripts/mutation-check.mjs [--only <trecho do nome>] [--jobs 3] [--check]
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split('|') : null;
const wanted = (m) => !only || only.some((o) => m.name.includes(o));
const jobs = Number(args.includes('--jobs') ? args[args.indexOf('--jobs') + 1] : 3);

const S = 'lib/sla/';
const T = 'lib/tickets/';
// { name, file (trecho do arquivo de migração) | ts (caminho do arquivo TS), find, replace, nth (qual ocorrência; omitido = única), suite }
const M = [
  // ---------------------------------------------------------------- TS: minutos úteis
  // (mutantes EQUIVALENTES removidos: «intervalo invertido» — o laço já não soma nada quando b < a — e «NUL aceito» — a regra de controle < 32 já recusa o NUL)
  { name: 'sla/minutos: dia sem expediente conta', ts: `${S}business.ts`, find: "  if ((def.closed_dates ?? []).includes(date)) return [];", replace: '' },
  { name: 'sla/minutos: dia da semana errado', ts: `${S}business.ts`, find: 'def.weekly[String(weekdayOf(date))]', replace: 'def.weekly[String((weekdayOf(date) + 1) % 7)]' },
  { name: 'sla/minutos: início da janela não recortado', ts: `${S}business.ts`, find: 'const lo = Math.max(w.startMs, aMs);', replace: 'const lo = w.startMs;' },
  { name: 'sla/minutos: fim da janela não recortado', ts: `${S}business.ts`, find: 'const hi = Math.min(w.endMs, bMs);', replace: 'const hi = w.endMs;' },
  { name: 'sla/minutos: sem teto de 800 dias', ts: `${S}business.ts`, find: 'if (daysBetween(first, last) > MAX_DAYS)', replace: 'if (daysBetween(first, last) > MAX_DAYS * 100)' },
  { name: 'sla/projeção: fim exato da janela', ts: `${S}business.ts`, find: 'if (left <= room) return lo + left * MIN;', replace: 'if (left < room) return lo + left * MIN;' },
  { name: 'sla/projeção: zero minutos', ts: `${S}business.ts`, find: 'if (minutes <= 0) return fromMs;', replace: 'if (minutes < 0) return fromMs;' },
  { name: 'sla/projeção: janela já terminada', ts: `${S}business.ts`, find: 'if (w.endMs <= lo) continue;', replace: '' },
  // ---------------------------------------------------------------- TS: estados de SLA
  { name: 'sla/estado: limiar de 90%', ts: `${S}state.ts`, find: 'export const RISK_RATIO = 0.8;', replace: 'export const RISK_RATIO = 0.9;' },
  { name: 'sla/estado: próximo do limite exclusivo', ts: `${S}state.ts`, find: "else if (used >= target * RISK_RATIO) state = 'at_risk';", replace: "else if (used > target * RISK_RATIO) state = 'at_risk';" },
  { name: 'sla/estado: atraso na meta exata', ts: `${S}state.ts`, find: "else if (used > target) state = 'overdue';", replace: "else if (used >= target) state = 'overdue';" },
  { name: 'sla/estado: cumprido na meta exata', ts: `${S}state.ts`, find: "state = used <= target ? 'met' : 'breached';", replace: "state = used < target ? 'met' : 'breached';" },
  { name: 'sla/estado: pausa não descontada', ts: `${S}state.ts`, find: 'used -= businessMinutes(cal.def, cal.tz, Math.max(p.startMs, c.startedMs), Math.min(p.endMs ?? stop, stop));', replace: 'used -= 0;' },
  { name: 'sla/estado: pausa antes do início do ciclo', ts: `${S}state.ts`, find: 'Math.max(p.startMs, c.startedMs)', replace: 'p.startMs' },
  { name: 'sla/estado: relógio não para no marco', ts: `${S}state.ts`, find: 'const stop = Math.min(atMs, done ?? atMs);', replace: 'const stop = atMs;' },
  { name: 'sla/estado: pausa aberta ignorada', ts: `${S}state.ts`, find: 'const paused = c.pauses.some((p) => p.endMs === null);', replace: 'const paused = false;' },
  { name: 'sla/estado: marco futuro conta como cumprido', ts: `${S}state.ts`, find: 'if (done !== null && done <= atMs) state', replace: 'if (done !== null) state' },
  { name: 'sla/estado: pausa esconde o atraso', ts: `${S}state.ts`, find: "  else if (used > target) state = 'overdue';\n  else if (paused) state = 'paused';", replace: "  else if (paused) state = 'paused';\n  else if (used > target) state = 'overdue';" },
  { name: 'sla/estado: resumo: descumprido abaixo de pausado', ts: `${S}state.ts`, find: "const ORDER: SlaState[] = ['met', 'on_track', 'at_risk', 'paused', 'breached', 'overdue'];", replace: "const ORDER: SlaState[] = ['met', 'on_track', 'at_risk', 'breached', 'paused', 'overdue'];" },
  { name: 'sla/estado: resumo: pausado acima de atrasado', ts: `${S}state.ts`, find: "const ORDER: SlaState[] = ['met', 'on_track', 'at_risk', 'paused', 'breached', 'overdue'];", replace: "const ORDER: SlaState[] = ['met', 'on_track', 'at_risk', 'breached', 'overdue', 'paused'];" },
  { name: 'sla/estado: vencimento projetado com relógio pausado', ts: `${S}state.ts`, find: 'const dueMs = done === null && !paused && used < target ?', replace: 'const dueMs = done === null && used < target ?' },
  { name: 'sla/estado: vencimento ignora o consumo', ts: `${S}state.ts`, find: 'addBusinessMinutes(cal.def, cal.tz, atMs, target - used)', replace: 'addBusinessMinutes(cal.def, cal.tz, atMs, target)' },
  // ---------------------------------------------------------------- TS: fórmulas do painel
  { name: 'painel/fórmula: dentro da meta exclusivo', ts: `${S}metrics.ts`, find: 'const within = samples.filter((s) => s.consumed <= s.target).length;', replace: 'const within = samples.filter((s) => s.consumed < s.target).length;' },
  { name: 'painel/fórmula: sem dados vira 0%', ts: `${S}metrics.ts`, find: 'return whole === 0 ? null : round1((part * 100) / whole);', replace: 'return whole === 0 ? 0 : round1((part * 100) / whole);' },
  { name: 'painel/fórmula: arredondamento', ts: `${S}metrics.ts`, find: 'const round1 = (n: number) => Math.round(n * 10) / 10;', replace: 'const round1 = (n: number) => Math.round(n);' },
  { name: 'painel/fórmula: mediana de quantidade par', ts: `${S}metrics.ts`, find: 's.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2', replace: 's[mid]!' },
  { name: 'painel/fórmula: média', ts: `${S}metrics.ts`, find: 'xs.reduce((a, b) => a + b, 0) / xs.length', replace: 'xs.reduce((a, b) => a + b, 0) / (xs.length + 1)' },
  { name: 'painel/fórmula: backlog sem aguardando', ts: `${S}metrics.ts`, find: "export const BACKLOG_STATUSES = ['open', 'in_progress', 'waiting_requester'] as const;", replace: "export const BACKLOG_STATUSES = ['open', 'in_progress'] as const;" },
  { name: 'painel/fórmula: primeiro ciclo conta como reabertura', ts: `${S}metrics.ts`, find: 'c.cycleNumber > 1 &&', replace: 'c.cycleNumber >= 1 &&' },
  { name: 'painel/fórmula: reabertura no fim do período', ts: `${S}metrics.ts`, find: 'c.startedMs < toMs', replace: 'c.startedMs <= toMs' },
  { name: 'painel/fórmula: reabertura no início do período', ts: `${S}metrics.ts`, find: 'c.startedMs >= fromMs', replace: 'c.startedMs > fromMs' },
  // ---------------------------------------------------------------- TS: estados e ações do chamado
  { name: 'estado/ações: aberto pode ser encerrado direto', ts: `${T}status.ts`, find: "if (from === 'open') return to === 'in_progress' || to === 'waiting_requester' || to === 'resolved';", replace: "if (from === 'open') return to === 'in_progress' || to === 'waiting_requester' || to === 'resolved' || to === 'closed';" },
  { name: 'estado/ações: resolvido não volta a aberto', ts: `${T}status.ts`, find: "if (from === 'resolved') return to === 'closed' || to === 'open' || to === 'in_progress';", replace: "if (from === 'resolved') return to === 'closed' || to === 'in_progress';" },
  { name: 'estado/ações: encerrado não reabre', ts: `${T}status.ts`, find: "return to === 'open' || to === 'in_progress'; // closed: só reabertura", replace: 'return false;' },
  { name: 'estado/ações: solicitante confirma encerrado', ts: `${T}status.ts`, find: "if (status === 'resolved') out.push('confirm');", replace: "if (status === 'resolved' || status === 'closed') out.push('confirm');" },
  { name: 'estado/ações: solicitante responde encerrado', ts: `${T}status.ts`, find: "if (open) out.push('reply');", replace: "out.push('reply');" },
  { name: 'estado/ações: atendente atribui e move equipe', ts: `${T}status.ts`, find: "if (isManager(profile)) out.push('assign', 'move_team');", replace: "out.push('assign', 'move_team');" },
  { name: 'estado/ações: qualquer um devolve à fila', ts: `${T}status.ts`, find: "else if (assignedToMe) out.push('release');", replace: "else out.push('release');" },
  { name: 'estado/ações: assumir com responsável', ts: `${T}status.ts`, find: "if (!hasAssignee) out.push('claim');", replace: "out.push('claim');" },
  { name: 'estado/ações: solicitante reabre fora da janela', ts: `${T}status.ts`, find: "if ((status === 'resolved' || status === 'closed') && reopenAllowed) out.push('reopen');\n    return out;", replace: "if (status === 'resolved' || status === 'closed') out.push('reopen');\n    return out;" },
  { name: 'estado/ações: equipe reabre fora da janela', ts: `${T}status.ts`, find: "if ((status === 'resolved' || status === 'closed') && reopenAllowed) out.push('reopen');\n  return out;", replace: "if (status === 'resolved' || status === 'closed') out.push('reopen');\n  return out;" },
  { name: 'estado/ações: nota interna só em aberto', ts: `${T}status.ts`, find: "out.push('note');", replace: "if (open) out.push('note');" },
  // ---------------------------------------------------------------- TS: anexos e CSV
  { name: 'anexo: PNG sem conferir a assinatura inteira', ts: `${T}attachments.ts`, find: 'startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])', replace: 'startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b])' },
  { name: 'anexo: HTML/SVG disfarçado de texto', ts: `${T}attachments.ts`, find: "if (head.startsWith('<') ) return null;", replace: '' },
  { name: 'anexo: controle aceito em texto', ts: `${T}attachments.ts`, find: 'if (x === 0 || (x < 32 && x !== 9 && x !== 10 && x !== 13)) return false;', replace: 'if (x === 0) return false;' },
  { name: 'anexo: UTF-8 inválido aceito', ts: `${T}attachments.ts`, find: "new TextDecoder('utf-8', { fatal: true }).decode(b);", replace: "new TextDecoder('utf-8').decode(b);" },
  { name: 'anexo: limite de quantidade', ts: `${T}attachments.ts`, find: 'if (raw.length > MAX_FILES)', replace: 'if (raw.length > MAX_FILES + 5)' },
  { name: 'anexo: limite de tamanho', ts: `${T}attachments.ts`, find: 'if (f.size > max)', replace: 'if (f.size > max * 100)' },
  { name: 'anexo: teto de segurança de 10 MB', ts: `${T}attachments.ts`, find: 'const max = Math.min(ctx.maxBytes, HARD_MAX_BYTES);', replace: 'const max = ctx.maxBytes;' },
  { name: 'anexo: aspas no nome do arquivo', ts: `${T}attachments.ts`, find: 'name.replace(/[\\\\/\\x00-\\x1f"]/g', replace: 'name.replace(/[\\\\/\\x00-\\x1f]/g' },
  { name: 'anexo: nome sem limite de tamanho', ts: `${T}attachments.ts`, find: '.trim().slice(0, 180)', replace: '.trim().slice(0, 1800)' },
  { name: 'anexo: caminho sem o conteúdo', ts: `${T}attachments.ts`, find: '.update(`${idem}:${index}:`).update(bytes)', replace: '.update(`${idem}:${index}:`)' },
  { name: 'anexo: CSV só com extensão minúscula', ts: `${T}attachments.ts`, find: '/\\.csv$/i.test(filename)', replace: '/\\.csv$/.test(filename)' },
  { name: 'exportação: «@» não neutralizado', ts: `${T}csv.ts`, find: 'const danger = /^[=+\\-@\\t\\r]/.test(s);', replace: 'const danger = /^[=+\\-\\t\\r]/.test(s);' },
  { name: 'exportação: «=» não neutralizado', ts: `${T}csv.ts`, find: 'const danger = /^[=+\\-@\\t\\r]/.test(s);', replace: 'const danger = /^[+\\-@\\t\\r]/.test(s);' },
  { name: 'exportação: «+» não neutralizado', ts: `${T}csv.ts`, find: 'const danger = /^[=+\\-@\\t\\r]/.test(s);', replace: 'const danger = /^[=\\-@\\t\\r]/.test(s);' },
  { name: 'exportação: «-» não neutralizado', ts: `${T}csv.ts`, find: 'const danger = /^[=+\\-@\\t\\r]/.test(s);', replace: 'const danger = /^[=+@\\t\\r]/.test(s);' },
  { name: 'exportação: aspas não duplicadas', ts: `${T}csv.ts`, find: '"${safe.replace(/"/g, \'""\')}"', replace: '"${safe}"' },
  { name: 'exportação: separador no texto não protegido', ts: `${T}csv.ts`, find: '/[";\\n]/.test(safe)', replace: '/["\\n]/.test(safe)' },
  { name: 'exportação: quebra de linha mantida', ts: `${T}csv.ts`, find: "const s = v.replace(/\\r?\\n/g, ' ');", replace: 'const s = v;' },
  { name: 'exportação: inteiro não truncado', ts: `${T}csv.ts`, find: 'String(Math.trunc(Number(v)))', replace: 'String(Number(v))' },
  // ---------------------------------------------------------------- banco: SLA
  { name: 'banco/sla: dia sem expediente conta', file: 'tk_sla.sql', find: "  where not (coalesce(p_def -> 'closed_dates', '[]'::jsonb) ? p_day::text)\n", replace: '' },
  { name: 'banco/sla: início da janela não recortado', file: 'tk_sla.sql', find: 'lo := greatest(r.s, p_a); hi := least(r.e, p_b);', replace: 'lo := r.s; hi := least(r.e, p_b);' },
  { name: 'banco/sla: fim da janela não recortado', file: 'tk_sla.sql', find: 'lo := greatest(r.s, p_a); hi := least(r.e, p_b);', replace: 'lo := greatest(r.s, p_a); hi := r.e;' },
  { name: 'banco/sla: pausa não descontada', file: 'tk_sla.sql', find: 'return greatest(total - paused, 0);', replace: 'return greatest(total, 0);' },
  { name: 'banco/sla: relógio não para no marco', file: 'tk_sla.sql', find: 'stop := least(p_at, coalesce(case p_kind when \'first_response\' then c.first_response_at else c.resolved_at end, p_at));', replace: 'stop := p_at;' },
  { name: 'banco/sla: atraso na meta exata', file: 'tk_sla.sql', find: "elsif used > target then st := 'overdue';", replace: "elsif used >= target then st := 'overdue';" },
  { name: 'banco/sla: cumprido na meta exata', file: 'tk_sla.sql', find: "st := case when used <= target then 'met' else 'breached' end;", replace: "st := case when used < target then 'met' else 'breached' end;" },
  { name: 'banco/sla: pausa esconde o atraso', file: 'tk_sla.sql', find: "  elsif used > target then st := 'overdue';\n  elsif is_paused then st := 'paused';", replace: "  elsif is_paused then st := 'paused';\n  elsif used > target then st := 'overdue';" },
  { name: 'banco/sla: limiar de 90%', file: 'tk_sla.sql', find: 'select 0.8::numeric', replace: 'select 0.9::numeric' },
  { name: 'banco/sla: resumo na ordem errada', file: 'tk_sla.sql', find: "foreach s in array array['met', 'on_track', 'at_risk', 'paused', 'breached', 'overdue'] loop", replace: "foreach s in array array['met', 'on_track', 'at_risk', 'breached', 'paused', 'overdue'] loop" },
  { name: 'banco/sla: ciclo novo com a política mais antiga', file: 'tk_sla.sql', find: 'order by created_at desc, id desc limit 1;\n  if not found then raise exception \'nenhuma política', replace: 'order by created_at asc, id limit 1;\n  if not found then raise exception \'nenhuma política' },
  { name: 'banco/sla: intervalos sobrepostos aceitos', file: 'tk_sla.sql', find: "if prev is not null and s < prev then raise exception 'intervalos do dia", replace: "if false then raise exception 'intervalos do dia" },
  { name: 'banco/sla: primeira resposta maior que a resolução', file: 'tk_sla.sql', find: "if (p_targets -> p ->> 'first_response')::integer > (p_targets -> p ->> 'resolution')::integer then", replace: 'if false then' },
  { name: 'banco/sla: fuso inválido aceito', file: 'tk_sla.sql', find: "exception when others then raise exception 'fuso horário inválido' using errcode = '22023'; end;", replace: 'exception when others then null; end;' },
  { name: 'banco/sla: sem teto de 800 dias', file: 'tk_sla.sql', find: 'if last - d > 800 then', replace: 'if last - d > 80000 then' },
  // ---------------------------------------------------------------- banco: ciclo de vida do chamado
  // («reabertura sem trava de linha» foi removido: o índice único de ciclo ativo e a unicidade (chamado, nº do ciclo) já fazem o perdedor falhar — a trava só evita a tentativa)
  { name: 'banco/chamado: nota interna conta como primeira resposta', file: 'tk_tickets.sql', find: "perform private.tk_event(p_org, p_ticket, 'internal_note', uid, '{}'::jsonb);", replace: "update public.ticket_service_cycles set first_response_at = at where id = cyc and first_response_at is null; perform private.tk_event(p_org, p_ticket, 'internal_note', uid, '{}'::jsonb);" },
  { name: 'banco/chamado: resposta do solicitante não retoma', file: 'tk_tickets.sql', find: "    if t.status = 'waiting_requester' then\n      newst := 'in_progress';", replace: "    if false then\n      newst := 'in_progress';" },
  { name: 'banco/chamado: pedir informação sem pausar', file: 'tk_tickets.sql', find: '      insert into public.ticket_sla_pauses (organization_id, service_cycle_id, started_at) values (p_org, cyc, at);\n', replace: '' },
  { name: 'banco/chamado: resolver mantém a pausa aberta', file: 'tk_tickets.sql', find: 'was_paused := private.tk_close_pause(cyc, at);', replace: 'was_paused := false;' },
  { name: 'banco/chamado: resolver sem marco no ciclo', file: 'tk_tickets.sql', find: '      update public.ticket_service_cycles set resolved_at = at where id = cyc and resolved_at is null;\n', replace: '' },
  { name: 'banco/chamado: assumir chamado já assumido', file: 'tk_tickets.sql', find: "if t.assigned_user_id is not null then raise exception 'Este chamado acabou de ser assumido por outra pessoa.'", replace: "if false then raise exception 'Este chamado acabou de ser assumido por outra pessoa.'" },
  { name: 'banco/chamado: assumir fora da equipe', file: 'tk_tickets.sql', find: "if not private.tk_assignable(p_org, t.team_id, uid) then raise exception 'você precisa pertencer à equipe do chamado para assumi-lo'", replace: "if false then raise exception 'você precisa pertencer à equipe do chamado para assumi-lo'" },
  { name: 'banco/chamado: versão antiga aceita', file: 'tk_tickets.sql', find: 'if p_expected is not null and t.version <> p_expected then perform private.tk_conflict(); end if;', replace: '' },
  { name: 'banco/chamado: chave de idempotência com outro conteúdo', file: 'tk_tickets.sql', find: 'if r.scope <> p_scope or r.request_hash <> p_hash then raise', replace: 'if false then raise' },
  { name: 'banco/chamado: reabrir fora da janela', file: 'tk_tickets.sql', find: 'if oc.resolved_at is null or at > oc.resolved_at + make_interval(hours => st.reopen_window_hours) then', replace: 'if oc.resolved_at is null then' },
  { name: 'banco/chamado: reabrir sem motivo', file: 'tk_tickets.sql', find: "why := private.tk_req_text(p_reason, 3, 1000, 'Motivo da reabertura');", replace: "why := private.tk_req_text(p_reason, 0, 1000, 'Motivo da reabertura');" },
  { name: 'banco/chamado: reabertura não encerra o ciclo anterior', file: 'tk_tickets.sql', find: '  if oc.closed_at is null then update public.ticket_service_cycles set closed_at = at where id = oc.id; end if;\n', replace: '' },
  { name: 'banco/chamado: reabrir chamado em aberto', file: 'tk_tickets.sql', find: "if t.status not in ('resolved', 'closed') then raise exception 'só é possível reabrir um chamado resolvido ou encerrado'", replace: "if false then raise exception 'só é possível reabrir um chamado resolvido ou encerrado'" },
  { name: 'banco/chamado: solicitante impõe a prioridade', file: 'tk_tickets.sql', find: "req := uid; prio := 'normal'; team := cat.default_team_id; asg := null;", replace: "req := uid; prio := coalesce(p_priority, 'normal'); team := cat.default_team_id; asg := null;" },
  { name: 'banco/chamado: solicitante escolhe o responsável', file: 'tk_tickets.sql', find: "req := uid; prio := 'normal'; team := cat.default_team_id; asg := null;", replace: "req := uid; prio := 'normal'; team := cat.default_team_id; asg := p_assignee;" },
  { name: 'banco/chamado: solicitante abre em nome de outro', file: 'tk_tickets.sql', find: "req := uid; prio := 'normal'; team := cat.default_team_id; asg := null;", replace: "req := coalesce(p_requester, uid); prio := 'normal'; team := cat.default_team_id; asg := null;" },
  { name: 'banco/chamado: abertura em nome de quem não é solicitante', file: 'tk_tickets.sql', find: "if req is null or private.tk_profile_of(p_org, req) is distinct from 'requester' then", replace: 'if req is null then' },
  { name: 'banco/chamado: atendente atribui a terceiros na abertura', file: 'tk_tickets.sql', find: "if prof = 'agent' and asg <> uid then raise exception 'atendentes só podem atribuir a si mesmos; peça a um gestor'", replace: "if false then raise exception 'atendentes só podem atribuir a si mesmos; peça a um gestor'" },
  { name: 'banco/chamado: número por MAX+1', file: 'tk_tickets.sql', find: 'update public.ticket_counters set last_number = last_number + 1 where organization_id = p_org returning last_number into num;', replace: 'select coalesce(max(ticket_number), 0) + 1 into num from public.tickets where organization_id = p_org;', suite: 'conc' },
  { name: 'banco/chamado: idempotência desligada', file: 'tk_tickets.sql', find: '  if n = 1 then return null; end if;', replace: '  return null;', suite: 'conc' },
  { name: 'banco/chamado: assumir sem trava de linha', file: 'tk_tickets.sql', find: "t := private.tk_load_ticket(p_org, p_ticket, true, null);\n  if t.status in ('resolved', 'closed') then raise exception 'este chamado já foi encerrado' using errcode = '22023'; end if;\n  if t.assigned_user_id is not null then", replace: "t := private.tk_load_ticket(p_org, p_ticket, false, null);\n  if t.status in ('resolved', 'closed') then raise exception 'este chamado já foi encerrado' using errcode = '22023'; end if;\n  if t.assigned_user_id is not null then", suite: 'conc' },
  { name: 'banco/chamado: mensagem sem trava de linha', file: 'tk_tickets.sql', find: 't := private.tk_load_ticket(p_org, p_ticket, true, case when p_next_status is not null then p_expected else null end);', replace: 't := private.tk_load_ticket(p_org, p_ticket, false, case when p_next_status is not null then p_expected else null end);', suite: 'conc' },
  { name: 'banco/chamado: prioridade sem trava de linha', file: 'tk_tickets.sql', find: "  t := private.tk_load_ticket(p_org, p_ticket, true, p_expected);\n  if t.status in ('resolved', 'closed') then raise exception 'este chamado já foi encerrado' using errcode = '22023'; end if;\n  if p_priority = t.priority then return; end if;", replace: "  t := private.tk_load_ticket(p_org, p_ticket, false, p_expected);\n  if t.status in ('resolved', 'closed') then raise exception 'este chamado já foi encerrado' using errcode = '22023'; end if;\n  if p_priority = t.priority then return; end if;", suite: 'conc' },
  { name: 'banco/chamado: mais de 3 anexos', file: 'tk_tickets.sql', find: "jsonb_array_length(p_att) > 3 then raise exception 'envie até 3 anexos por mensagem'", replace: "jsonb_array_length(p_att) > 30 then raise exception 'envie até 3 anexos por mensagem'" },
  { name: 'banco/chamado: anexo SVG aceito', file: 'tk_tickets.sql', find: "'text/plain', 'text/csv') then raise exception 'tipo de anexo não permitido'", replace: "'text/plain', 'text/csv', 'image/svg+xml') then raise exception 'tipo de anexo não permitido'" },
  { name: 'banco/chamado: anexo acima do tamanho', file: 'tk_tickets.sql', find: 'if sz < 1 or sz > maxb then', replace: 'if sz < 1 then' },
  { name: 'banco/chamado: anexo com caminho de outra empresa', file: 'tk_tickets.sql', find: "if path is null or path !~ ('^' || p_org::text || '/' || p_ticket::text || '/[0-9a-f]{32}\\.[a-z0-9]{1,5}$') then raise exception 'anexo inválido'", replace: "if path is null then raise exception 'anexo inválido'" },
  { name: 'banco/chamado: solicitante cria nota interna', file: 'tk_tickets.sql', find: "if p_visibility <> 'public' or p_next_status is not null then raise exception 'sem permissão' using errcode = '42501'; end if;", replace: '' },
  { name: 'banco/chamado: solicitante responde chamado encerrado', file: 'tk_tickets.sql', find: "if t.status in ('resolved', 'closed') then raise exception 'este chamado está encerrado; use «Reabrir»", replace: "if false then raise exception 'este chamado está encerrado; use «Reabrir»" },
  { name: 'banco/chamado: nota interna muda o estado', file: 'tk_tickets.sql', find: "if p_visibility = 'internal' and p_next_status is not null then raise exception 'nota interna não altera o estado do chamado'", replace: "if false then raise exception 'nota interna não altera o estado do chamado'" },
  { name: 'banco/chamado: equipe responde chamado encerrado', file: 'tk_tickets.sql', find: "if p_visibility = 'public' and t.status in ('resolved', 'closed') then raise exception 'este chamado está encerrado; reabra antes de responder ao solicitante'", replace: "if false then raise exception 'este chamado está encerrado; reabra antes de responder ao solicitante'" },
  { name: 'banco/chamado: confirmar chamado não resolvido', file: 'tk_tickets.sql', find: "if t.status <> 'resolved' then raise exception 'só é possível confirmar um chamado resolvido'", replace: "if false then raise exception 'só é possível confirmar um chamado resolvido'" },
  { name: 'banco/chamado: encerrar chamado não resolvido', file: 'tk_tickets.sql', find: "if t.status <> 'resolved' then raise exception 'só é possível encerrar um chamado já resolvido'", replace: "if false then raise exception 'só é possível encerrar um chamado já resolvido'" },
  { name: 'banco/chamado: retomar de estado inválido', file: 'tk_tickets.sql', find: "if t.status not in ('open', 'waiting_requester') then raise exception 'transição de status inválida'", replace: "if false then raise exception 'transição de status inválida'" },
  { name: 'banco/chamado: mover equipe mantém responsável incompatível', file: 'tk_tickets.sql', find: 'drop_asg := t.assigned_user_id is not null and not private.tk_assignable(p_org, p_team, t.assigned_user_id);', replace: 'drop_asg := false;' },
  { name: 'banco/chamado: notificar o próprio autor', file: 'tk_tickets.sql', find: 'if p_to is null or p_to = (select auth.uid()) then return; end if;', replace: 'if p_to is null then return; end if;' },
  { name: 'banco/chamado: notificar quem não tem acesso', file: 'tk_tickets.sql', find: '  if not private.tk_visible_for(p_org, p_to, t.team_id, t.assigned_user_id, t.requester_user_id) then return; end if;\n', replace: '' },
  // ---------------------------------------------------------------- banco: leituras, DTO do solicitante e painel
  { name: 'banco/leitura: nota interna no DTO do solicitante (mensagens)', file: 'tk_reads.sql', find: "and (staff or m.visibility = 'public')", replace: '', nth: 1 },
  { name: 'banco/leitura: anexo interno no DTO do solicitante', file: 'tk_reads.sql', find: "and (staff or m.visibility = 'public')", replace: '', nth: 2 },
  { name: 'banco/leitura: autor com dado de equipe para o solicitante', file: 'tk_reads.sql', find: "private.tk_pname(m.author_user_id, staff or m.author_kind = 'requester')", replace: 'private.tk_pname(m.author_user_id, true)' },
  { name: 'banco/leitura: equipe no DTO do solicitante', file: 'tk_reads.sql', find: "'team_id', case when staff then t.team_id end, 'team', case when staff then (select name from public.teams where id = t.team_id) end,", replace: "'team_id', t.team_id, 'team', (select name from public.teams where id = t.team_id)," },
  { name: 'banco/leitura: tamanho de página', file: 'tk_reads.sql', find: 'least(greatest(coalesce(p_size, 25), 1), 50)', replace: 'least(greatest(coalesce(p_size, 25), 1), 5000)' },
  { name: 'banco/leitura: fila sem escopo por perfil', file: 'tk_reads.sql', find: '    and private.tk_ticket_visible(p_org, t.team_id, t.assigned_user_id, t.requester_user_id)\n    and (req is null', replace: '    and (req is null' },
  { name: 'banco/leitura: filtro por solicitante', file: 'tk_reads.sql', find: 'and (req is null or t.requester_user_id = req)', replace: '' },
  { name: 'banco/leitura: filtro de SLA', file: 'tk_reads.sql', find: "and case when sla is null then true else ac.id is not null and private.tk_cycle_sla(ac.id, now()) ->> 'summary' = sla end", replace: '' },
  { name: 'banco/leitura: busca pelo número', file: 'tk_reads.sql', find: "t.ticket_number::text = ltrim(q, '#') or ", replace: '' },
  { name: 'banco/leitura: curinga LIKE como texto', file: 'tk_reads.sql', find: "'%', '\\%')", replace: "'%', '%')" },
  { name: 'banco/leitura: visão «atribuídos a mim»', file: 'tk_reads.sql', find: "when 'mine' then t.assigned_user_id = uid and", replace: "when 'mine' then t.assigned_user_id is not null and" },
  { name: 'banco/painel: primeiro ciclo conta como reabertura', file: 'tk_reads.sql', find: 'and cy.cycle_number > 1', replace: 'and cy.cycle_number >= 1' },
  { name: 'banco/painel: primeira resposta dentro da meta exclusiva', file: 'tk_reads.sql', find: 'if used <= c.first_response_target_minutes then', replace: 'if used < c.first_response_target_minutes then' },
  { name: 'banco/painel: resolução dentro da meta exclusiva', file: 'tk_reads.sql', find: 'if used <= c.resolution_target_minutes then', replace: 'if used < c.resolution_target_minutes then' },
  { name: 'banco/painel: sem dados vira 0%', file: 'tk_reads.sql', find: "'rate', case when fr_n = 0 then null else", replace: "'rate', case when fr_n = 0 then 0 else" },
  { name: 'banco/painel: backlog sem aguardando', file: 'tk_reads.sql', find: "where t.id = any (scope) and t.status in ('open', 'in_progress', 'waiting_requester');", replace: "where t.id = any (scope) and t.status in ('open', 'in_progress');" },
  { name: 'banco/painel: atrasos abertos ocultos', file: 'tk_reads.sql', find: "if m -> 'first_response' ->> 'state' = 'overdue' then od_fr := od_fr + 1; end if;", replace: '' },
  { name: 'banco/painel: atendente vê a carga de todos', file: 'tk_reads.sql', find: "(prof <> 'agent' or t.assigned_user_id = uid)", replace: 'true' },
  { name: 'banco/painel: período sem teto', file: 'tk_reads.sql', find: 'or p_to - p_from > 400 then', replace: 'or p_to - p_from > 40000 then' },
  { name: 'banco/painel: escopo por perfil', file: 'tk_reads.sql', find: "    and private.tk_ticket_visible(p_org, t.team_id, t.assigned_user_id, t.requester_user_id);\n\n  select count(*) into created", replace: ";\n\n  select count(*) into created" },
  // ---------------------------------------------------------------- banco: perfis, escopo e guardas
  { name: 'banco/perfil: leitor vira atendente', file: 'tk_access.sql', find: "when 'viewer' then 'requester'", replace: "when 'viewer' then 'agent'" },
  { name: 'banco/perfil: atendente desativado continua', file: 'tk_access.sql', find: "when 'member' then case when private.tk_agent_active(org, (select auth.uid())) then 'agent' end", replace: "when 'member' then 'agent'" },
  { name: 'banco/escopo: atendente vê tudo', file: 'tk_access.sql', find: 'coalesce(assignee = (select auth.uid()), false) or private.tk_in_team(org, team)', replace: 'true' },
  { name: 'banco/escopo: solicitante vê tudo', file: 'tk_access.sql', find: "when 'requester' then requester = (select auth.uid())", replace: "when 'requester' then true" },
  { name: 'banco/escopo: nota interna visível ao solicitante', file: 'tk_access.sql', find: "when 'requester' then vis = 'public'", replace: "when 'requester' then true" },
  { name: 'banco/guarda: sem segundo fator', file: 'tk_guards.sql', find: "if not private.mfa_ok() then raise exception 'verificação em duas etapas necessária'", replace: "if false then raise exception 'verificação em duas etapas necessária'" },
  { name: 'banco/guarda: sem perfil exigido', file: 'tk_guards.sql', find: "if not ok then raise exception 'sem permissão'", replace: "if false then raise exception 'sem permissão'" },
  { name: 'banco/guarda: gestor vale como proprietário', file: 'tk_guards.sql', find: "when 'owner' then prof = 'owner'", replace: "when 'owner' then prof in ('owner', 'manager')" },
  { name: 'banco/guarda: transição inválida aceita', file: 'tk_guards.sql', find: 'if new.status is distinct from old.status and not (', replace: 'if false and not (' },
  { name: 'banco/guarda: metas do ciclo mutáveis', file: 'tk_guards.sql', find: "if (to_jsonb(new) - keep) is distinct from (to_jsonb(old) - keep) then\n    raise exception 'metas, política e prioridade do ciclo", replace: "if false then\n    raise exception 'metas, política e prioridade do ciclo" },
  { name: 'banco/guarda: marco do ciclo reescrito', file: 'tk_guards.sql', find: "if (old.first_response_at is not null and new.first_response_at is distinct from old.first_response_at)\n     or (old.resolved_at is not null and new.resolved_at is distinct from old.resolved_at)\n     or (old.closed_at is not null and new.closed_at is distinct from old.closed_at) then", replace: 'if false then' },
  { name: 'banco/guarda: mensagem editável', file: 'tk_guards.sql', find: "foreach t in array array['ticket_messages', 'ticket_attachments', 'ticket_events', 'business_calendar_versions', 'sla_policy_versions'] loop", replace: "foreach t in array array['ticket_attachments', 'ticket_events', 'business_calendar_versions', 'sla_policy_versions'] loop" },
  { name: 'banco/guarda: mensagem apagável', file: 'tk_guards.sql', find: "foreach t in array array['tickets', 'ticket_messages', 'ticket_attachments',", replace: "foreach t in array array['tickets', 'ticket_attachments'," },
  { name: 'banco/guarda: responsável inválido aceito no gatilho', file: 'tk_guards.sql', find: "if new.team_id is null or not private.tk_assignable(new.organization_id, new.team_id, new.assigned_user_id) then\n      raise exception 'responsável inválido: precisa ser atendente ativo da equipe do chamado' using errcode = '23514';\n    end if;\n  end if;\n  if (to_jsonb(new)", replace: "if false then\n      raise exception 'responsável inválido: precisa ser atendente ativo da equipe do chamado' using errcode = '23514';\n    end if;\n  end if;\n  if (to_jsonb(new)" },
  { name: 'banco/guarda: versão não incrementa', file: 'tk_guards.sql', find: 'new.version := old.version + 1;', replace: 'new.version := old.version;' },
  // ---------------------------------------------------------------- banco: cadastros
  { name: 'banco/cadastro: sair da equipe mantém o responsável', file: 'tk_registry.sql', find: "and assigned_user_id = any (removed) and status <> 'closed' loop", replace: "and assigned_user_id = any (removed) and status <> 'closed' and false loop" },
  { name: 'banco/cadastro: desativar sem decidir sobre os chamados', file: 'tk_registry.sql', find: "if p_mode is null or p_mode not in ('unassign', 'reassign') then raise exception", replace: "if false then raise exception" },
  { name: 'banco/cadastro: reatribuir a quem não é da equipe', file: 'tk_registry.sql', find: "if not private.tk_assignable(p_org, t.team_id, p_to) then raise exception 'a pessoa escolhida não pertence à equipe de todos os chamados", replace: "if false then raise exception 'a pessoa escolhida não pertence à equipe de todos os chamados" },
  { name: 'banco/cadastro: desativar a si mesmo', file: 'tk_registry.sql', find: "if p_user = (select auth.uid()) then raise exception 'você não pode desativar o próprio acesso'", replace: "if false then raise exception 'você não pode desativar o próprio acesso'" },
  { name: 'banco/cadastro: equipe de outra empresa na categoria', file: 'tk_registry.sql', find: "if p_default_team is not null and not exists (select 1 from public.teams where id = p_default_team and organization_id = p_org and active) then raise exception 'equipe padrão inválida'", replace: "if false then raise exception 'equipe padrão inválida'" },
  { name: 'banco/cadastro: solicitante entra em equipe', file: 'tk_registry.sql', find: "if not exists (select 1 from public.organization_members m where m.organization_id = p_org and m.user_id = u and m.role in ('owner', 'admin', 'manager', 'member')) then", replace: 'if false then' },
  { name: 'banco/cadastro: gestor publica SLA', file: 'tk_registry.sql', find: "perform private.tk_guard(p_org, 'owner');\n  perform private.tk_validate_calendar(p_timezone, p_calendar);", replace: "perform private.tk_guard(p_org, 'manager');\n  perform private.tk_validate_calendar(p_timezone, p_calendar);" },
  { name: 'banco/cadastro: gestor altera as políticas', file: 'tk_registry.sql', find: "perform private.tk_guard(p_org, 'owner');\n  if jsonb_typeof(p) <> 'object' then", replace: "perform private.tk_guard(p_org, 'manager');\n  if jsonb_typeof(p) <> 'object' then" },
  // ---------------------------------------------------------------- banco: privilégios e integridade
  { name: 'banco/privilégio: função de chamado executável por anon', file: 'tk_privileges.sql', find: "execute format('grant execute on function %s to authenticated', f.sig);\n  end loop;\n  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p", replace: "execute format('grant execute on function %s to authenticated, anon', f.sig);\n  end loop;\n  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p" },
  { name: 'banco/privilégio: função interna exposta', file: 'tk_privileges.sql', find: "if f.proname in ('tk_role', 'tk_agent_active'", replace: "if true or f.proname in ('tk_role', 'tk_agent_active'" },
  { name: 'banco/integridade: mais de um ciclo ativo', file: 'tk_schema.sql', find: 'create unique index ticket_service_cycles_one_active_uq on public.ticket_service_cycles (ticket_id) where closed_at is null;', replace: 'create unique index ticket_service_cycles_one_active_uq on public.ticket_service_cycles (ticket_id) where false;' },
  { name: 'banco/integridade: mais de uma pausa aberta', file: 'tk_schema.sql', find: 'create unique index ticket_sla_pauses_one_open_uq on public.ticket_sla_pauses (service_cycle_id) where ended_at is null;', replace: 'create unique index ticket_sla_pauses_one_open_uq on public.ticket_sla_pauses (service_cycle_id) where false;' },
  { name: 'banco/integridade: número repetido', file: 'tk_schema.sql', find: '  unique (organization_id, ticket_number),\n', replace: '' },
  { name: 'banco/integridade: equipe de outra empresa no chamado', file: 'tk_schema.sql', find: 'foreign key (team_id, organization_id) references public.teams (id, organization_id),\n  check (assigned_user_id', replace: 'foreign key (team_id) references public.teams (id),\n  check (assigned_user_id' },
  { name: 'banco/integridade: categoria de outra empresa no chamado', file: 'tk_schema.sql', find: 'foreign key (category_id, organization_id) references public.ticket_categories (id, organization_id),', replace: 'foreign key (category_id) references public.ticket_categories (id),' },
  { name: 'banco/integridade: mensagem herda visibilidade interna sem checar', file: 'tk_schema.sql', find: "check (author_kind <> 'requester' or visibility = 'public')", replace: 'check (true)' },
];

const migDir = join(root, 'supabase', 'migrations');
const files = readdirSync(migDir).filter((f) => f.endsWith('.sql'));
const SCRIPT = { db: 'test-db.mjs', conc: 'test-concurrency.mjs' };
const kindOf = (m) => m.suite ?? (m.ts ? 'unit' : 'db');

function runSuite(dir, suite) {
  return new Promise((resolve) => {
    const cmd = suite === 'unit'
      ? [join(dir, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/unit/sla-', 'tests/unit/ticket-', 'tests/unit/csv', 'tests/unit/attachments']
      : [join(dir, 'scripts', SCRIPT[suite])];
    const p = spawn(process.execPath, cmd, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

function applyMutation(path, mutate) {
  const text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const parts = text.split(mutate.find);
  const nth = mutate.nth ?? 1;
  if (parts.length < 2) throw new Error(`mutação sem alvo: ${mutate.name}`);
  if (parts.length > 2 && !mutate.nth) throw new Error(`mutação ambígua (${parts.length - 1} ocorrências): ${mutate.name}`);
  if (nth > parts.length - 1) throw new Error(`mutação sem a ocorrência ${nth}: ${mutate.name}`);
  writeFileSync(path, parts.slice(0, nth).join(mutate.find) + mutate.replace + parts.slice(nth).join(mutate.find));
}

function workspace(label, mutate, suite) {
  const dir = mkdtempSync(join(tmpdir(), `pack25-tk-mut-${label}-`));
  if (suite === 'unit') {
    for (const d of ['lib', 'tests', 'app', 'components']) cpSync(join(root, d), join(dir, d), { recursive: true });
    for (const f of ['vitest.config.ts', 'tsconfig.json', 'package.json']) cpSync(join(root, f), join(dir, f));
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction');
    if (mutate) applyMutation(join(dir, mutate.ts), mutate);
    return dir;
  }
  mkdirSync(join(dir, 'scripts'));
  for (const s of Object.values(SCRIPT)) cpSync(join(root, 'scripts', s), join(dir, 'scripts', s));
  cpSync(join(root, 'supabase'), join(dir, 'supabase'), { recursive: true });
  if (mutate) applyMutation(join(dir, 'supabase', 'migrations', files.find((x) => x.includes(mutate.file))), mutate);
  return dir;
}

if (args.includes('--check')) {
  // só confere se cada mutação encontra o seu alvo (rápido; não roda suítes)
  let bad = 0;
  for (const m of M) {
    const path = m.ts ? join(root, m.ts) : join(migDir, files.find((x) => x.includes(m.file)) ?? '');
    const n = readFileSync(path, 'utf8').replaceAll('\r\n', '\n').split(m.find).length - 1;
    if (!(n >= 1 && (m.nth ? m.nth <= n : n === 1))) { bad++; console.log(`SEM ALVO ÚNICO (${n} ocorrências): ${m.name}`); }
  }
  console.log(bad ? `${bad} mutação(ões) com alvo inválido` : `${M.length} mutações com alvo válido`);
  process.exit(bad ? 1 : 0);
}

const todo = M.filter(wanted);
for (const suite of new Set(todo.map(kindOf))) {
  const base = workspace(`base-${suite}`, null, suite);
  const baseline = await runSuite(base, suite);
  rmSync(base, { recursive: true, force: true });
  if (baseline.code !== 0) {
    console.error(`A suíte «${suite}» sem mutação já reprova; corrija antes.\n` + baseline.out.slice(-1500));
    process.exit(2);
  }
}

const survived = [];
const broken = [];
let next = 0;
async function worker() {
  while (next < todo.length) {
    const m = todo[next++];
    const suite = kindOf(m);
    let dir;
    try {
      dir = workspace(String(next), m, suite);
    } catch (e) {
      console.log(`SEM ALVO    ${m.name} — ${e.message}`);
      broken.push(m.name);
      continue;
    }
    const r = await runSuite(dir, suite);
    rmSync(dir, { recursive: true, force: true });
    const killed = r.code !== 0;
    console.log(`${killed ? 'MORTA     ' : 'SOBREVIVEU '} ${m.name}`);
    if (!killed) survived.push(m.name);
  }
}
// a suíte de concorrência é sensível a carga: roda sozinha, depois das demais
const light = todo.filter((m) => kindOf(m) !== 'conc');
const heavy = todo.filter((m) => kindOf(m) === 'conc');
const all = todo.slice();
todo.length = 0;
todo.push(...light);
next = 0;
await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
todo.length = 0;
todo.push(...heavy);
next = 0;
await Promise.all(Array.from({ length: 1 }, worker));
console.log(`\n${all.length - survived.length - broken.length}/${all.length} mutações reprovadas pela suíte.`);
if (broken.length) console.error('Mutações sem alvo (o texto mudou):\n- ' + broken.join('\n- '));
if (survived.length) console.error('Sobreviveram:\n- ' + survived.join('\n- '));
if (survived.length || broken.length) process.exit(1);
