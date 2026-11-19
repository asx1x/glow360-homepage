-- ============================================================
-- Contractor network applications. Public can submit; nobody
-- but you can read them back — same pattern as bookings, since
-- this also captures a name/email/phone worth protecting.
-- ============================================================
create table contractor_applications (
  id bigint generated always as identity primary key,
  full_name text not null,
  email text not null,
  phone text,
  region text not null,
  equipment_description text not null,
  availability_confirmed boolean not null default false,
  message text,
  status text not null default 'applied',
  created_at timestamptz not null default now()
);

alter table contractor_applications enable row level security;

create policy "Public can submit an application"
on contractor_applications for insert to anon
with check (
  length(full_name) between 1 and 200
  and length(email) between 1 and 255
  and length(region) between 1 and 200
  and length(equipment_description) between 1 and 1000
  and availability_confirmed = true
  and status = 'applied'
);

create policy "Authenticated admin can view applications"
on contractor_applications for select to authenticated using (true);

create policy "Authenticated admin can manage applications"
on contractor_applications for update to authenticated using (true) with check (true);
