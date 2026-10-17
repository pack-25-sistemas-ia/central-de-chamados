# ARCHITECTURE — Central de Chamados

## Visão geral
Next.js 16 (App Router, React 19, TypeScript strict, Tailwind 4) sobre Supabase (Auth, PostgreSQL, Storage). Sem backend separado e **sem `service_role`**: o app fala com o banco **como o usuário logado** (RLS + funções `tk_*`). Este sistema **não tem nenhuma porta pública (anon)**.

```
Navegador ── sessão + MFA ──▶ Server Components/Actions/Route Handlers ──▶ cliente do usuário ──▶ SELECT (RLS) + public.tk_* (escrita e leituras montadas)
                                                                            └─ private.tk_* (regras; ninguém chama direto)
Storage privado (tk-attachments) ◀── upload pelo servidor (sessão do usuário) · download por URL assinada de 60 s, depois de tk_attachment_info
```

## Camadas
| Camada | Onde | Papel |
|---|---|---|
| Regras e integridade | `supabase/migrations/20271201*` | Fonte de verdade: estados, atribuição, SLA (`tk_bminutes`, `tk_metric`), ciclos, pausas, idempotência, número sequencial, versão otimista, auditoria |
| Leitura | RLS (`000050_tk_access`) | Só SELECT, por perfil e por equipe; solicitante só os próprios e só mensagens públicas |
| Escrita | RPCs `public.tk_*` | SECURITY DEFINER, `search_path` vazio, validam sessão, MFA, perfil e que os ids são da MESMA empresa |
| DTOs | `tk_queue`, `tk_ticket_detail`, `tk_dashboard`, `tk_export_rows` | O DTO do solicitante é montado **no banco** (sem notas, eventos, SLA, equipe, responsável) |
| Espelho TS | `lib/sla/*`, `lib/tickets/status.ts` | Projeta vencimentos, decide o que mostrar e fixa as regras em testes com os mesmos valores do SQL; **nunca grava** |
| Ações | `lib/tickets/actions/*` | Validação (Zod), anexos, chamada da RPC, mensagem amigável, `revalidatePath` |
| UI | `app/(app)/*`, `components/tk/*` | Server Components; formulários por contexto (`TkForm`); tabelas no servidor, sem TanStack/DnD |

## Fluxo de um chamado
1. **Abrir** (`tk_open_ticket`): contador por empresa (trava de linha) → ticket + mensagem inicial pública + ciclo 1 (política vigente) + evento + notificações, **numa transação**; chave de idempotência = id do chamado.
2. **Assumir** (`tk_claim`): trava de linha; só quem chega primeiro vence; exige pertencer à equipe.
3. **Conversar** (`tk_post_message`): resposta pública (marca a 1ª resposta do ciclo), nota interna (não conta nem notifica o solicitante) ou resposta + «pedir informação» (abre a pausa) / «resolver» (fecha a pausa e marca a resolução) — **mesma transação**.
4. **Responder** (solicitante): se estava aguardando, volta a «em atendimento» e a pausa é encerrada.
5. **Resolver → confirmar/encerrar** (`tk_confirm`, `tk_set_status`) ou **reabrir** (`tk_reopen`): encerra o ciclo anterior, abre o novo com a política vigente e registra o motivo.

## Concorrência
Alterações do chamado fazem `select … for update`; metadados usam **versão otimista** (`expected` → «alterado por outra pessoa»); aberturas usam contador atômico e chave de idempotência; índices únicos parciais garantem **um ciclo ativo** e **uma pausa aberta**. Testado com sessões reais em `scripts/test-concurrency.mjs`.

## Anexos
Servidor lê os bytes, confere tipo (allowlist) e tamanho, gera o caminho `<empresa>/<chamado>/<hash>.<ext>` e envia com a sessão do usuário (política do bucket confere a empresa). A RPC vincula o anexo à mensagem (herda a visibilidade). Download: `tk_attachment_info` (autorização no banco) → URL assinada de 60 s com download forçado. Uploads sem vínculo são **órfãos**: a gestão os remove depois de 2 h (`tk_orphan_uploads` + política de exclusão só para órfãos).

## Tempo
Instantes em `timestamptz`; expediente em hora local do fuso IANA da versão do calendário; SLA calculado na leitura. Ver `docs/SLA.md`.

## Estrutura de pastas
`app/(app)/*` telas (rotas em português) · `app/api/{anexos,exportar}` · `app/marca/logo` · `lib/sla` · `lib/tickets` · `components/tk` · `supabase/{migrations,tests,seed-demo.sql}` · `scripts` (seed, testes de banco/concorrência/mutação) · `tests/{unit,e2e}` · `.agents/skills`.
