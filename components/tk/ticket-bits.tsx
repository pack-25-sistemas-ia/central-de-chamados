import Link from 'next/link';
import { Badge } from '@/components/ui/primitives';
import { SLA_LABEL, SLA_TONE, formatMinutes, type SlaState } from '@/lib/sla/state';
import { PRIORITY_LABEL, PRIORITY_TONE, STATUS_LABEL, STATUS_TONE, type Priority, type Status } from '@/lib/tickets/status';
import type { Metric, Sla } from '@/lib/tickets/data';
import { formatInstant } from '@/lib/sla/time';

export const StatusBadge = ({ status }: { status: string }) => <Badge tone={STATUS_TONE[status as Status] ?? 'neutral'}>{STATUS_LABEL[status as Status] ?? status}</Badge>;
export const PriorityBadge = ({ priority }: { priority: string }) => <Badge tone={PRIORITY_TONE[priority as Priority] ?? 'neutral'}>{PRIORITY_LABEL[priority as Priority] ?? priority}</Badge>;
export const SlaBadge = ({ state }: { state: SlaState }) => <Badge tone={SLA_TONE[state]}>{SLA_LABEL[state]}</Badge>;

/** Texto + cor (nunca só cor): o estado do SLA lido em minutos úteis. */
export function SlaCell({ sla }: { sla: Sla | null }) {
  if (!sla) return <span className="text-muted">—</span>;
  return (
    <span className="flex flex-col gap-0.5">
      <SlaBadge state={sla.summary} />
      <span className="text-xs text-muted">1ª resposta: {formatMinutes(sla.first_response.consumed)} de {formatMinutes(sla.first_response.target)}</span>
    </span>
  );
}

export function MetricRow({ label, m, tz, due }: { label: string; m: Metric; tz: string; due?: number | null }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{label}</span><SlaBadge state={m.state} /></div>
      <p className="mt-1 text-xs text-muted tabular-nums">{formatMinutes(m.consumed)} úteis consumidos de {formatMinutes(m.target)}</p>
      {m.done_at ? <p className="text-xs text-muted">Marco em {formatInstant(Date.parse(m.done_at), tz)}</p> : null}
      {due ? <p className="text-xs text-muted">Vence em ≈ {formatInstant(due, tz)}</p> : null}
    </div>
  );
}

export const TicketLink = ({ id, number, subject }: { id: string; number: number; subject: string }) => (
  <Link href={`/chamados/${id}`} className="font-medium underline-offset-2 hover:underline"><span className="tabular-nums text-muted">#{number}</span> {subject}</Link>
);
