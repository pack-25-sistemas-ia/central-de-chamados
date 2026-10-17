import type { Metadata } from 'next';
import { AreaF, FileF, SelectF, TextF, TkForm } from '@/components/tk/fields';
import { Card, PageHeader } from '@/components/ui/primitives';
import { loadCategories, loadPeople, loadTeams } from '@/lib/tickets/data';
import { openTicket } from '@/lib/tickets/actions/tickets';
import { pageCtx } from '@/lib/tickets/page';
import { PRIORITIES, PRIORITY_LABEL } from '@/lib/tickets/status';

export const metadata: Metadata = { title: 'Novo chamado' };

export default async function NewTicketPage() {
  const c = await pageCtx(['owner', 'manager', 'agent', 'requester']);
  const categories = (await loadCategories(c.ctx, c.org)).filter((x) => x.active);
  const [teams, people] = c.isStaff ? await Promise.all([loadTeams(c.ctx, c.org), loadPeople(c.ctx, c.org)]) : [[], []];
  const requesters = people.filter((p) => p.profile === 'requester');
  const assignable = people.filter((p) => p.profile && p.profile !== 'requester' && p.active);
  const mb = Math.floor(c.settings.attachment_max_size_bytes / 1024 / 1024 * 10) / 10;

  return (
    <>
      <PageHeader title="Novo chamado" description={c.isStaff ? 'Abertura pela equipe, em nome de um solicitante cadastrado. A descrição vira a primeira mensagem pública e NÃO conta como resposta ao solicitante.' : 'Conte o que precisa. A equipe responderá por aqui e você acompanha o andamento.'} />
      <Card className="max-w-3xl">
        <TkForm action={openTicket} submit="Abrir chamado" pending="Abrindo…" reset={false}>
          <>
            {c.isStaff ? <SelectF name="requester" label="Solicitante" opts={requesters.map((p) => ({ value: p.user_id, label: p.email ? `${p.name} (${p.email})` : p.name }))} placeholder="Selecione…" required span hint={requesters.length === 0 ? 'Nenhum solicitante cadastrado: associe a pessoa à empresa como «Leitor» em Pessoas e acessos.' : undefined} /> : null}
            <TextF name="subject" label="Assunto" required max={160} span />
            <SelectF name="category" label="Categoria" opts={categories.map((x) => ({ value: x.id, label: x.name }))} placeholder="— sem categoria —" span />
            {c.isStaff ? <SelectF name="priority" label="Prioridade" def="normal" opts={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))} /> : null}
            {c.isStaff ? <SelectF name="team" label="Equipe" opts={teams.filter((t) => t.active).map((t) => ({ value: t.id, label: t.name }))} placeholder="Pela categoria" hint="Se vazio, usa a equipe padrão da categoria." /> : null}
            {c.isStaff ? <SelectF name="assignee" label="Responsável" opts={assignable.map((p) => ({ value: p.user_id, label: p.name }))} placeholder="— sem responsável —" hint={c.profile === 'agent' ? 'Atendentes só podem atribuir a si mesmos.' : 'Precisa pertencer à equipe do chamado.'} /> : null}
            <AreaF name="description" label="Descrição" max={10000} hint="Quanto mais detalhes (o que aconteceu, quando, o que você já tentou), mais rápido o atendimento." />
            <FileF hint={`Até 3 arquivos de até ${mb} MB: imagem (PNG, JPG, WebP, GIF), PDF ou texto. O sistema não faz verificação antivírus: não envie arquivos de origem duvidosa.`} />
          </>
        </TkForm>
      </Card>
    </>
  );
}
