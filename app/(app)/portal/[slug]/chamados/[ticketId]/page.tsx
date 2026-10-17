import { notFound, redirect } from 'next/navigation';
import { requireContext } from '@/lib/auth/session';
import { uuidOrNull } from '@/lib/tickets/query';

// Endereço do chamado dentro do portal da empresa. O slug só identifica a empresa; o acesso continua sendo decidido pelo banco (RLS) na página do chamado.
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export default async function PortalTicketPage({ params }: { params: Promise<{ slug: string; ticketId: string }> }) {
  const { slug, ticketId } = await params;
  const id = uuidOrNull(ticketId);
  if (!SLUG.test(slug) || slug.length > 60 || !id) notFound();
  const ctx = await requireContext();
  const target = ctx.memberships.find((m) => m.slug === slug);
  if (!target || target.organization_id !== ctx.membership.organization_id) notFound();
  redirect(`/chamados/${id}`);
}
