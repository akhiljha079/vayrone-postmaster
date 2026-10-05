# /db

- `migrations/NNN_description.sql` — one numbered file per schema change. Never edit a released migration; add a new one.
- `schema.sql` — **generated** by `npm run db:schema`, used for fresh installs. `schema.manifest.json` lists the versions and checksums it contains so the runner can record them in `schema_migrations`.

Compatibility target: MariaDB 10.11 / 11.4 LTS and MySQL 8.4 LTS. Avoid engine-specific syntax (no `utf8mb4_0900_*` collations, no MySQL-only JSON functions in DDL).

Upgrade flow (Phase 10): pre-update backup → apply pending migrations in order, each in its own transaction where DDL allows → verify checksums → on failure restore the backup and roll back the binary.
