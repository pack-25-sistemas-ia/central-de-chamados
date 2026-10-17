// Anexos: o servidor decide tipo, tamanho e caminho. A extensão e o Content-Type enviados pelo navegador NÃO são confiados: o tipo é conferido pelos BYTES.
// Allowlist: PNG, JPEG, WebP, GIF, PDF e texto simples/CSV. Não aceita executáveis, HTML nem SVG (conteúdo ativo). Não há antivírus: o sistema não afirma o contrário.
import { createHash } from 'node:crypto';

export const MAX_FILES = 3;
export const HARD_MAX_BYTES = 10 * 1024 * 1024; // teto de segurança (o bucket e o banco repetem)
export type Kind = { ext: string; mime: string };

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/** Texto simples: UTF-8 válido, sem bytes de controle (exceto tab, quebras de linha) e sem NUL. */
function isPlainText(b: Uint8Array): boolean {
  if (b.length === 0) return false;
  for (const x of b.subarray(0, Math.min(b.length, 8192))) if (x === 0 || (x < 32 && x !== 9 && x !== 10 && x !== 13)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return false; }
  return true;
}

export function sniff(b: Uint8Array, filename: string): Kind | null {
  if (b.length > 8 && startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: 'png', mime: 'image/png' };
  if (b.length > 4 && startsWith(b, [0xff, 0xd8, 0xff])) return { ext: 'jpg', mime: 'image/jpeg' };
  if (b.length > 12 && startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return { ext: 'webp', mime: 'image/webp' };
  if (b.length > 6 && (startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) return { ext: 'gif', mime: 'image/gif' };
  if (b.length > 5 && startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { ext: 'pdf', mime: 'application/pdf' };
  if (isPlainText(b)) {
    const head = new TextDecoder().decode(b.subarray(0, 512)).trimStart().toLowerCase();
    if (head.startsWith('<') ) return null; // HTML/SVG/XML disfarçado de texto
    return /\.csv$/i.test(filename) ? { ext: 'csv', mime: 'text/csv' } : { ext: 'txt', mime: 'text/plain' };
  }
  return null;
}

export const safeFilename = (name: string): string => (name.replace(/[\\/\x00-\x1f"]/g, '_').trim().slice(0, 180) || 'arquivo');

/** Caminho gerado pelo servidor e DETERMINÍSTICO (idem + posição + conteúdo): reenviar o mesmo envio reaproveita o mesmo arquivo em vez de criar órfãos. */
export function storagePath(org: string, ticket: string, idem: string, index: number, bytes: Uint8Array, ext: string): string {
  const h = createHash('sha256').update(`${idem}:${index}:`).update(bytes).digest('hex').slice(0, 32);
  return `${org}/${ticket}/${h}.${ext}`;
}

export type Prepared = { path: string; filename: string; mime: string; size: number; bytes: Uint8Array };

/** Lê e valida os arquivos do formulário. Devolve a lista pronta para enviar ou uma mensagem de erro amigável. */
export async function prepareFiles(fd: FormData, ctx: { org: string; ticket: string; idem: string; maxBytes: number }): Promise<{ ok: true; files: Prepared[] } | { ok: false; error: string }> {
  const raw = fd.getAll('file').filter((f): f is File => f instanceof File && f.size > 0);
  if (raw.length > MAX_FILES) return { ok: false, error: `Envie no máximo ${MAX_FILES} anexos por mensagem.` };
  const max = Math.min(ctx.maxBytes, HARD_MAX_BYTES);
  const files: Prepared[] = [];
  for (const [i, f] of raw.entries()) {
    if (f.size > max) return { ok: false, error: `«${safeFilename(f.name)}» passa do tamanho máximo (${Math.floor(max / 1024 / 1024) || 1} MB).` };
    const bytes = new Uint8Array(await f.arrayBuffer());
    const kind = sniff(bytes, f.name);
    if (!kind) return { ok: false, error: `«${safeFilename(f.name)}»: tipo de arquivo não permitido. Use imagem (PNG, JPG, WebP, GIF), PDF ou texto.` };
    files.push({ path: storagePath(ctx.org, ctx.ticket, ctx.idem, i, bytes, kind.ext), filename: safeFilename(f.name), mime: kind.mime, size: bytes.length, bytes });
  }
  return { ok: true, files };
}

export const attachmentsJson = (files: Prepared[]) => files.map((f) => ({ path: f.path, filename: f.filename, mime: f.mime, size: f.size }));
