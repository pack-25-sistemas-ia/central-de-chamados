# PERMISSIONS — Central de Chamados

Perfis derivados do papel da pessoa na empresa (Core). **O banco aplica tudo** (`private.tk_profile`, `tk_guard`, RLS e funções `tk_*`); a interface só reflete. O solicitante **não** é um atendente com menus ocultos: o DTO dele é montado no banco sem notas, eventos, SLA, equipes nem responsável.

| Perfil | Papel no Core | Acesso |
|---|---|---|
| Proprietário | `owner` / `admin` | Tudo: marca, políticas, expediente e metas de SLA, pessoas, equipes, categorias, respostas prontas, relatórios; exige 2º fator no banco. |
| Gestor | `manager` | Todos os chamados da empresa; equipes, categorias, respostas prontas, distribuição, relatórios. Não altera políticas, marca nem propriedade. |
| Atendente | `member` (ativo) | Chamados **atribuídos a ele ou às suas equipes**; assume chamados sem responsável da própria equipe; responde, anota, muda prioridade/categoria, pede informação, resolve; devolve à fila o que é dele. Não atribui a terceiros, não move equipe. |
| Solicitante | `viewer` | Abre chamados; vê **só os próprios**; responde e anexa; confirma a solução; reabre na janela. Não vê notas internas, eventos, SLA, equipes, responsável nem outros chamados. |
| Sem acesso | atendente desativado, ou sem papel | Nada (404 nas telas; funções recusam). A autoria histórica é preservada. |

## Matriz
| Ação | Prop. | Gestor | Atendente | Solicitante |
|---|:-:|:-:|:-:|:-:|
| Abrir chamado (próprio) | ✓ | ✓ | ✓ | ✓ |
| Abrir em nome de solicitante | ✓ | ✓ | ✓ (atribui só a si) | — |
| Ver chamado | todos | todos | da equipe/atribuídos | próprios |
| Resposta pública | ✓ | ✓ | ✓ | ✓ (nos próprios) |
| Nota interna e seus anexos | ✓ | ✓ | ✓ | — |
| Assumir | ✓* | ✓* | ✓ | — |
| Atribuir a outra pessoa / mover de equipe | ✓ | ✓ | — | — |
| Prioridade e categoria | ✓ | ✓ | ✓ | — |
| Pedir informação (pausa) / resolver / encerrar | ✓ | ✓ | ✓ | — |
| Confirmar solução | — | — | — | ✓ |
| Reabrir (na janela, com motivo) | ✓ | ✓ | ✓ | ✓ |
| Equipes, categorias, respostas prontas | ✓ | ✓ | — | — |
| Desativar/reativar atendente | ✓ | ✓ | — | — |
| Marca, políticas, expediente e metas de SLA, limpar órfãos | ✓ | limpar órfãos | — | — |
| Painel, relatórios e CSV | ✓ | ✓ | do seu escopo | — |
\* O responsável precisa **pertencer à equipe do chamado** (regra do banco para qualquer atribuição).

## Responsável válido
Membro ativo, perfil de equipe (owner/admin/manager/member) e participante da equipe do chamado (`private.tk_assignable`, reforçado por gatilho). Trocar a equipe remove o responsável incompatível com evento auditado; sair da equipe devolve à fila os chamados abertos da pessoa; desativar um atendente exige escolher **devolver à fila** ou **reatribuir**.

## Associação
Não existe cadastro público em empresa. Pessoas entram por convite do Supabase Auth + associação (`docs/MEMBROS.md`); conhecer o id ou o slug da empresa não concede acesso.
