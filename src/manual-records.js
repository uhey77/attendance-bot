// User-approved backfill; Sheets row is entered separately with the same ID.
// Idempotent migration, scoped to this deployment's owner. No Slack post is sent.
export async function applyManualRecords(tx, env) {
  if (env.ALLOWED_TEAM_ID !== 'T00000000' || env.ALLOWED_USER_ID !== 'U00000001') return;
  const record = { id: 'manual-20260927-20m46s-01', kind: 'manual',
    workDate: '2026-09-27', durationMs: 1246000, startedAt: null, endedAt: null };
  const marker = 'migration:manual-20260927-20m46s-01';
  if (await tx.get(marker)) return;
  if (await tx.get('record:' + record.id)) throw new Error('Manual record ID conflict');
  await tx.put('record:' + record.id, record);
  await tx.put(marker, true);
}
