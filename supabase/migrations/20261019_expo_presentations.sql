-- Presentaciones de cada usuario: solo se guarda el ID del archivo en Google Drive.
create table public.expo_presentations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  drive_file_id text not null check (drive_file_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  kind text not null check (kind in ('pptx','html')),
  created_at timestamptz not null default now()
);
create index expo_presentations_owner_idx on public.expo_presentations(owner_id, created_at desc);
alter table public.expo_presentations enable row level security;

-- Cada usuario solo ve y modifica sus propias filas.
create policy expo_sel on public.expo_presentations for select to authenticated
  using (owner_id = (select auth.uid()));
create policy expo_ins on public.expo_presentations for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy expo_upd on public.expo_presentations for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy expo_del on public.expo_presentations for delete to authenticated
  using (owner_id = (select auth.uid()));

revoke all on public.expo_presentations from anon;
grant select, insert, update, delete on public.expo_presentations to authenticated;
