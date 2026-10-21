-- W3 A14 (spec §3 A14, §8 default 4): dedicated keep-alive table.
-- Strictly non-sensitive heartbeat rows — NEVER grows into a general-purpose table.
create table if not exists public.keepalive (
  id integer primary key default 1,
  updated_at timestamptz not null default now(),
  constraint keepalive_single_row check (id = 1)
);

alter table public.keepalive enable row level security;

-- Permissive SELECT so the publishable-key ping (anon role) counts as user DB activity.
-- F7 (final review): idempotent — a re-run of a half-applied env must not abort here (42710).
do $f7$
  begin
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'keepalive' and policyname = 'keepalive select for anyone'
    ) then
      create policy "keepalive select for anyone"
        on public.keepalive for select
        using (true);
    end if;
  end;
$f7$;

-- Explicit privilege (review P0): RLS policies are not table privileges; new Supabase
-- projects may not auto-grant Data API access. Grant the minimum the ping needs.
grant usage on schema public to anon;
grant select on public.keepalive to anon;

insert into public.keepalive (id) values (1)
on conflict (id) do nothing;
