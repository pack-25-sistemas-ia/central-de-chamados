import type { Metadata } from 'next';
import Link from 'next/link';
import { FilterForm, FInput, FSelect, Pagination, TD, TH, TableShell, Tabs } from '@/components/tk/bits';
import { PriorityBadge, SlaCell, StatusBadge } from '@/components/tk/ticket-bits';
import { Card, PageHeader } from '@/components/ui/primitives';
import { formatInstant } from '@/lib/sla/time';
import { loadCategories, loadPeople, loadQueue, loadTeams, type QueueRow } from '@/lib/tickets/data';
import { pageCtx } from '@/lib/tickets/page';
import { PAGE_SIZE, isIsoDate, one, pageFrom, safeSearch, uuidOrNull, withParams, type SearchParams } from '@/lib/tickets/query';
import { PRIORITIES, PRIORITY_LABEL, STATUSES, STATUS_LABEL, isPriority, isStatus } from '@/lib/tickets/status';

export const metadata: Metadata = { title: 'Chamados' };

const VIEWS = [
  { key: '', label: 'Todos' }, { key: 'mine', label: 'Meus' }, { key: 'unassigned', label: 'Sem responsável' }, { key: 'waiting', label: 'Aguardando solicitante' },
  { key: 'overdue', label: 'SLA atrasado' }, { key: 'resolved', label: 'Resolvidos' },
] as const;
const SLA_FILTER = [['on_track', 'Dentro do prazo'], ['at_risk', 'Próximo do limite'], ['overdue', 'Atrasado'], ['paused', 'Pausado'], ['met', 'Cumprido'], ['breached', 'Descumprido']] as const;

export default async function QueuePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const c = await pageCtx(['owner', 'manager', 'agent', 'requester']);
  const sp = await searchParams;
  const page = pageFrom(one(sp.page));
  const staff = c.isStaff;
  const view = (VIEWS.map((v) => v.key) as string[]).includes(one(sp.view) ?? '') ? (one(sp.view) ?? '') : '';
  const board = staff && one(sp.layout) === 'board';
  const status = one(sp.status);
  const filters: Record<string, unknown> = {
    q: safeSearch(one(sp.q)) ?? undefined, view: view || undefined, status: isStatus(status) ? [status] : undefined, priority: isPriority(one(sp.priority)) ? one(sp.priority) : undefined,
    category: uuidOrNull(one(sp.category)) ?? undefined, from: isIsoDate(one(sp.from)) ? one(sp.from) : undefined, to: isIsoDate(one(sp.to)) ? one(sp.to) : undefined,
  };
  if (staff) {
    filters.team = uuidOrNull(one(sp.team)) ?? undefined;
    filters.assignee = one(sp.assignee) === 'none' || one(sp.assignee) === 'me' ? one(sp.assignee) : (uuidOrNull(one(sp.assignee)) ?? undefined);
    filters.requester = uuidOrNull(one(sp.requester)) ?? undefined;
    filters.sla = SLA_FILTER.some(([k]) => k === one(sp.sla)) ? one(sp.sla) : undefined;
    filters.sort = ['priority', 'activity'].includes(one(sp.sort) ?? '') ? one(sp.sort) : undefined;
  }

  const [categories, teams, people] = await Promise.all([loadCategories(c.ctx, c.org), staff ? loadTeams(c.ctx, c.org) : Promise.resolve([]), staff ? loadPeople(c.ctx, c.org) : Promise.resolve([])]);
  const catOpts = categories.map((x) => ({ value: x.id, label: x.name }));
  const exportQuery = new URLSearchParams(Object.entries({ q: one(sp.q), view, status, priority: one(sp.priority), category: one(sp.category), team: one(sp.team), assignee: one(sp.assignee), requester: one(sp.requester), sla: one(sp.sla), from: one(sp.from), to: one(sp.to) }).filter(([, v]) => !!v) as Array<[string, string]>).toString();

  const columns = board ? await Promise.all(STATUSES.map(async (s) => ({ s, q: await loadQueue(c.ctx, c.org, { ...filters, status: [s] }, 1, 15) }))) : null;
  const list = board ? null : await loadQueue(c.ctx, c.org, filters, page, PAGE_SIZE);
  const when = (iso: string) => formatInstant(Date.parse(iso), c.tz);
  const rows: QueueRow[] = list?.rows ?? [];

  return (
    <>
      <PageHeader title={staff ? 'Chamados' : 'Meus chamados'} description={staff ? 'A fila mostra só o que você tem acesso. Filtros e paginação são aplicados no servidor.' : 'Todos os chamados que você abriu.'}>
        <div className="flex flex-wrap gap-2">
          {staff ? <Link href={withParams('/chamados', sp, { layout: board ? null : 'board', page: null })} className="inline-flex min-h-10 items-center rounded-md border border-border px-4 text-sm font-medium hover:bg-black/5 dark:hover:bg-white/5">{board ? 'Ver em tabela' : 'Ver em quadro'}</Link> : null}
          {staff ? <a href={`/api/exportar/chamados${exportQuery ? `?${exportQuery}` : ''}`} className="inline-flex min-h-10 items-center rounded-md border border-border px-4 text-sm font-medium hover:bg-black/5 dark:hover:bg-white/5">Exportar CSV</a> : null}
          <Link href="/chamados/novo" className="inline-flex min-h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">Novo chamado</Link>
        </div>
      </PageHeader>

      {staff ? <Tabs current={view} items={VIEWS.map((v) => ({ key: v.key, label: v.label, href: withParams('/chamados', sp, { view: v.key || null, page: null }) }))} /> : null}

      <FilterForm clear="/chamados">
        {view ? <input type="hidden" name="view" value={view} /> : null}
        {board ? <input type="hidden" name="layout" value="board" /> : null}
        <FInput name="q" label="Número ou assunto" sp={sp} placeholder="#123 ou palavra" />
        {!board ? <FSelect name="status" label="Status" sp={sp} opts={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))} /> : null}
        <FSelect name="priority" label="Prioridade" sp={sp} opts={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))} />
        <FSelect name="category" label="Categoria" sp={sp} opts={catOpts} />
        {staff ? <FSelect name="team" label="Equipe" sp={sp} opts={teams.map((t) => ({ value: t.id, label: t.name }))} /> : null}
        {staff ? <FSelect name="assignee" label="Responsável" sp={sp} opts={[{ value: 'me', label: 'Eu' }, { value: 'none', label: 'Sem responsável' }, ...people.filter((p) => p.profile && p.profile !== 'requester').map((p) => ({ value: p.user_id, label: p.name }))]} /> : null}
        {staff ? <FSelect name="requester" label="Solicitante" sp={sp} opts={people.filter((p) => p.profile === 'requester').map((p) => ({ value: p.user_id, label: p.name }))} /> : null}
        {staff ? <FSelect name="sla" label="Situação do SLA" sp={sp} opts={SLA_FILTER.map(([value, label]) => ({ value, label }))} /> : null}
        <FInput name="from" label="Criado de" type="date" sp={sp} />
        <FInput name="to" label="Criado até" type="date" sp={sp} />
      </FilterForm>

      {board && columns ? (
        <div>
          <p className="mb-3 text-sm text-muted">Quadro por status. Para mudar o estado, abra o chamado: pedir informação e resolver exigem uma mensagem ao solicitante (nada depende de arrastar cartões).</p>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            {columns.map(({ s, q }) => (
              <section key={s} aria-label={STATUS_LABEL[s]} className="rounded-lg border border-border bg-card p-2">
                <h2 className="mb-2 flex items-center justify-between px-1 text-sm font-semibold">{STATUS_LABEL[s]} <span className="rounded-full bg-black/5 px-2 text-xs tabular-nums dark:bg-white/10">{q.total}</span></h2>
                <ul className="space-y-2">
                  {q.rows.length === 0 ? <li className="px-1 py-3 text-xs text-muted">Nenhum chamado.</li> : null}
                  {q.rows.map((r) => (
                    <li key={r.id}>
                      <Card className="p-3">
                        <Link href={`/chamados/${r.id}`} className="text-sm font-medium underline-offset-2 hover:underline"><span className="tabular-nums text-muted">#{r.number}</span> {r.subject}</Link>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5"><PriorityBadge priority={r.priority} />{r.sla && (s === 'open' || s === 'in_progress' || s === 'waiting_requester') ? <SlaCell sla={r.sla} /> : null}</div>
                        <p className="mt-1 text-xs text-muted">{r.assignee ?? 'Sem responsável'}</p>
                      </Card>
                    </li>
                  ))}
                </ul>
                {q.total > q.rows.length ? <p className="mt-2 px-1 text-xs"><Link className="underline underline-offset-2" href={withParams('/chamados', sp, { layout: null, status: s, page: null })}>Ver todos os {q.total} em tabela</Link></p> : null}
              </section>
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* Celular: cartões. Tela média ou maior: tabela. */}
          <ul className="space-y-3 md:hidden" aria-label="Chamados">
            {rows.length === 0 ? <li className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted">Nenhum chamado encontrado.</li> : null}
            {rows.map((r) => (
              <li key={r.id}>
                <Card className="p-3">
                  <Link href={`/chamados/${r.id}`} className="font-medium underline-offset-2 hover:underline"><span className="tabular-nums text-muted">#{r.number}</span> {r.subject}</Link>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5"><StatusBadge status={r.status} /><PriorityBadge priority={r.priority} /></div>
                  {staff ? <div className="mt-2"><SlaCell sla={r.sla} /></div> : null}
                  <p className="mt-2 text-xs text-muted">{staff ? `${r.requester ?? '—'} · ${r.assignee ?? 'Sem responsável'} · ` : ''}Atualizado em {when(r.last_public_activity_at)}</p>
                </Card>
              </li>
            ))}
          </ul>
          <div className="hidden md:block">
            <TableShell caption="Chamados" empty={rows.length === 0} emptyText="Nenhum chamado encontrado.">
              <thead>
                <tr>
                  <th className={TH}>Chamado</th>{staff ? <th className={TH}>Solicitante</th> : null}<th className={TH}>Categoria</th>{staff ? <th className={TH}>Equipe</th> : null}{staff ? <th className={TH}>Responsável</th> : null}
                  <th className={TH}>Prioridade</th><th className={TH}>Status</th>{staff ? <th className={TH}>SLA</th> : null}<th className={TH}>Atividade</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className={TD}><Link className="font-medium underline-offset-2 hover:underline" href={`/chamados/${r.id}`}><span className="tabular-nums text-muted">#{r.number}</span> {r.subject}</Link></td>
                    {staff ? <td className={TD}>{r.requester ?? '—'}</td> : null}
                    <td className={TD}>{r.category ?? '—'}</td>
                    {staff ? <td className={TD}>{r.team ?? '—'}</td> : null}
                    {staff ? <td className={TD}>{r.assignee ?? <span className="text-muted">Sem responsável</span>}</td> : null}
                    <td className={TD}><PriorityBadge priority={r.priority} /></td><td className={TD}><StatusBadge status={r.status} /></td>
                    {staff ? <td className={TD}><SlaCell sla={r.sla} /></td> : null}
                    <td className={`${TD} whitespace-nowrap tabular-nums`}>{when(r.last_public_activity_at)}</td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </div>
          <Pagination base="/chamados" sp={sp} page={page} total={list?.total ?? 0} />
        </>
      )}
    </>
  );
}
