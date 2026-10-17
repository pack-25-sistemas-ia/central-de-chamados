import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Composer } from '@/components/tk/composer';
import { ResponsiveDetails } from '@/components/tk/responsive-details';
import { MetricRow, PriorityBadge, SlaBadge, StatusBadge } from '@/components/tk/ticket-bits';
import { AssignForm, CategoryForm, ClaimButton, CloseButton, ConfirmButton, PriorityForm, ReleaseButton, ReopenForm, ResumeButton, TeamForm } from '@/components/tk/ticket-actions';
import { Alert, Badge, Card } from '@/components/ui/primitives';
import { cycleSla, type Cycle } from '@/lib/sla/state';
import { formatInstant } from '@/lib/sla/time';
import { loadCanned, loadCategories, loadDetail, loadPeople, loadTeams, type CycleView, type Detail } from '@/lib/tickets/data';
import { pageCtx } from '@/lib/tickets/page';
import { uuidOrNull } from '@/lib/tickets/query';
import { EVENT_LABEL, STATUS_LABEL, availableActions, type Action } from '@/lib/tickets/status';

export const metadata: Metadata = { title: 'Chamado' };

const toCycle = (c: CycleView): Cycle => ({
  startedMs: Date.parse(c.started_at), firstResponseMs: c.first_response_at ? Date.parse(c.first_response_at) : null, resolvedMs: c.resolved_at ? Date.parse(c.resolved_at) : null,
  firstResponseTarget: c.sla.first_response.target, resolutionTarget: c.sla.resolution.target,
  pauses: c.pauses.map((p) => ({ startMs: Date.parse(p.started_at), endMs: p.ended_at ? Date.parse(p.ended_at) : null })),
});

function dueOf(detail: Detail, cycle: CycleView, now: number) {
  if (!detail.calendar || cycle.closed_at) return { first: null, resolution: null };
  const r = cycleSla({ def: detail.calendar.definition, tz: detail.calendar.timezone }, toCycle(cycle), now);
  return { first: r.first.dueMs, resolution: r.resolution.dueMs };
}

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const id = uuidOrNull((await params).id);
  if (!id) notFound();
  const c = await pageCtx(['owner', 'manager', 'agent', 'requester']);
  const d = await loadDetail(c.ctx, c.org, id);
  if (!d) notFound();
  const t = d.ticket;
  const staff = c.isStaff;
  const profile = d.viewer.profile;
  const assignedToMe = t.assigned_user_id === d.viewer.user_id;
  const actions = new Set<Action>(availableActions({ status: t.status, profile, assignedToMe, hasAssignee: !!t.assigned_user_id, reopenAllowed: d.reopen.allowed }));
  const [categories, canned, teams, people] = staff
    ? await Promise.all([loadCategories(c.ctx, c.org), loadCanned(c.ctx, c.org), loadTeams(c.ctx, c.org), loadPeople(c.ctx, c.org)])
    : [[], [], [], []];
  const tz = c.tz;
  const when = (iso: string) => formatInstant(Date.parse(iso), tz);
  const active = d.cycles.find((x) => !x.closed_at) ?? d.cycles[0] ?? null;
  const due = active ? dueOf(d, active, c.now) : { first: null, resolution: null };
  const attByMsg = new Map<string, Detail['attachments']>();
  for (const a of d.attachments) attByMsg.set(a.message_id, [...(attByMsg.get(a.message_id) ?? []), a]);
  const mb = Math.floor(c.settings.attachment_max_size_bytes / 1024 / 1024 * 10) / 10;
  const assignable = people.filter((p) => p.profile && p.profile !== 'requester' && p.active && (t.team_id ? p.teams.includes(t.team_id) : false));

  const sidebar = (
    <div className="space-y-4">
      <Card title="Detalhes">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted">Status</dt><dd><StatusBadge status={t.status} /></dd>
          <dt className="text-muted">Prioridade</dt><dd><PriorityBadge priority={t.priority} /></dd>
          <dt className="text-muted">Categoria</dt><dd>{t.category ?? '—'}</dd>
          {staff ? <><dt className="text-muted">Equipe</dt><dd>{t.team ?? '—'}</dd><dt className="text-muted">Responsável</dt><dd>{t.assignee ?? 'Sem responsável'}</dd></> : null}
          <dt className="text-muted">Solicitante</dt><dd>{t.requester ?? '—'}</dd>
          <dt className="text-muted">Aberto em</dt><dd className="tabular-nums">{when(t.created_at)}</dd>
        </dl>
      </Card>

      {staff && active ? (
        <Card title="SLA" description={`Ciclo ${active.cycle}${active.closed_at ? ' (encerrado)' : ''} · minutos úteis · fuso ${d.calendar?.timezone ?? tz}`}>
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm"><span className="text-muted">Situação:</span><SlaBadge state={active.sla.summary} />{active.paused ? <Badge>Relógio pausado</Badge> : null}</div>
            <MetricRow label="Primeira resposta" m={active.sla.first_response} tz={tz} due={due.first} />
            <MetricRow label="Resolução" m={active.sla.resolution} tz={tz} due={due.resolution} />
            <p className="text-xs text-muted">As metas foram fixadas no início deste ciclo. Mudar a prioridade ou a política não altera a meta do ciclo em andamento; vale para os próximos. «Próximo do limite» = 80% da meta consumida.</p>
          </div>
        </Card>
      ) : null}

      {staff ? (
        <Card title="Ações">
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {actions.has('claim') ? <ClaimButton ticket={t.id} /> : null}
              {actions.has('resume') ? <ResumeButton ticket={t.id} expected={t.version} /> : null}
              {actions.has('release') ? <ReleaseButton ticket={t.id} expected={t.version} /> : null}
              {actions.has('close') ? <CloseButton ticket={t.id} expected={t.version} /> : null}
            </div>
            {actions.has('assign') ? <AssignForm ticket={t.id} expected={t.version} current={t.assigned_user_id} people={assignable.map((p) => ({ value: p.user_id, label: p.name }))} /> : null}
            {actions.has('move_team') ? <TeamForm ticket={t.id} expected={t.version} current={t.team_id} teams={teams.filter((x) => x.active).map((x) => ({ value: x.id, label: x.name }))} /> : null}
            {actions.has('set_priority') ? <PriorityForm ticket={t.id} expected={t.version} current={t.priority} /> : null}
            {actions.has('set_category') ? <CategoryForm ticket={t.id} expected={t.version} current={t.category_id} categories={categories.filter((x) => x.active).map((x) => ({ value: x.id, label: x.name }))} /> : null}
            {!actions.has('assign') && !actions.has('move_team') && !actions.has('set_priority') && !actions.has('claim') && !actions.has('close') && !actions.has('resume') && !actions.has('release') ? <p className="text-sm text-muted">Chamado encerrado: sem ações de atendimento.</p> : null}
          </div>
        </Card>
      ) : null}

      {staff && d.cycles.length > 0 ? (
        <Card title="Ciclos de atendimento" description="A reabertura cria um novo ciclo; os anteriores ficam preservados.">
          <ul className="space-y-2 text-sm">
            {d.cycles.map((cy) => (
              <li key={cy.id} className="rounded-md border border-border p-2">
                <div className="flex items-center justify-between gap-2"><span className="font-medium">Ciclo {cy.cycle}</span><SlaBadge state={cy.sla.summary} /></div>
                <p className="text-xs text-muted">Início {when(cy.started_at)}{cy.first_response_at ? ` · 1ª resposta ${when(cy.first_response_at)}` : ''}{cy.resolved_at ? ` · resolvido ${when(cy.resolved_at)}` : ''}{cy.pauses.length ? ` · ${cy.pauses.length} pausa(s)` : ''}</p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {!staff ? (
        <Card title="O que você pode fazer">
          <div className="space-y-3">
            {actions.has('confirm') ? <><p className="text-sm">A equipe marcou este chamado como resolvido. Se resolveu, confirme; se não, reabra.</p><ConfirmButton ticket={t.id} expected={t.version} /></> : null}
            {actions.has('reopen') ? <ReopenForm ticket={t.id} expected={t.version} requester /> : null}
            {(t.status === 'resolved' || t.status === 'closed') && !d.reopen.allowed ? <Alert tone="info">O prazo para reabrir terminou ({d.reopen.window_hours} h após a solução). Se o problema voltou, <Link className="underline" href="/chamados/novo">abra um novo chamado</Link> citando o número #{t.number}.</Alert> : null}
            {actions.size === 0 || (actions.size === 1 && actions.has('reply')) ? <p className="text-sm text-muted">Responda na conversa ao lado. A equipe é avisada.</p> : null}
          </div>
        </Card>
      ) : actions.has('reopen') ? <Card title="Reabrir"><ReopenForm ticket={t.id} expected={t.version} requester={false} /></Card> : null}
    </div>
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm"><Link className="text-muted underline underline-offset-2" href="/chamados">← Chamados</Link></p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight"><span className="tabular-nums text-muted">#{t.number}</span> {t.subject}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2"><StatusBadge status={t.status} /><PriorityBadge priority={t.priority} />{staff && active ? <SlaBadge state={active.sla.summary} /> : null}</div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="order-2 min-w-0 space-y-4 lg:order-1">
          <section aria-label="Conversa" className="space-y-3">
            {d.messages.map((m) => {
              const internal = m.visibility === 'internal';
              const mine = m.author_id === d.viewer.user_id;
              return (
                <article key={m.id} aria-label={`${internal ? 'Nota interna' : m.kind === 'requester' ? 'Mensagem do solicitante' : 'Resposta da equipe'} de ${m.author ?? 'usuário'}`}
                  className={internal ? 'rounded-lg border border-warning bg-warning/10 p-4' : m.kind === 'staff' ? 'rounded-lg border border-border bg-card p-4' : 'rounded-lg border border-border bg-black/[0.03] p-4 dark:bg-white/5'}>
                  <header className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                    <strong>{m.author ?? 'Usuário'}{mine ? ' (você)' : ''}</strong>
                    {internal ? <Badge tone="warning">🔒 Nota interna — só a equipe vê</Badge> : m.kind === 'staff' ? <Badge tone="success">Equipe</Badge> : <Badge>Solicitante</Badge>}
                    {m.on_behalf ? <span className="text-xs text-muted">(registrado pela equipe em nome do solicitante)</span> : null}
                    <time className="ml-auto text-xs text-muted tabular-nums" dateTime={m.created_at}>{when(m.created_at)}</time>
                  </header>
                  <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
                  {(attByMsg.get(m.id) ?? []).length > 0 ? (
                    <ul className="mt-3 flex flex-wrap gap-2" aria-label="Anexos">
                      {(attByMsg.get(m.id) ?? []).map((a) => (
                        <li key={a.id}><a className="inline-flex min-h-9 items-center gap-1 rounded-md border border-border px-2 text-xs underline-offset-2 hover:underline" href={`/api/anexos/${a.id}`}>📎 {a.filename} <span className="text-muted">({Math.max(1, Math.round(a.size / 1024))} KB)</span></a></li>
                      ))}
                    </ul>
                  ) : null}
                </article>
              );
            })}
          </section>

          {t.status === 'resolved' && !staff ? <Alert tone="success">Este chamado foi marcado como resolvido. Confirme ao lado ou reabra se ainda precisar de ajuda.</Alert> : null}
          {actions.has('reply') || actions.has('note') ? (
            <Composer ticket={t.id} expected={t.version} staff={staff} canned={canned.filter((x) => x.active).map((x) => ({ id: x.id, title: x.title, body: x.body }))} canResolve={actions.has('resolve')} uploadLimitMb={mb} />
          ) : (
            <Alert tone="info">Este chamado está {STATUS_LABEL[t.status].toLowerCase()}. {staff ? 'Notas internas continuam permitidas.' : ''}</Alert>
          )}

          {staff && d.events.length > 0 ? (
            <details className="rounded-lg border border-border bg-card">
              <summary className="flex min-h-10 cursor-pointer list-none items-center px-4 text-sm font-medium">Histórico de eventos ({d.events.length})</summary>
              <ol className="space-y-1 border-t border-border p-4 text-sm">
                {d.events.map((e) => (
                  <li key={e.id} className="flex flex-wrap gap-x-2"><time className="tabular-nums text-muted" dateTime={e.created_at}>{when(e.created_at)}</time><span>{EVENT_LABEL[e.type] ?? e.type}</span>{e.actor ? <span className="text-muted">por {e.actor}</span> : null}</li>
                ))}
              </ol>
            </details>
          ) : null}
        </div>

        <aside className="order-1 lg:order-2" aria-label="Metadados do chamado">
          <ResponsiveDetails summary="Detalhes, SLA e ações">{sidebar}</ResponsiveDetails>
        </aside>
      </div>
    </>
  );
}
