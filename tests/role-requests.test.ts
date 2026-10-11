import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, migrate } from '../src/db.js';
import { ROLE_OPTIONS } from '../src/role-requests.js';

test('only one pending request exists for a member and role, and a decision permits a new request', async () => {
  const db = await openDatabase();
  try {
    await migrate(db, 'guild');
    const role = ROLE_OPTIONS[0].id;
    const insert = (id: string) => db.query(`INSERT INTO role_requests(id,user_id,role_id,status,requested_at)
      VALUES($1,'member',$2,'pending',1) ON CONFLICT DO NOTHING RETURNING id`, [id, role]);
    assert.equal((await insert('first')).rows.length, 1);
    assert.equal((await insert('duplicate')).rows.length, 0);
    await db.query("UPDATE role_requests SET status='denied',decided_by='staff',decided_at=2 WHERE id='first'");
    assert.equal((await insert('second')).rows.length, 1);
    const rows = (await db.query('SELECT id,status FROM role_requests ORDER BY id')).rows;
    assert.deepEqual(rows.map(row => [row.id, row.status]), [['first', 'denied'], ['second', 'pending']]);
  } finally { await db.close(); }
});
