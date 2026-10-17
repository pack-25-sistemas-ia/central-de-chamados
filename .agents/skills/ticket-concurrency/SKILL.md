---
name: ticket-concurrency
description: Use ao criar ou alterar qualquer operação que grava em chamado, mensagem, ciclo ou pausa.
---

# ticket-concurrency

- Toda escrita começa com `private.tk_load_ticket(org, ticket, true, expected)` (trava a linha, confere acesso e versão). Sem ela, assumir/resolver/reabrir deixam de ter um vencedor.
- Número do chamado: contador por empresa (`update … returning`), **nunca** `MAX+1`.
- Idempotência: `tk_idem(org, user, chave, escopo, hash)`; a abertura usa a chave como id do chamado. Mesma chave + conteúdo diferente = recusa.
- Invariantes (índices parciais + gatilhos): um ciclo ativo por chamado, uma pausa aberta por ciclo, «aguardando solicitante» ⇔ pausa aberta, responsável na equipe.
- Cuidado com `NULL` em condições `if`: `not NULL` não dispara; use `coalesce`/`is distinct from`.
- Testes: `scripts/test-concurrency.mjs` (sessões reais). Rode sem outra carga; margens de tempo ficam generosas.
