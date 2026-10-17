import { NextResponse, type NextRequest } from 'next/server';
import { resolveContext } from '@/lib/auth/session';
import { rateLimit } from '@/lib/security/rate-limit';
import { instantToLocal } from '@/lib/sla/time';
import { SLA_LABEL, type SlaState } from '@/lib/sla/state';
import { toCsv } from '@/lib/tickets/csv';
import { isIsoDate, safeSearch, uuidOrNull } from '@/lib/tickets/query';
import { PRIORITY_LABEL, STATUS_LABEL, isPriority, isStatus, type Priority, type Status } from '@/lib/tickets/status';

// Exportação CSV dos chamados (equipe). Sessão, MFA e perfil são conferidos no servidor; o banco devolve só o que o usuário pode ver (mesmos filtros e escopo da fila);
// fórmulas são neutralizadas; sem corpo de mensagem nem e-mail; a exportação é auditada (somente a quantidade de linhas).
type Row = { number: number; subject: string; status: Status; priority: Priority; category: string | null; team: string | null; assignee: string | null; requester: string | null; created_at: string; last_public_activity_at: string; cycles: number; resolved_at: string | null; sla: SlaState | null };

export async function GET(req: NextRequest) {
  const r = await resolveContext();
  if (r.kind !== 'ok') return new NextResponse(r.kind === 'forbidden' ? 'Sem permissão' : 'Não autenticado', { status: r.kind === 'forbidden' ? 403 : 401 });
  const { supabase, user, membership } = r.ctx;
  const org = membership.organization_id;
  const rl = rateLimit(`tk-export:${user.id}`, { limit: 10, windowMs: 60_000 });
  if (!rl.allowed) return new NextResponse('Muitas exportações. Aguarde um instante.', { status: 429, headers: { 'retry-after': String(rl.retryAfterSeconds) } });
  const { data: ctxData } = await supabase.rpc('tk_my_context', { p_org: org });
  const profile = (ctxData as { profile?: string } | null)?.profile;
  if (profile !== 'owner' && profile !== 'manager' && profile !== 'agent') return new NextResponse('Sem permissão', { status: 403 });
  const { data: st } = await supabase.from('ticket_settings').select('timezone').eq('organization_id', org).maybeSingle();
  const tz = (st as { timezone: string } | null)?.timezone ?? 'America/Sao_Paulo';

  const p = req.nextUrl.searchParams;
  const status = p.get('status') ?? undefined;
  const filters = {
    q: safeSearch(p.get('q') ?? undefined) ?? undefined, view: ['mine', 'unassigned', 'waiting', 'overdue', 'resolved'].includes(p.get('view') ?? '') ? p.get('view') : undefined,
    status: isStatus(status) ? [status] : undefined, priority: isPriority(p.get('priority')) ? p.get('priority') : undefined, category: uuidOrNull(p.get('category') ?? undefined) ?? undefined,
    team: uuidOrNull(p.get('team') ?? undefined) ?? undefined, requester: uuidOrNull(p.get('requester') ?? undefined) ?? undefined,
    assignee: p.get('assignee') === 'none' || p.get('assignee') === 'me' ? p.get('assignee') : (uuidOrNull(p.get('assignee') ?? undefined) ?? undefined),
    sla: ['on_track', 'at_risk', 'overdue', 'paused', 'met', 'breached'].includes(p.get('sla') ?? '') ? p.get('sla') : undefined,
    from: isIsoDate(p.get('from') ?? undefined) ? p.get('from') : undefined, to: isIsoDate(p.get('to') ?? undefined) ? p.get('to') : undefined,
  };
  const { data, error } = await supabase.rpc('tk_export_rows', { p_org: org, p_filters: filters });
  if (error) return new NextResponse('Falha ao exportar', { status: 500 });
  const rows = (data ?? []) as Row[];

  const when = (iso: string | null) => { if (!iso) return ''; const l = instantToLocal(Date.parse(iso), tz); return `${l.date.split('-').reverse().join('/')} ${l.time}`; };
  const csv = toCsv(
    [
      { key: 'number', label: 'Número', kind: 'int' }, { key: 'subject', label: 'Assunto', kind: 'text' }, { key: 'status', label: 'Status', kind: 'text' }, { key: 'priority', label: 'Prioridade', kind: 'text' },
      { key: 'category', label: 'Categoria', kind: 'text' }, { key: 'team', label: 'Equipe', kind: 'text' }, { key: 'assignee', label: 'Responsável', kind: 'text' }, { key: 'requester', label: 'Solicitante', kind: 'text' },
      { key: 'created', label: `Criado em (${tz})`, kind: 'text' }, { key: 'activity', label: 'Última atividade pública', kind: 'text' }, { key: 'cycles', label: 'Ciclos', kind: 'int' },
      { key: 'resolved', label: 'Resolvido em', kind: 'text' }, { key: 'sla', label: 'SLA (ciclo atual)', kind: 'text' },
    ],
    rows.map((t) => ({
      number: t.number, subject: t.subject, status: STATUS_LABEL[t.status] ?? t.status, priority: PRIORITY_LABEL[t.priority] ?? t.priority, category: t.category, team: t.team, assignee: t.assignee,
      requester: t.requester, created: when(t.created_at), activity: when(t.last_public_activity_at), cycles: t.cycles, resolved: when(t.resolved_at), sla: t.sla ? SLA_LABEL[t.sla] : '',
    })),
  );
  await supabase.rpc('tk_log_export', { p_org: org, p_rows: rows.length });
  const day = instantToLocal(Date.now(), tz).date;
  return new NextResponse(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="chamados-${day}.csv"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
}
