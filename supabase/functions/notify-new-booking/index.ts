
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
 
serve(async (req) => {
  const payload = await req.json();
  const booking = payload.record;
 
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const NOTIFY_EMAIL = Deno.env.get("NOTIFY_EMAIL") ?? "info@glow360.co.nz";
 
  const emailBody = {
    from: "Glow360 Bookings <bookings@updates.glow360.co.nz>",
    to: [NOTIFY_EMAIL],
    subject: `New booking: ${booking.suburb} — ${booking.appointment_date} at ${booking.time_slot}`,
    html: `
      <h2>New booking received</h2>
      <p><strong>Name:</strong> ${booking.client_name}</p>
      <p><strong>Email:</strong> ${booking.client_email}</p>
      <p><strong>Address:</strong> ${booking.property_address}</p>
      <p><strong>Suburb:</strong> ${booking.suburb}</p>
      <p><strong>Date:</strong> ${booking.appointment_date}</p>
      <p><strong>Time:</strong> ${booking.time_slot}</p>
      <p><strong>Package:</strong> ${booking.package_selected}</p>
    `
  };
 
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(emailBody)
  });
 
  if (!res.ok) {
    const errText = await res.text();
    console.error("Resend error:", errText);
    return new Response(errText, { status: 500 });
  }
 
  return new Response("OK", { status: 200 });
});
 