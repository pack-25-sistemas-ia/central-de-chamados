// Estados e ações: as mesmas regras do gatilho ticket_guard e das funções tk_* (a interface só reflete; o banco decide).
import { describe, expect, it } from 'vitest';
import { STATUSES, availableActions, canTransition, isOpenStatus, type Action, type Profile, type Status } from '@/lib/tickets/status';

const act = (status: Status, profile: Profile, over: Partial<{ assignedToMe: boolean; hasAssignee: boolean; reopenAllowed: boolean }> = {}): Action[] =>
  availableActions({ status, profile, assignedToMe: false, hasAssignee: false, reopenAllowed: false, ...over });

describe('transições', () => {
  const ok: Array<[Status, Status]> = [['open', 'in_progress'], ['open', 'waiting_requester'], ['open', 'resolved'], ['in_progress', 'waiting_requester'], ['in_progress', 'resolved'],
    ['waiting_requester', 'in_progress'], ['waiting_requester', 'resolved'], ['resolved', 'closed'], ['resolved', 'in_progress'], ['resolved', 'open'], ['closed', 'open'], ['closed', 'in_progress']];
  it.each(ok)('%s → %s é permitido', (a, b) => expect(canTransition(a, b)).toBe(true));
  it('todas as outras são recusadas (inclusive manter o mesmo estado)', () => {
    const allowed = new Set(ok.map(([a, b]) => `${a}>${b}`));
    for (const a of STATUSES) for (const b of STATUSES) if (!allowed.has(`${a}>${b}`)) expect(canTransition(a, b), `${a} → ${b}`).toBe(false);
  });
  it('só aberto, em atendimento e aguardando contam como abertos', () => {
    expect(STATUSES.filter(isOpenStatus)).toEqual(['open', 'in_progress', 'waiting_requester']);
  });
});

describe('ações do solicitante (não é um atendente com menus ocultos)', () => {
  it('chamado aberto: só responder', () => expect(act('open', 'requester')).toEqual(['reply']));
  it('resolvido: confirmar e, na janela, reabrir; nunca resolver, atribuir ou mudar prioridade', () => {
    expect(act('resolved', 'requester', { reopenAllowed: true })).toEqual(['confirm', 'reopen']);
    expect(act('resolved', 'requester')).toEqual(['confirm']);
    for (const s of STATUSES) for (const forbidden of ['resolve', 'assign', 'claim', 'set_priority', 'move_team', 'note', 'ask_info', 'close'] as Action[]) expect(act(s, 'requester', { reopenAllowed: true })).not.toContain(forbidden);
  });
  it('encerrado: só reabrir dentro da janela; fora dela, nada', () => {
    expect(act('closed', 'requester', { reopenAllowed: true })).toEqual(['reopen']);
    expect(act('closed', 'requester')).toEqual([]);
  });
});

describe('ações da equipe', () => {
  it('atendente: assume sem responsável; devolve o que é dele; não atribui nem move equipe', () => {
    expect(act('open', 'agent')).toContain('claim');
    expect(act('in_progress', 'agent', { hasAssignee: true, assignedToMe: true })).toContain('release');
    const a = act('in_progress', 'agent', { hasAssignee: true });
    expect(a).not.toContain('claim');
    expect(a).not.toContain('assign');
    expect(a).not.toContain('move_team');
    expect(a).not.toContain('release'); // só devolve à fila o que é dele
  });
  it('gestor e proprietário atribuem e movem de equipe', () => {
    for (const p of ['manager', 'owner'] as const) expect(act('in_progress', p, { hasAssignee: true })).toEqual(expect.arrayContaining(['assign', 'move_team', 'reply', 'resolve', 'ask_info']));
  });
  it('nota interna sempre disponível; responder, pedir informação e resolver só em chamado aberto', () => {
    expect(act('closed', 'agent')).toContain('note');
    expect(act('resolved', 'manager')).toEqual(expect.arrayContaining(['note', 'close']));
    expect(act('resolved', 'manager')).not.toContain('reply');
    expect(act('closed', 'manager')).not.toContain('resolve');
  });
  it('retomar só em aberto ou aguardando solicitante', () => {
    expect(act('waiting_requester', 'agent')).toContain('resume');
    expect(act('in_progress', 'agent')).not.toContain('resume');
  });
  it('reabrir só na janela', () => {
    expect(act('resolved', 'agent', { reopenAllowed: true })).toContain('reopen');
    expect(act('resolved', 'agent')).not.toContain('reopen');
  });
});
