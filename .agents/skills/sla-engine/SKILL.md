---
name: sla-engine
description: Use ao alterar cálculo de SLA, expediente, pausas, ciclos, metas, estados de SLA ou fórmulas do painel.
---

# sla-engine

- **Fonte de verdade = SQL** (`private.tk_bminutes`, `tk_consumed`, `tk_metric`, `tk_cycle_sla`, `tk_start_cycle`). O espelho `lib/sla/*` deve dar os mesmos resultados; mude os dois e os testes com os **mesmos valores** (`55_tk_sla_dashboard.sql` × `tests/unit/sla-*.test.ts`).
- Tempo = minutos **úteis** (expediente local do fuso da versão do calendário, vários intervalos, dias sem expediente) menos as pausas. Sem cron: o estado é calculado na leitura.
- Estados: cumprido/descumprido (marco existe) · atrasado (> meta; a pausa **não** esconde) · pausado · próximo do limite (≥ 80%) · dentro do prazo.
- Ciclo fixa política, prioridade-base e metas no início; só os 3 marcos mudam, uma vez. Prioridade operacional não reescreve a meta. Versões de calendário/política são imutáveis.
- Primeira resposta = 1ª mensagem **pública** da equipe (nota interna, sistema e abertura administrativa não contam).
- Painel: por chamado × por ciclo; denominador zero = «Sem dados»; mostre ciclos abertos já atrasados.
- Antes de mudar: `docs/SLA.md`. Depois: `pnpm test`, `pnpm test:db`, `pnpm test:mutation --only "sla/|painel/"`.
