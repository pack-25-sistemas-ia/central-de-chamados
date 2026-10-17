# SLA — Central de Chamados

SLA aqui é **medição em minutos úteis**, não uma data de vencimento. A fonte de verdade é o banco (`private.tk_*`, migração `000300_tk_sla`); `lib/sla/*` é um espelho TypeScript que projeta vencimentos e fixa as regras em testes com **os mesmos valores** (`supabase/tests/55_tk_sla_dashboard.sql` × `tests/unit/sla-*.test.ts`). **Nada depende de cron**: o estado é calculado na leitura a partir de instantes.

## Conceitos
| Termo | Definição |
|---|---|
| Expediente (calendário) | Intervalos semanais em hora **local** do fuso IANA da versão, vários por dia, mais datas sem expediente. Sem integração automática de feriados. |
| Versão de calendário / de política | Imutáveis. Publicar altera só os **próximos** ciclos. A política aponta o calendário e guarda as metas por prioridade. |
| Ciclo de atendimento | Um por abertura/reabertura. Guarda **política, calendário (via política), prioridade-base e metas** no início. Só os marcos `first_response_at`, `resolved_at` e `closed_at` são preenchidos, uma vez (gatilho no banco). |
| Pausa | Intervalo em que o chamado está «aguardando solicitante». No máximo **uma aberta por ciclo**; não se sobrepõem. |
| Consumido | Minutos úteis entre o início do ciclo e o marco (ou «agora») **menos** os minutos úteis das pausas. |

## Marcos
- **Primeira resposta** termina na primeira mensagem **pública** de um membro da equipe. **Não contam:** nota interna, mensagem de sistema e a abertura administrativa (o texto digitado pela equipe em nome do solicitante é registrado como mensagem do solicitante).
- **Resolução** termina quando a equipe resolve. Resolver e pedir informação exigem uma **mensagem pública** (feita na mesma transação que muda o estado); logo a primeira resposta sempre existe quando há resolução.
- **Pausa** começa ao pedir informação (`waiting_requester`) e termina quando o solicitante responde, quando a equipe retoma ou quando o chamado é resolvido — atomicamente.

## Estados
| Estado | Regra (ordem de avaliação) |
|---|---|
| Cumprido / Descumprido | O marco existe: consumido até o marco ≤ meta → cumprido; senão, descumprido. |
| Atrasado | Sem marco e consumido **> meta**. Vale mesmo com o relógio pausado (a pausa não esconde atraso). |
| Pausado | Sem marco, dentro da meta, com pausa aberta. |
| Próximo do limite | Sem marco, relógio correndo e consumido **≥ 80%** da meta (`private.tk_risk_ratio()`, `RISK_RATIO`). |
| Dentro do prazo | Os demais. |
O resumo do ciclo é o pior estado: atrasado > descumprido > pausado > próximo do limite > dentro do prazo > cumprido.

## Snapshots (por que a meta não muda)
- **Política/calendário/metas**: fixados no início do ciclo. Publicar nova versão vale para ciclos futuros; os em andamento mantêm a anterior.
- **Prioridade**: alterar a prioridade operacional **não** reescreve a meta do ciclo em andamento (a interface explica isso); vale para os próximos.
- **Reabertura**: cria novo ciclo com a política **vigente**, preservando integralmente o anterior (inclusive atraso e pausas).
- **Janela de reabertura**: contada a partir da resolução do último ciclo (`reopen_window_hours`, padrão 72 h). Fora da janela o sistema orienta abrir **novo chamado** (não reabre em silêncio).

## Cálculo
`tk_bminutes(def, tz, a, b)`: para cada dia local entre `a` e `b` (máx. 800 dias), soma a interseção dos intervalos do expediente com `[a, b)`; dia listado em `closed_dates` não tem expediente; «24:00» é a meia-noite seguinte. Pausas são subtraídas do mesmo modo. **Horário de verão:** hora local inexistente/ambígua segue a regra do PostgreSQL para `timestamp AT TIME ZONE` (e a do `Intl` no TypeScript); testado em America/New_York na virada de 01/11/2026 (sexta 16–17 + segunda 09–10 = 120 min).

## Exemplos conferidos (calendário padrão, `America/Sao_Paulo`)
- Segunda 08:00 → 09:30 = **30**; segunda 11:00 → 14:00 = **120** (almoço não conta); sexta 17:00 → segunda 10:00 = **120**; semana útil inteira = **2400**; com a quarta sem expediente, segunda 09:00 → quarta 18:00 = **960**.
- Aberto no sábado 10:00 e respondido na segunda 09:30 = **30** min úteis.
- Início segunda 10:00; pausa segunda 11:00 → terça 10:00 (420 úteis); em terça 12:00: 600 − 420 = **180**; segunda pausa de 30 min → **150**.
- Meta de 240: 191 min = dentro do prazo; **192 = 80% = próximo do limite**; 240 ainda não é atraso; 241 é atraso.
- Painel: respostas em 30, 300, 20 e 10 min (meta 240) → 3 de 4 dentro = **75%**, média **90**, mediana **25**.

## Painel: métrica por chamado × por ciclo
Por chamado: criados no período, backlog atual (aberto + em atendimento + aguardando), não atribuídos, distribuições por categoria e prioridade, carga atual por atendente (distribuição de trabalho, **não** ranking de qualidade). Por ciclo: resolvidos no período, reaberturas (ciclos 2+ iniciados no período) e cumprimento de primeira resposta e de resolução (`dentro da meta ÷ concluídos no período`). Os **ciclos abertos já atrasados** aparecem à parte. Denominador zero = «Sem dados».
