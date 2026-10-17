# MEMORY — CENTRAL DE CHAMADOS
Atualizado em: 2026-10-17 | Versão: 1.0.0 | Estado: VALIDADO

## Missão do sistema
Help desk para equipes de suporte interno ou externo: portal do solicitante, fila (tabela e quadro), respostas públicas e notas internas separadas no banco, SLA de primeira resposta e resolução em minutos úteis, atribuição segura sob concorrência, painel e CSV. Risco LGPD: médio (nome, e-mail, conteúdo do chamado, anexos).

## Stack e caminhos-chave
Next.js 16 (App Router) + React 19 + TypeScript strict + Tailwind 4 + Supabase (Auth, PostgreSQL, Storage). Banco: `supabase/migrations/20271201*` (escrita só por RPCs `tk_*` SECURITY DEFINER; RLS só SELECT; FKs compostas). SLA: `tk_sla.sql` (banco, fonte de verdade) com espelho TS em `lib/sla/*`. Domínio TS: `lib/tickets/*`. UI: `app/(app)/*`, `app/(app)/portal/[slug]`, `components/tk`. Testes: `tests/unit`, `tests/e2e`, `supabase/tests`, `scripts/test-*.mjs`, `scripts/mutation-check.mjs`. Skills: `.agents/skills/*`.
Comandos: `pnpm lint | typecheck | test | build | test:db | test:concurrency | test:mutation | test:e2e` (E2E na porta 3126, ver docs/DEPLOYMENT.md). Seed: `node scripts/seed-demo.mjs` (empresa «Suporte Aurora TI (demonstração)», 32 chamados, relativo à data).

## Implementado e verificado (2026-10-17, com evidência)
- Portal do solicitante; fila em tabela e quadro com filtros e paginação no servidor; detalhe com conversa pública e notas internas (DTO do solicitante montado no banco, sem notas, eventos, SLA, equipe nem responsável); respostas prontas; equipes, categorias, configurações, marca e logotipo; notificações internas; painel por chamado e por ciclo; CSV (`;`, BOM, anti-injeção de fórmula) com auditoria sem PII.
- SLA em minutos úteis (calendário, fuso, feriados, pausa enquanto aguarda o solicitante, ciclos com snapshots de política, reabertura com novo ciclo). Estados: met, breached, overdue, paused, at_risk, on_track; pausa não esconde atraso.
- Concorrência: número por contador com trava, idempotência por chave, versão otimista (40001), assumir/atribuir com trava de linha.
- Anexos privados com tipo real pelos bytes (recusa SVG/HTML/zip/exe), URL assinada de 60 s.
- `pnpm lint`, `pnpm typecheck`: sem erros. `pnpm test`: 127 testes em 8 arquivos. `pnpm build`: ok.
- `pnpm test:db` (Core + sistema): todos passam — `50_tk_domain` (13 blocos), `55_tk_sla_dashboard`, `60_tk_queue_attachments`, `70_tk_security`.
- `pnpm test:concurrency`: passa (aberturas simultâneas com 12 usuários, duplo envio, assumir, versão antiga, pausa × resposta, resoluções e reaberturas simultâneas, troca de equipe × atribuição, invariantes).
- E2E (Playwright, app compilado, banco recriado antes de cada arquivo): core-flow 5, email-flows 3, security 5, tk-flow 10, tk-demo 9, tk-ops 5, tk-security 6, tk-responsive 5 — **48 passam**.
- `pnpm test:mutation`: **164/164 mutações reprovadas** (rodada completa final). Mutantes equivalentes removidos e documentados: intervalo invertido, NUL aceito, reabertura sem trava de linha, atribuir a quem não é da equipe (o gatilho `ticket_guard` tem a mesma mensagem).
- Revisão visual desktop (1440) e celular (375) feita em capturas.

## Em implementação
- Nada.

## Pendências e riscos
- Fora do escopo do MVP: entrada de chamados por e-mail, chat em tempo real, telefonia, base de conhecimento pública, pesquisa de satisfação, arrastar-e-soltar (docs/DECISIONS.md).
- Rate limit em memória é por instância; o limite no banco vale em qualquer instância. Sem CAPTCHA no MVP.
- Retenção/exclusão de chamados é administrativa (docs/SECURITY.md); a interface não exclui.
- Comprador precisa do próprio Supabase (região Brasil), SMTP, MFA e hospedagem (docs/DEPLOYMENT.md).

## Decisões relevantes
Ver docs/DECISIONS.md (D-T1…T19). Principais: SLA calculado no banco com espelho TS (mesmos valores); versões de calendário/política imutáveis; ciclo de atendimento por reabertura; visibilidade decidida no banco (`tk_ticket_visible`, `tk_message_visible`); sem recharts, TanStack, dnd-kit nem react-hook-form; CSP sem `style=""`.

## Testes executados
Ver «Implementado e verificado». Mutação: 8 sobreviventes na rodada do banco viraram testes diretos (50, 55, 60); 7 mortos, 1 equivalente removido; rodada final 164/164.

## Armadilhas (para não repetir)
- `created_at` igual na mesma transação não desempata versões: usar `clock_timestamp()` (causava flake e falsos «mortos» nos mutantes).
- Teste de concorrência de abertura com um único usuário é serializado pelo rate limit: usar usuários distintos.
- Em testes de mutante, `test.has` com padrão genérico (`%reabrir%`) casa a mensagem do próximo erro; use um trecho exclusivo da mensagem do guarda.
- Condição `NOT NULL` não dispara com NULL: `coalesce` em funções de visibilidade. Variável PL/pgSQL com nome de coluna é ambígua.
- Em E2E, cartões mobile (`md:hidden`) duplicam seletores da tabela; o spec do Core espera h1 «Painel» no `/dashboard` e 404 em `/settings`, `/audit`, `/privacy` para o leitor.
- Não editar migrações/testes enquanto a mutação roda. Tabela temporária não cabe em função STABLE.

## Próxima tarefa recomendada
1. Se o comprador quiser, adicionar entrada por e-mail com fila e consentimento (docs/DECISIONS.md).
2. Opcional: CAPTCHA no portal e pesquisa de satisfação.

## Referências
docs/FEATURES.md · docs/DATA_MODEL.md · docs/ARCHITECTURE.md · docs/DECISIONS.md · docs/REFERENCES.md · docs/SECURITY.md · docs/SLA.md · docs/PERMISSIONS.md · docs/DEPLOYMENT.md
