---
name: attachments-storage
description: Use ao alterar upload, download, tipos permitidos ou políticas do Storage de anexos e logotipo.
---

# attachments-storage

- Bucket `tk-attachments` **privado**. O servidor lê os bytes, confere tipo (`lib/tickets/attachments.ts#sniff`: PNG/JPEG/WebP/GIF/PDF/texto/CSV), tamanho (limite da empresa, teto 10 MB), gera o caminho `<empresa>/<chamado>/<hash>.<ext>` e envia com a sessão do usuário. Recusa SVG, HTML/XML, executáveis e zip.
- A RPC (`tk_add_attachments`) revalida caminho (mesma empresa e chamado), tipo e tamanho e herda a visibilidade da mensagem.
- Download: `tk_attachment_info` (autorização no banco) → URL assinada de 60 s com download forçado; nunca exponha o caminho.
- Políticas do Storage: leitura só se existir anexo registrado visível; exclusão só de órfãos (>2 h) pela gestão.
- Sem antivírus: não afirme o contrário.
- Testes: `tests/unit/attachments.test.ts`, `60_tk_queue_attachments.sql` (5), `tk-ops.spec.ts`.
