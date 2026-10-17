-- Central de Chamados — MODELO DE DADOS.
-- O Core já possui `organization_settings` (nome de exibição e tema do painel); as políticas de chamados ficam em `ticket_settings`.
-- Convenções: instantes em timestamptz; expediente em hora local do fuso IANA da versão do calendário; prazos em MINUTOS ÚTEIS;
-- relacionamentos por chave composta (id, organization_id): nenhum registro referencia outra empresa. Escrita só por funções tk_* (migrações seguintes).
-- Histórico nunca se apaga: mensagens, eventos, ciclos, pausas e versões de política são append-only (ver 000100).

begin;
set local check_function_bodies = off;

-- ======================================================================= identidade e políticas da empresa
create table public.ticket_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  public_display_name text check (char_length(btrim(public_display_name)) between 2 and 80),
  logo_path text check (char_length(logo_path) <= 200),
  primary_color text not null default '#2563eb' check (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  timezone text not null default 'America/Sao_Paulo' check (timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$' and char_length(timezone) <= 60),
  reopen_window_hours integer not null default 72 check (reopen_window_hours between 0 and 8760),
  attachment_max_size_bytes integer not null default 5242880 check (attachment_max_size_bytes between 10240 and 10485760),
  retention_policy_text text check (char_length(retention_policy_text) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ======================================================================= equipes, membros de equipe, categorias
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 60),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index teams_org_name_uq on public.teams (organization_id, lower(btrim(name)));

create table public.team_members (
  organization_id uuid not null,
  team_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (team_id, user_id),
  foreign key (team_id, organization_id) references public.teams (id, organization_id) on delete cascade,
  foreign key (organization_id, user_id) references public.organization_members (organization_id, user_id) on delete cascade
);
create index team_members_user_idx on public.team_members (organization_id, user_id);

-- Atendente desativado: preserva a autoria histórica; deixa de ser atribuível e de acessar a fila.
create table public.agent_status (
  organization_id uuid not null,
  user_id uuid not null,
  active boolean not null default true,
  deactivated_at timestamptz,
  primary key (organization_id, user_id),
  foreign key (organization_id, user_id) references public.organization_members (organization_id, user_id) on delete cascade
);

create table public.ticket_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 60),
  default_team_id uuid,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (default_team_id, organization_id) references public.teams (id, organization_id)
);
create unique index ticket_categories_org_name_uq on public.ticket_categories (organization_id, lower(btrim(name)));

-- ======================================================================= expediente (calendário) e política de SLA: VERSÕES IMUTÁVEIS
-- definition = {"weekly": {"1": [["09:00","12:00"],["13:00","18:00"]], ...}, "closed_dates": ["2026-12-25"]}   (0 = domingo … 6 = sábado)
create table public.business_calendar_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  timezone text not null check (timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$' and char_length(timezone) <= 60),
  definition jsonb not null check (jsonb_typeof(definition) = 'object' and pg_column_size(definition) <= 8192),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (id, organization_id)
);
create index business_calendar_versions_org_idx on public.business_calendar_versions (organization_id, created_at desc);

-- targets_by_priority = {"low": {"first_response": 480, "resolution": 2400}, "normal": {...}, "high": {...}, "urgent": {...}}   (minutos úteis)
create table public.sla_policy_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  business_calendar_version_id uuid not null,
  targets_by_priority jsonb not null check (jsonb_typeof(targets_by_priority) = 'object' and pg_column_size(targets_by_priority) <= 4096),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (business_calendar_version_id, organization_id) references public.business_calendar_versions (id, organization_id)
);
create index sla_policy_versions_org_idx on public.sla_policy_versions (organization_id, created_at desc);

-- ======================================================================= chamados
create table public.ticket_counters (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  last_number bigint not null default 0 check (last_number >= 0)
);

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ticket_number bigint not null check (ticket_number > 0),
  requester_user_id uuid not null,
  subject text not null check (char_length(btrim(subject)) between 3 and 160),
  category_id uuid,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'waiting_requester', 'resolved', 'closed')),
  team_id uuid,
  assigned_user_id uuid,
  version integer not null default 1 check (version >= 1),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_public_activity_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, ticket_number),
  foreign key (category_id, organization_id) references public.ticket_categories (id, organization_id),
  foreign key (team_id, organization_id) references public.teams (id, organization_id),
  check (assigned_user_id is null or team_id is not null)
);
create index tickets_org_status_idx on public.tickets (organization_id, status, created_at desc);
create index tickets_org_requester_idx on public.tickets (organization_id, requester_user_id, created_at desc);
create index tickets_org_assignee_idx on public.tickets (organization_id, assigned_user_id) where assigned_user_id is not null;
create index tickets_org_team_idx on public.tickets (organization_id, team_id);
create index tickets_org_created_idx on public.tickets (organization_id, created_at desc);

-- Mensagens: APPEND-ONLY. A visibilidade é decidida aqui, no banco: nota interna nunca chega a quem não é equipe.
create table public.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  ticket_id uuid not null,
  author_user_id uuid not null,
  author_kind text not null check (author_kind in ('requester', 'staff', 'system')),
  visibility text not null check (visibility in ('public', 'internal')),
  body text not null check (char_length(btrim(body)) between 1 and 10000),
  created_at timestamptz not null default now(),
  unique (id, ticket_id, organization_id),
  foreign key (ticket_id, organization_id) references public.tickets (id, organization_id),
  check (author_kind <> 'requester' or visibility = 'public')
);
create index ticket_messages_ticket_idx on public.ticket_messages (ticket_id, created_at);

create table public.ticket_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  ticket_id uuid not null,
  message_id uuid not null,
  storage_path text not null unique check (char_length(storage_path) <= 300 and storage_path !~ '(^/|\.\.|\\)'),
  original_filename text not null check (char_length(btrim(original_filename)) between 1 and 180),
  mime_type text not null check (char_length(mime_type) <= 100),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  uploaded_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (message_id, ticket_id, organization_id) references public.ticket_messages (id, ticket_id, organization_id)
);
create index ticket_attachments_ticket_idx on public.ticket_attachments (ticket_id);

create table public.ticket_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  ticket_id uuid not null,
  event_type text not null check (char_length(event_type) between 2 and 40),
  actor_user_id uuid,
  safe_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_metadata) = 'object' and pg_column_size(safe_metadata) <= 2048),
  created_at timestamptz not null default now(),
  foreign key (ticket_id, organization_id) references public.tickets (id, organization_id)
);
create index ticket_events_ticket_idx on public.ticket_events (ticket_id, id);

-- ======================================================================= ciclos de atendimento e pausas de SLA
create table public.ticket_service_cycles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  ticket_id uuid not null,
  cycle_number integer not null check (cycle_number >= 1),
  sla_policy_version_id uuid not null,
  priority_snapshot text not null check (priority_snapshot in ('low', 'normal', 'high', 'urgent')),
  first_response_target_minutes integer not null check (first_response_target_minutes > 0),
  resolution_target_minutes integer not null check (resolution_target_minutes > 0),
  started_at timestamptz not null default now(),
  first_response_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  unique (ticket_id, cycle_number),
  unique (id, organization_id),
  foreign key (ticket_id, organization_id) references public.tickets (id, organization_id),
  foreign key (sla_policy_version_id, organization_id) references public.sla_policy_versions (id, organization_id),
  check (first_response_at is null or first_response_at >= started_at),
  check (resolved_at is null or resolved_at >= started_at),
  check (closed_at is null or closed_at >= started_at)
);
-- Um único ciclo ATIVO (não encerrado) por chamado.
create unique index ticket_service_cycles_one_active_uq on public.ticket_service_cycles (ticket_id) where closed_at is null;
create index ticket_service_cycles_org_idx on public.ticket_service_cycles (organization_id, started_at);

create table public.ticket_sla_pauses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  service_cycle_id uuid not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  foreign key (service_cycle_id, organization_id) references public.ticket_service_cycles (id, organization_id),
  check (ended_at is null or ended_at >= started_at)
);
-- Uma única pausa aberta por ciclo.
create unique index ticket_sla_pauses_one_open_uq on public.ticket_sla_pauses (service_cycle_id) where ended_at is null;
create index ticket_sla_pauses_cycle_idx on public.ticket_sla_pauses (service_cycle_id, started_at);

-- ======================================================================= respostas prontas, notificações, idempotência, limite de abuso
create table public.canned_responses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 2 and 80),
  body text not null check (char_length(btrim(body)) between 1 and 5000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.notifications (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  recipient_user_id uuid not null,
  ticket_id uuid not null,
  event_type text not null check (event_type in ('assigned', 'public_reply', 'resolved', 'reopened')),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (ticket_id, organization_id) references public.tickets (id, organization_id)
);
create index notifications_recipient_idx on public.notifications (recipient_user_id, organization_id, created_at desc);

create table public.mutation_requests (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  idempotency_key uuid not null,
  scope text not null check (scope in ('open_ticket', 'post_message')),
  request_hash text not null,
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id, idempotency_key)
);
create index mutation_requests_created_idx on public.mutation_requests (created_at);

create table public.ticket_rate_limits (
  bucket text not null check (char_length(bucket) <= 120),
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, window_start)
);

commit;
