-- Run in Supabase → SQL Editor (once per project).
-- Then: Database → Replication → enable Realtime for public.library_items
--   and for public.library_uploads (so cropped photos sync live).

-- If `insert into storage.buckets` fails, create bucket `library-uploads` in
-- Storage UI and mark it public, then run only the storage policy section.

create table if not exists public.library_items (
  image_path text primary key,
  category text not null default '',
  notes text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.library_items enable row level security;

-- Open read/write for anyone with the anon key (typical class / shared site).
-- Tighten later with auth: only authenticated users can insert/update/delete.
create policy "library_items_select" on public.library_items
  for select using (true);

create policy "library_items_insert" on public.library_items
  for insert with check (true);

create policy "library_items_update" on public.library_items
  for update using (true);

create policy "library_items_delete" on public.library_items
  for delete using (true);

-- Cropped / uploaded images (binary in Storage, metadata here)
create table if not exists public.library_uploads (
  id uuid primary key,
  caption text not null default '',
  category text not null default '',
  storage_path text not null,
  updated_at timestamptz not null default now(),
  -- So other devices can place the crop after the same source as the author.
  source_static_path text,
  source_upload_id uuid
);

alter table public.library_uploads enable row level security;

create policy "library_uploads_select" on public.library_uploads
  for select using (true);

create policy "library_uploads_insert" on public.library_uploads
  for insert with check (true);

create policy "library_uploads_update" on public.library_uploads
  for update using (true);

create policy "library_uploads_delete" on public.library_uploads
  for delete using (true);

-- Storage bucket for upload JPEGs (create once in Dashboard → Storage, or SQL below)
insert into storage.buckets (id, name, public)
  values ('library-uploads', 'library-uploads', true)
  on conflict (id) do nothing;

create policy "library_uploads_storage_read"
  on storage.objects for select
  using (bucket_id = 'library-uploads');

create policy "library_uploads_storage_insert"
  on storage.objects for insert
  with check (bucket_id = 'library-uploads');

create policy "library_uploads_storage_update"
  on storage.objects for update
  using (bucket_id = 'library-uploads');

create policy "library_uploads_storage_delete"
  on storage.objects for delete
  using (bucket_id = 'library-uploads');

-- Existing projects: add columns once (safe to re-run on PostgreSQL 11+).
alter table public.library_uploads
  add column if not exists source_static_path text;

alter table public.library_uploads
  add column if not exists source_upload_id uuid;

-- Shared “removed from gallery” manifest paths (same count on every device). Single row id=1.
create table if not exists public.library_gallery_prefs (
  id smallint primary key default 1
    constraint gallery_prefs_singleton check (id = 1),
  hidden_static_paths text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.library_gallery_prefs enable row level security;

create policy "gallery_prefs_select" on public.library_gallery_prefs
  for select using (true);

create policy "gallery_prefs_insert" on public.library_gallery_prefs
  for insert with check (id = 1);

create policy "gallery_prefs_update" on public.library_gallery_prefs
  for update using (id = 1) with check (id = 1);

-- Row id=1 is created by the site’s first upsert (avoids empty `{}` wiping local removals).

-- Books still shown in the grid but marked unavailable (taken). Run once on existing projects.
alter table public.library_gallery_prefs
  add column if not exists taken_static_paths text[] not null default '{}';

alter table public.library_gallery_prefs
  add column if not exists taken_upload_ids uuid[] not null default '{}';

-- Optional: Database → Replication → Realtime for public.library_gallery_prefs

-- Visitor book requests (multi-select from gallery; review in Supabase Table Editor).
create table if not exists public.book_inquiries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  requester_name text not null,
  requester_email text not null,
  message text not null default '',
  books jsonb not null default '[]'::jsonb
);

alter table public.book_inquiries enable row level security;

drop policy if exists "book_inquiries_insert_anon" on public.book_inquiries;

create policy "book_inquiries_insert_anon" on public.book_inquiries
  for insert with check (true);

-- No SELECT/UPDATE/DELETE for anonymous clients; use the dashboard (service role) to read.
