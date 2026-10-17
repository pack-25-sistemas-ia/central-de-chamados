-- Central de Chamados — PRIVILÉGIOS DAS FUNÇÕES (última migração do sistema).
-- O Postgres concede EXECUTE a PUBLIC por padrão e o Supabase a anon/authenticated. Aqui:
--  · administrativas e de uso (public.tk_*): SÓ usuário autenticado (cada uma ainda valida sessão, MFA e perfil). Este sistema NÃO tem nenhuma porta pública (anon);
--  · internas (private.tk_*): ninguém, exceto os auxiliares que as políticas de RLS e o Storage avaliam como o próprio usuário.

begin;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'tk\_%' loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname like 'tk\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname in ('tk_role', 'tk_agent_active', 'tk_profile', 'tk_is_owner', 'tk_is_manager', 'tk_is_staff', 'tk_in_team', 'tk_ticket_visible', 'tk_ticket_access', 'tk_message_visible', 'tk_attachment_visible', 'tk_guard') then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

commit;
