// Estados do chamado, perfis e ações permitidas. O banco repete as regras (gatilho ticket_guard + funções tk_*); aqui só decidimos o que mostrar.
export const STATUSES = ['open', 'in_progress', 'waiting_requester', 'resolved', 'closed'] as const;
export type Status = (typeof STATUSES)[number];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];
export type Profile = 'owner' | 'manager' | 'agent' | 'requester';
export type Action = 'claim' | 'release' | 'assign' | 'move_team' | 'set_priority' | 'set_category' | 'reply' | 'note' | 'ask_info' | 'resolve' | 'resume' | 'close' | 'reopen' | 'confirm';

export const STATUS_LABEL: Record<Status, string> = { open: 'Aberto', in_progress: 'Em atendimento', waiting_requester: 'Aguardando solicitante', resolved: 'Resolvido', closed: 'Encerrado' };
export const STATUS_TONE: Record<Status, 'neutral' | 'success' | 'warning' | 'danger'> = { open: 'warning', in_progress: 'success', waiting_requester: 'neutral', resolved: 'success', closed: 'neutral' };
export const PRIORITY_LABEL: Record<Priority, string> = { low: 'Baixa', normal: 'Normal', high: 'Alta', urgent: 'Urgente' };
export const PRIORITY_TONE: Record<Priority, 'neutral' | 'success' | 'warning' | 'danger'> = { low: 'neutral', normal: 'neutral', high: 'warning', urgent: 'danger' };
export const PROFILE_LABEL: Record<Profile, string> = { owner: 'Proprietário', manager: 'Gestor', agent: 'Atendente', requester: 'Solicitante' };
export const ACTION_LABEL: Record<Action, string> = {
  claim: 'Assumir chamado', release: 'Devolver à fila', assign: 'Atribuir a', move_team: 'Mover para equipe', set_priority: 'Alterar prioridade', set_category: 'Alterar categoria',
  reply: 'Resposta ao solicitante', note: 'Nota interna', ask_info: 'Pedir informação', resolve: 'Resolver', resume: 'Retomar atendimento', close: 'Encerrar', reopen: 'Reabrir', confirm: 'Confirmar solução',
};
export const EVENT_LABEL: Record<string, string> = {
  created: 'Chamado aberto', claimed: 'Chamado assumido', assigned: 'Responsável atribuído', unassigned: 'Responsável removido', team_changed: 'Equipe alterada', category_changed: 'Categoria alterada',
  priority_changed: 'Prioridade alterada', status_changed: 'Status alterado', public_reply: 'Resposta pública da equipe', internal_note: 'Nota interna', requester_reply: 'Resposta do solicitante',
  sla_paused: 'SLA pausado (aguardando solicitante)', sla_resumed: 'SLA retomado', resolved: 'Chamado resolvido', closed: 'Chamado encerrado', reopened: 'Chamado reaberto',
};
export const NOTIFICATION_LABEL: Record<string, string> = { assigned: 'Chamado atribuído', public_reply: 'Nova resposta', resolved: 'Solicitação resolvida', reopened: 'Chamado reaberto' };

export const isStatus = (v: unknown): v is Status => typeof v === 'string' && (STATUSES as readonly string[]).includes(v);
export const isPriority = (v: unknown): v is Priority => typeof v === 'string' && (PRIORITIES as readonly string[]).includes(v);
export const isOpenStatus = (s: Status): boolean => s === 'open' || s === 'in_progress' || s === 'waiting_requester';
export const isStaff = (p: Profile | null): boolean => p === 'owner' || p === 'manager' || p === 'agent';
export const isManager = (p: Profile | null): boolean => p === 'owner' || p === 'manager';

/** Transições aceitas pelo gatilho do banco (as de reabertura só valem pela ação «Reabrir», que cria novo ciclo). */
export function canTransition(from: Status, to: Status): boolean {
  if (from === 'open') return to === 'in_progress' || to === 'waiting_requester' || to === 'resolved';
  if (from === 'in_progress') return to === 'waiting_requester' || to === 'resolved';
  if (from === 'waiting_requester') return to === 'in_progress' || to === 'resolved';
  if (from === 'resolved') return to === 'closed' || to === 'open' || to === 'in_progress';
  return to === 'open' || to === 'in_progress'; // closed: só reabertura
}

/** Ações visíveis para o usuário neste chamado (a interface não é a barreira: o banco recusa o resto). */
export function availableActions(p: { status: Status; profile: Profile; assignedToMe: boolean; hasAssignee: boolean; reopenAllowed: boolean }): Action[] {
  const { status, profile, assignedToMe, hasAssignee, reopenAllowed } = p;
  const out: Action[] = [];
  const open = isOpenStatus(status);
  if (profile === 'requester') {
    if (open) out.push('reply');
    if (status === 'resolved') out.push('confirm');
    if ((status === 'resolved' || status === 'closed') && reopenAllowed) out.push('reopen');
    return out;
  }
  out.push('note');
  if (open) {
    out.push('reply', 'ask_info', 'resolve');
    if (status === 'open' || status === 'waiting_requester') out.push('resume');
    out.push('set_priority', 'set_category');
    if (!hasAssignee) out.push('claim');
    if (isManager(profile)) out.push('assign', 'move_team');
    else if (assignedToMe) out.push('release');
  }
  if (status === 'resolved') out.push('close');
  if ((status === 'resolved' || status === 'closed') && reopenAllowed) out.push('reopen');
  return out;
}
