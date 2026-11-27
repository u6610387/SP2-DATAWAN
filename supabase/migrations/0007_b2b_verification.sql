-- 0007: owner-verified B2B customers.
-- A customer applies for a business profile; the owner approves or rejects it (never code, never AI).
-- Documents live in the private `business-docs` bucket; user_events is an append-only audit log
-- whose payload holds field names / reason codes only, never PII.
create type b2b_status as enum ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED');
create type business_type as enum ('restaurant', 'reseller', 'hotel', 'other');

create table business_profiles (
  user_id                  uuid primary key references users(id) on delete cascade,
  status                   b2b_status not null default 'PENDING_VERIFICATION',
  business_name            text not null check (char_length(business_name) between 1 and 100),
  business_type            business_type not null,
  address_text             text not null,
  lat                      double precision,
  lng                      double precision,
  default_delivery_window  text,
  tax_id                   text check (tax_id is null or tax_id ~ '^\d{13}$'),
  submitted_at             timestamptz not null default now(),
  decided_at               timestamptz,
  decided_by               uuid,                       -- owner's Supabase auth id (no FK on purpose)
  verified_at              timestamptz,
  rejection_reason         text,
  needs_rereview           boolean not null default false,
  rereview_fields          text[] not null default '{}',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check ((lat is null) = (lng is null)),
  check (status <> 'REJECTED' or rejection_reason is not null)
);
create index business_profiles_status_idx on business_profiles (status, submitted_at);
create trigger business_profiles_updated_at before update on business_profiles
  for each row execute function set_updated_at();

create table business_documents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  path          text not null,
  content_type  text not null,
  uploaded_at   timestamptz not null default now()
);
create index business_documents_user_idx on business_documents (user_id);

create table user_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  actor       event_actor not null,
  event       text not null check (event in (
    'B2B_APPLIED', 'B2B_UPDATED', 'B2B_APPROVED', 'B2B_REJECTED',
    'B2B_REREVIEW', 'B2B_ACKNOWLEDGED', 'B2B_REVOKED', 'B2B_DOCS_PURGED'
  )),
  payload     jsonb,
  created_at  timestamptz not null default now()
);
create index user_events_user_idx on user_events (user_id, created_at);

alter table business_profiles  enable row level security;
alter table business_documents enable row level security;
alter table user_events        enable row level security;
create policy owner_all  on business_profiles  for all using (is_owner()) with check (is_owner());
create policy owner_all  on business_documents for all using (is_owner()) with check (is_owner());
create policy owner_read on user_events        for select using (is_owner());
-- Audit log is append-only even for the owner
revoke update, delete on user_events from authenticated;

-- Private bucket. Uploads go through the Worker (service role) after it validates the path.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('business-docs', 'business-docs', false, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
create policy owner_read_business_docs on storage.objects
  for select using (bucket_id = 'business-docs' and is_owner());
