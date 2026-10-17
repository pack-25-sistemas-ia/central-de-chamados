-- Central de Chamados — STORAGE PRIVADO.
--  · tk-attachments: bucket PRIVADO (anexos dos chamados; 10 MB no máximo, allowlist de tipos; sem SVG, HTML nem executáveis);
--  · tk-logos: logotipo da marca (público por natureza; só imagens raster pequenas; só o proprietário grava/remove).
-- Anexos: caminho <organização>/<chamado>/<32 hex>.<ext> GERADO PELO SERVIDOR. Envio permitido a quem tem acesso à empresa; leitura SOMENTE se o anexo existe e o usuário pode ver a
-- mensagem dona dele (anexo de nota interna herda visibilidade interna: o solicitante não baixa). Remoção: só a gestão, e só de arquivos ÓRFÃOS (sem registro) com mais de 2 horas.
-- Só cria os buckets se o Storage existir (Postgres puro de teste não tem).

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') and exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('tk-attachments', 'tk-attachments', false, 10485760, array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv'])
    on conflict (id) do nothing;
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('tk-logos', 'tk-logos', true, 524288, array['image/png', 'image/jpeg', 'image/webp']) on conflict (id) do nothing;

    execute $p$create policy tk_att_insert on storage.objects for insert to authenticated with check (
      bucket_id = 'tk-attachments'
      and objects.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{32}\.[a-z0-9]{1,5}$'
      and private.tk_profile(split_part(objects.name, '/', 1)::uuid) is not null)$p$;
    execute $p$create policy tk_att_select on storage.objects for select to authenticated using (
      bucket_id = 'tk-attachments'
      and exists (select 1 from public.ticket_attachments a where a.storage_path = objects.name))$p$;
    execute $p$create policy tk_att_delete_orphans on storage.objects for delete to authenticated using (
      bucket_id = 'tk-attachments'
      and objects.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      and private.tk_is_manager(split_part(objects.name, '/', 1)::uuid)
      and objects.created_at < now() - interval '2 hours'
      and not exists (select 1 from public.ticket_attachments a where a.storage_path = objects.name))$p$;

    execute $p$create policy tk_logos_insert on storage.objects for insert to authenticated with check (
      bucket_id = 'tk-logos' and objects.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/logo-[0-9a-f]{8,32}\.(png|jpg|webp)$'
      and private.tk_is_owner(split_part(objects.name, '/', 1)::uuid))$p$;
    execute $p$create policy tk_logos_delete on storage.objects for delete to authenticated using (
      bucket_id = 'tk-logos' and objects.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      and private.tk_is_owner(split_part(objects.name, '/', 1)::uuid))$p$;
  end if;
end $$;
