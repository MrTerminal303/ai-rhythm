# W3 B6 — auth journey evidence template (T23)

Fill this in when exercising the guest / signed-in journeys. Every row needs an OBSERVED
result, not an expected one. A row that was not exercised is marked `not run` — never `pass`.

## Environment

- Build: `pnpm --filter @airhythm/web build && pnpm start` (production CSP)
- Supabase project ref: _<project-ref>_ — migration `20261012_auth_profiles_runs.sql` applied: yes/no
- Browser + platform: _<chrome version / windows 10 pro 19045>_

## Guest zero-touch (the load-bearing invariant)

| # | Step | Observed |
|---|------|----------|
| 1 | Fresh profile, open `/` → `/play`, play a full chart to completion | Requests to `*.supabase.co`: ___ (must be 0) |
| 2 | On the results screen, note the overlay | `results-overlay` visible: ___ / `run-sync-error` visible: ___ (must be absent) |
| 3 | Reload `/settings`, press **Sync now** | Deferred notice shown (guest has no channel): ___ |
| 4 | Play a second run | Still zero cloud requests: ___ |

## Signed-in journey

| # | Step | Observed |
|---|------|----------|
| 1 | `/auth` → create account (confirmation disabled) | Row appears in `profiles` for the new user id: ___ |
| 2 | Change a volume on `/settings`, wait 2 s | `profiles.settings` updated with the new envelope (rev advanced): ___ |
| 3 | Reload the page | Session restored, `/settings` shows the synced value: ___ |
| 4 | Play a run to completion | One row in `runs` for this user with `run_id` = the RunResult id, `verified` copy labelled unverified in UI: ___ |
| 5 | Sign out, play a run | No new `runs` row; the guest run is never queued: ___ |

## Remote-payload paths

| # | Step | Observed |
|---|------|----------|
| 1 | Set `profiles.settings = NULL` in the SQL editor, then sync | Row ends initialized with local values, sync reports ok: ___ |
| 2 | Set `profiles.settings = '{"nonsense":1}'`, then sync | `settings-sync-deferred` shown, local settings unchanged: ___ |
| 3 | Set a remote `deviceCalibrationOffsetMs` envelope with a high rev, then sync | `/settings` value AND `loadCalibration()` (next run's offset) both show the remote value: ___ |

## Grant/policy validation (validate, do not assume)

Run in the SQL editor after applying the migration:

```sql
select grantee, privilege_type from information_schema.role_table_grants
 where table_name in ('profiles','runs') order by table_name, grantee, privilege_type;

select tablename, policyname, cmd, qual, with_check from pg_policies
 where tablename in ('profiles','runs') order by tablename, policyname;
```

- `anon` holds NO privilege on either table: ___
- `authenticated` holds exactly: profiles(select,insert,update), runs(select,insert): ___
- Policies match `20261012_auth_profiles_runs.sql`: ___

See `evidence/b6-rls.md` for the executed request-level cases (`SUPABASE_TEST=1` suite).
