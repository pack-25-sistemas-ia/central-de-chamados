# Adicionar pessoas a uma organização

O MVP **não** traz tela de convite: o escopo é o núcleo (login, MFA, organização, papéis, auditoria). Quem implanta o sistema para um cliente adiciona a equipe de dois modos. Se o cliente precisar de convite dentro do app, é uma adaptação a pedir ao Claude Code ou ao Codex (veja "Se quiser um convite dentro do app").

## Como adicionar (3 passos, sem código)
1. **Convidar no painel do Supabase:** *Authentication → Users → Invite user*, digite o e-mail. A pessoa recebe um e-mail para definir a senha. (Requer SMTP configurado; veja a documentação do Supabase (Auth → SMTP).)
2. **Associar à organização:** em *SQL Editor*, troque o `slug`, o e-mail e o papel e execute:

```sql
insert into public.organization_members (organization_id, user_id, role)
select o.id, u.id, 'member'          -- papéis: owner, admin, manager, member, viewer
from public.organizations o
join auth.users u on lower(u.email) = lower('pessoa@empresa.com')
where o.slug = 'slug-da-organizacao';
```
O `slug` aparece na tabela `organizations` (coluna `slug`).
3. **Conferir:** a pessoa entra e vê a organização. A associação aparece em **Auditoria**.

## Cuidados
- **Papel mínimo necessário.** Dê `owner` ou `admin` só a quem precisa: esses papéis **exigem verificação em duas etapas** (a pessoa será levada a cadastrar o autenticador no primeiro acesso).
- **O SQL Editor ignora as regras de acesso** (roda como administrador do banco). Use só você, nunca exponha esse acesso ao cliente.
- **Remover pessoa:** tela **Equipe → Remover**. O proprietário único não pode ser removido ou rebaixado.
- **LGPD:** registre quem tem acesso e por quê; remova quem sai da empresa.

## Se quiser um convite dentro do app
Peça ao agente algo como: "implemente convite de membros por e-mail: tabela de convites com token aleatório guardado só como hash, expiração de 7 dias, uso único, válido apenas para o e-mail convidado, só owner/admin convida, sem papel maior que o do convidante, auditoria do convite e do aceite, e testes RLS A/B e E2E". Siga `docs/SECURITY.md`.

## Papéis na Central de Chamados
| Papel no Supabase/Core | Perfil na Central |
|---|---|
| `owner` / `admin` | Proprietário (2º fator obrigatório) |
| `manager` | Gestor |
| `member` | Atendente (depois, em **Equipes**, marque as equipes dele) |
| `viewer` | **Solicitante** (portal) |
Depois de associar um atendente, adicione-o a uma equipe; sem equipe ele só vê chamados atribuídos diretamente a ele.
