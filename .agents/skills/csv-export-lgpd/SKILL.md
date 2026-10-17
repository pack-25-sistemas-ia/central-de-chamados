---
name: csv-export-lgpd
description: Use ao exportar dados, tratar retenção/exclusão ou registrar auditoria.
---

# csv-export-lgpd

- CSV via `lib/tickets/csv.ts`: separador `;`, UTF-8 com BOM, CRLF; células que começam com `= + - @` ou controle ganham apóstrofo. A rota `/api/exportar/chamados` exige sessão e perfil de equipe, usa os mesmos filtros/escopo da fila (`tk_export_rows`, máx. 5000) e chama `tk_log_export` (auditoria sem PII).
- Exporte só o necessário: sem corpo de mensagem nem e-mail.
- O sistema não exclui chamados pela interface; retenção, exclusão e anonimização são administrativas (`docs/SECURITY.md`). Não crie exclusão em massa.
- Nunca logue nome, e-mail, assunto ou corpo de mensagem.
- Testes: `csv.test.ts`, `tk-ops.spec.ts`; mutantes `exportação:`.
