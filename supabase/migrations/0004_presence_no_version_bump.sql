-- 0004: a presence heartbeat is not an order change.
--
-- The LIFF order room POSTs /heartbeat every 30 s, which writes orders.customer_last_seen_at.
-- bump_order_version() (0001) incremented `version` on every update, so the version the LIFF
-- had cached went stale within seconds and Accept / Counter got 409 "If-Match does not match
-- the current order version". The heartbeat is not broadcast, so the page never refetched.
--
-- Now: if nothing changed except customer_last_seen_at (and the trigger-maintained
-- updated_at / version, plus the generated total_satang, which is not yet computed in a
-- BEFORE trigger), keep the version. Any real change, alone or together with a heartbeat,
-- still bumps it. Tested in apps/worker/test/orderVersionTrigger.test.ts (PGlite).
create or replace function bump_order_version() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'customer_last_seen_at' - 'updated_at' - 'version' - 'total_satang')
     = (to_jsonb(old) - 'customer_last_seen_at' - 'updated_at' - 'version' - 'total_satang') then
    new.version = old.version;
    return new;
  end if;
  new.version = old.version + 1;
  return new;
end $$;
