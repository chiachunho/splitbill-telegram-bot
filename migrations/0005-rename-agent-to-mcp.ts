/**
 * Rename the MCP connection tables from `agent_*` to `mcp_*`, before db:push runs (#147).
 *
 * #155 shipped them as `agent_connections` / `agent_idempotency` with an audit `source` of
 * 'agent'. "agent" names the AI on the other end, not the connection, and n8n or a script
 * isn't one, so the code now says `mcp`. db:push alone would see one table vanish and
 * another appear and ask whether it is a rename, which needs a TTY the build doesn't have.
 *
 * Only previews built from #155 have the old names; production never did, so there this is
 * a no-op. On such a preview the previous deploy reads the old names until the new one is
 * live, which is acceptable for a preview and is why this breaks the usual "old code keeps
 * working" rule. Idempotent: every step checks that the old name still exists.
 */
import type { MigrationSql } from "../scripts/migrate";

export default async function up(sql: MigrationSql) {
  await sql`
    DO $$
    BEGIN
      IF to_regclass('public.agent_connections') IS NOT NULL
         AND to_regclass('public.mcp_connections') IS NULL THEN
        ALTER TABLE agent_connections RENAME TO mcp_connections;
      END IF;
      IF to_regclass('public.agent_idempotency') IS NOT NULL
         AND to_regclass('public.mcp_idempotency') IS NULL THEN
        ALTER TABLE agent_idempotency RENAME TO mcp_idempotency;
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'record_audit_log'
          AND column_name = 'agent_connection_id'
      ) THEN
        ALTER TABLE record_audit_log RENAME COLUMN agent_connection_id TO mcp_connection_id;
      END IF;
    END $$
  `;

  // Names Postgres and drizzle derived from the old table names. Renamed so db:push finds
  // what the schema expects instead of dropping and recreating them.
  await sql`ALTER SEQUENCE IF EXISTS agent_connections_id_seq RENAME TO mcp_connections_id_seq`;
  await sql`ALTER SEQUENCE IF EXISTS agent_idempotency_id_seq RENAME TO mcp_idempotency_id_seq`;
  await sql`ALTER INDEX IF EXISTS agent_connections_user_idx RENAME TO mcp_connections_user_idx`;
  await sql`ALTER INDEX IF EXISTS agent_idempotency_created_idx RENAME TO mcp_idempotency_created_idx`;
  await sql`
    DO $$
    DECLARE
      r record;
    BEGIN
      FOR r IN
        SELECT c.conrelid::regclass::text AS tbl, c.conname AS old,
               replace(c.conname, 'agent_', 'mcp_') AS new
        FROM pg_constraint c
        -- to_regclass, not ::regclass: on a fresh database the tables don't exist yet
        -- (db:push creates them after this), and a NULL simply matches nothing.
        WHERE c.conrelid = ANY (ARRAY[
                to_regclass('public.mcp_connections'),
                to_regclass('public.mcp_idempotency'),
                to_regclass('public.record_audit_log')])
          AND c.conname LIKE '%agent\_%'
      LOOP
        EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.old, r.new);
      END LOOP;
    END $$
  `;

  await sql`UPDATE record_audit_log SET source = 'mcp' WHERE source = 'agent'`;
}
