import type { Metadata } from 'next';
import Link from 'next/link';
import { FilterForm, FInput, FSelect, Kpi, Section, TD, TH, TableShell } from '@/components/tk/bits';
import { StatusBadge, PriorityBadge, SlaCell } from '@/components/tk/ticket-bits';
import { Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { formatMinutes } from '@/lib/sla/state';
import { addDays, formatDateBR, instantToLocal } from '@/lib/sla/time';
import { loadDashboard, loadQueue, loadTeams, type Compliance } from '@/lib/tickets/data';
import { pageCtx } from '@/lib/tickets/page';
import { isIsoDate, one, uuidOrNull, type SearchParams } from '@/lib/tickets/query';
import { PRIORITY_LABEL, STATUS_LABEL, type Priority } from '@/lib/tickets/status';

export const metadata: Metadata = { title: 'Painel de chamados' };

const pct = (n: number | null) => (n === null ? 'Sem dados' : `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);

function ComplianceCards({ title, c, target }: { title: string; c: Compliance; target: string }) {
  return (
    <>
      <Kpi label={`Cumprimento — ${title}`} value={pct(c.rate)} tone={c.rate === null ? 'neutral' : c.rate >= 90 ? 'success' : c.rate >= 70 ? 'warning' : 'danger'}
        definition={`${c.within_target} de ${c.cycles} ciclo(s) com ${target} no período, dentro da meta (em minutos úteis).`} />
      <Kpi label={`Tempo útil médio — ${title}`} value={formatMinutes(c.avg_minutes)} definition={`Mediana: ${formatMinutes(c.median_minutes)}. Só minutos de expediente, sem as pausas.`} />
    </>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const c = await pageCtx();
  if (!c.profile) {
    return <EmptyState title="Seu usuário ainda não tem acesso aos chamados" description="Peça ao proprietário da empresa para ajustar seu papel em Pessoas e acessos."><Link className="text-sm underline underline-offset-2" href="/members">Ver pessoas e acessos</Link></EmptyState>;
  }
  if (c.isRequester) {
    const q = await loadQueue(c.ctx, c.org, {}, 1, 5);
    const open = await loadQueue(c.ctx, c.org, { status: ['open', 'in_progress', 'waiting_requester'] }, 1, 1);
    return (
      <>
        <PageHeader title="Meus chamados" description="Acompanhe suas solicitações e converse com a equipe de atendimento.">
          <Link href="/chamados/novo" className="inline-flex min-h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">Novo chamado</Link>
        </PageHeader>
        <div className="mb-6 grid gap-3 sm:grid-cols-2">
          <Kpi label="Chamados em andamento" value={open.total} definition="Abertos, em atendimento ou aguardando a sua resposta." />
          <Kpi label="Total de chamados" value={q.total} definition="Todos os chamados que você abriu." />
        </div>
        <Section title="Mais recentes" actions={<Link className="text-sm underline underline-offset-2" href="/chamados">Ver todos</Link>}>
          <TableShell caption="Chamados recentes" empty={q.rows.length === 0} emptyText="Você ainda não abriu nenhum chamado.">
            <thead><tr><th className={TH}>Chamado</th><th className={TH}>Status</th><th className={TH}>Atualizado</th></tr></thead>
            <tbody>
              {q.rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className={TD}><Link className="font-medium underline underline-offset-2" href={`/chamados/${r.id}`}><span className="tabular-nums text-muted">#{r.number}</span> {r.subject}</Link></td>
                  <td className={TD}><StatusBadge status={r.status} /></td>
                  <td className={TD}>{formatDateBR(instantToLocal(Date.parse(r.last_public_activity_at), c.tz).date)}</td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </Section>
      </>
    );
  }

  const sp = await searchParams;
  const to = isIsoDate(one(sp.to)) ? one(sp.to)! : c.today;
  const from = isIsoDate(one(sp.from)) && one(sp.from)! <= to && one(sp.from)! >= addDays(to, -400) ? one(sp.from)! : addDays(to, -29);
  const team = c.isManager ? uuidOrNull(one(sp.team)) : null;
  const [d, teams, queue] = await Promise.all([loadDashboard(c.ctx, c.org, from, to, team), c.isManager ? loadTeams(c.ctx, c.org) : Promise.resolve([]), loadQueue(c.ctx, c.org, { view: 'overdue' }, 1, 8)]);

  return (
    <>
      <PageHeader title="Painel de chamados" description={`Período: ${formatDateBR(from)} a ${formatDateBR(to)} · fuso ${c.tz}. Criados contam pela data de abertura; resolvidos e respostas contam pela data do marco; tempos em minutos úteis.`}>
        <Link href="/chamados/novo" className="inline-flex min-h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">Novo chamado</Link>
      </PageHeader>
      <FilterForm clear="/dashboard">
        <FInput name="from" label="De" type="date" sp={{ ...sp, from }} />
        <FInput name="to" label="Até" type="date" sp={{ ...sp, to }} />
        {c.isManager ? <FSelect name="team" label="Equipe" sp={sp} opts={teams.map((t) => ({ value: t.id, label: t.name }))} /> : null}
      </FilterForm>
      {!d ? <EmptyState title="Não foi possível carregar os indicadores" description="Tente novamente em instantes." /> : (
        <>
          <Section title="Situação atual" description="Backlog = abertos + em atendimento + aguardando solicitante (agora, independentemente do período).">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Kpi label="Backlog atual" value={d.backlog.total} />
              <Kpi label="Não atribuídos" value={d.backlog.unassigned} tone={d.backlog.unassigned > 0 ? 'warning' : 'neutral'} definition="Sem responsável, entre os do backlog." />
              <Kpi label="Em atendimento" value={d.backlog.in_progress} />
              <Kpi label="Aguardando solicitante" value={d.backlog.waiting_requester} definition="Com o SLA pausado." />
            </div>
          </Section>
          <Section title="No período" description="Por chamado: criados. Por ciclo: resolvidos, reabertos e cumprimento de SLA (um chamado reaberto tem mais de um ciclo).">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Kpi label="Chamados criados" value={d.created_tickets} definition="Por chamado, pela data de abertura." />
              <Kpi label="Ciclos resolvidos" value={d.resolved_cycles} definition="Por ciclo, pela data da resolução." />
              <Kpi label="Reaberturas" value={d.reopened_cycles} definition={`Novos ciclos iniciados no período (${d.reopened_tickets} chamado(s) distintos).`} />
              <Kpi label="Atrasados em aberto agora" value={d.overdue_open.first_response + d.overdue_open.resolution} tone={d.overdue_open.first_response + d.overdue_open.resolution > 0 ? 'danger' : 'neutral'}
                definition={`${d.overdue_open.first_response} sem primeira resposta no prazo · ${d.overdue_open.resolution} sem resolução no prazo (ciclos ainda abertos).`} />
              <ComplianceCards title="primeira resposta" c={d.first_response} target="primeira resposta" />
              <ComplianceCards title="resolução" c={d.resolution} target="resolução" />
            </div>
          </Section>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Por categoria" description="Chamados criados no período.">
              {d.by_category.length === 0 ? <p className="text-sm text-muted">Sem dados</p> : <ul className="space-y-1 text-sm">{d.by_category.map((x) => <li key={x.name} className="flex justify-between gap-2"><span>{x.name}</span><span className="tabular-nums">{x.count}</span></li>)}</ul>}
            </Card>
            <Card title="Por prioridade" description="Chamados criados no período.">
              {Object.keys(d.by_priority).length === 0 ? <p className="text-sm text-muted">Sem dados</p> : <ul className="space-y-1 text-sm">{(['urgent', 'high', 'normal', 'low'] as Priority[]).filter((p) => d.by_priority[p]).map((p) => <li key={p} className="flex justify-between gap-2"><span>{PRIORITY_LABEL[p]}</span><span className="tabular-nums">{d.by_priority[p]}</span></li>)}</ul>}
            </Card>
            <Card title="Carga atual por atendente" description="Chamados abertos atribuídos, em ordem alfabética. Mostra distribuição de trabalho, não avaliação de qualidade.">
              {d.workload.length === 0 ? <p className="text-sm text-muted">Nenhum chamado atribuído.</p> : <ul className="space-y-1 text-sm">{d.workload.map((x) => <li key={x.user_id} className="flex justify-between gap-2"><span>{x.name}</span><span className="tabular-nums">{x.open}</span></li>)}</ul>}
            </Card>
          </div>
          <Section title="SLA atrasado" description="Chamados abertos com alguma meta já vencida (calculado agora, em minutos úteis).">
            <TableShell caption="Chamados com SLA atrasado" empty={queue.rows.length === 0} emptyText="Nenhum chamado atrasado. 🎉">
              <thead><tr><th className={TH}>Chamado</th><th className={TH}>Prioridade</th><th className={TH}>Status</th><th className={TH}>SLA</th></tr></thead>
              <tbody>
                {queue.rows.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className={TD}><Link className="font-medium underline underline-offset-2" href={`/chamados/${r.id}`}><span className="tabular-nums text-muted">#{r.number}</span> {r.subject}</Link></td>
                    <td className={TD}><PriorityBadge priority={r.priority} /></td><td className={TD}>{STATUS_LABEL[r.status]}</td><td className={TD}><SlaCell sla={r.sla} /></td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
            {queue.total > queue.rows.length ? <p className="mt-2 text-sm"><Link className="underline underline-offset-2" href="/chamados?view=overdue">Ver todos os {queue.total}</Link></p> : null}
          </Section>
        </>
      )}
    </>
  );
}
