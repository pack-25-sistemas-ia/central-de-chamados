import type { Metadata } from 'next';
import Link from 'next/link';
import { AreaF, CheckF, TextF, TkForm } from '@/components/tk/fields';
import { Disclosure, TD, TH, TableShell } from '@/components/tk/bits';
import { Badge, PageHeader } from '@/components/ui/primitives';
import { saveCanned } from '@/lib/tickets/actions/registry';
import { loadCanned } from '@/lib/tickets/data';
import { pageCtx } from '@/lib/tickets/page';
import { one, uuidOrNull, type SearchParams } from '@/lib/tickets/query';

export const metadata: Metadata = { title: 'Respostas prontas' };

export default async function CannedPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const c = await pageCtx(['owner', 'manager']);
  const sp = await searchParams;
  const items = await loadCanned(c.ctx, c.org);
  const editing = items.find((x) => x.id === uuidOrNull(one(sp.editar)));
  return (
    <>
      <PageHeader title="Respostas prontas" description="Modelos de texto para a equipe. Ao escolher um modelo no compositor, o texto só é inserido: o atendente revisa antes de enviar (nada é enviado automaticamente). Não coloque dados de clientes nem notas internas nos modelos." />
      <div className="mb-6">
        <Disclosure summary={editing ? `Editar — ${editing.title}` : 'Nova resposta pronta'} tone="primary" open={!!editing}>
          <TkForm action={saveCanned} submit={editing ? 'Salvar resposta' : 'Criar resposta'} reset={!editing}>
            <>
              {editing ? <input type="hidden" name="id" value={editing.id} /> : null}
              <TextF name="title" label="Título" def={editing?.title} required max={80} span />
              <AreaF name="body" label="Texto" def={editing?.body} max={5000} />
              {editing ? <CheckF name="active" label="Ativa (aparece no compositor)" def={editing.active} /> : null}
            </>
          </TkForm>
        </Disclosure>
      </div>
      <TableShell caption="Respostas prontas" empty={items.length === 0} emptyText="Nenhuma resposta pronta ainda.">
        <thead><tr><th className={TH}>Título</th><th className={TH}>Texto</th><th className={TH}>Situação</th><th className={TH}><span className="sr-only">Ações</span></th></tr></thead>
        <tbody>
          {items.map((x) => (
            <tr key={x.id} className="border-t border-border">
              <td className={TD}>{x.title}</td><td className={`${TD} max-w-md`}><span className="line-clamp-2 whitespace-pre-wrap">{x.body}</span></td>
              <td className={TD}><Badge tone={x.active ? 'success' : 'neutral'}>{x.active ? 'Ativa' : 'Inativa'}</Badge></td>
              <td className={TD}><Link className="underline underline-offset-2" href={`/respostas-prontas?editar=${x.id}`}>Editar</Link></td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </>
  );
}
