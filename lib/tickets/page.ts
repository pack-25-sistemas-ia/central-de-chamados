import 'server-only';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { requireContext, type Context } from '@/lib/auth/session';
import { nowMs } from '@/lib/time';
import { instantToLocal } from '@/lib/sla/time';
import type { Profile } from './status';

export type TicketSettings = {
  public_display_name: string | null; logo_path: string | null; primary_color: string; timezone: string; reopen_window_hours: number; attachment_max_size_bytes: number; retention_policy_text: string | null;
};
export const DEFAULT_SETTINGS: TicketSettings = {
  public_display_name: null, logo_path: null, primary_color: '#2563eb', timezone: 'America/Sao_Paulo', reopen_window_hours: 72, attachment_max_size_bytes: 5 * 1024 * 1024, retention_policy_text: null,
};

export type Access = { profile: Profile | null; userId: string | null; teams: string[] };

/** Perfil e equipes do usuário na empresa ativa (uma ida ao banco por requisição). */
export const loadAccess = cache(async (org: string): Promise<Access> => {
  const ctx = await requireContext();
  const { data } = await ctx.supabase.rpc('tk_my_context', { p_org: org });
  const d = (data ?? {}) as { profile?: Profile | null; user_id?: string | null; teams?: string[] };
  return { profile: d.profile ?? null, userId: d.user_id ?? null, teams: d.teams ?? [] };
});

/** Contexto comum das páginas: sessão (já com MFA/papel), perfil, políticas, fuso e «hoje» no fuso da empresa. */
export async function pageCtx(allow?: readonly Profile[]) {
  const ctx = await requireContext();
  const org = ctx.membership.organization_id;
  const access = await loadAccess(org);
  if (allow && (!access.profile || !allow.includes(access.profile))) notFound();
  const { data } = await ctx.supabase.from('ticket_settings').select('public_display_name, logo_path, primary_color, timezone, reopen_window_hours, attachment_max_size_bytes, retention_policy_text').eq('organization_id', org).maybeSingle();
  const settings: TicketSettings = (data as TicketSettings | null) ?? DEFAULT_SETTINGS;
  const now = nowMs();
  const today = instantToLocal(now, settings.timezone).date;
  const staff = access.profile === 'owner' || access.profile === 'manager' || access.profile === 'agent';
  return {
    ctx, org, settings, tz: settings.timezone, today, now, profile: access.profile, userId: access.userId ?? ctx.user.id, teams: access.teams,
    isStaff: staff, isManager: access.profile === 'owner' || access.profile === 'manager', isOwner: access.profile === 'owner', isRequester: access.profile === 'requester',
  };
}
export type PageCtx = Awaited<ReturnType<typeof pageCtx>>;
export type { Context };
