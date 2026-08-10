# Logo Catalogue

Web page where people upload company logos into a shared catalogue.
Static site on Netlify, data + files in Supabase. No build step, no framework.

## Files

| File | Role |
|---|---|
| `index.html` | Whole app: upload view + gallery view. Vanilla JS, supabase-js from CDN. |
| `config.js` | Supabase project URL + anon key. Safe to commit (see below). |
| `schema.sql` | Tables, storage bucket, RLS policies, seed data. Idempotent — safe to re-run. |
| `netlify.toml` | Publish config. `publish = "."`, no build command. |

## Supabase

Project ref: `fbtvbdixarkfarwoivef`

- `companies` — id, name, alt_name, sort_order, locked, created_at
- `logos` — id, company_id → companies, path, file_name, created_at. **One live logo per company**, enforced by a partial unique index on `company_id where deleted_at is null`.
- Storage bucket `logos`, public, 5 MB/file, images only. Object path is `<company_id>/<uuid>.<ext>`.

Schema changes are DDL, so they can only be applied from the Supabase dashboard
SQL Editor (the anon key cannot run them). After editing `schema.sql`, the user
must paste it into the SQL Editor and run it.

## Decisions worth not re-litigating

**Access model is "anyone with the link" — chosen deliberately.** The RLS
policies grant the `anon` role full read/write/delete on both tables and the
bucket. Anyone who reaches the URL can upload or delete, and can do it straight
against the REST API since the anon key ships in the page source. The user was
told this and accepted it for now. A login gate (Supabase Auth) was offered and
deferred — revisit before the URL goes anywhere public.

**The anon key in `config.js` is not a leak.** It is designed to be public;
RLS is the actual control. The `service_role` key must never appear here.

**Renaming is possible from `schema.sql`, just not from the app.** `三菱` was
renamed to `Mitsubishi` (with `三菱` moved into `alt_name`) by dropping the
`prevent_rename` trigger, running the UPDATE, and letting the trigger section
lower down recreate it. Any future rename follows that pattern, and must sit
**before** the seed block — the seed is guarded on `name`, so renaming after it
would insert a duplicate under the old name.

**The 25 seeded companies are locked.** Their names cannot be edited, enforced
by the `prevent_rename` trigger rather than just the UI, because RLS
`WITH CHECK` cannot see the OLD row. The seed list is guarded per name, not by
"table is empty", so re-running `schema.sql` picks up companies added to the
list later — the cost being that a seeded company purged from the bin returns
on the next run.

**`alt_name` holds the same company in the other script** — `Panasonic` ↔
`國際牌`, `Mitsubishi` ↔ `三菱`. It exists because `name` is immutable: the
established 11 were already live under single names and could not be renamed
to a combined form without deleting them and cascading away their logos. It is
mutable (only `name` is frozen), so it can be backfilled. Upload tiles show
`Panasonic（國際牌）`; the gallery, panel and bin stay on `name` alone so
headings and captions do not wrap.

**One logo per company** (reversed 2026-07-30; was "uploads are additive").
Once a company has a logo its tile becomes a solid-bordered frame showing the
logo at full opacity — no `+`, no drop target, and the panel's upload area is
hidden. Deleting the logo frees the slot. The index is partial on
`deleted_at is null`, so binned logos do not hold the slot, and the bin can
hold several old logos for one company. A restore fails if the slot was
refilled meanwhile; `index.html` checks for that and says so in words.

**Companies sort A–Z in the browser, not in SQL.** `activeCompanies()` sorts by
`localeCompare` on the display name. `sort_order` still exists and is still
written on insert, but nothing reads it for display any more.

## Running it

```
netlify dev          # local preview at localhost:8888
netlify deploy --prod  # needs `netlify login` first (interactive browser flow)
```

`netlify dev` only serves locally — it is not a deploy. Uploads done locally
still hit the live Supabase project.

## Status

- Supabase: live, schema applied, verified end-to-end (table read, anon upload,
  unauthenticated public read, anon delete).
- Netlify: **not deployed yet.** Blocked on the user running `netlify login`,
  which needs their browser.
