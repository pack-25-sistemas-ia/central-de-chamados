import type { Metadata } from 'next';
import Link from 'next/link';
import { FilterForm, FInput, FSelect, Section } from '@/components/tk/bits';
import { Card, PageHeader } from '@/components/ui/primitives';
import { addDays } from '@/lib/sla/time';
import { loadCategories, loadTeams } from '@/lib/tickets/data';
import { pageCtx } from '@/lib/tickets/page';
import { PRIORITIES, PRIORITY_LABEL, STATUSES, STATUS_LABEL } from '@/lib/tickets/status';
import type { SearchParams } from '@/lib/tickets/query';

export const metadata: Metadata = { title: 'Relatórios' };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const c = await pageCtx(['owner', 'manager']);
  const sp = await searchParams;
  const [teams, categories] = await Promise.all([loadTeams(c.ctx, c.org), loadCategories(c.ctx, c.org)]);
  const from = addDays(c.today, -29);

  return (
    <>
      <PageHeader title="Relatórios" description={`Base temporal: fuso ${c.tz}. Os indicadores completos estão em «Visão geral»; aqui você exporta os chamados e confere as definições usadas.`}>
        <Link href={`/dashboard?from=${from}&to=${c.today}`} className="inline-flex min-h-10 items-center rounded-md border border-border px-4 text-sm font-medium hover:bg-black/5 dark:hover:bg-white/5">Ver indicadores dos últimos 30 dias</Link>
      </PageHeader>

      <Section title="Exportar chamados (CSV)" description="Os mesmos filtros e o mesmo escopo da fila. O arquivo usa «;» e UTF-8 com BOM (abre direto no Excel); textos que começam com = + - @ são neutralizados contra injeção de fórmulas. Não inclui o texto das mensagens nem e-mails. Cada exportação é registrada na auditoria.">
        <FilterForm action="/api/exportar/chamados" clear="/relatorios">
          <FInput name="from" label="Criado de" type="date" sp={{ from }} />
          <FInput name="to" label="Criado até" type="date" sp={{ to: c.today }} />
          <FSelect name="status" label="Status" sp={sp} opts={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))} />
          <FSelect name="priority" label="Prioridade" sp={sp} opts={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))} />
          <FSelect name="team" label="Equipe" sp={sp} opts={teams.map((t) => ({ value: t.id, label: t.name }))} />
          <FSelect name="category" label="Categoria" sp={sp} opts={categories.map((x) => ({ value: x.id, label: x.name }))} />
        </FilterForm>
      </Section>

      <Section title="Definições dos indicadores">
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Por chamado">
            <ul className="list-disc space-y-2 pl-5 text-sm">
              <li><strong>Criados no período</strong>: chamados cuja abertura cai no período (fuso da empresa).</li>
              <li><strong>Backlog atual</strong>: abertos + em atendimento + aguardando solicitante, agora.</li>
              <li><strong>Não atribuídos</strong>: itens do backlog sem responsável.</li>
              <li><strong>Distribuição por categoria e prioridade</strong>: sobre os criados no período.</li>
              <li><strong>Carga por atendente</strong>: chamados abertos atribuídos agora. É distribuição de trabalho, não avaliação de desempenho.</li>
            </ul>
          </Card>
          <Card title="Por ciclo de atendimento">
            <ul className="list-disc space-y-2 pl-5 text-sm">
              <li><strong>Cumprimento de primeira resposta</strong> = ciclos com primeira resposta no período e tempo útil consumido dentro da meta ÷ ciclos com primeira resposta no período.</li>
              <li><strong>Cumprimento de resolução</strong> = ciclos resolvidos no período dentro da meta ÷ ciclos resolvidos no período.</li>
              <li><strong>Reaberturas</strong>: novos ciclos (2º em diante) iniciados no período. Um chamado reaberto tem mais de um ciclo; os anteriores continuam contando nos seus períodos.</li>
              <li><strong>Atrasados em aberto</strong>: ciclos ainda em andamento com meta já vencida; ficam visíveis à parte para que atrasos não sumam por só contarmos ciclos concluídos.</li>
              <li>Sem ciclos no período o resultado é <strong>«Sem dados»</strong>, nunca 0%.</li>
            </ul>
          </Card>
          <Card title="Tempo útil">
            <p className="text-sm">Minutos dentro do expediente configurado (vários intervalos por dia, dias sem expediente), menos as pausas enquanto o chamado aguarda o solicitante. Cada ciclo usa o calendário e as metas fixados no seu início.</p>
          </Card>
          <Card title="Limiar «próximo do limite»">
            <p className="text-sm">80% da meta consumida (e ainda não vencida). Estados: dentro do prazo, próximo do limite, atrasado, pausado, cumprido e descumprido.</p>
          </Card>
        </div>
      </Section>
    </>
  );
}
