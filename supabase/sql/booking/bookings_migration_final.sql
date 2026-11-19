-- ============================================================
-- 0. Remove the artifacts from the original instant-lock model —
--    they don't fit the enquiry-then-confirm workflow.
-- ============================================================
DROP POLICY IF EXISTS "Public can create bookings" ON bookings;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS unique_appointment_slot;
DROP VIEW IF EXISTS available_slots;

-- ============================================================
-- 1. Rename the date column; time_slot's name is already fine
--    and stays as-is.
-- ============================================================
ALTER TABLE bookings RENAME COLUMN appointment_date TO requested_date;

-- ============================================================
-- 2. New columns for the enquiry -> route-optimize -> confirm
--    workflow.
-- ============================================================
ALTER TABLE bookings
  ADD COLUMN status text NOT NULL DEFAULT 'pending',
  ADD COLUMN confirmed_date date,
  ADD COLUMN confirmed_time text,
  ADD COLUMN latitude double precision,
  ADD COLUMN longitude double precision,
  ADD COLUMN suburb text;

ALTER TABLE bookings
  ADD CONSTRAINT status_valid CHECK (status IN ('pending', 'confirmed', 'declined'));

ALTER TABLE bookings
  ADD CONSTRAINT confirmed_time_valid CHECK (confirmed_time IS NULL OR confirmed_time IN ('9:00 am', '11:00 am', '1:00 pm', '3:00 pm'));

-- Prevents you from assigning two jobs to the same confirmed
-- date+time. NULLs (every pending enquiry) never conflict with
-- each other, so this only fires once you've actually confirmed
-- a real time twice.
ALTER TABLE bookings
  ADD CONSTRAINT unique_confirmed_slot UNIQUE (confirmed_date, confirmed_time);

-- ============================================================
-- 3. Singleton config table: the real calendar date that Day 1
--    of the 28-day route cycle falls on.
--
--    !! REPLACE THE PLACEHOLDER DATE BELOW BEFORE GOING LIVE !!
-- ============================================================
CREATE TABLE schedule_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  cycle_start_date date NOT NULL,
  cycle_length_days smallint NOT NULL DEFAULT 28
);

INSERT INTO schedule_config (cycle_start_date, cycle_length_days)
VALUES ('2026-01-01', 28); -- <<< REPLACE '2026-01-01' WITH YOUR REAL DAY 1

ALTER TABLE schedule_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can view schedule config" ON schedule_config FOR SELECT TO anon USING (true);
CREATE POLICY "Authenticated admin manages schedule config" ON schedule_config FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 4. The suburb roster, keyed by position in the 28-day cycle.
--    Rest/admin days (7, 14, 21, 28) have no rows — no suburb
--    will ever match those days, so no special-casing needed.
-- ============================================================
CREATE TABLE zone_schedule (
  id bigint generated always as identity primary key,
  cycle_day smallint NOT NULL CHECK (cycle_day BETWEEN 1 AND 28),
  suburb text NOT NULL
);

ALTER TABLE zone_schedule ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can view the zone schedule" ON zone_schedule FOR SELECT TO anon USING (true);
CREATE POLICY "Authenticated admin manages the zone schedule" ON zone_schedule FOR ALL TO authenticated USING (true) WITH CHECK (true);

INSERT INTO zone_schedule (cycle_day, suburb) VALUES
  (1, 'Remuera'), (1, 'Greenlane'),
  (2, 'Epsom'), (2, 'Mt Eden'),
  (3, 'Newmarket'), (3, 'Parnell'),
  (4, 'Ponsonby'), (4, 'St Marys Bay'),
  (5, 'Grey Lynn'), (5, 'Westmere'),
  (6, 'Auckland CBD'), (6, 'Waterfront'),
  -- 7 = Rest and Admin day
  (8, 'Orakei'), (8, 'Mission Bay'),
  (9, 'Kohimarama'), (9, 'St Heliers'),
  (10, 'Meadowbank'), (10, 'Saint Johns'),
  (11, 'Glen Innes'), (11, 'Glendowie'),
  (12, 'Panmure'), (12, 'Mt Wellington'),
  (13, 'Ellerslie'), (13, 'Penrose'),
  -- 14 = Rest and Admin day
  (15, 'Kingsland'), (15, 'Morningside'),
  (16, 'Mt Albert'), (16, 'Point Chevalier'),
  (17, 'Avondale'), (17, 'Waterview'),
  (18, 'New Lynn'), (18, 'Green Bay'),
  (19, 'Glen Eden'), (19, 'Henderson'),
  (20, 'Onehunga'), (20, 'Royal Oak'),
  -- 21 = Rest and Admin day
  (22, 'Otahuhu'), (22, 'Mangere East'),
  (23, 'Papatoetoe'), (23, 'Manukau Central'),
  (24, 'Takapuna'), (24, 'Milford'),
  (25, 'Northcote'), (25, 'Birkenhead'),
  (26, 'Devonport'), (26, 'Belmont'),
  (27, 'Kingsland'), (27, 'Sandringham');
  -- 28 = Rest and Admin day

-- ============================================================
-- 5. Explicit excluded zones, with a reason for the custom-quote
--    message.
-- ============================================================
CREATE TABLE excluded_zones (
  id bigint generated always as identity primary key,
  suburb text NOT NULL,
  reason text NOT NULL
);

ALTER TABLE excluded_zones ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can view excluded zones" ON excluded_zones FOR SELECT TO anon USING (true);
CREATE POLICY "Authenticated admin manages excluded zones" ON excluded_zones FOR ALL TO authenticated USING (true) WITH CHECK (true);

INSERT INTO excluded_zones (suburb, reason) VALUES
  ('Albany', 'Too hilly/disconnected for bike-and-train logistics'),
  ('Glenfield', 'Too hilly/disconnected for bike-and-train logistics'),
  ('Sunnynook', 'Too hilly/disconnected for bike-and-train logistics'),
  ('Browns Bay', 'Too hilly/disconnected for bike-and-train logistics'),
  ('Mairangi Bay', 'Too hilly/disconnected for bike-and-train logistics'),
  ('Long Bay', 'Too hilly/disconnected for bike-and-train logistics'),
  ('Torbay', 'Too hilly/disconnected for bike-and-train logistics'),
  ('Pakuranga', 'No rail access; severe bottleneck traffic'),
  ('Botany', 'No rail access; severe bottleneck traffic'),
  ('Howick', 'No rail access; severe bottleneck traffic'),
  ('Dannemora', 'No rail access; severe bottleneck traffic'),
  ('Whitford', 'No rail access; severe bottleneck traffic'),
  ('Maraetai', 'No rail access; severe bottleneck traffic'),
  ('Titirangi', 'Steep winding topography or isolated ferry constraints'),
  ('Laingholm', 'Steep winding topography or isolated ferry constraints'),
  ('Swanson', 'Steep winding topography or isolated ferry constraints'),
  ('Massey', 'Steep winding topography or isolated ferry constraints'),
  ('Westgate', 'Steep winding topography or isolated ferry constraints'),
  ('Hobsonville', 'Steep winding topography or isolated ferry constraints'),
  ('Takanini', 'Excessive transit commute time exceeding the 1-hour buffer'),
  ('Papakura', 'Excessive transit commute time exceeding the 1-hour buffer'),
  ('Drury', 'Excessive transit commute time exceeding the 1-hour buffer'),
  ('Pukekohe', 'Excessive transit commute time exceeding the 1-hour buffer');

-- ============================================================
-- 6. Suburb-name normalizer (handles "Mt"/"Mount", "Pt"/"Point",
--    "St"/"Saint" inconsistencies) and the 28-day cycle-position
--    calculator, mirrored exactly by the client-side JS.
-- ============================================================
CREATE OR REPLACE FUNCTION normalize_suburb(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT trim(regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(input), '^mt\s', 'mount ', 'i'),
        '^pt\s', 'point ', 'i'
      ),
      '^st\s', 'saint ', 'i'
    ),
    '\s+', ' ', 'g'
  ));
$$;

CREATE OR REPLACE FUNCTION cycle_day_for(target_date date)
RETURNS smallint
LANGUAGE sql
STABLE
AS $$
  SELECT ((((target_date - cfg.cycle_start_date)::int % cfg.cycle_length_days)
           + cfg.cycle_length_days) % cfg.cycle_length_days + 1)::smallint
  FROM schedule_config cfg
  LIMIT 1;
$$;

-- ============================================================
-- 7. A view exposing only genuinely CONFIRMED times — this is
--    what the public form checks to grey out "BOOKED OUT" slots.
--    Pending enquiries never block other people from enquiring
--    about the same popular slot.
-- ============================================================
CREATE VIEW confirmed_slots AS
SELECT confirmed_date, confirmed_time
FROM bookings
WHERE status = 'confirmed';

GRANT SELECT ON confirmed_slots TO anon;

-- ============================================================
-- 8. The public INSERT policy: sane values only, no backdating,
--    no already-confirmed slot, no excluded suburb, and only on
--    a day this suburb is actually on the route.
-- ============================================================
CREATE POLICY "Public can request a booking"
ON bookings FOR INSERT TO anon
WITH CHECK (
  requested_date >= CURRENT_DATE
  AND time_slot IN ('9:00 am', '11:00 am', '1:00 pm', '3:00 pm')
  AND status = 'pending'
  AND confirmed_date IS NULL
  AND confirmed_time IS NULL
  AND package_selected = '$250 Core Session'
  AND length(client_name) BETWEEN 1 AND 200
  AND length(property_address) BETWEEN 1 AND 300
  AND suburb IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM excluded_zones ez
    WHERE normalize_suburb(ez.suburb) = normalize_suburb(suburb)
  )
  AND NOT EXISTS (
    SELECT 1 FROM bookings existing
    WHERE existing.status = 'confirmed'
      AND existing.confirmed_date = requested_date
      AND existing.confirmed_time = time_slot
  )
  AND EXISTS (
    SELECT 1 FROM zone_schedule z
    WHERE normalize_suburb(z.suburb) = normalize_suburb(suburb)
      AND z.cycle_day = cycle_day_for(requested_date)
  )
);

-- ============================================================
-- 9. Admin access for the future map/review dashboard. There's
--    no public sign-up page anywhere, so "authenticated"
--    effectively only ever means you — see the Supabase Auth
--    setup note in the reply alongside this file.
-- ============================================================
CREATE POLICY "Authenticated admin can view all bookings"
ON bookings FOR SELECT TO authenticated
USING (true);

CREATE POLICY "Authenticated admin can update bookings"
ON bookings FOR UPDATE TO authenticated
USING (true) WITH CHECK (true);
