// Notification for a new contractor application.
// Called by the Postgres trigger (pg_net) whenever a row is inserted into contractor_applications.
// Deployed with --no-verify-jwt because only the database trigger calls it.

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const NOTIFY_EMAIL = Deno.env.get("NOTIFY_EMAIL") ?? "info@glow360.co.nz";
const FROM = "Glow360 Applications <applications@updates.glow360.co.nz>";

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const oneLine = (v: unknown, max = 120) =>
  String(v ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set");
    return new Response("Missing secret", { status: 500 });
  }

  let body: any;
  try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

  // Accept either { record: {...} } or the bare row.
  const r = body?.record ?? body;
  if (!r || !r.full_name) {
    console.error("Unexpected payload, top-level keys:", Object.keys(body ?? {}));
    return new Response("Unexpected payload", { status: 400 });
  }

  const rows: [string, unknown][] = [
    ["Name", r.full_name],
    ["Email", r.email],
    ["Phone", r.phone],
    ["Region", r.region],
    ["Equipment", r.equipment_description],
    ["Availability confirmed", r.availability_confirmed ? "Yes" : "No"],
    ["Message", r.message],
    ["Received", r.created_at],
  ];
  const html =
    `<h2 style="font-family:sans-serif">New contractor application</h2>` +
    `<table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">` +
    rows.map(([k, v]) =>
      `<tr><td style="padding:6px 14px 6px 0;color:#666;vertical-align:top">${esc(k)}</td>` +
      `<td style="padding:6px 0;white-space:pre-wrap">${esc(v) || "-"}</td></tr>`).join("") +
    `</table>`;

  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(r.email ?? ""));
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: [NOTIFY_EMAIL],
      reply_to: validEmail ? r.email : undefined,
      subject: `New contractor application: ${oneLine(r.full_name, 80)} (${oneLine(r.region, 60)})`,
      html,
    }),
  });

  if (!res.ok) {
    console.error("Resend error", res.status, await res.text());
    return new Response("Email failed", { status: 502 });
  }
  return new Response("ok", { status: 200 });
});
