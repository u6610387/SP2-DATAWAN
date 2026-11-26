-- 0006: product categories + owner-created products (สต็อก tab).
-- Categories group products for the owner; the order parser still matches products by aliases
-- (it reads the active catalog on every message, so a new product is recognised immediately).
create table categories (
  id          uuid primary key default gen_random_uuid(),
  name_th     text not null check (length(btrim(name_th)) between 1 and 60),
  sort        int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index categories_name_active_uidx on categories (lower(btrim(name_th))) where is_active;
create trigger categories_updated_at before update on categories
  for each row execute function set_updated_at();

alter table categories enable row level security;
create policy owner_all on categories for all using (is_owner()) with check (is_owner());

alter table products add column category_id uuid references categories(id) on delete set null;
create index products_category_idx on products (category_id);
-- One active product per name (the parser and the owner commands rely on names being unambiguous).
create unique index products_name_active_uidx on products (lower(btrim(name_th))) where is_active;

-- Same view, plus the category (columns appended; keep caller's rights — see 0003).
create or replace view product_stock with (security_invoker = true) as
  select p.id as product_id, p.name_th, p.unit,
         coalesce(sum(s.qty_delta), 0) as on_hand,
         p.category_id, c.name_th as category_name
  from products p
  left join stock_logs s on s.product_id = p.id
  left join categories c on c.id = p.category_id
  group by p.id, c.name_th;
