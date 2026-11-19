-- ============================================================
-- 1. Turn on Row Level Security.
--    With RLS on and zero policies, anon has NO access at all
--    by default — this single line is what stops anyone from
--    reading client_name/client_email/property_address via the
--    public REST API.
-- ============================================================
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. Prevent double-booking at the database level.
--    This is what actually closes the race condition — two
--    simultaneous submissions for the same date+slot can no
--    longer both succeed, regardless of what the client-side
--    availability check saw a moment earlier.
-- ============================================================
ALTER TABLE bookings
  ADD CONSTRAINT unique_appointment_slot UNIQUE (appointment_date, time_slot);

-- ============================================================
-- 3. Allow the public form to INSERT, but only with values that
--    make sense — no backdated appointments, no slot outside
--    your actual offering, no arbitrary package string.
--    Deliberately no SELECT / UPDATE / DELETE policy for anon:
--    that absence is what keeps existing rows unreadable and
--    unmodifiable from the client side.
-- ============================================================
CREATE POLICY "Public can create bookings"
ON bookings FOR INSERT TO anon
WITH CHECK (
  appointment_date >= CURRENT_DATE
  AND time_slot IN ('9:00 am', '11:00 am', '1:00 pm', '3:00 pm')
  AND package_selected = '$250 Core Session'
  AND length(client_name) BETWEEN 1 AND 200
  AND length(property_address) BETWEEN 1 AND 300
);

-- ============================================================
-- 4. A narrow view for the availability dropdown to query.
--    Owned by the table owner rather than anon, so it can see
--    every row to compute availability — while anon still has
--    zero direct access to the bookings table itself. Only
--    date + slot are exposed, never name/email/address.
-- ============================================================
CREATE VIEW available_slots AS
SELECT appointment_date, time_slot FROM bookings;

GRANT SELECT ON available_slots TO anon;
