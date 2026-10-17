# FEATURES — Central de Chamados
Status: VERIFIED = existe e tem evidência (arquivo/teste). O que não foi feito está em «Fora do escopo», não como pendência.

| Fluxo | Status | Evidência |
|---|---|---|
| Login, recuperação de acesso, organizações, membros e MFA (Core) | VERIFIED | `tests/e2e/core-flow.spec.ts`, `email-flows.spec.ts`, `security.spec.ts` |
| Perfis e permissões no banco (proprietário, gestor, atendente, solicitante) | VERIFIED | `supabase/tests/50_tk_domain.sql`, `70_tk_security.sql`, `tk-demo.spec.ts` |
| Abertura pelo solicitante e administrativa, número legível, idempotência | VERIFIED | `50_tk_domain.sql` (3, 9), `test-concurrency.mjs`, `tk-flow.spec.ts` |
| Equipes, categorias (equipe padrão), responsável válido | VERIFIED | `50_tk_domain.sql` (1, 7, 10), `tk-demo.spec.ts` |
| Fila (tabela e quadro), filtros, visões, paginação no servidor | VERIFIED | `60_tk_queue_attachments.sql` (3, 4), `tk-demo.spec.ts` |
| Conversa: resposta pública × nota interna (separadas no banco) | VERIFIED | `50_tk_domain.sql` (5), `tk-flow.spec.ts`, `tk-security.spec.ts` |
| Anexos privados (tipo por bytes, limite, URL assinada, herança de visibilidade) | VERIFIED | `attachments.test.ts`, `60_tk_queue_attachments.sql` (5), `tk-ops.spec.ts` |
| Estados, assumir (um vence), versão otimista, reabertura com novo ciclo | VERIFIED | `50_tk_domain.sql` (6–8), `ticket-status.test.ts`, `test-concurrency.mjs` |
| SLA em minutos úteis: expediente, fuso, pausas, ciclos, snapshots | VERIFIED | `55_tk_sla_dashboard.sql`, `sla-*.test.ts` |
| Calendário e metas editáveis (versões imutáveis) | VERIFIED | `60_tk_queue_attachments.sql` (7), `tk-ops.spec.ts` |
| Respostas prontas (só preenchem o texto) | VERIFIED | `tk-demo.spec.ts` |
| Notificações internas | VERIFIED | `60_tk_queue_attachments.sql` (6), `tk-demo.spec.ts` |
| Painel com dados reais e fórmulas por chamado × por ciclo | VERIFIED | `55_tk_sla_dashboard.sql` (6), `sla-metrics.test.ts`, `tk-flow.spec.ts` (11) |
| Exportação CSV segura (fórmulas neutralizadas, escopo, auditada) | VERIFIED | `csv.test.ts`, `tk-ops.spec.ts` |
| Marca: nome, cor e logotipo | VERIFIED | `tk-ops.spec.ts` |
| Desativar atendente com destino explícito dos chamados | VERIFIED | `50_tk_domain.sql` (10), `tk-demo.spec.ts` |
| Segurança (anon, RLS A/B, MFA, XSS, CSP, limite de abuso) | VERIFIED | `70_tk_security.sql`, `tk-security.spec.ts` |
| Responsivo e acessibilidade básica (375/768/1440) | VERIFIED | `tk-responsive.spec.ts`, `tk-flow.spec.ts` (12) |
| Seed de demonstração coerente e relativo à data | VERIFIED | `supabase/seed-demo.sql`, `scripts/seed-demo.mjs` (confere ao carregar) |

## Fora do escopo (decisão de produto)
Telefonia, WhatsApp, chat em tempo real, e-mail (entrada/saída) como requisito, chatbot, aplicativo nativo, redes sociais, base de conhecimento, ativos, contratos/faturamento, automação visual de workflows, SLA contratual por cliente, feriados automáticos, formulário público anônimo, IA, edição/exclusão de mensagens pela interface.
