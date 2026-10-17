# DATA_MODEL — Central de Chamados

Toda tabela de negócio tem `organization_id` e RLS. Relações usam **chave composta `(id, organization_id)`**: nenhum registro aponta para outra empresa. Escrita só por RPCs `tk_*`; `anon` não tem acesso a nada; `authenticated` só tem SELECT (nas tabelas com política).

| Tabela | Conteúdo | Integridade |
|---|---|---|
| `ticket_settings` | Nome exibido, logotipo, cor, fuso, janela de reabertura (h), tamanho máximo de anexo, texto de retenção | Convive com `organization_settings` do Core (tema do painel); marca é mantida em sincronia. Anexo ≤ 10 MB |
| `teams`, `team_members` | Equipes e participantes | Chave composta; participante precisa ser membro da empresa |
| `agent_status` | Atendente ativo/desativado | Desativar preserva autoria; perde acesso e atribuição |
| `ticket_categories` | Nome, equipe padrão, ativa | Nome único por empresa; equipe da mesma empresa |
| `business_calendar_versions` | Fuso + `definition` (`weekly`, `closed_dates`) | **Imutável** (append-only) |
| `sla_policy_versions` | Calendário + metas por prioridade (min úteis) | **Imutável**; vigente = a mais recente |
| `ticket_counters` | Último número por empresa | Atualizado com trava de linha (sem `MAX+1`) |
| `tickets` | Número legível, solicitante, assunto, categoria, prioridade, status, equipe, responsável, **versão**, `last_public_activity_at` | `(organização, número)` único; transições validadas por gatilho; responsável precisa ser atribuível (ativo, perfil de equipe, na equipe); sem DELETE |
| `ticket_messages` | Autor, `author_kind` (requester/staff/system), `visibility` (public/internal), texto | **Append-only**; solicitante só publica `public` |
| `ticket_attachments` | Caminho no Storage, nome, tipo, tamanho, mensagem | Herda a visibilidade da mensagem; caminho único; append-only |
| `ticket_events` | Tipo e metadados seguros | **Append-only**; só a equipe lê |
| `ticket_service_cycles` | Ciclo (nº), política, prioridade-base, metas, início, 1ª resposta, resolução, encerramento | **Um ciclo ativo** por chamado (índice parcial); só os 3 marcos mudam, uma vez |
| `ticket_sla_pauses` | Início/fim de cada pausa | **Uma pausa aberta** por ciclo; só se fecha |
| `canned_responses` | Título e texto | Só a equipe lê |
| `notifications` | Destinatário, chamado, tipo, lida | Só o destinatário lê; criadas na transação da ação |
| `mutation_requests` | Idempotência (chave, hash do conteúdo, resultado) | Sem política: ilegível pela API |
| `ticket_rate_limits` | Contadores de abuso por usuário | Sem política |

Também usados do Core: `organizations`, `organization_members`, `organization_settings`, `profiles`, `audit_log`.

## Perfis (derivados do papel)
`owner/admin → proprietário` · `manager → gestor` · `member (ativo) → atendente` · `viewer → solicitante`. Detalhes em `docs/PERMISSIONS.md`.

## Storage
`tk-attachments` (**privado**, 10 MB, imagem/PDF/texto): insere quem tem perfil na empresa e caminho no formato do servidor; lê **somente** se existir anexo registrado e o usuário puder ver a mensagem; apaga só a gestão e só órfãos (>2 h). `tk-logos` (público, 512 KB, png/jpeg/webp): só o proprietário grava.

## Migrações (ordem)
`000000_tk_schema` · `000050_tk_access` · `000100_tk_guards` · `000300_tk_sla` · `000400_tk_registry` · `000500_tk_tickets` · `000600_tk_reads` · `000700_tk_storage` · `999999_tk_privileges` (sempre a última: revoga e concede EXECUTE; **nenhuma função é concedida a `anon`**).
