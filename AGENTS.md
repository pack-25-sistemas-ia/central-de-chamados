# AGENTS — Central de Chamados

Sistema 12 do Pack 25 Sistemas IA (central-de-chamados). O status real vive em MEMORY.md.

## Regras perenes
- Esta pasta é autossuficiente: nada importa de fora dela, sem workspace:*, sem citar outros sistemas.
- Ler MEMORY.md antes de trabalhar; atualizar ao concluir marcos, só com fatos comprovados.
- Toda tabela de negócio tem organization_id + RLS (nunca desabilitar); toda escrita passa por RPC `tk_*` (SECURITY DEFINER, search_path vazio) e valida sessão, MFA, perfil e que os ids são da MESMA empresa. **Este sistema não tem porta pública: nenhuma função vai para `anon`.**
- **O banco decide estado, SLA e visibilidade** (gatilho `ticket_guard`, `tk_bminutes`/`tk_metric`, DTOs do solicitante). O espelho TS (`lib/sla`, `lib/tickets/status.ts`) só projeta e explica: mudou uma regra, mude os dois e os testes com os mesmos valores.
- Solicitante ≠ atendente com menus ocultos: nunca envie nota interna, eventos, SLA, equipe ou responsável ao navegador dele; qualquer DTO novo precisa de teste A/B.
- Nota interna não é resposta e não muda estado; pedir informação e resolver exigem mensagem pública na mesma transação; pausa só em «aguardando solicitante».
- Ciclos guardam política/metas no início; histórico (mensagens, eventos, ciclos, pausas, versões) é imutável: corrija com novo evento/versão, nunca com UPDATE/DELETE.
- CSP estrita: sem `style=""`. Anexos: tipo pelos bytes, bucket privado, URL assinada curta; sem antivírus (não afirmar o contrário).
- Nunca commitar segredos; o sistema não usa service_role. Dados pessoais mínimos; sem PII em logs; seed só com nomes fictícios (`@demo.exemplo`) e senha aleatória.
- Não declarar pronto sem evidência (comando + resultado). Se algo não foi executado, escrever NÃO EXECUTADO.

## Comandos
pnpm install --frozen-lockfile · pnpm lint · pnpm typecheck · pnpm test · pnpm build · pnpm test:db · pnpm test:concurrency · pnpm test:mutation · pnpm test:e2e
(E2E: app compilado na porta 3126, `supabase db reset` + `node scripts/seed-demo.mjs` antes, um arquivo por vez — ver docs/DEPLOYMENT.md.)

## Mapa
`lib/sla` (minutos úteis, estado, fórmulas) · `lib/tickets` (estados, ações do servidor, anexos, CSV, dados) · `components/tk` · `app/(app)/*` (rotas em português) · `app/api/{anexos,exportar}` · `supabase/migrations/20271201*` · `supabase/tests` · `scripts` · `.agents/skills/*`.

## Definição de pronto (resumo)
Migrações em banco limpo, seed reproduzível, teste RLS A/B negando acesso cruzado, fluxos críticos em Playwright,
mobile e desktop revisados, licenças e segredos verificados, instalação isolada validada, docs e MEMORY.md atualizados.
