---
name: supabase-security
description: Use ao criar tabela, política, RPC, bucket ou privilégio.
---

# supabase-security

- `organization_id` + FK composta `(id, organization_id)`; RLS só SELECT; escrita por RPC `tk_*` SECURITY DEFINER com `search_path` vazio, validando sessão, MFA, perfil e empresa (`private.tk_guard`).
- Privilégios são fechados na **última** migração (`999999_tk_privileges`): `public.tk_*` só `authenticated`; **nenhuma função para `anon`**; `private.tk_*` ninguém, salvo auxiliares de RLS/Storage (lista no arquivo — função nova usada por política precisa entrar nela).
- Nunca desligar RLS. Sem `service_role` no app. Gatilhos de imutabilidade em histórico.
- Cuidado: variável PL/pgSQL com o mesmo nome de coluna (`id`) causa ambiguidade; `IF` com `CASE … THEN` dentro quebra o parser (use variável).
- Testes: `supabase/tests/70_tk_security.sql` (superfície, search_path, RLS, A/B, MFA), `tk-security.spec.ts`.
