-- =====================================================================
-- 0002_order_code.sql — assign short order codes ('A12') on insert.
-- Code = 'A' || (order_no % 1000), skipping codes still used by an open order,
-- so owner LINE commands stay short. Unique among open orders (orders_open_code_uidx).
-- =====================================================================
create or replace function assign_order_code() returns trigger
language plpgsql as $$
declare
  n int := (new.order_no % 1000)::int;
  tries int := 0;
  candidate text;
begin
  if new.code is not null and new.code <> '' then
    return new;
  end if;
  loop
    candidate := 'A' || n;
    exit when not exists (
      select 1 from orders o
      where o.code = candidate and o.status not in ('DELIVERED', 'CANCELLED')
    );
    n := (n + 1) % 1000;
    tries := tries + 1;
    if tries >= 1000 then
      raise exception 'no free order code';
    end if;
  end loop;
  new.code := candidate;
  return new;
end $$;

create trigger orders_assign_code before insert on orders
  for each row execute function assign_order_code();
