'use server';

import { z } from 'zod';
import { fail, succeed, type ActionState } from '@/lib/actions/result';
import { bust, dbMessage, formObject, guarded, parse, type SaveResult } from '../action-kit';

const uuid = z.string().uuid('Registro inválido.');
const optUuid = z.union([uuid, z.literal('')]).transform((v) => (v === '' ? null : v));
const checkbox = z.union([z.literal('on'), z.literal('')]).optional().transform((v) => v === 'on');

const teamSchema = z.object({ id: optUuid.optional(), name: z.string().trim().min(2, 'Informe o nome (mínimo de 2 letras).').max(60, 'Nome longo demais (máx. 60).'), active: checkbox });
export async function saveTeam(_prev: ActionState, fd: FormData): Promise<SaveResult> {
  const values = formObject(fd);
  const p = parse(teamSchema, values, values);
  if (!p.ok) return p.state;
  return guarded('manager', 'saveTeam', async ({ ctx, org }) => {
    const d = p.data;
    const { data, error } = await ctx.supabase.rpc('tk_save_team', { p_org: org, p_id: d.id ?? null, p_name: d.name, p_active: d.id ? d.active : true });
    if (error) return fail(dbMessage(error), undefined, values);
    bust('/equipes', '/chamados', '/categorias');
    return { ...succeed(d.id ? 'Equipe atualizada.' : 'Equipe criada.'), id: data as string };
  });
}

const membersSchema = z.object({ team: uuid });
export async function saveTeamMembers(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const p = parse(membersSchema, formObject(fd));
  if (!p.ok) return p.state;
  const users = fd.getAll('user').filter((x): x is string => typeof x === 'string' && z.string().uuid().safeParse(x).success);
  return guarded('manager', 'saveTeamMembers', async ({ ctx, org }) => {
    const { error } = await ctx.supabase.rpc('tk_set_team_members', { p_org: org, p_team: p.data.team, p_users: users });
    if (error) return fail(dbMessage(error));
    bust('/equipes', '/chamados');
    return succeed('Membros da equipe atualizados. Chamados abertos de quem saiu voltaram para a fila da equipe.');
  });
}

const categorySchema = z.object({ id: optUuid.optional(), name: z.string().trim().min(2, 'Informe o nome (mínimo de 2 letras).').max(60, 'Nome longo demais (máx. 60).'), team: optUuid.optional(), active: checkbox });
export async function saveCategory(_prev: ActionState, fd: FormData): Promise<SaveResult> {
  const values = formObject(fd);
  const p = parse(categorySchema, values, values);
  if (!p.ok) return p.state;
  return guarded('manager', 'saveCategory', async ({ ctx, org }) => {
    const d = p.data;
    const { data, error } = await ctx.supabase.rpc('tk_save_category', { p_org: org, p_id: d.id ?? null, p_name: d.name, p_default_team: d.team ?? null, p_active: d.id ? d.active : true });
    if (error) return fail(dbMessage(error), undefined, values);
    bust('/categorias', '/chamados');
    return { ...succeed(d.id ? 'Categoria atualizada.' : 'Categoria criada.'), id: data as string };
  });
}

const cannedSchema = z.object({
  id: optUuid.optional(), title: z.string().trim().min(2, 'Informe o título (mínimo de 2 letras).').max(80, 'Título longo demais (máx. 80).'),
  body: z.string().trim().min(1, 'Escreva o texto da resposta.').max(5000, 'Texto longo demais (máx. 5.000).'), active: checkbox,
});
export async function saveCanned(_prev: ActionState, fd: FormData): Promise<SaveResult> {
  const values = formObject(fd);
  const p = parse(cannedSchema, values, values);
  if (!p.ok) return p.state;
  return guarded('manager', 'saveCanned', async ({ ctx, org }) => {
    const d = p.data;
    const { data, error } = await ctx.supabase.rpc('tk_save_canned', { p_org: org, p_id: d.id ?? null, p_title: d.title, p_body: d.body, p_active: d.id ? d.active : true });
    if (error) return fail(dbMessage(error), undefined, values);
    bust('/respostas-prontas', '/chamados');
    return { ...succeed(d.id ? 'Resposta pronta atualizada.' : 'Resposta pronta criada.'), id: data as string };
  });
}

const agentSchema = z.object({ user: uuid, active: z.enum(['on', 'off']), mode: z.enum(['', 'unassign', 'reassign']).optional(), to: optUuid.optional() });
/** Desativar atendente: o gestor DECIDE o que fazer com os chamados abertos dele (devolver à fila ou reatribuir). */
export async function setAgentActive(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const p = parse(agentSchema, formObject(fd));
  if (!p.ok) return p.state;
  return guarded('manager', 'setAgentActive', async ({ ctx, org }) => {
    const d = p.data;
    const { data, error } = await ctx.supabase.rpc('tk_set_agent_active', { p_org: org, p_user: d.user, p_active: d.active === 'on', p_mode: d.mode || null, p_to: d.to ?? null });
    if (error) return fail(dbMessage(error));
    bust('/equipes', '/chamados', '/members');
    const n = (data as { tickets_changed?: number } | null)?.tickets_changed ?? 0;
    return succeed(d.active === 'on' ? 'Atendente reativado.' : `Atendente desativado. ${n} chamado(s) aberto(s) tratado(s).`);
  });
}
