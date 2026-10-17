// Configuração da Central de Chamados. Para personalizar para uma empresa:
//  1. troque `name`;  2. substitua public/brand/logo.svg (ou envie um logotipo em «Configurações»);  3. ajuste a navegação em `groups`.
// Perfis (ver docs/PERMISSIONS.md): owner = proprietário · manager = gestor · agent = atendente (member do Core) · requester = solicitante (viewer do Core).
// Este arquivo é do sistema (listado em .core-overrides): o sync-core nunca o sobrescreve.
import type { Profile } from '@/lib/tickets/status';

export type NavItem = { href: string; label: string; profiles?: readonly Profile[] };
export type NavGroup = { title: string; items: NavItem[] };

const STAFF: readonly Profile[] = ['owner', 'manager', 'agent'];
const MGMT: readonly Profile[] = ['owner', 'manager'];
const REQUESTER: readonly Profile[] = ['requester'];

export const systemConfig: { name: string; logo: string; groups: NavGroup[] } = {
  name: 'Central de Chamados',
  logo: '/brand/logo.svg',
  groups: [
    {
      title: 'Atendimento',
      items: [
        { href: '/dashboard', label: 'Visão geral', profiles: STAFF },
        { href: '/chamados', label: 'Chamados', profiles: STAFF },
        { href: '/chamados?view=mine', label: 'Meus chamados', profiles: STAFF },
        { href: '/chamados?view=unassigned', label: 'Não atribuídos', profiles: STAFF },
      ],
    },
    {
      title: 'Portal',
      items: [
        { href: '/dashboard', label: 'Início', profiles: REQUESTER },
        { href: '/chamados', label: 'Meus chamados', profiles: REQUESTER },
        { href: '/chamados/novo', label: 'Novo chamado', profiles: REQUESTER },
      ],
    },
    {
      title: 'Cadastros',
      items: [
        { href: '/equipes', label: 'Equipes', profiles: MGMT },
        { href: '/categorias', label: 'Categorias', profiles: MGMT },
        { href: '/respostas-prontas', label: 'Respostas prontas', profiles: MGMT },
      ],
    },
    {
      title: 'Análise e empresa',
      items: [
        { href: '/relatorios', label: 'Relatórios', profiles: MGMT },
        { href: '/configuracoes', label: 'Configurações', profiles: ['owner'] },
      ],
    },
  ],
};
