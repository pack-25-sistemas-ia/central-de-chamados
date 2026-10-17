// CSV seguro: separador «;» (Excel pt-BR), UTF-8 com BOM, CRLF e proteção contra injeção de fórmulas.
import { describe, expect, it } from 'vitest';
import { csvText, toCsv } from '@/lib/tickets/csv';

describe('csvText', () => {
  it.each(['=1+1', '+SOMA(A1)', '-2+3', '@cmd', '\tabc', '\rabc'])('neutraliza «%s» com apóstrofo', (v) => {
    expect(csvText(v).replace(/^"|"$/g, '')).toMatch(/^'/);
  });
  it('não altera texto comum nem números no meio', () => {
    expect(csvText('Chamado 12')).toBe('Chamado 12');
    expect(csvText('a=b')).toBe('a=b');
    expect(csvText('1+1')).toBe('1+1');
  });
  it('aspas duplicadas e campo entre aspas quando há «;», aspas ou quebra', () => {
    expect(csvText('ele disse "oi"')).toBe('"ele disse ""oi"""');
    expect(csvText('a;b')).toBe('"a;b"');
  });
  it('quebras de linha viram espaço (a linha do CSV nunca é partida)', () => {
    expect(csvText('linha 1\nlinha 2')).toBe('linha 1 linha 2');
    expect(csvText('linha 1\r\nlinha 2')).toBe('linha 1 linha 2');
  });
  it('fórmula com aspas e separador continua inerte', () => {
    expect(csvText('=HYPERLINK("http://x";"y")')).toBe('"\'=HYPERLINK(""http://x"";""y"")"');
  });
});

describe('toCsv', () => {
  const cols = [{ key: 'n', label: 'Número', kind: 'int' as const }, { key: 's', label: 'Assunto', kind: 'text' as const }];
  it('BOM, cabeçalho, CRLF e «;»', () => {
    const out = toCsv(cols, [{ n: 7, s: 'Olá' }, { n: 8, s: 'a;b' }]);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.slice(1)).toBe('Número;Assunto\r\n7;Olá\r\n8;"a;b"\r\n');
  });
  it('vazio, nulo e indefinido saem vazios; inteiros são truncados', () => {
    expect(toCsv(cols, [{ n: null, s: undefined }, { n: 3.9, s: '' }]).slice(1)).toBe('Número;Assunto\r\n;\r\n3;\r\n');
  });
  it('o rótulo da coluna também é protegido', () => {
    expect(toCsv([{ key: 'x', label: '=cmd', kind: 'text' }], []).slice(1)).toBe("'=cmd\r\n");
  });
});
