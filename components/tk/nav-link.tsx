'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Link do menu que também compara a visão (?view=…): «Chamados», «Meus chamados» e «Não atribuídos» apontam para a mesma página e não podem ficar todos ativos. */
export function TkNavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  const sp = useSearchParams();
  const [path = '', query = ''] = href.split('?');
  const wantView = new URLSearchParams(query).get('view') ?? '';
  const curView = sp.get('view') ?? '';
  let active: boolean;
  if (path === '/chamados') {
    const onQueue = pathname === '/chamados' && wantView === curView;
    const onDetail = !wantView && pathname.startsWith('/chamados/') && pathname !== '/chamados/novo';
    active = onQueue || onDetail;
  } else {
    active = pathname === path || pathname.startsWith(`${path}/`);
  }
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn('flex min-h-10 items-center rounded-md px-3 text-sm font-medium transition', active ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-black/5 dark:hover:bg-white/5')}
    >
      {children}
    </Link>
  );
}
