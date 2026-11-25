-- 0005: pin search_path on every public function (Supabase linter: function_search_path_mutable).
--
-- Without a pinned search_path, a function resolves unqualified names using the caller's
-- search_path, so an object created earlier in that path could shadow the one the function
-- means. None of these are SECURITY DEFINER, so the risk is low; this closes it anyway.
-- Metadata-only (ALTER FUNCTION … SET): no table rewrite, no data change, triggers keep working.
-- Guarded by apps/worker/test/e2e/rls.e2e.test.ts (catalog check) and the lifecycle E2E.
alter function public.is_owner() set search_path = '';           -- uses auth.jwt() (qualified)
alter function public.set_updated_at() set search_path = '';     -- now() is in pg_catalog
alter function public.guard_order_status() set search_path = '';
alter function public.assign_order_code() set search_path = public; -- queries public.orders unqualified
