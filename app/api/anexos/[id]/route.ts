import { NextResponse } from 'next/server';
import { resolveContext } from '@/lib/auth/session';
import { logEvent } from '@/lib/log';
import { rateLimit } from '@/lib/security/rate-limit';
import { uuidOrNull } from '@/lib/tickets/query';

// Download de anexo: (1) sessão + MFA; (2) o BANCO decide se o usuário pode ver a mensagem dona do anexo (tk_attachment_info);
// (3) só então geramos uma URL assinada CURTA (60 s) do bucket privado, com download forçado. O caminho do arquivo nunca vai ao navegador.
// Anexo de nota interna não é entregue ao solicitante.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = uuidOrNull((await ctx.params).id);
  if (!id) return new NextResponse('Anexo não encontrado', { status: 404 });
  const r = await resolveContext();
  if (r.kind !== 'ok') return new NextResponse(r.kind === 'forbidden' ? 'Sem permissão' : 'Não autenticado', { status: r.kind === 'forbidden' ? 403 : 401 });
  const { supabase, user, membership } = r.ctx;
  const rl = rateLimit(`tk-att:${user.id}`, { limit: 60, windowMs: 60_000 });
  if (!rl.allowed) return new NextResponse('Muitos downloads. Aguarde um instante.', { status: 429, headers: { 'retry-after': String(rl.retryAfterSeconds) } });
  const { data, error } = await supabase.rpc('tk_attachment_info', { p_org: membership.organization_id, p_attachment: id });
  if (error || !data) return new NextResponse('Anexo não encontrado', { status: 404 });
  const info = data as { path: string; filename: string };
  const signed = await supabase.storage.from('tk-attachments').createSignedUrl(info.path, 60, { download: info.filename });
  if (signed.error || !signed.data?.signedUrl) {
    logEvent('error', 'tk_signed_url_failed', { name: signed.error?.name ?? 'unknown' });
    return new NextResponse('Não foi possível abrir o anexo agora', { status: 502 });
  }
  return NextResponse.redirect(signed.data.signedUrl, { status: 302, headers: { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' } });
}
