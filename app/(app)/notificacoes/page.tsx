import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionButton } from '@/components/tk/fields';
import { Section } from '@/components/tk/bits';
import { Badge, EmptyState, PageHeader } from '@/components/ui/primitives';
import { formatInstant } from '@/lib/sla/time';
import { markNotificationsRead } from '@/lib/tickets/actions/tickets';
import { loadNotifications } from '@/lib/tickets/data';
import { pageCtx } from '@/lib/tickets/page';
import { NOTIFICATION_LABEL } from '@/lib/tickets/status';

export const metadata: Metadata = { title: 'Notificações' };

export default async function NotificationsPage() {
  const c = await pageCtx(['owner', 'manager', 'agent', 'requester']);
  const n = await loadNotifications(c.ctx, c.org, 50);
  return (
    <>
      <PageHeader title="Notificações" description="Avisos dentro do sistema sobre os chamados que você acompanha. O sistema não envia e-mail nem mensagens externas: para saber de novidades, volte aqui.">
        {n.unread > 0 ? <ActionButton action={markNotificationsRead} fields={{}} label="Marcar todas como lidas" pending="Marcando…" /> : null}
      </PageHeader>
      <Section title={n.unread > 0 ? `${n.unread} não lida(s)` : 'Tudo em dia'}>
        {n.items.length === 0 ? <EmptyState title="Nenhuma notificação ainda" description="Você será avisado quando um chamado for atribuído a você, receber resposta, for resolvido ou reaberto." /> : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {n.items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
                {!i.read ? <Badge tone="success">Nova</Badge> : null}
                <span className="font-medium">{NOTIFICATION_LABEL[i.type] ?? i.type}</span>
                <Link className="underline underline-offset-2" href={`/chamados/${i.ticket_id}`}><span className="tabular-nums text-muted">#{i.number}</span> {i.subject}</Link>
                <time className="ml-auto text-xs text-muted tabular-nums" dateTime={i.created_at}>{formatInstant(Date.parse(i.created_at), c.tz)}</time>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
