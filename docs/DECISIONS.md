# DECISIONS — Central de Chamados

**D-T1 O banco decide estado, SLA e visibilidade.** Transições (gatilho), SLA (`tk_bminutes`/`tk_metric`), ciclos, pausas, número, idempotência e versão vivem em PL/pgSQL; o TypeScript é espelho testado com os mesmos valores (`lib/sla`, `lib/tickets/status.ts`).

**D-T2 Solicitante não é atendente com menus ocultos.** O perfil `requester` (Core `viewer`) tem funções e DTO próprios: o banco nunca lhe entrega notas internas, eventos, ciclos/SLA, equipes nem responsável. Testado por RLS, por RPC e por API.

**D-T3 Mapeamento de papéis sem mudar o Core.** `owner/admin → proprietário`, `manager → gestor`, `member → atendente` (precisa estar numa equipe para ver a fila), `viewer → solicitante`. Atendente desativado vive em `agent_status`, sem alterar `organization_members`.

**D-T4 SLA calculado na leitura.** Estado = função de instantes; sem cron e sem coluna «vence em». A projeção de vencimento (`addBusinessMinutes`) é só exibição.

**D-T5 Ciclos com snapshots.** Cada abertura/reabertura cria um ciclo que fixa política (calendário via política), prioridade-base e metas. Prioridade operacional alterada **não** muda a meta do ciclo; política nova vale para ciclos futuros.

**D-T6 Pausa só em «aguardando solicitante».** Abre ao pedir informação, fecha ao responder/retomar/resolver, na mesma transação. Uma aberta por ciclo (índice parcial). A pausa não esconde atraso anterior.

**D-T7 Pedir informação e resolver exigem mensagem pública.** Evita mudança silenciosa de estado e garante que a primeira resposta exista antes de qualquer resolução. Nota interna nunca muda estado nem conta como resposta.

**D-T8 Reabrir.** Janela contada da resolução do último ciclo (`reopen_window_hours`); exige motivo (público se do solicitante, interno se da equipe); fora da janela orienta novo chamado. Volta para «em atendimento» se o responsável ainda é válido, senão «aberto» sem responsável.

**D-T9 Atribuição estrita.** Responsável = membro ativo, perfil de equipe e participante da equipe do chamado, em RPC **e** gatilho. Assumir é disputado por trava de linha. Trocar equipe remove o responsável incompatível (evento); sair da equipe ou ser desativado exige decidir o destino dos chamados abertos.

**D-T10 Versão otimista.** Alterações de metadados enviam a versão lida; divergência = «alterado por outra pessoa» com botão de atualizar, sem perder o texto digitado.

**D-T11 Idempotência.** Abertura usa a chave como id do chamado; mensagens usam `mutation_requests` (chave + hash do conteúdo). Mesma chave com outro conteúdo é recusada. Anexos têm caminho determinístico (chave + posição + conteúdo) para que reenvios não gerem órfãos.

**D-T12 Anexos privados sem antivírus.** Allowlist por bytes (imagem, PDF, texto/CSV), sem SVG/HTML/executável, limite configurável (teto 10 MB), caminho gerado no servidor, URL assinada de 60 s com download forçado. Não afirmamos verificação de malware.

**D-T13 Texto simples.** Mensagens são texto com quebras de linha (sem Markdown, sem HTML): elimina uma classe de XSS e de links enganosos.

**D-T14 Sem TanStack Table nem dnd-kit.** Tabelas e filtros no servidor, por URL (compartilháveis, sem JS no cliente); o quadro não depende de arrastar. React Hook Form também não foi adotado: Server Actions + Zod + formulários nativos bastam. Ver `docs/REFERENCES.md`.

**D-T15 Notificações internas na mesma transação.** Para quem tem acesso ao chamado e nunca para o autor; sem e-mail (fora do MVP).

**D-T16 Exclusão.** A interface não exclui nem edita mensagens, eventos, ciclos ou versões (gatilhos). Exclusão/anonimização é administrativa e documentada em `docs/SECURITY.md`.

**D-T17 Pastas e slug.** O sistema vive em `sistemas/12-central-de-chamados` e o repositório espelho é `central-de-chamados` (o prompt citava `sistemas/chamados`); o catálogo registra id 12 com esse slug.

**D-T18 `ticket_settings` ao lado do Core.** O Core já tem `organization_settings` (tema do painel); as políticas de chamados ficam em tabela própria e a marca é mantida em sincronia.

**D-T19 IA fora do MVP.** Nada de função de IA vazia; sem chave de LLM o sistema é completo. Se um dia houver, só por habilitação explícita da empresa, ação do usuário, revisão humana e sem alterar estado ou SLA.
