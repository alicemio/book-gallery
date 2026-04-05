-- Run in Supabase → SQL Editor (once per project).
-- Then: Database → Replication → enable Realtime for public.library_items

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
