---
name: ticket-domain
description: Use ao mexer em chamados, estados, atribuição, mensagens, reabertura ou no modelo de dados da Central de Chamados.
---

# ticket-domain

- Modelo: `tickets` + `ticket_messages` (public/internal, append-only) + `ticket_attachments` + `ticket_events` + `ticket_service_cycles` + `ticket_sla_pauses`. Veja `docs/DATA_MODEL.md`.
- Estados: `open → in_progress ⇄ waiting_requester → resolved → closed`; reabertura volta a `open`/`in_progress` com **novo ciclo**. Regras em `ticket_guard` (banco) **e** `lib/tickets/status.ts` (espelho).
- Pedir informação e resolver exigem **mensagem pública** na mesma transação (`tk_post_message`). Nota interna não conta como resposta e não muda estado.
- Responsável = membro ativo, perfil de equipe e **na equipe do chamado** (RPC + gatilho). Assumir: um vence (trava de linha).
- Metadados exigem a **versão** lida; divergência = «alterado por outra pessoa».
- Histórico é imutável: corrija com novo evento, nunca com UPDATE/DELETE.
- Testes: `supabase/tests/50_tk_domain.sql`, `tests/unit/ticket-status.test.ts`, `scripts/test-concurrency.mjs`.
