const identifier = value => `"${value.replaceAll('"', '""')}"`;
const literal = value => `'${value.replaceAll("'", "''")}'`;

export async function reconcileRole(client, { role, password, database, owner, readOnly }) {
  const target = identifier(role);
  await client.query('BEGIN');
  try {
    const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    if (!existing.rowCount) await client.query(`CREATE ROLE ${target} LOGIN PASSWORD ${literal(password)}`);
    else await client.query(`ALTER ROLE ${target} PASSWORD ${literal(password)}`);
    await client.query(`GRANT CONNECT ON DATABASE ${identifier(database)} TO ${target}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${target}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${target}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${target}`);
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(owner)} IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM ${target}`);
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(owner)} IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM ${target}`);
    await client.query(`REVOKE CREATE ON SCHEMA public FROM ${target}`);
    for (const table of ['schema_migrations', 'deliveries', 'delivery_evidence']) {
      const columns = await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', ['public', table]);
      if (!columns.rowCount) continue;
      const identifiers = columns.rows.map(({ column_name }) => identifier(column_name)).join(',');
      await client.query(`REVOKE ALL PRIVILEGES (${identifiers}) ON public.${table} FROM ${target}`);
      await client.query(`GRANT SELECT ON public.${table} TO ${target}`);
      if (!readOnly && table !== 'schema_migrations') await client.query(`GRANT INSERT ON public.${table} TO ${target}`);
      if (!readOnly && table === 'deliveries') await client.query(`GRANT UPDATE(status,attempts,provider_id,evidence) ON public.deliveries TO ${target}`);
    }
    if (readOnly) await client.query(`ALTER ROLE ${target} SET default_transaction_read_only = on`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
