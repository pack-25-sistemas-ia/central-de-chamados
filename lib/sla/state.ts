// Estado do SLA de um ciclo (espelho de private.tk_consumed / tk_metric / tk_cycle_sla). Tudo é função de instantes: não depende de cron.
//  · consumido = minutos úteis desde o início do ciclo até o marco (ou até «agora») MENOS os minutos úteis das pausas (pausas não se sobrepõem: nada é descontado duas vezes);
//  · estados: met/breached (cumprido/descumprido) · overdue (atrasado em aberto) · paused · at_risk (≥ 80% da meta) · on_track;
//  · um atraso que já existia antes da pausa continua atraso (a pausa não o esconde).
import { addBusinessMinutes, businessMinutes, type CalendarDef } from './business';

export const RISK_RATIO = 0.8;
export type Kind = 'first_response' | 'resolution';
export type SlaState = 'on_track' | 'at_risk' | 'overdue' | 'paused' | 'met' | 'breached';
export type Pause = { startMs: number; endMs: number | null };
export type Cycle = { startedMs: number; firstResponseMs: number | null; resolvedMs: number | null; firstResponseTarget: number; resolutionTarget: number; pauses: Pause[] };
export type Calendar = { def: CalendarDef; tz: string };
export type Metric = { target: number; consumed: number; state: SlaState; doneMs: number | null; dueMs: number | null };

const doneOf = (c: Cycle, k: Kind) => (k === 'first_response' ? c.firstResponseMs : c.resolvedMs);
const targetOf = (c: Cycle, k: Kind) => (k === 'first_response' ? c.firstResponseTarget : c.resolutionTarget);

export function consumed(cal: Calendar, c: Cycle, k: Kind, atMs: number): number {
  const done = doneOf(c, k);
  const stop = Math.min(atMs, done ?? atMs);
  let used = businessMinutes(cal.def, cal.tz, c.startedMs, stop);
  for (const p of c.pauses) used -= businessMinutes(cal.def, cal.tz, Math.max(p.startMs, c.startedMs), Math.min(p.endMs ?? stop, stop));
  return Math.max(used, 0);
}

export function metric(cal: Calendar, c: Cycle, k: Kind, atMs: number): Metric {
  const target = targetOf(c, k);
  const done = doneOf(c, k);
  const used = consumed(cal, c, k, atMs);
  const paused = c.pauses.some((p) => p.endMs === null);
  let state: SlaState;
  if (done !== null && done <= atMs) state = used <= target ? 'met' : 'breached';
  else if (used > target) state = 'overdue';
  else if (paused) state = 'paused';
  else if (used >= target * RISK_RATIO) state = 'at_risk';
  else state = 'on_track';
  // projeção do vencimento (só enquanto o relógio corre e a meta não foi cumprida)
  const dueMs = done === null && !paused && used < target ? addBusinessMinutes(cal.def, cal.tz, atMs, target - used) : null;
  return { target, consumed: Math.round(used * 100) / 100, state, doneMs: done, dueMs };
}

// do pior para o melhor: overdue > breached > paused > at_risk > on_track > met
const ORDER: SlaState[] = ['met', 'on_track', 'at_risk', 'paused', 'breached', 'overdue'];
export function summary(a: SlaState, b: SlaState): SlaState {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

export function cycleSla(cal: Calendar, c: Cycle, atMs: number) {
  const first = metric(cal, c, 'first_response', atMs);
  const resolution = metric(cal, c, 'resolution', atMs);
  return { first, resolution, summary: summary(first.state, resolution.state) };
}

export const SLA_LABEL: Record<SlaState, string> = {
  on_track: 'Dentro do prazo', at_risk: 'Próximo do limite', overdue: 'Atrasado', paused: 'Pausado', met: 'Cumprido', breached: 'Descumprido',
};
export const SLA_TONE: Record<SlaState, 'success' | 'warning' | 'danger' | 'neutral'> = {
  on_track: 'success', at_risk: 'warning', overdue: 'danger', paused: 'neutral', met: 'success', breached: 'danger',
};
/** Minutos úteis em texto legível: «45 min», «2 h 30 min». */
export function formatMinutes(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'Sem dados';
  const m = Math.round(n);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
