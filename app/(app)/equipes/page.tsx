import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionButton, CheckF, SelectF, TextF, TkForm } from '@/components/tk/fields';
import { Disclosure, Section, TD, TH, TableShell } from '@/components/tk/bits';
import { Badge, Card, PageHeader } from '@/components/ui/primitives';
import { saveTeam, saveTeamMembers, setAgentActive } from '@/lib/tickets/actions/registry';
import { loadPeople, loadTeamMembers, loadTeams } from '@/lib/tickets/data';
import { pageCtx } from '@/lib/tickets/page';
import { one, uuidOrNull, type SearchParams } from '@/lib/tickets/query';
import { PROFILE_LABEL } from '@/lib/tickets/status';

export const metadata: Metadata = { title: 'Equipes' };

export default async function TeamsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const c = await pageCtx(['owner', 'manager']);
  const sp = await searchParams;
  const [teams, members, people] = await Promise.all([loadTeams(c.ctx, c.org), loadTeamMembers(c.ctx, c.org), loadPeople(c.ctx, c.org)]);
  const staff = people.filter((p) => p.profile !== 'requester' && ['owner', 'admin', 'manager', 'member'].includes(p.role));
  const byId = new Map(people.map((p) => [p.user_id, p]));
  const editId = uuidOrNull(one(sp.editar));
  const editing = teams.find((t) => t.id === editId);

  return (
    <>
      <PageHeader title="Equipes" description="Atendentes pertencem a equipes. Cada atendente vê os chamados atribuídos a ele e os das suas equipes; o responsável de um chamado precisa pertencer à equipe dele." />
      <div className="mb-6">
        <Disclosure summary={editing ? `Editar equipe — ${editing.name}` : 'Nova equipe'} tone="primary" open={!!editing}>
          <TkForm action={saveTeam} submit={editing ? 'Salvar equipe' : 'Criar equipe'} reset={!editing}>
            <>
              {editing ? <input type="hidden" name="id" value={editing.id} /> : null}
              <TextF name="name" label="Nome da equipe" def={editing?.name} required max={60} span />
              {editing ? <CheckF name="active" label="Ativa" def={editing.active} /> : null}
            </>
          </TkForm>
        </Disclosure>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {teams.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted lg:col-span-2">Nenhuma equipe ainda. Crie a primeira acima.</p> : null}
        {teams.map((t) => {
          const ids = new Set(members.get(t.id) ?? []);
          return (
            <Card key={t.id} title={t.name} description={t.active ? `${ids.size} membro(s)` : 'Equipe inativa'}>
              <TkForm action={saveTeamMembers} submit="Salvar membros" pending="Salvando…" reset={false} className="grid gap-2">
                <>
                  <input type="hidden" name="team" value={t.id} />
                  <fieldset>
                    <legend className="mb-1 text-sm font-medium">Membros</legend>
                    <div className="grid gap-1">
                      {staff.filter((p) => p.active).map((p) => (
                        <label key={p.user_id} className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" name="user" value={p.user_id} defaultChecked={ids.has(p.user_id)} className="size-4" /> {p.name} <span className="text-xs text-muted">({p.profile ? PROFILE_LABEL[p.profile] : p.role})</span></label>
                      ))}
                    </div>
                  </fieldset>
                </>
              </TkForm>
              <p className="mt-3 text-sm"><Link className="underline underline-offset-2" href={`/equipes?editar=${t.id}`}>Renomear ou {t.active ? 'desativar' : 'reativar'}</Link></p>
            </Card>
          );
        })}
      </div>

      <Section title="Atendentes" description="Desativar preserva a autoria histórica. Você decide o que acontece com os chamados abertos do atendente: devolver à fila ou reatribuir.">
        <TableShell caption="Atendentes" empty={staff.length === 0} emptyText="Nenhum atendente. Associe pessoas à empresa em Pessoas e acessos.">
          <thead><tr><th className={TH}>Pessoa</th><th className={TH}>Perfil</th><th className={TH}>Equipes</th><th className={TH}>Situação</th><th className={TH}>Ação</th></tr></thead>
          <tbody>
            {staff.map((p) => (
              <tr key={p.user_id} className="border-t border-border">
                <td className={TD}>{p.name}{p.email && p.email !== p.name ? <div className="text-xs text-muted">{p.email}</div> : null}</td>
                <td className={TD}>{p.profile ? PROFILE_LABEL[p.profile] : '—'}</td>
                <td className={TD}>{p.teams.map((id) => teams.find((t) => t.id === id)?.name).filter(Boolean).join(', ') || <span className="text-muted">Nenhuma</span>}</td>
                <td className={TD}><Badge tone={p.active ? 'success' : 'neutral'}>{p.active ? 'Ativo' : 'Desativado'}</Badge></td>
                <td className={TD}>
                  {p.user_id === c.userId || p.role === 'owner' || p.role === 'admin' ? <span className="text-xs text-muted">—</span> : p.active ? (
                    <details className="max-w-xs">
                      <summary className="cursor-pointer text-sm underline underline-offset-2">Desativar…</summary>
                      <TkForm action={setAgentActive} submit="Desativar atendente" pending="Desativando…" reset={false} variant="danger" className="mt-2 grid gap-2">
                        <>
                          <input type="hidden" name="user" value={p.user_id} /><input type="hidden" name="active" value="off" />
                          <SelectF name="mode" label="Chamados abertos dele" def="unassign" opts={[{ value: 'unassign', label: 'Devolver à fila (sem responsável)' }, { value: 'reassign', label: 'Reatribuir a…' }]} />
                          <SelectF name="to" label="Reatribuir a" placeholder="— escolha —" opts={staff.filter((x) => x.active && x.user_id !== p.user_id).map((x) => ({ value: x.user_id, label: x.name }))} hint="Só para «Reatribuir»: a pessoa precisa pertencer à equipe de cada chamado." />
                        </>
                      </TkForm>
                    </details>
                  ) : <ActionButton action={setAgentActive} fields={{ user: p.user_id, active: 'on' }} label="Reativar" pending="Reativando…" />}
                </td>
              </tr>
            ))}
          </tbody>
        </TableShell>
        <p className="mt-2 text-xs text-muted">Pessoas novas entram pela tela «Pessoas e acessos»: papel <strong>Membro</strong> = atendente, <strong>Gerente</strong> = gestor, <strong>Leitor</strong> = solicitante. {byId.size} pessoa(s) na empresa.</p>
      </Section>
    </>
  );
}
