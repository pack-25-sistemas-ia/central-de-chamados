'use server';

import { z } from 'zod';
import { fail, succeed, type ActionState } from '@/lib/actions/result';
import { logEvent } from '@/lib/log';
import { attachmentsJson, prepareFiles, type Prepared } from '../attachments';
import { bust, dbMessage, formObject, guarded, parse, type ActionCtx, type SaveResult } from '../action-kit';

const uuid = z.string().uuid('Registro inválido.');
const optUuid = z.union([uuid, z.literal('')]).transform((v) => (v === '' ? null : v));
const version = z.coerce.number().int().min(1);
const BUCKET = 'tk-attachments';

/** Envia os arquivos ao Storage privado (com a sessão do próprio usuário; a política do bucket confere a empresa). Reenvio do mesmo conteúdo reaproveita o arquivo. */
async function upload(a: ActionCtx, files: Prepared[]): Promise<{ ok: true; created: string[] } | { ok: false; error: string }> {
  const created: string[] = [];
  for (const f of files) {
    const r = await a.ctx.supabase.storage.from(BUCKET).upload(f.path, f.bytes, { contentType: f.mime, upsert: false });
    if (r.error) {
      const dup = /already exists|duplicate|409/i.test(`${r.error.message} ${(r.error as { statusCode?: string }).statusCode ?? ''}`);
      if (!dup) {
        if (created.length) await a.ctx.supabase.storage.from(BUCKET).remove(created);
        logEvent('error', 'tk_upload_failed', { name: r.error.name });
        return { ok: false, error: 'Não foi possível enviar os anexos. Tente novamente.' };
      }
    } else created.push(f.path);
  }
  return { ok: true, created };
}
async function discard(a: ActionCtx, created: string[]) {
  if (created.length) await a.ctx.supabase.storage.from(BUCKET).remove(created).catch(() => undefined);
}

const openSchema = z.object({
  idem: uuid,
  subject: z.string().trim().min(3, 'O assunto deve ter ao menos 3 caracteres.').max(160, 'Assunto longo demais (máx. 160).'),
  category: optUuid.optional(),
  description: z.string().trim().min(1, 'Descreva o que está acontecendo.').max(10000, 'Descrição longa demais (máx. 10.000 caracteres).'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().or(z.literal('')),
  requester: optUuid.optional(),
  team: optUuid.optional(),
  assignee: optUuid.optional(),
});

/** Abre um chamado. A chave de idempotência vira o id do chamado: reenviar (duplo clique, rede ruim) devolve o MESMO chamado. */
export async function openTicket(_prev: ActionState, fd: FormData): Promise<SaveResult> {
  const values = formObject(fd);
  const p = parse(openSchema, values, values);
  if (!p.ok) return p.state;
  return guarded('any', 'openTicket', async (a) => {
    const d = p.data;
    const { data: st } = await a.ctx.supabase.from('ticket_settings').select('attachment_max_size_bytes').eq('organization_id', a.org).maybeSingle();
    const prep = await prepareFiles(fd, { org: a.org, ticket: d.idem, idem: d.idem, maxBytes: (st as { attachment_max_size_bytes: number } | null)?.attachment_max_size_bytes ?? 5 * 1024 * 1024 });
    if (!prep.ok) return fail(prep.error, undefined, values);
    const up = await upload(a, prep.files);
    if (!up.ok) return fail(up.error, undefined, values);
    const { data, error } = await a.ctx.supabase.rpc('tk_open_ticket', {
      p_org: a.org, p_id: d.idem, p_idem: d.idem, p_subject: d.subject, p_category: d.category ?? null, p_description: d.description, p_priority: d.priority || null,
      p_requester: d.requester ?? null, p_team: d.team ?? null, p_assignee: d.assignee ?? null, p_attachments: attachmentsJson(prep.files),
    });
    if (error) {
      await discard(a, up.created);
      return fail(dbMessage(error), undefined, values);
    }
    const r = data as { id: string; ticket_number: number };
    bust('/chamados', '/dashboard');
    return { ...succeed(`Chamado #${r.ticket_number} aberto.`), id: r.id, redirectTo: `/chamados/${r.id}` };
  });
}

const messageSchema = z.object({
  idem: uuid, ticket: uuid, expected: version.optional(),
  visibility: z.enum(['public', 'internal']),
  body: z.string().trim().min(1, 'Escreva a mensagem.').max(10000, 'Mensagem longa demais (máx. 10.000 caracteres).'),
  next: z.enum(['', 'waiting_requester', 'resolved']).optional(),
});

/** Resposta pública ou nota interna (com anexos). «Pedir informação» e «Resolver» mudam o estado na MESMA transação da mensagem. */
export async function postMessage(_prev: ActionState, fd: FormData): Promise<SaveResult> {
  const values = formObject(fd);
  const p = parse(messageSchema, values, values);
  if (!p.ok) return p.state;
  return guarded('any', 'postMessage', async (a) => {
    const d = p.data;
    const { data: st } = await a.ctx.supabase.from('ticket_settings').select('attachment_max_size_bytes').eq('organization_id', a.org).maybeSingle();
    const prep = await prepareFiles(fd, { org: a.org, ticket: d.ticket, idem: d.idem, maxBytes: (st as { attachment_max_size_bytes: number } | null)?.attachment_max_size_bytes ?? 5 * 1024 * 1024 });
    if (!prep.ok) return fail(prep.error, undefined, values);
    const up = await upload(a, prep.files);
    if (!up.ok) return fail(up.error, undefined, values);
    const { data, error } = await a.ctx.supabase.rpc('tk_post_message', {
      p_org: a.org, p_ticket: d.ticket, p_idem: d.idem, p_visibility: d.visibility, p_body: d.body, p_attachments: attachmentsJson(prep.files), p_next_status: d.next || null, p_expected: d.expected ?? null,
    });
    if (error) {
      await discard(a, up.created);
      return fail(dbMessage(error), undefined, values);
    }
    const r = data as { status: string };
    bust('/chamados', `/chamados/${d.ticket}`, '/dashboard');
    const msg = d.visibility === 'internal' ? 'Nota interna registrada.' : r.status === 'waiting_requester' && d.next ? 'Resposta enviada. O SLA está pausado até o solicitante responder.' : r.status === 'resolved' ? 'Chamado resolvido.' : 'Resposta enviada.';
    return succeed(msg);
  });
}

const base = z.object({ ticket: uuid, expected: version.optional() });
const afterChange = (id: string) => bust('/chamados', `/chamados/${id}`, '/dashboard');

export async function claimTicket(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const p = parse(base, formObject(fd));
  if (!p.ok) return p.state;
  return guarded('staff', 'claimTicket', async ({ ctx, org }) => {
    const { error } = await ctx.supabase.rpc('tk_claim', { p_org: org, p_ticket: p.data.ticket });
    if (error) return fail(dbMessage(error));
    afterChange(p.data.ticket);
    return succeed('Você assumiu o chamado.');
  });
}

const assignSchema = base.extend({ user: optUuid });
export async function assignTicket(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const p = parse(assignSchema, formObject(fd));
  if (!p.ok) return p.state;
  return guarded('staff', 'assignTicket', async ({ ctx, org }) => {
    const { error } = await ctx.supabase.rpc('tk_assign', { p_org: org, p_ticket: p.data.ticket, p_user: p.data.user, p_expected: p.data.expected ?? null });
    if (error) return fail(dbMessage(error));
    afterChange(p.data.ticket);
    return succeed(p.data.user ? 'Responsável atribuído.' : 'Chamado devolvido à fila.');
  });
}

const teamSchema = base.extend({ team: uuid });
export async function moveTeam(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const p = parse(teamSchema, formObject(fd));
  if (!p.ok) return p.state;
  return guarded('manager', 'moveTeam', async ({ ctx, org }) => {
    const { error } = await ctx.supabase.rpc('tk_move_team', { p_org: org, p_ticket: p.data.ticket, p_team: p.data.team, p_expected: p.data.expected ?? null });
    if (error) return fail(dbMessage(error));
    afterChange(p.data.ticket);
    return succeed('Equipe alterada.');
  });
}

const prioritySchema = base.extend({ priority: z.enum(['low', 'normal', 'high', 'urgent'], 'Prioridade inválida.') });
export async function setPriority(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const p = parse(prioritySchema, formObject(fd));
  if (!p.ok) return p.state;
  return guarded('staff', 'setPriority', async ({ ctx, org }) => {
    const { error } = await ctx.supabase.rpc('tk_set_priority', { p_org: org, p_ticket: p.data.ticket, p_priority: p.data.priority, p_expected: p.data.expected ?? null });
    if (error) return fail(dbMessage(error));
    afterChange(p.data.ticket);
    return succeed('Prioridade alterada. A meta de SLA do ciclo em andamento não muda; vale para os próximos ciclos.');
  });
}

const categorySchema = base.extend({ category: optUuid });
export async function setCategory(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const p = parse(categorySchema, formObject(fd));
  if (!p.ok) return p.state;
  return guarded('staff', 'setCategory', async ({ ctx, org }) => {
    const { error } = await ctx.supabase.rpc('tk_set_category', { p_org: org, p_ticket: p.data.ticket, p_category: p.data.category, p_expected: p.data.expected ?? null });
    if (error) return fail(dbMessage(error));
    afterChange(p.data.ticket);
    return succeed('Categoria alterada.');
  });
}

const statusSchema = base.extend({ status: z.enum(['in_progress', 'closed'], 'Estado inválido.') });
export async function setStatus(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const p = parse(statusSchema, formObject(fd));
  if (!p.ok) return p.state;
  return guarded('staff', 'setStatus', async ({ ctx, org }) => {
    const { error } = await ctx.supabase.rpc('tk_set_status', { p_org: org, p_ticket: p.data.ticket, p_status: p.data.status, p_expected: p.data.expected ?? null });
    if (error) return fail(dbMessage(error));
    afterChange(p.data.ticket);
    return succeed(p.data.status === 'closed' ? 'Chamado encerrado.' : 'Atendimento retomado.');
  });
}

export async function confirmTicket(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const p = parse(base, formObject(fd));
  if (!p.ok) return p.state;
  return guarded('requester', 'confirmTicket', async ({ ctx, org }) => {
    const { error } = await ctx.supabase.rpc('tk_confirm', { p_org: org, p_ticket: p.data.ticket, p_expected: p.data.expected ?? null });
    if (error) return fail(dbMessage(error));
    afterChange(p.data.ticket);
    return succeed('Obrigado! O chamado foi encerrado.');
  });
}

const reopenSchema = base.extend({ reason: z.string().trim().min(3, 'Explique por que está reabrindo (mín. 3 caracteres).').max(1000, 'Motivo longo demais (máx. 1.000).') });
export async function reopenTicket(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const values = formObject(fd);
  const p = parse(reopenSchema, values, values);
  if (!p.ok) return p.state;
  return guarded('any', 'reopenTicket', async ({ ctx, org }) => {
    const { error } = await ctx.supabase.rpc('tk_reopen', { p_org: org, p_ticket: p.data.ticket, p_reason: p.data.reason, p_expected: p.data.expected ?? null });
    if (error) return fail(dbMessage(error), undefined, values);
    afterChange(p.data.ticket);
    return succeed('Chamado reaberto. Um novo ciclo de atendimento foi iniciado.');
  });
}

export async function markNotificationsRead(): Promise<ActionState> {
  return guarded('any', 'markNotificationsRead', async ({ ctx, org }) => {
    const { error } = await ctx.supabase.rpc('tk_mark_notifications', { p_org: org, p_ids: null });
    if (error) return fail(dbMessage(error));
    bust('/notificacoes', '/dashboard', '/chamados');
    return succeed('Notificações marcadas como lidas.');
  });
}
