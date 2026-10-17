import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { switchOrganization } from '@/app/(app)/actions';
import { Button, EmptyState } from '@/components/ui/primitives';
import { requireContext } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Portal do solicitante' };

// O slug IDENTIFICA a empresa, mas NÃO concede acesso: só quem já é membro dela entra (convite/associação pelo mecanismo do Core).
// Conhecer o endereço ou o slug de outra empresa não dá acesso a nenhum dado dela.
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export default async function PortalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG.test(slug) || slug.length > 60) notFound();
  const ctx = await requireContext();
  const target = ctx.memberships.find((m) => m.slug === slug);
  if (!target) notFound();
  if (target.organization_id === ctx.membership.organization_id) redirect('/chamados');
  return (
    <EmptyState title={`Entrar em «${target.name}»`} description="Você tem acesso a mais de uma empresa. Troque para esta empresa para ver os seus chamados.">
      <form action={switchOrganization}><input type="hidden" name="organization_id" value={target.organization_id} /><Button type="submit">Trocar para {target.name}</Button></form>
    </EmptyState>
  );
}
