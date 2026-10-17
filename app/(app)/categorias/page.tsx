import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckF, SelectF, TextF, TkForm } from '@/components/tk/fields';
import { Disclosure, TD, TH, TableShell } from '@/components/tk/bits';
import { Badge, PageHeader } from '@/components/ui/primitives';
import { saveCategory } from '@/lib/tickets/actions/registry';
import { loadCategories, loadTeams } from '@/lib/tickets/data';
import { pageCtx } from '@/lib/tickets/page';
import { one, uuidOrNull, type SearchParams } from '@/lib/tickets/query';

export const metadata: Metadata = { title: 'Categorias' };

export default async function CategoriesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const c = await pageCtx(['owner', 'manager']);
  const sp = await searchParams;
  const [categories, teams] = await Promise.all([loadCategories(c.ctx, c.org), loadTeams(c.ctx, c.org)]);
  const editing = categories.find((x) => x.id === uuidOrNull(one(sp.editar)));
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  return (
    <>
      <PageHeader title="Categorias" description="Classificam os chamados. A equipe padrão recebe automaticamente os chamados da categoria (o solicitante não escolhe equipe)." />
      <div className="mb-6">
        <Disclosure summary={editing ? `Editar categoria — ${editing.name}` : 'Nova categoria'} tone="primary" open={!!editing}>
          <TkForm action={saveCategory} submit={editing ? 'Salvar categoria' : 'Criar categoria'} reset={!editing}>
            <>
              {editing ? <input type="hidden" name="id" value={editing.id} /> : null}
              <TextF name="name" label="Nome" def={editing?.name} required max={60} span />
              <SelectF name="team" label="Equipe padrão" def={editing?.default_team_id ?? ''} placeholder="— nenhuma —" opts={teams.filter((t) => t.active).map((t) => ({ value: t.id, label: t.name }))} />
              {editing ? <CheckF name="active" label="Ativa (aparece para novos chamados)" def={editing.active} /> : null}
            </>
          </TkForm>
        </Disclosure>
      </div>
      <TableShell caption="Categorias" empty={categories.length === 0} emptyText="Nenhuma categoria ainda.">
        <thead><tr><th className={TH}>Nome</th><th className={TH}>Equipe padrão</th><th className={TH}>Situação</th><th className={TH}><span className="sr-only">Ações</span></th></tr></thead>
        <tbody>
          {categories.map((x) => (
            <tr key={x.id} className="border-t border-border">
              <td className={TD}>{x.name}</td><td className={TD}>{x.default_team_id ? teamName.get(x.default_team_id) ?? '—' : <span className="text-muted">Nenhuma</span>}</td>
              <td className={TD}><Badge tone={x.active ? 'success' : 'neutral'}>{x.active ? 'Ativa' : 'Inativa'}</Badge></td>
              <td className={TD}><Link className="underline underline-offset-2" href={`/categorias?editar=${x.id}`}>Editar</Link></td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </>
  );
}
