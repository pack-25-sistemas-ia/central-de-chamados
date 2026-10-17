# DEPLOYMENT — Central de Chamados

Tudo é seu: seu projeto Supabase, seu repositório, sua hospedagem. Nada é enviado ao autor do Pack.

## Pré-requisitos
Node 22+, pnpm 12, Docker (Supabase local e `pnpm test:db`), conta Supabase com região **São Paulo** (dados pessoais), hospedagem Node (ex.: Vercel).

## Variáveis (`.env.local`, nunca no git)
| Variável | Valor |
|---|---|
| `NEXT_PUBLIC_APP_URL` | URL pública do app |
| `NEXT_PUBLIC_SUPABASE_URL` | URL do seu projeto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | chave publishable/anon (segura no navegador; o acesso é limitado por RLS e pelos privilégios das funções) |

O sistema **não usa** `service_role` e **não tem** segredos de servidor próprios. Não coloque `service_role` em variável alguma.

## Banco e Storage
1. **Local**: `supabase start` e `supabase db reset` (migrações; criam os buckets `tk-attachments` privado e `tk-logos`). Portas 589xx (`project_id = pack25-central-de-chamados`). Demonstração: `node scripts/seed-demo.mjs`.
2. **Produção**: `supabase link --project-ref <ref>` e `supabase db push`. **Não** rode `seed-demo.mjs` (cria usuários e chamados fictícios). Confira em *Storage* que `tk-attachments` continua **privado**.
3. **Autenticação**: confirmação de e-mail ligada, senha mínima de 12, **TOTP (MFA) habilitado** (proprietário/administrador exigem o 2º fator no banco), SMTP próprio, URL do app em Redirect URLs.
4. **Convidar e associar pessoas**: `docs/MEMBROS.md`.
5. **Backup e restauração**: backups diários do Supabase (PITR em plano pago). Restaure o **banco inteiro** e o **Storage**: chamados, mensagens, ciclos, pausas e anexos dependem uns dos outros. Teste a restauração num projeto separado. Os arquivos de anexo ficam no Storage: inclua o bucket `tk-attachments` na sua rotina de cópia.
6. **Reversão**: migrações só para frente; para voltar, restaure o backup. Versões de calendário/política e o histórico são imutáveis; corrigir é publicar nova versão ou registrar novo evento.

## Aplicação
`pnpm install --frozen-lockfile` → `pnpm lint && pnpm typecheck && pnpm test && pnpm build` → `pnpm start`. Em hospedagem serverless, configure as 3 variáveis no painel do provedor. Envio de anexos usa Server Actions com limite de corpo de 32 MB (`next.config.ts`): confirme que seu provedor aceita esse tamanho de requisição.

## Primeiro uso em produção
1. Entrar como proprietário (ativar o 2º fator). 2. **Configurações**: marca, janela de reabertura, anexos, **expediente e metas de SLA reais** (os iniciais são demonstrativos). 3. **Equipes** e **Categorias** (equipe padrão). 4. **Pessoas e acessos**: associar atendentes (Membro), gestores (Gerente) e solicitantes (Leitor); marcar atendentes nas equipes. 5. Abrir um chamado de teste como solicitante, responder como atendente, pedir informação, resolver e confirmar.

## Custos externos
| Item | Observação |
|---|---|
| Supabase | Plano gratuito serve para testar; produção recomenda plano pago (backups/PITR, sem pausa por inatividade, armazenamento dos anexos) |
| Hospedagem Node | Vercel/Render/etc.; há opções gratuitas com limites |
| SMTP | Necessário para confirmar cadastro e recuperar senha; o sistema **não** envia e-mail sobre chamados |
| Domínio | Opcional, recomendado |

## Testes locais
- Unitários: `pnpm test` · SQL: `pnpm test:db` (inclui os testes do Core) · concorrência: `pnpm test:concurrency` · mutação: `pnpm test:mutation` (demorado; roda sozinho, sem outra carga).
- **E2E**: `pnpm test:e2e` usa o Supabase local e o app **compilado** (`pnpm build && pnpm start -p 3126`). Copie URLs/chaves de `supabase status` para `.env.e2e` (`E2E_SUPABASE_URL`, `E2E_SUPABASE_ANON_KEY`, `E2E_BASE_URL`, `E2E_MAILPIT_URL`). Rode **um arquivo por vez**, reiniciando o app entre eles (limitador em memória) e **depois de `supabase db reset` + `node scripts/seed-demo.mjs`** (os fluxos alteram dados e leem a senha da demonstração em `node_modules/.cache`). Arquivos: `core-flow`, `email-flows`, `security`, `tk-flow`, `tk-demo`, `tk-ops`, `tk-security`, `tk-responsive`.

## Dados de demonstração
«Suporte Aurora TI (demonstração)»: 1 proprietário, 1 gestor, 3 atendentes, 2 equipes, 4 solicitantes, 5 categorias, 5 respostas prontas, 32 chamados em todos os estados e situações de SLA (dentro do prazo, próximo do limite, pausado, atrasado, cumprido, descumprido) e um chamado reaberto com dois ciclos. Datas relativas à execução. Usuários `dono@`, `gestor@`, `atendente1@`…`3@`, `solicitante1@`…`4@` (`@demo.exemplo`) com **senha aleatória por execução** em `node_modules/.cache/tk-demo-credentials.json`.

## Checklist de produção
- [ ] Região Brasil; backups ligados (banco **e** Storage); MFA ligado; SMTP próprio; Redirect URLs.
- [ ] `seed-demo.mjs` **não** executado; nenhuma chave `service_role` em variável de ambiente.
- [ ] Bucket `tk-attachments` privado.
- [ ] Expediente, fuso e metas de SLA revisados com o time; janela de reabertura definida.
- [ ] Texto de retenção e política de exclusão revisados com seu jurídico (controlador = quem implanta).
- [ ] Teste de restauração feito.
