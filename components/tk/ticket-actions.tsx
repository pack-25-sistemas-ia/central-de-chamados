'use client';

import { assignTicket, claimTicket, confirmTicket, moveTeam, reopenTicket, setCategory, setPriority, setStatus } from '@/lib/tickets/actions/tickets';
import { PRIORITIES, PRIORITY_LABEL } from '@/lib/tickets/status';
import { ActionButton, AreaF, SelectF, TkForm } from './fields';

type Opt = { value: string; label: string };
const COMPACT = 'grid gap-2';

export const ClaimButton = ({ ticket }: { ticket: string }) => <ActionButton action={claimTicket} fields={{ ticket }} label="Assumir chamado" variant="primary" pending="Assumindo…" />;

export const ConfirmButton = ({ ticket, expected }: { ticket: string; expected: number }) => (
  <ActionButton action={confirmTicket} fields={{ ticket, expected: String(expected) }} label="Confirmar que foi resolvido" variant="primary" pending="Confirmando…" />
);

export const ResumeButton = ({ ticket, expected }: { ticket: string; expected: number }) => (
  <ActionButton action={setStatus} fields={{ ticket, expected: String(expected), status: 'in_progress' }} label="Retomar atendimento" pending="Retomando…" />
);

export const CloseButton = ({ ticket, expected }: { ticket: string; expected: number }) => (
  <ActionButton action={setStatus} fields={{ ticket, expected: String(expected), status: 'closed' }} label="Encerrar chamado" confirm="Encerrar este chamado resolvido?" pending="Encerrando…" />
);

export const ReleaseButton = ({ ticket, expected }: { ticket: string; expected: number }) => (
  <ActionButton action={assignTicket} fields={{ ticket, expected: String(expected), user: '' }} label="Devolver à fila" confirm="Devolver este chamado à fila (sem responsável)?" pending="Devolvendo…" />
);

export function AssignForm({ ticket, expected, people, current }: { ticket: string; expected: number; people: Opt[]; current: string | null }) {
  return (
    <TkForm action={assignTicket} submit="Atribuir" pending="Atribuindo…" reset={false} className={COMPACT}>
      <>
        <input type="hidden" name="ticket" value={ticket} /><input type="hidden" name="expected" value={expected} />
        <SelectF name="user" label="Atribuir a" def={current ?? ''} placeholder="— sem responsável —" opts={people} />
      </>
    </TkForm>
  );
}

export function TeamForm({ ticket, expected, teams, current }: { ticket: string; expected: number; teams: Opt[]; current: string | null }) {
  return (
    <TkForm action={moveTeam} submit="Mover" pending="Movendo…" reset={false} className={COMPACT}>
      <>
        <input type="hidden" name="ticket" value={ticket} /><input type="hidden" name="expected" value={expected} />
        <SelectF name="team" label="Mover para equipe" def={current ?? ''} placeholder="Selecione…" opts={teams} required />
      </>
    </TkForm>
  );
}

export function PriorityForm({ ticket, expected, current }: { ticket: string; expected: number; current: string }) {
  return (
    <TkForm action={setPriority} submit="Alterar" pending="Salvando…" reset={false} className={COMPACT}>
      <>
        <input type="hidden" name="ticket" value={ticket} /><input type="hidden" name="expected" value={expected} />
        <SelectF name="priority" label="Prioridade" def={current} opts={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))} />
      </>
    </TkForm>
  );
}

export function CategoryForm({ ticket, expected, categories, current }: { ticket: string; expected: number; categories: Opt[]; current: string | null }) {
  return (
    <TkForm action={setCategory} submit="Alterar" pending="Salvando…" reset={false} className={COMPACT}>
      <>
        <input type="hidden" name="ticket" value={ticket} /><input type="hidden" name="expected" value={expected} />
        <SelectF name="category" label="Categoria" def={current ?? ''} placeholder="— sem categoria —" opts={categories} />
      </>
    </TkForm>
  );
}

export function ReopenForm({ ticket, expected, requester }: { ticket: string; expected: number; requester: boolean }) {
  return (
    <TkForm action={reopenTicket} submit="Reabrir chamado" pending="Reabrindo…" reset className={COMPACT}>
      <>
        <input type="hidden" name="ticket" value={ticket} /><input type="hidden" name="expected" value={expected} />
        <AreaF name="reason" label="Motivo da reabertura" hint={requester ? 'Conte o que ainda não foi resolvido. Um novo ciclo de atendimento será iniciado.' : 'O motivo fica como nota interna. Um novo ciclo de atendimento e de SLA será iniciado.'} max={1000} />
      </>
    </TkForm>
  );
}
