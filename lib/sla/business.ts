// Minutos ÚTEIS (espelho TypeScript de private.tk_bminutes / tk_cal_day). A fonte de verdade é o banco; aqui se projetam vencimentos e se fixam as regras em testes
// com OS MESMOS valores de supabase/tests/55_tk_sla_dashboard.sql.
// Regras: expediente semanal em hora LOCAL do fuso do calendário (vários intervalos por dia) · datas sem expediente · interseção com [a, b) · sem feriados automáticos.
import { addDays, daysBetween, instantToLocal, localToInstant, weekdayOf } from './time';

const MIN = 60_000;
/** {"weekly": {"1": [["09:00","12:00"],["13:00","18:00"]], ...}, "closed_dates": ["2026-12-25"]}  (0 = domingo … 6 = sábado; «24:00» = meia-noite final) */
export type CalendarDef = { weekly: Record<string, Array<[string, string]>>; closed_dates?: string[] };
export type Window = { startMs: number; endMs: number };
const MAX_DAYS = 800;

export function dayWindows(def: CalendarDef, tz: string, date: string): Window[] {
  if ((def.closed_dates ?? []).includes(date)) return [];
  const spans = def.weekly[String(weekdayOf(date))] ?? [];
  return spans.map(([s, e]) => ({ startMs: localToInstant(date, s, tz), endMs: localToInstant(date, e, tz) })).sort((x, y) => x.startMs - y.startMs);
}

/** Minutos úteis entre dois instantes (fração preservada). */
export function businessMinutes(def: CalendarDef, tz: string, aMs: number, bMs: number): number {
  if (!(bMs > aMs)) return 0;
  const first = instantToLocal(aMs, tz).date;
  const last = instantToLocal(bMs, tz).date;
  if (daysBetween(first, last) > MAX_DAYS) throw new RangeError('período longo demais para o cálculo de SLA');
  let total = 0;
  for (let d = first; d <= last; d = addDays(d, 1)) {
    for (const w of dayWindows(def, tz, d)) {
      const lo = Math.max(w.startMs, aMs);
      const hi = Math.min(w.endMs, bMs);
      if (hi > lo) total += (hi - lo) / MIN;
    }
  }
  return total;
}

/** Instante em que se completam `minutes` minutos úteis a partir de `fromMs` (null se o calendário não tem expediente no horizonte). */
export function addBusinessMinutes(def: CalendarDef, tz: string, fromMs: number, minutes: number): number | null {
  if (minutes <= 0) return fromMs;
  let left = minutes;
  let date = instantToLocal(fromMs, tz).date;
  for (let i = 0; i < MAX_DAYS; i++, date = addDays(date, 1)) {
    for (const w of dayWindows(def, tz, date)) {
      const lo = Math.max(w.startMs, fromMs);
      if (w.endMs <= lo) continue;
      const room = (w.endMs - lo) / MIN;
      if (left <= room) return lo + left * MIN;
      left -= room;
    }
  }
  return null;
}
