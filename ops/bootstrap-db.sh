#!/bin/sh
set -eu

case "${APP_DB_USER:-}${MIGRATION_USER:-}" in
	*[!A-Za-z0-9_]*|"") echo 'Database role names may contain only letters, numbers, and underscores.' >&2; exit 2 ;;
esac
if [ "$APP_DB_USER" = "$MIGRATION_USER" ] || [ "$APP_DB_USER" = "$POSTGRES_USER" ] || [ "$MIGRATION_USER" = "$POSTGRES_USER" ]; then
	echo 'Bootstrap, runtime, and migration database roles must be distinct.' >&2
	exit 2
fi
if [ "${#APP_DB_PASSWORD}" -lt 24 ] || [ "${#MIGRATION_PASSWORD}" -lt 24 ]; then
	echo 'Runtime and migration database passwords must each contain at least 24 characters.' >&2
	exit 2
fi
export PGPASSWORD="$POSTGRES_PASSWORD"

psql --set ON_ERROR_STOP=on --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv db_name POSTGRES_DB
\getenv app_user APP_DB_USER
\getenv app_password APP_DB_PASSWORD
\getenv migration_user MIGRATION_USER
\getenv migration_password MIGRATION_PASSWORD
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION', :'app_user', :'app_password')
\gexec

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION', :'migration_user', :'migration_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'migration_user')
\gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION', :'migration_user', :'migration_password')
\gexec

SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', :'db_name')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I, %I', :'db_name', :'app_user', :'migration_user')
\gexec
SELECT format('GRANT CREATE ON DATABASE %I TO %I', :'db_name', :'migration_user')
\gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_user')
\gexec
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'migration_user')
\gexec

-- Transfer ordinary public-schema objects from the old bootstrap owner on upgrades.
SELECT format('ALTER TABLE %I.%I OWNER TO %I', schemaname, tablename, :'migration_user')
FROM pg_tables WHERE schemaname = 'public'
\gexec
SELECT format('ALTER SEQUENCE %I.%I OWNER TO %I', n.nspname, c.relname, :'migration_user')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'S'
\gexec
SELECT format('ALTER VIEW %I.%I OWNER TO %I', schemaname, viewname, :'migration_user')
FROM pg_views WHERE schemaname = 'public'
\gexec
SELECT format('ALTER MATERIALIZED VIEW %I.%I OWNER TO %I', schemaname, matviewname, :'migration_user')
FROM pg_matviews WHERE schemaname = 'public'
\gexec
SELECT format('ALTER FUNCTION %I.%I(%s) OWNER TO %I', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), :'migration_user')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
\gexec

SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'app_user')
\gexec
SELECT format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_user')
\gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'migration_user', :'app_user')
\gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', :'migration_user', :'app_user')
\gexec
SELECT format('REVOKE ALL ON TABLE schema_migrations FROM %I', :'app_user')
WHERE to_regclass('public.schema_migrations') IS NOT NULL
\gexec
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
