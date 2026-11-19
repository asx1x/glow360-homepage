create or replace function notify_new_application()
returns trigger
language plpgsql
security definer
as $$
begin
  perform net.http_post(
    url := 'https://caaenhofcnxbhiskqrzk.supabase.co/functions/v1/notify-new-application',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'contractor_applications',
      'record', row_to_json(new)
    )
  );
  return new;
end;
$$;

drop trigger if exists trigger_notify_new_application on contractor_applications;

create trigger trigger_notify_new_application
after insert on contractor_applications
for each row
execute function notify_new_application();
