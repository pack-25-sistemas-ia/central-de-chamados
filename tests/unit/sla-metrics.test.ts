// Fórmulas do painel: os números são OS MESMOS do teste SQL (resposta 30, 300, 20 e 10 min → 75%, média 90, mediana 25).
import { describe, expect, it } from 'vitest';
import { average, backlog, compliance, median, percent, reopenedCycles } from '@/lib/sla/metrics';

describe('painel: fórmulas', () => {
  it('primeira resposta: 4 ciclos, 3 dentro da meta (um gastou 300 > 240)', () => {
    const c = compliance([{ consumed: 30, target: 240 }, { consumed: 300, target: 240 }, { consumed: 20, target: 240 }, { consumed: 10, target: 240 }]);
    expect(c).toEqual({ cycles: 4, within: 3, rate: 75, avg: 90, median: 25 });
  });
  it('resolução: 120 e 60 min dentro da meta de 1440 = 100%', () => {
    expect(compliance([{ consumed: 120, target: 1440 }, { consumed: 60, target: 1440 }])).toEqual({ cycles: 2, within: 2, rate: 100, avg: 90, median: 90 });
  });
  it('exatamente na meta conta como cumprido', () => expect(compliance([{ consumed: 240, target: 240 }]).within).toBe(1));
  it('denominador zero = null («Sem dados»), nunca 0%', () => {
    expect(compliance([])).toEqual({ cycles: 0, within: 0, rate: null, avg: null, median: null });
    expect(percent(0, 0)).toBeNull();
    expect(average([])).toBeNull();
    expect(median([])).toBeNull();
  });
  it('mediana de quantidade ímpar e par', () => {
    expect(median([5, 1, 9])).toBe(5);
    expect(median([10, 20, 30, 300])).toBe(25);
  });
  it('percentual com uma casa', () => expect(percent(1, 3)).toBe(33.3));
});

describe('backlog e reaberturas', () => {
  it('backlog atual = open + in_progress + waiting_requester; fechados não entram', () => {
    const b = backlog([
      { status: 'open', assigned: false }, { status: 'in_progress', assigned: true }, { status: 'in_progress', assigned: false },
      { status: 'waiting_requester', assigned: true }, { status: 'resolved', assigned: true }, { status: 'closed', assigned: false },
    ]);
    expect(b).toEqual({ open: 1, in_progress: 2, waiting_requester: 1, unassigned: 2, total: 4 });
  });
  it('reaberturas contam NOVOS ciclos iniciados no período (ciclo 1 não conta; fronteira superior exclusiva)', () => {
    const cycles = [{ cycleNumber: 1, startedMs: 10 }, { cycleNumber: 2, startedMs: 10 }, { cycleNumber: 3, startedMs: 20 }, { cycleNumber: 2, startedMs: 5 }];
    expect(reopenedCycles(cycles, 10, 20)).toBe(1);
    expect(reopenedCycles(cycles, 10, 21)).toBe(2);
  });
});
