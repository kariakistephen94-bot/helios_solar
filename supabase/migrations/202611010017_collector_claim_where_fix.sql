-- Additive and rerunnable. Supabase rejects an UPDATE without a WHERE clause, which made every
-- collector claim fail with "UPDATE requires a WHERE clause" when the search plan changed.
-- This patches the existing public.helios_backend in place; no table or row is touched.
do $$
declare d text;
begin
  select pg_get_functiondef('public.helios_backend(text,jsonb)'::regprocedure) into d;
  if position('update helios.search_tasks set active=false;' in d)>0 then
    execute replace(d,'update helios.search_tasks set active=false;','update helios.search_tasks set active=false where true;');
  end if;
end $$;
