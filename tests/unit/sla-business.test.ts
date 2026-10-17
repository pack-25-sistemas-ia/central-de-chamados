// Minutos úteis: os valores são OS MESMOS de supabase/tests/55_tk_sla_dashboard.sql (o espelho TS e o banco não podem divergir).
import { describe, expect, it } from 'vitest';
import { addBusinessMinutes, businessMinutes, dayWindows, type CalendarDef } from '@/lib/sla/business';
import { localToInstant } from '@/lib/sla/time';

const SP = 'America/Sao_Paulo';
const NY = 'America/New_York';
const DEFAULT: CalendarDef = {
  weekly: Object.fromEntries(['1', '2', '3', '4', '5'].map((d) => [d, [['09:00', '12:00'], ['13:00', '18:00']]])) as CalendarDef['weekly'],
  closed_dates: [],
};
const at = (date: string, hhmm: string, tz = SP) => localToInstant(date, hhmm, tz);
const bm = (a: number, b: number, def = DEFAULT, tz = SP) => businessMinutes(def, tz, a, b);
const MON = '2026-10-19';

describe('minutos úteis', () => {
  it('antes do expediente não conta; só 09:00–09:30', () => expect(bm(at(MON, '08:00'), at(MON, '09:30'))).toBe(30));
  it('intervalo de almoço (12–13) não conta', () => expect(bm(at(MON, '11:00'), at(MON, '14:00'))).toBe(120));
  it('sexta 17–18 + segunda 09–10; fim de semana não conta', () => expect(bm(at('2026-10-23', '17:00'), at('2026-10-26', '10:00'))).toBe(120));
  it('sábado e domingo: zero', () => expect(bm(at('2026-10-24', '10:00'), at('2026-10-25', '18:00'))).toBe(0));
  it('semana útil inteira = 5 × 480', () => expect(bm(at(MON, '09:00'), at('2026-10-23', '18:00'))).toBe(2400));
  it('intervalo vazio ou invertido = 0', () => {
    expect(bm(at(MON, '10:00'), at(MON, '10:00'))).toBe(0);
    expect(bm(at(MON, '11:00'), at(MON, '10:00'))).toBe(0);
  });
  it('fração de minuto preservada', () => expect(bm(at(MON, '09:00'), at(MON, '09:00') + 30_000)).toBe(0.5));
  it('dia sem expediente (quarta 21/10) não conta', () => {
    const def = { ...DEFAULT, closed_dates: ['2026-10-21'] };
    expect(bm(at(MON, '09:00'), at('2026-10-21', '18:00'), def)).toBe(960);
    expect(dayWindows(def, SP, '2026-10-21')).toEqual([]);
  });
});

describe('fuso e horário de verão', () => {
  it('o mesmo instante cai em horas diferentes: São Paulo 09–11 × Nova York 08–10 (só 09–10 é expediente)', () => {
    const a = Date.parse('2026-10-23T12:00:00Z');
    const b = Date.parse('2026-10-23T14:00:00Z');
    expect(bm(a, b, DEFAULT, SP)).toBe(120);
    expect(bm(a, b, DEFAULT, NY)).toBe(60);
  });
  it('virada do horário de verão (01/11/2026, Nova York): sexta 16–17 + segunda 09–10', () => {
    const def: CalendarDef = { weekly: { '1': [['09:00', '17:00']], '5': [['09:00', '17:00']] } };
    expect(bm(at('2026-10-30', '16:00', NY), at('2026-11-02', '10:00', NY), def, NY)).toBe(120);
  });
  it('«24:00» é a meia-noite seguinte', () => {
    const def: CalendarDef = { weekly: { '1': [['22:00', '24:00']] } };
    expect(bm(at(MON, '21:00'), at('2026-10-20', '01:00'), def)).toBe(120);
  });
});

describe('projeção de vencimento (addBusinessMinutes)', () => {
  it('dentro do expediente: soma direta', () => expect(addBusinessMinutes(DEFAULT, SP, at(MON, '09:00'), 90)).toBe(at(MON, '10:30')));
  it('atravessa o almoço', () => expect(addBusinessMinutes(DEFAULT, SP, at(MON, '11:30'), 60)).toBe(at(MON, '13:30')));
  it('começa fora do expediente: conta a partir da próxima janela', () => expect(addBusinessMinutes(DEFAULT, SP, at('2026-10-17', '10:00'), 30)).toBe(at(MON, '09:30')));
  it('atravessa o fim de semana', () => expect(addBusinessMinutes(DEFAULT, SP, at('2026-10-23', '17:30'), 60)).toBe(at('2026-10-26', '09:30')));
  it('é a inversa de businessMinutes', () => {
    const from = at(MON, '10:17');
    const due = addBusinessMinutes(DEFAULT, SP, from, 1440)!;
    expect(businessMinutes(DEFAULT, SP, from, due)).toBeCloseTo(1440, 6);
  });
  it('calendário sem expediente não tem vencimento', () => expect(addBusinessMinutes({ weekly: {} }, SP, at(MON, '09:00'), 10)).toBeNull());
  it('zero minutos = o próprio instante (mesmo fora do expediente)', () => {
    expect(addBusinessMinutes(DEFAULT, SP, at(MON, '09:00'), 0)).toBe(at(MON, '09:00'));
    expect(addBusinessMinutes(DEFAULT, SP, at('2026-10-24', '10:00'), 0)).toBe(at('2026-10-24', '10:00'));
  });
  it('vencimento que cai EXATAMENTE no fim da janela fica no fim da janela (não pula para a próxima)', () => {
    expect(addBusinessMinutes(DEFAULT, SP, at(MON, '09:00'), 180)).toBe(at(MON, '12:00'));
    expect(addBusinessMinutes(DEFAULT, SP, at(MON, '13:00'), 300)).toBe(at(MON, '18:00'));
    expect(addBusinessMinutes(DEFAULT, SP, at(MON, '09:00'), 181)).toBe(at(MON, '13:01'));
  });
});

describe('segurança do cálculo', () => {
  it('recusa períodos de mais de 800 dias', () => {
    expect(() => bm(at('2020-01-01', '09:00'), at('2026-01-01', '09:00'))).toThrow(/longo demais/);
  });
});
