---
name: ticket-visibility
description: Use ao criar ou alterar qualquer leitura, DTO, tela ou rota que mostre dados de chamados (principalmente para o solicitante).
---

# ticket-visibility

- O solicitante (Core `viewer`) NÃO é atendente com menus ocultos. Nunca envie ao navegador dele: notas internas, anexos internos, eventos, ciclos/SLA, calendário, equipe, responsável, e-mail de colegas.
- A separação é feita **no banco** (RLS + DTOs `tk_ticket_detail`/`tk_queue`), não em CSS nem em `if` de componente. Nova leitura = nova função `tk_*` ou política, com teste A/B (`60_tk_queue_attachments.sql`, `70_tk_security.sql`) e E2E de API (`tk-security.spec.ts`).
- Escopo: gestão vê tudo; atendente vê atribuídos + equipes; solicitante só os próprios. `tk_ticket_visible` retorna **false** (nunca NULL) para quem não vê.
- Rotas do portal (`/portal/<slug>`): o slug identifica a empresa, não dá acesso.
- Texto sempre como texto (sem HTML/Markdown). Teste XSS em `tk-security.spec.ts`.
