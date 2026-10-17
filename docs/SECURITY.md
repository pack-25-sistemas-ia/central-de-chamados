# SECURITY — Central de Chamados

## Superfície
**Não há porta pública:** nenhuma função `tk_*` é executável por `anon` e `anon` não lê nem escreve em nenhuma tabela (testado: `70_tk_security.sql`, `tk-security.spec.ts`). Formulário público anônimo está fora do MVP. O app não usa `service_role`. O slug da empresa identifica o portal mas **não dá acesso**: só quem já é membro entra (associação por convite do Supabase Auth + SQL documentado).

## Autorização
Perfis do banco (`private.tk_profile`) + `tk_guard` (sessão, **MFA aal2 para proprietário/administrador**, perfil mínimo) em toda função. RLS só de leitura; toda escrita por `tk_*` (SECURITY DEFINER, `search_path` vazio, EXECUTE só para `authenticated`; auxiliares internos sem EXECUTE, exceto as de RLS). Cada função confere que os ids pertencem à **mesma empresa** (chaves compostas e checagens); `organization_id` do navegador nunca é confiado. Testes A/B entre empresas e entre solicitantes.

## Separação entre mensagens públicas e internas
`visibility` é uma coluna; a RLS e os DTOs (`tk_ticket_detail`, `tk_queue`) só entregam `internal` à equipe com acesso ao chamado. **Nota interna não é enviada ao navegador do solicitante** (não é escondida por CSS). Anexo de nota interna herda a visibilidade interna (tela, API REST e Storage direto negados ao solicitante). Eventos, ciclos/SLA, equipes e responsável também não saem para o solicitante.

## Anexos
Bucket **privado**; tipo conferido pelos bytes (PNG, JPEG, WebP, GIF, PDF, texto/CSV); recusa SVG, HTML/XML, executáveis, zip/office; limite configurável com teto de 10 MB; até 3 por mensagem; caminho gerado no servidor; nome sanitizado; download por URL assinada de **60 s** com download forçado depois da autorização no banco; sem Referer; sem cache. **Não há antivírus**: não afirmamos o contrário. Uploads órfãos são removidos pela gestão (>2 h) e a política de exclusão do Storage só permite apagar órfãos.

## Entrada e saída
Validação no servidor (Zod nas ações; `check` e funções no banco). Texto sempre renderizado como texto (teste de XSS em assunto e mensagem). CSV com «;», UTF-8 com BOM, células que começam com `= + - @` ou controle recebem apóstrofo; sem corpo de mensagem nem e-mail; cada exportação é auditada (só a quantidade de linhas).

## Abuso e consistência
Limite por usuário no banco (`tk_rate_hit`: aberturas, mensagens, reaberturas) e em memória por instância nas ações e exportações; paginação e tamanhos limitados (50 por página, 5000 linhas por exportação). Idempotência (duplo envio), versão otimista e travas de linha (testado em `test-concurrency.mjs`). CSP estrita com nonce; sem estilo/script em linha.

## Auditoria, retenção, exclusão e anonimização
`audit_log` (Core) registra mudanças administrativas (equipes, categorias, respostas prontas, atendentes, políticas e versões de SLA, configurações) e as exportações, só com metadados; `ticket_events` registra status, prioridade, equipe, responsável, reabertura, resolução e fechamento de cada chamado. Mensagens, eventos, ciclos, pausas e versões são **imutáveis**; a interface não exclui nada.
- **Retenção**: defina o prazo no texto de *Configurações → retenção* (a demonstração usa 24 meses após o encerramento) e execute-o como rotina administrativa.
- **Exclusão/anonimização** (pedido de titular ou fim da retenção): administrativa, direto no banco, por quem implanta (controlador). Procedimento recomendado: exportar o que for devido ao titular; para anonimizar, trocar nome/e-mail em `profiles` e apagar o conteúdo livre das mensagens do titular numa janela de manutenção que desabilite temporariamente o gatilho `append_ticket_messages` e registre a operação; para excluir por completo, remover primeiro os anexos do Storage e depois as linhas na ordem inversa das chaves. Não há botão de exclusão em massa por não haver política única para todas as empresas.
- Solicitações de titulares podem ser registradas em *Privacidade (LGPD)* (Core).

## Segredos
Nenhum segredo de servidor próprio. `.env*` fora do git; o seed de demonstração gera senha aleatória e não a versiona. `check-no-secrets` do Pack roda na CI.

## Verificação
`pnpm test:db` (privilégios, `search_path`, RLS ligada, A/B, MFA) · `tk-security.spec.ts` (anon, solicitante pela API, XSS, CSP, idempotência, versão, concorrência) · `tk-ops.spec.ts` (anexos e Storage) · `pnpm test:mutation` (remove cada defesa e exige que um teste falhe).

## Reportar vulnerabilidade
Veja o `SECURITY.md` do repositório do Pack.
