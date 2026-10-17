// Estados de SLA e pausas: valores iguais aos de supabase/tests/55_tk_sla_dashboard.sql.
import { describe, expect, it } from 'vitest';
import type { CalendarDef } from '@/lib/sla/business';
import { consumed, cycleSla, formatMinutes, metric, summary, type Calendar, type Cycle } from '@/lib/sla/state';
import { localToInstant } from '@/lib/sla/time';

const SP = 'America/Sao_Paulo';
const DEF: CalendarDef = { weekly: Object.fromEntries(['1', '2', '3', '4', '5'].map((d) => [d, [['09:00', '12:00'], ['13:00', '18:00']]])) as CalendarDef['weekly'] };
const CAL: Calendar = { def: DEF, tz: SP };
const at = (d: string, t: string) => localToInstant(d, t, SP);
const MON = '2026-10-19';
const TUE = '2026-10-20';
const cyc = (over: Partial<Cycle> = {}): Cycle => ({ startedMs: at(MON, '09:00'), firstResponseMs: null, resolvedMs: null, firstResponseTarget: 240, resolutionTarget: 1440, pauses: [], ...over });

describe('limiar e atraso (meta de 240 min, iniciado segunda 09:00)', () => {
  const c = cyc();
  it('180 min (75%): no prazo', () => {
    const m = metric(CAL, c, 'first_response', at(MON, '12:00'));
    expect(m.state).toBe('on_track');
    expect(m.consumed).toBe(180);
  });
  it('191 min ainda abaixo de 80%; 192 min = 80% é «próximo do limite»', () => {
    expect(metric(CAL, c, 'first_response', at(MON, '13:11')).state).toBe('on_track');
    expect(metric(CAL, c, 'first_response', at(MON, '13:12')).state).toBe('at_risk');
  });
  it('exatamente na meta ainda não é atraso; um minuto depois é', () => {
    expect(metric(CAL, c, 'first_response', at(MON, '14:00')).state).toBe('at_risk');
    expect(metric(CAL, c, 'first_response', at(MON, '14:01')).state).toBe('overdue');
  });
  it('resumo = pior estado', () => {
    expect(cycleSla(CAL, c, at(MON, '14:01')).summary).toBe('overdue');
    expect(cycleSla(CAL, c, at(MON, '10:00')).summary).toBe('on_track');
    expect(summary('met', 'on_track')).toBe('on_track');
    expect(summary('paused', 'at_risk')).toBe('paused');
    expect(summary('breached', 'paused')).toBe('breached');
  });
  it('projeta o vencimento enquanto o relógio corre', () => {
    const m = metric(CAL, c, 'first_response', at(MON, '10:00'));
    expect(m.dueMs).toBe(at(MON, '14:00'));
  });
});

describe('cumprida × descumprida', () => {
  it('aberto no sábado, respondido na segunda 09:30: 30 min úteis, cumprida; o relógio para no marco', () => {
    const c = cyc({ startedMs: at('2026-10-17', '10:00'), firstResponseMs: at(MON, '09:30') });
    const m = metric(CAL, c, 'first_response', at('2026-10-30', '12:00'));
    expect(m).toMatchObject({ state: 'met', consumed: 30, target: 240, dueMs: null });
  });
  it('alta: 60 min na meta de 60 = cumprida; resolução em 360 ≤ 480 = cumprida', () => {
    const c = cyc({ firstResponseTarget: 60, resolutionTarget: 480, firstResponseMs: at(MON, '10:00'), resolvedMs: at(MON, '16:00') });
    expect(metric(CAL, c, 'first_response', at('2026-10-30', '12:00')).state).toBe('met');
    expect(metric(CAL, c, 'resolution', at('2026-10-30', '12:00'))).toMatchObject({ state: 'met', consumed: 360 });
  });
  it('urgente respondida em 60 min (meta 30): descumprida', () => {
    const c = cyc({ firstResponseTarget: 30, resolutionTarget: 240, firstResponseMs: at(MON, '10:00') });
    expect(metric(CAL, c, 'first_response', at('2026-10-30', '12:00')).state).toBe('breached');
  });
});

describe('pausas', () => {
  const base = cyc({ startedMs: at(MON, '10:00'), firstResponseMs: at(MON, '10:30') });
  it('seg 10:00 → ter 12:00 = 600 úteis; pausa seg 11:00 → ter 10:00 = 420; consumo 180', () => {
    const c = { ...base, pauses: [{ startMs: at(MON, '11:00'), endMs: at(TUE, '10:00') }] };
    expect(consumed(CAL, c, 'resolution', at(TUE, '12:00'))).toBe(180);
  });
  it('segunda pausa também é descontada, sem contar duas vezes', () => {
    const c = { ...base, pauses: [{ startMs: at(MON, '11:00'), endMs: at(TUE, '10:00') }, { startMs: at(TUE, '10:30'), endMs: at(TUE, '11:00') }] };
    expect(consumed(CAL, c, 'resolution', at(TUE, '12:00'))).toBe(150);
  });
  it('pausa aberta desconta até o instante consultado e o estado é «pausado»', () => {
    const c = { ...base, pauses: [{ startMs: at(MON, '11:00'), endMs: at(TUE, '10:00') }, { startMs: at(TUE, '10:30'), endMs: at(TUE, '11:00') }, { startMs: at(TUE, '11:30'), endMs: null }] };
    expect(consumed(CAL, c, 'resolution', at(TUE, '12:00'))).toBe(120);
    expect(metric(CAL, c, 'resolution', at(TUE, '12:00')).state).toBe('paused');
    expect(metric(CAL, c, 'resolution', at(TUE, '12:00')).dueMs).toBeNull();
  });
  it('pausa fora do expediente não altera o consumo', () => {
    const c = { ...base, pauses: [{ startMs: at(TUE, '18:00'), endMs: at('2026-10-21', '09:00') }] };
    expect(consumed(CAL, c, 'resolution', at('2026-10-21', '09:00'))).toBe(consumed(CAL, { ...base }, 'resolution', at(TUE, '18:00')));
  });
  it('pausada dentro da meta: 25 úteis − 15 de pausa = 10 («pausado»)', () => {
    const c = cyc({ firstResponseTarget: 30, resolutionTarget: 240, pauses: [{ startMs: at(MON, '09:10'), endMs: null }] });
    expect(metric(CAL, c, 'first_response', at(MON, '09:25'))).toMatchObject({ consumed: 10, state: 'paused' });
  });
  it('atraso que já existia antes da pausa continua atraso (a pausa não o esconde)', () => {
    const c = cyc({ firstResponseTarget: 30, resolutionTarget: 240, pauses: [{ startMs: at(MON, '11:00'), endMs: null }] });
    expect(metric(CAL, c, 'first_response', at(MON, '11:30')).state).toBe('overdue');
  });
});

describe('leitura histórica e dados anômalos', () => {
  it('olhando para um instante ANTES do marco, a meta ainda não estava cumprida (o consumo conta até o instante consultado)', () => {
    const c = cyc({ firstResponseMs: at(MON, '10:00') });
    const antes = metric(CAL, c, 'first_response', at(MON, '09:30'));
    expect(antes).toMatchObject({ state: 'on_track', consumed: 30 });
    expect(metric(CAL, c, 'first_response', at(MON, '10:00'))).toMatchObject({ state: 'met', consumed: 60 });
  });
  it('pausa registrada antes do início do ciclo é recortada: não desconta tempo que o ciclo nunca teve', () => {
    const c = cyc({ startedMs: at(MON, '10:00'), pauses: [{ startMs: at(MON, '09:00'), endMs: at(MON, '11:00') }] });
    expect(consumed(CAL, c, 'resolution', at(MON, '12:00'))).toBe(60); // 10:00–12:00 = 120; pausa recortada 10:00–11:00 = 60
  });
});

describe('formatação', () => {
  it('minutos úteis legíveis; null = «Sem dados»', () => {
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(60)).toBe('1 h');
    expect(formatMinutes(150)).toBe('2 h 30 min');
    expect(formatMinutes(null)).toBe('Sem dados');
  });
});
