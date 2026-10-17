// Anexos: o tipo é conferido pelos BYTES (não pela extensão nem pelo Content-Type), caminho gerado pelo servidor e limites.
import { describe, expect, it } from 'vitest';
import { MAX_FILES, prepareFiles, safeFilename, sniff, storagePath } from '@/lib/tickets/attachments';

const bytes = (...n: number[]) => new Uint8Array(n);
const text = (s: string) => new TextEncoder().encode(s);
const ORG = '11111111-1111-4111-8111-111111111111';
const TK = '22222222-2222-4222-8222-222222222222';

describe('sniff (assinatura dos bytes)', () => {
  it('PNG, JPEG, WebP, GIF e PDF', () => {
    expect(sniff(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0), 'a.png')).toEqual({ ext: 'png', mime: 'image/png' });
    expect(sniff(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0), 'a.jpg')).toEqual({ ext: 'jpg', mime: 'image/jpeg' });
    expect(sniff(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0, 0), 'a.webp')).toEqual({ ext: 'webp', mime: 'image/webp' });
    expect(sniff(text('GIF89a....'), 'a.gif')).toEqual({ ext: 'gif', mime: 'image/gif' });
    expect(sniff(text('GIF87a....'), 'a.gif')).toEqual({ ext: 'gif', mime: 'image/gif' });
    expect(sniff(text('%PDF-1.4\n...'), 'a.pdf')).toEqual({ ext: 'pdf', mime: 'application/pdf' });
  });
  it('a extensão é ignorada: HTML com nome .png é recusado; PNG com nome .exe é aceito como PNG', () => {
    expect(sniff(text('<html><script>alert(1)</script></html>'), 'foto.png')).toBeNull();
    expect(sniff(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0), 'x.exe')?.mime).toBe('image/png');
  });
  it('SVG, XML e HTML disfarçados de texto são recusados (conteúdo ativo)', () => {
    expect(sniff(text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'a.txt')).toBeNull();
    expect(sniff(text('   \n<?xml version="1.0"?><svg/>'), 'a.txt')).toBeNull();
    expect(sniff(text('<!DOCTYPE html><html>'), 'a.csv')).toBeNull();
  });
  it('executáveis e binários desconhecidos são recusados', () => {
    expect(sniff(bytes(0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0), 'a.exe')).toBeNull(); // MZ
    expect(sniff(bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0), 'a')).toBeNull(); // ELF
    expect(sniff(bytes(0x50, 0x4b, 3, 4, 0, 0, 0, 0), 'a.docx')).toBeNull(); // zip/office
    expect(sniff(bytes(), 'vazio.txt')).toBeNull();
  });
  it('texto simples (UTF-8 válido, sem NUL/controle) e CSV; binário com NUL não é texto', () => {
    expect(sniff(text('linha 1\nlinha 2\tcom tab\r\n'), 'log.txt')).toEqual({ ext: 'txt', mime: 'text/plain' });
    expect(sniff(text('a;b\n1;2\n'), 'dados.CSV')).toEqual({ ext: 'csv', mime: 'text/csv' });
    expect(sniff(bytes(0x61, 0x00, 0x62, 0x63), 'a.txt')).toBeNull();
    expect(sniff(bytes(0x61, 0x01, 0x62), 'a.txt')).toBeNull();
    expect(sniff(bytes(0xc3, 0x28, 0x61), 'a.txt')).toBeNull(); // UTF-8 inválido
  });
});

describe('nomes e caminhos', () => {
  it('nome de arquivo sem barras, aspas nem controles; nunca vazio; no máximo 180 caracteres', () => {
    expect(safeFilename('..\\..\\etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeFilename('a"b\u0007c')).toBe('a_b_c');
    expect(safeFilename('   ')).toBe('arquivo');
    expect(safeFilename('x'.repeat(300))).toHaveLength(180);
  });
  it('caminho gerado pelo servidor: <empresa>/<chamado>/<32 hex>.<ext>; determinístico por (chave, posição, conteúdo)', () => {
    const p = storagePath(ORG, TK, 'chave-1', 0, text('abc'), 'txt');
    expect(p).toMatch(new RegExp(`^${ORG}/${TK}/[0-9a-f]{32}\\.txt$`));
    expect(storagePath(ORG, TK, 'chave-1', 0, text('abc'), 'txt')).toBe(p);
    expect(storagePath(ORG, TK, 'chave-2', 0, text('abc'), 'txt')).not.toBe(p);
    expect(storagePath(ORG, TK, 'chave-1', 1, text('abc'), 'txt')).not.toBe(p);
    expect(storagePath(ORG, TK, 'chave-1', 0, text('abd'), 'txt')).not.toBe(p);
  });
});

function form(files: Array<{ name: string; data: Uint8Array | string }>): FormData {
  const fd = new FormData();
  for (const f of files) fd.append('file', new File([typeof f.data === 'string' ? text(f.data) : (f.data as BlobPart)], f.name));
  return fd;
}
const ctx = { org: ORG, ticket: TK, idem: 'i1', maxBytes: 1000 };

describe('prepareFiles', () => {
  it('prepara arquivos válidos e devolve o JSON para o banco', async () => {
    const r = await prepareFiles(form([{ name: 'log.txt', data: 'olá' }]), ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.files).toHaveLength(1);
      expect(r.files[0]).toMatchObject({ filename: 'log.txt', mime: 'text/plain', size: 4 });
    }
  });
  it(`recusa mais de ${MAX_FILES} anexos`, async () => {
    const r = await prepareFiles(form(Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ name: `a${i}.txt`, data: 'x' }))), ctx);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/no máximo 3/) });
  });
  it('recusa acima do limite da empresa e acima do teto de segurança de 10 MB', async () => {
    expect(await prepareFiles(form([{ name: 'g.txt', data: 'x'.repeat(1001) }]), ctx)).toMatchObject({ ok: false, error: expect.stringMatching(/tamanho máximo/) });
    const big = await prepareFiles(form([{ name: 'g.txt', data: 'x'.repeat(11 * 1024 * 1024) }]), { ...ctx, maxBytes: 50 * 1024 * 1024 });
    expect(big).toMatchObject({ ok: false, error: expect.stringMatching(/tamanho máximo/) });
  });
  it('recusa tipo não permitido (mesmo com extensão inofensiva) e ignora campos vazios', async () => {
    expect(await prepareFiles(form([{ name: 'inofensivo.pdf', data: '<html>' }]), ctx)).toMatchObject({ ok: false, error: expect.stringMatching(/não permitido/) });
    const fd = new FormData();
    fd.append('file', new File([], 'vazio.txt'));
    expect(await prepareFiles(fd, ctx)).toEqual({ ok: true, files: [] });
  });
});
