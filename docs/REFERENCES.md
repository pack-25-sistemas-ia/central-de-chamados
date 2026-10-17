# REFERENCES — Central de Chamados

Avaliação **antes** do código. Consulta em **2026-10-17** pela API do GitHub (licença, estrelas, último commit na data) e pelo `npm view` (versão/licença dos pacotes). Estrelas são sinal complementar, não critério técnico. **Nenhum código de terceiros foi copiado** e nenhuma dependência nova foi adicionada além do Core web.

| Projeto | URL | Estrelas | Versão/commit avaliado | Licença | Aspectos úteis | Restrições | Decisão |
|---|---|---|---|---|---|---|---|
| Chatwoot | https://github.com/chatwoot/chatwoot | 37.889 | v4.18.0 (18/09/2026) · commit `4e6a4d3ad4` | **MIT**, exceto o diretório `enterprise/` (licença própria, proprietária); componentes de terceiros mantêm a licença original | Triagem por caixa de entrada, atribuição (assumir/atribuir), distinção entre resposta e nota privada na conversa | Foco em conversa em tempo real/omnicanal (fora do escopo); `enterprise/` não pode ser usado | **Só referência de produto** (nada copiado) |
| Zammad | https://github.com/zammad/zammad | 6.015 | branch `develop`, commit `228b456174` (sem release «latest» na API) | **AGPL-3.0** | Visões de fila, ciclo de estados, SLA com calendários e escalonamento | Copyleft de rede: copiar obrigaria a abrir o sistema inteiro | **Só referência conceitual** (nada lido em código) |
| FreeScout | https://github.com/freescout-help-desk/freescout | 4.604 | 1.8.248 (17/10/2026) · commit `56c4d014cf` | **AGPL-3.0** | Composição da tela de atendimento (conversa + coluna lateral), notas internas | Copyleft de rede; módulos pagos | **Só referência de produto** |
| shadcn/ui | https://github.com/shadcn-ui/ui | 125.787 | commit `d2fba50ee5` | MIT | Padrões de componentes acessíveis | Os componentes são copiados, não dependência; o Core já traz as primitivas necessárias | **Referência de UX** (nada copiado) |
| TanStack Table | https://github.com/TanStack/table | 28.496 | `@tanstack/react-table` 9.3.1 · commit `95c4768496` | MIT | Tabelas com ordenação/filtro no cliente | Exige JavaScript no cliente; aqui filtros, ordenação e paginação são **no servidor** por URL | **Não adotado** (D-T14) |
| dnd-kit | https://github.com/clauderic/dnd-kit | 17.723 | `@dnd-kit/core` 6.3.1 · commit `01bc678e93` | MIT | Arrastar-e-soltar no quadro | O prompt exige operar sem arrastar; mover de estado pede mensagem (pausa/resolução) | **Não adotado** (D-T14) |

## Observações
- **Chatwoot**: a licença do repositório é MIT *com exceção* (`enterprise/`). Mesmo assim optamos por não incorporar nada: a arquitetura (omnicanal, tempo real) é diferente da nossa e o ganho seria nulo.
- **AGPL (Zammad, FreeScout)**: usados apenas para entender o produto (filas, SLA, notas); sem leitura nem cópia de implementação.
- **Dependências**: nenhuma adicionada; `recharts`, `decimal.js`, `papaparse` etc. não são necessários aqui (painel em tabelas e `<progress>`; fórmulas simples).
- **React Hook Form**, previsto na stack padrão do prompt, não foi adotado: Server Actions, Zod e formulários nativos preservam o texto digitado (ver `components/tk/use-tk-action.ts`) com menos JavaScript.

## Pesquisa pendente
Nenhuma. Se uma consulta futura contradisser licença ou versão acima, atualize esta tabela e o `THIRD_PARTY_NOTICES.md` do Pack.
