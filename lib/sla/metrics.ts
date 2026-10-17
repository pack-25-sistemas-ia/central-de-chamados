// Fórmulas do painel (espelho de public.tk_dashboard). Denominador zero = null («Sem dados»), nunca 0%.
//  · cumprimento de primeira resposta = ciclos com primeira resposta no período dentro da meta ÷ ciclos com primeira resposta no período;
//  · cumprimento de resolução = ciclos resolvidos no período dentro da meta ÷ ciclos resolvidos no período;
//  · backlog atual = open + in_progress + waiting_requester;
//  · reaberturas = NOVOS ciclos (cycle_number > 1) iniciados no período. Métrica por CICLO ≠ métrica por CHAMADO.

export type Sample = { consumed: number; target: number };
export type Compliance = { cycles: number; within: number; rate: number | null; avg: number | null; median: number | null };

const round1 = (n: number) => Math.round(n * 10) / 10;

export function percent(part: number, whole: number): number | null {
  return whole === 0 ? null : round1((part * 100) / whole);
}
export function average(xs: number[]): number | null {
  return xs.length === 0 ? null : round1(xs.reduce((a, b) => a + b, 0) / xs.length);
}
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return round1(s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2);
}

export function compliance(samples: Sample[]): Compliance {
  const within = samples.filter((s) => s.consumed <= s.target).length;
  const used = samples.map((s) => s.consumed);
  return { cycles: samples.length, within, rate: percent(within, samples.length), avg: average(used), median: median(used) };
}

export const BACKLOG_STATUSES = ['open', 'in_progress', 'waiting_requester'] as const;
export function backlog(tickets: Array<{ status: string; assigned: boolean }>) {
  const open = tickets.filter((t) => (BACKLOG_STATUSES as readonly string[]).includes(t.status));
  return {
    open: open.filter((t) => t.status === 'open').length,
    in_progress: open.filter((t) => t.status === 'in_progress').length,
    waiting_requester: open.filter((t) => t.status === 'waiting_requester').length,
    unassigned: open.filter((t) => !t.assigned).length,
    total: open.length,
  };
}
export const reopenedCycles = (cycles: Array<{ cycleNumber: number; startedMs: number }>, fromMs: number, toMs: number): number =>
  cycles.filter((c) => c.cycleNumber > 1 && c.startedMs >= fromMs && c.startedMs < toMs).length;
