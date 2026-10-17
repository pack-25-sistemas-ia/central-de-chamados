import 'server-only';
import type { Context } from '@/lib/auth/session';
import type { CalendarDef } from '@/lib/sla/business';
import type { Priority, Profile, Status } from './status';
import type { SlaState } from '@/lib/sla/state';

// Leituras: filas, detalhe, painel e exportação passam por funções tk_* (o DTO do solicitante é montado no BANCO); listas simples vêm do RLS.
export type Metric = { target: number; consumed: number; state: SlaState; done_at: string | null };
export type Sla = { first_response: Metric; resolution: Metric; summary: SlaState };
export type QueueRow = {
  id: string; number: number; subject: string; status: Status; priority: Priority; version: number; category_id: string | null; category: string | null; created_at: string; last_public_activity_at: string;
  requester_id: string; requester: string | null; team_id: string | null; team: string | null; assigned_user_id: string | null; assignee: string | null; sla: Sla | null;
};
export type Queue = { rows: QueueRow[]; total: number; page: number; size: number };

export type Message = { id: string; kind: 'requester' | 'staff' | 'system'; visibility: 'public' | 'internal'; body: string; created_at: string; author_id: string | null; author: string | null; on_behalf: boolean };
export type Attachment = { id: string; message_id: string; filename: string; mime: string; size: number };
export type TicketEvent = { id: number; type: string; actor: string | null; meta: Record<string, unknown>; created_at: string };
export type CycleView = {
  id: string; cycle: number; priority: Priority; started_at: string; first_response_at: string | null; resolved_at: string | null; closed_at: string | null; sla: Sla; paused: boolean;
  pauses: Array<{ started_at: string; ended_at: string | null }>;
};
export type Detail = {
  ticket: { id: string; number: number; subject: string; status: Status; priority: Priority; version: number; category_id: string | null; category: string | null; created_at: string; updated_at: string;
    requester_id: string; requester: string | null; team_id: string | null; team: string | null; assigned_user_id: string | null; assignee: string | null };
  messages: Message[]; attachments: Attachment[]; events: TicketEvent[]; cycles: CycleView[]; calendar: { definition: CalendarDef; timezone: string } | null;
  reopen: { window_hours: number; until: string | null; allowed: boolean }; viewer: { profile: Profile; user_id: string };
};
export type Person = { user_id: string; role: string; profile: Profile | null; name: string; email: string | null; active: boolean; teams: string[] };
export type Team = { id: string; name: string; active: boolean };
export type Category = { id: string; name: string; default_team_id: string | null; active: boolean };
export type Canned = { id: string; title: string; body: string; active: boolean };
export type NotificationItem = { id: number; type: string; ticket_id: string; number: number; subject: string; read: boolean; created_at: string };
export type Dashboard = {
  period: { from: string; to: string; timezone: string }; created_tickets: number; backlog: { open: number; in_progress: number; waiting_requester: number; unassigned: number; total: number };
  resolved_cycles: number; reopened_cycles: number; reopened_tickets: number; by_category: Array<{ name: string; count: number }>; by_priority: Record<string, number>;
  workload: Array<{ user_id: string; name: string; open: number }>;
  first_response: Compliance; resolution: Compliance; overdue_open: { first_response: number; resolution: number };
};
export type Compliance = { cycles: number; within_target: number; rate: number | null; avg_minutes: number | null; median_minutes: number | null };

export async function loadQueue(ctx: Context, org: string, filters: Record<string, unknown>, page: number, size: number): Promise<Queue> {
  const { data, error } = await ctx.supabase.rpc('tk_queue', { p_org: org, p_filters: filters, p_page: page, p_size: size });
  if (error || !data) return { rows: [], total: 0, page, size };
  return data as Queue;
}

export async function loadDetail(ctx: Context, org: string, id: string): Promise<Detail | null> {
  const { data, error } = await ctx.supabase.rpc('tk_ticket_detail', { p_org: org, p_ticket: id });
  if (error || !data) return null;
  return data as Detail;
}

export async function loadPeople(ctx: Context, org: string): Promise<Person[]> {
  const { data } = await ctx.supabase.rpc('tk_people', { p_org: org });
  return (data ?? []) as Person[];
}

export async function loadTeams(ctx: Context, org: string): Promise<Team[]> {
  const { data } = await ctx.supabase.from('teams').select('id, name, active').eq('organization_id', org).order('name');
  return (data ?? []) as Team[];
}
export async function loadTeamMembers(ctx: Context, org: string): Promise<Map<string, string[]>> {
  const { data } = await ctx.supabase.from('team_members').select('team_id, user_id').eq('organization_id', org);
  const m = new Map<string, string[]>();
  for (const r of (data ?? []) as Array<{ team_id: string; user_id: string }>) m.set(r.team_id, [...(m.get(r.team_id) ?? []), r.user_id]);
  return m;
}
export async function loadCategories(ctx: Context, org: string): Promise<Category[]> {
  const { data } = await ctx.supabase.from('ticket_categories').select('id, name, default_team_id, active').eq('organization_id', org).order('name');
  return (data ?? []) as Category[];
}
export async function loadCanned(ctx: Context, org: string): Promise<Canned[]> {
  const { data } = await ctx.supabase.from('canned_responses').select('id, title, body, active').eq('organization_id', org).order('title');
  return (data ?? []) as Canned[];
}
export async function loadNotifications(ctx: Context, org: string, limit = 30): Promise<{ unread: number; items: NotificationItem[] }> {
  const { data } = await ctx.supabase.rpc('tk_notifications', { p_org: org, p_limit: limit });
  const d = (data ?? { unread: 0, items: [] }) as { unread: number; items: NotificationItem[] };
  return { unread: d.unread ?? 0, items: d.items ?? [] };
}
export async function loadDashboard(ctx: Context, org: string, from: string, to: string, team: string | null): Promise<Dashboard | null> {
  const { data, error } = await ctx.supabase.rpc('tk_dashboard', { p_org: org, p_from: from, p_to: to, p_team: team });
  if (error || !data) return null;
  return data as Dashboard;
}

export type SlaPolicy = { calendar: { timezone: string; definition: CalendarDef; created_at: string }; targets: Record<Priority, { first_response: number; resolution: number }>; created_at: string; versions: number };
export async function loadSlaPolicy(ctx: Context, org: string): Promise<SlaPolicy | null> {
  const { data: pol } = await ctx.supabase.from('sla_policy_versions').select('business_calendar_version_id, targets_by_priority, created_at').eq('organization_id', org).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!pol) return null;
  const p = pol as { business_calendar_version_id: string; targets_by_priority: SlaPolicy['targets']; created_at: string };
  const { data: cal } = await ctx.supabase.from('business_calendar_versions').select('timezone, definition, created_at').eq('id', p.business_calendar_version_id).maybeSingle();
  const { count } = await ctx.supabase.from('sla_policy_versions').select('id', { count: 'exact', head: true }).eq('organization_id', org);
  if (!cal) return null;
  return { calendar: cal as SlaPolicy['calendar'], targets: p.targets_by_priority, created_at: p.created_at, versions: count ?? 1 };
}
