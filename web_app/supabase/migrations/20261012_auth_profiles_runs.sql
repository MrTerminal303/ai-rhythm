-- W3 T23 (B6, D29): auth-backed profiles + personal run history.
-- Operator action: apply via the dashboard SQL editor (same path as T1/A14's keepalive).
-- After applying, VALIDATE — do not assume defaults: confirm the grants below are present
-- (`information_schema.role_table_grants`) and the policies match (`pg_policies`), because
-- new Supabase projects may not auto-grant Data API access, and a missing grant and an RLS
-- policy are SEPARATE controls (either alone leaves the table unreachable).

-- profiles: profile + settings (owner-only)
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text unique,
  settings jsonb,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "profiles: owner all" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- runs: personal run history — score sync authorized HERE, never via profiles (spec §4 B6)
create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,                     -- CLIENT-generated stable id (round 3 P1-4): idempotent retries
  user_id uuid not null references auth.users on delete cascade,
  chart_hash text not null,
  audio_hash text,
  score int not null,
  accuracy numeric not null,
  max_combo int not null,
  judgements jsonb not null,
  played_at timestamptz not null default now(), -- the client ALSO sends RunResult.playedAt explicitly (validated) — this default only covers legacy rows
  created_at timestamptz not null default now(),
  unique (user_id, run_id)                  -- duplicate upload with the same runId → conflict → no-op (idempotent)
);
alter table public.runs enable row level security;
create policy "runs: read own" on public.runs for select using (auth.uid() = user_id);
create policy "runs: insert own" on public.runs for insert with check (auth.uid() = user_id);
-- no update/delete policies in W3 — rows are append-only personal history

-- Explicit privileges (review P0): RLS policies are NOT table privileges; new Supabase projects
-- may not auto-grant Data API access. Grant the minimum each flow needs — verify the resulting
-- grants + policies in the dashboard after running (validate, don't assume defaults).
-- NOTE: `anon` is deliberately granted NOTHING here. Guests have zero cloud access
-- (spec §4 guest policy), so an unauthenticated read must fail at the GRANT layer with a
-- non-2xx, not merely return zero rows. Do not "fix" this by granting anon SELECT.
grant usage on schema public to authenticated;
grant select, insert, update on public.profiles to authenticated;  -- owner-all policy; no delete needed in W3
grant select, insert on public.runs to authenticated;             -- append-only personal history
