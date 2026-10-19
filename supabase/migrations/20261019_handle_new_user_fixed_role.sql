-- El rol nunca lo decide el cliente: todo registro nuevo entra como 'usuario'.
-- Para dar otro rol, hazlo desde el SQL Editor: update public.profiles set role = 'admin' where email = '...';
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'usuario'::public.user_role);
  return new;
end;
$$;

-- Solo la usa el trigger; no debe poder llamarse por la API.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
