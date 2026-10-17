'use server';

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { fail, succeed, type ActionState } from '@/lib/actions/result';
import { isValidTimeZone } from '@/lib/sla/time';
import { PRIORITIES } from '../status';
import { bust, dbMessage, formObject, guarded, parse, type SaveResult } from '../action-kit';

const int = (min: number, max: number, label: string) => z.coerce.number({ message: `${label}: informe um número.` }).int(`${label}: use um número inteiro.`).min(min, `${label}: mínimo ${min}.`).max(max, `${label}: máximo ${max}.`);

/** Marca: nome exibido e cor principal (mantidos em sincronia com a «Identidade visual» do Core, que alimenta o tema do painel). */
const brandSchema = z.object({
  display_name: z.string().trim().min(2, 'Informe ao menos 2 caracteres.').max(80, 'Nome longo demais (máx. 80).'),
  primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Cor inválida (use #RRGGBB).'),
});
export async function saveBrand(_prev: ActionState, fd: FormData): Promise<SaveResult> {
  const values = formObject(fd);
  const p = parse(brandSchema, values, values);
  if (!p.ok) return p.state;
  return guarded('owner', 'saveBrand', async ({ ctx, org }) => {
    const d = p.data;
    const { error } = await ctx.supabase.rpc('tk_save_settings', { p_org: org, p: { public_display_name: d.display_name, primary_color: d.primary_color.toLowerCase() } });
    if (error) return fail(dbMessage(error), undefined, values);
    const { data: cur } = await ctx.supabase.from('organization_settings').select('theme').eq('organization_id', org).maybeSingle();
    const theme = { ...((cur?.theme as Record<string, unknown> | undefined) ?? {}), primary: d.primary_color.toLowerCase() };
    const r = await ctx.supabase.from('organization_settings').update({ display_name: d.display_name, theme }).eq('organization_id', org).select('organization_id');
    if (r.error || !r.data?.length) return fail('Não foi possível aplicar a marca ao painel. Tente novamente.', undefined, values);
    bust('/', '/configuracoes', '/settings');
    return succeed('Marca salva.');
  });
}

const rulesSchema = z.object({
  reopen_window_hours: int(0, 8760, 'Janela de reabertura'),
  attachment_max_mb: z.coerce.number({ message: 'Tamanho máximo dos anexos: informe um número.' }).min(0.01, 'Tamanho máximo dos anexos: mínimo 0,01 MB.').max(10, 'Tamanho máximo dos anexos: máximo 10 MB.'),
  retention_policy_text: z.string().trim().max(1000, 'Texto longo demais (máx. 1.000).').optional(),
});
export async function saveRules(_prev: ActionState, fd: FormData): Promise<SaveResult> {
  const values = formObject(fd);
  const p = parse(rulesSchema, { ...values, attachment_max_mb: (values.attachment_max_mb ?? '').replace(',', '.') }, values);
  if (!p.ok) return p.state;
  return guarded('owner', 'saveRules', async ({ ctx, org }) => {
    const d = p.data;
    const { error } = await ctx.supabase.rpc('tk_save_settings', { p_org: org, p: {
      reopen_window_hours: d.reopen_window_hours, attachment_max_size_bytes: Math.round(d.attachment_max_mb * 1024 * 1024), retention_policy_text: d.retention_policy_text || null } });
    if (error) return fail(dbMessage(error), undefined, values);
    bust('/configuracoes', '/chamados');
    return succeed('Regras salvas. Valem para novas ações; chamados já resolvidos mantêm a janela em que foram resolvidos.');
  });
}

// ---- expediente e metas de SLA (publica uma NOVA versão; ciclos em andamento mantêm a anterior)
const TIME = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const slaSchema = z.object({ timezone: z.string().trim().min(3).max(60).refine(isValidTimeZone, 'Fuso horário inválido (ex.: America/Sao_Paulo).'), closed_dates: z.string().max(8000).optional() });

export async function publishSla(_prev: ActionState, fd: FormData): Promise<SaveResult> {
  const values = formObject(fd);
  const p = parse(slaSchema, values, values);
  if (!p.ok) return p.state;
  const errors: Record<string, string[]> = {};
  const weekly: Record<string, Array<[string, string]>> = {};
  for (let d = 0; d <= 6; d++) {
    const rows: Array<[string, string]> = [];
    for (let i = 1; i <= 3; i++) {
      const s = (values[`d${d}_s${i}`] ?? '').trim();
      const e = (values[`d${d}_e${i}`] ?? '').trim();
      if (!s && !e) continue;
      if (!TIME.test(s) || !TIME.test(e)) { errors[`d${d}_s${i}`] = ['Use o formato HH:MM (ex.: 09:00).']; continue; }
      rows.push([s, e]);
    }
    if (rows.length) weekly[String(d)] = rows;
  }
  const targets: Record<string, { first_response: number; resolution: number }> = {};
  for (const pr of PRIORITIES) {
    const fr = Number((values[`t_${pr}_first_response`] ?? '').trim());
    const rs = Number((values[`t_${pr}_resolution`] ?? '').trim());
    if (!Number.isInteger(fr) || fr < 1 || fr > 525600) errors[`t_${pr}_first_response`] = ['Informe minutos úteis (inteiro de 1 a 525600).'];
    if (!Number.isInteger(rs) || rs < 1 || rs > 525600) errors[`t_${pr}_resolution`] = ['Informe minutos úteis (inteiro de 1 a 525600).'];
    targets[pr] = { first_response: fr, resolution: rs };
  }
  const closed = (p.data.closed_dates ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  for (const c of closed) if (!/^\d{4}-\d{2}-\d{2}$/.test(c) || Number.isNaN(Date.parse(`${c}T00:00:00Z`))) errors.closed_dates = ['Use datas AAAA-MM-DD, uma por linha.'];
  if (Object.keys(errors).length) return fail('Revise os campos destacados.', errors, values);
  return guarded('owner', 'publishSla', async ({ ctx, org }) => {
    const { error } = await ctx.supabase.rpc('tk_publish_sla', { p_org: org, p_timezone: p.data.timezone, p_calendar: { weekly, closed_dates: closed }, p_targets: targets });
    if (error) return fail(dbMessage(error), undefined, values);
    bust('/configuracoes', '/chamados', '/dashboard');
    return succeed('Nova versão de expediente e SLA publicada. Vale para os próximos ciclos de atendimento; os em andamento mantêm a versão anterior.');
  });
}

// ---- logotipo: só imagens raster pequenas, tipo conferido pelos BYTES (não pelo nome nem pelo Content-Type enviado)
const MAX_LOGO = 512 * 1024;
function sniff(b: Uint8Array): { ext: 'png' | 'jpg' | 'webp'; mime: string } | null {
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { ext: 'webp', mime: 'image/webp' };
  return null;
}

export async function uploadLogo(_prev: ActionState, fd: FormData): Promise<SaveResult> {
  const file = fd.get('logo');
  if (!(file instanceof File) || file.size === 0) return fail('Escolha uma imagem PNG, JPG ou WebP.', { logo: ['Escolha uma imagem.'] });
  if (file.size > MAX_LOGO) return fail('A imagem deve ter no máximo 512 KB.', { logo: ['Imagem grande demais (máx. 512 KB).'] });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(bytes);
  if (!kind) return fail('Formato não aceito. Use PNG, JPG ou WebP.', { logo: ['Formato não aceito (use PNG, JPG ou WebP).'] });
  return guarded('owner', 'uploadLogo', async ({ ctx, org }) => {
    const { data: cur } = await ctx.supabase.from('ticket_settings').select('logo_path').eq('organization_id', org).maybeSingle();
    const path = `${org}/logo-${randomBytes(8).toString('hex')}.${kind.ext}`;
    const up = await ctx.supabase.storage.from('tk-logos').upload(path, bytes, { contentType: kind.mime, upsert: false });
    if (up.error) return fail('Não foi possível enviar o logotipo. Tente novamente.');
    const { error } = await ctx.supabase.rpc('tk_set_logo', { p_org: org, p_path: path });
    if (error) return fail(dbMessage(error));
    const old = (cur as { logo_path: string | null } | null)?.logo_path;
    if (old) await ctx.supabase.storage.from('tk-logos').remove([old]);
    bust('/', '/configuracoes');
    return succeed('Logotipo atualizado.');
  });
}

export async function removeLogo(): Promise<SaveResult> {
  return guarded('owner', 'removeLogo', async ({ ctx, org }) => {
    const { data: cur } = await ctx.supabase.from('ticket_settings').select('logo_path').eq('organization_id', org).maybeSingle();
    const { error } = await ctx.supabase.rpc('tk_set_logo', { p_org: org, p_path: null });
    if (error) return fail(dbMessage(error));
    const old = (cur as { logo_path: string | null } | null)?.logo_path;
    if (old) await ctx.supabase.storage.from('tk-logos').remove([old]);
    bust('/', '/configuracoes');
    return succeed('Logotipo removido.');
  });
}

/** Remove uploads ÓRFÃOS (enviados mas nunca vinculados a mensagem, com mais de 2 h). A lista vem do banco; a política do Storage só permite apagar órfãos. */
export async function cleanupOrphans(): Promise<ActionState> {
  return guarded('manager', 'cleanupOrphans', async ({ ctx, org }) => {
    const { data, error } = await ctx.supabase.rpc('tk_orphan_uploads', { p_org: org });
    if (error) return fail(dbMessage(error));
    const paths = (data ?? []) as string[];
    if (paths.length === 0) return succeed('Nenhum upload órfão encontrado.');
    const r = await ctx.supabase.storage.from('tk-attachments').remove(paths);
    if (r.error) return fail('Não foi possível remover os arquivos órfãos agora. Tente novamente.');
    return succeed(`${paths.length} upload(s) órfão(s) removido(s).`);
  });
}
