import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate } from '../src/db.js';
import { Engine, DAY, type Member } from '../src/engine.js';

const NOW = 100 * DAY;
const member = (id: string, overrides: Partial<Member> = {}): Member => ({ id, name: id, bot: false, created: 0, joined: NOW, pending: false, ...overrides });
const link = (uses: number, code='a', owner: string | null='owner') => ({ code, uses, owner });
async function fixture() {
  const db = await openDatabase(); await migrate(db,'guild');
  const e = new Engine(db,{ageDays:30,stayDays:7});
  await e.reconcile([member('owner'),member('owner2')],[link(0),link(0,'b','owner2')],NOW,false);
  return { db, e };
}
async function rule(e: Engine) { await e.db.query("INSERT INTO reward_rules(id,threshold,label) VALUES('invites-1',1,'a free 1-week key')"); }

test('rankings include zero-score humans, share ties, exclude bots/leavers and return ranks beyond the displayed page', async () => {
  const {db,e}=await fixture();
  try {
    assert.deepEqual((await e.leaderboard()).map(r=>[r.id,r.rank,r.qualified,r.tied]),
      [['owner',1,0,2],['owner2',1,0,2]]);
    await e.joins([member('x')],[link(1),link(0,'b','owner2')],NOW,true);
    assert.equal((await e.memberRank('owner'))!.rank,1);
    assert.equal((await e.memberRank('owner2'))!.rank,1); // Pending is not a score.
    await e.refresh(NOW+8*DAY);
    assert.equal((await e.memberRank('owner2'))!.rank,2);
    await e.joins([member('y',{joined:NOW+8*DAY})],[link(1),link(1,'b','owner2')],NOW+8*DAY,true);
    await e.refresh(NOW+16*DAY);
    assert.equal((await e.leaderboard(1)).length,1);
    assert.equal((await e.memberRank('owner2'))!.rank,1);
    assert.equal((await e.memberRank('owner2'))!.tied,2);
    assert.equal((await e.memberRank('x'))!.rank,3);
    await e.joins([member('robot',{bot:true})],[link(2),link(1,'b','owner2')],NOW+16*DAY,true);
    assert.equal(await e.memberRank('robot'),undefined);
    await e.leave('owner2',NOW+17*DAY);
    assert.equal(await e.memberRank('owner2'),undefined);
    assert.equal((await e.memberRank('owner'))!.total,3);
    await e.leave('x',NOW+17*DAY);
    assert.equal((await e.memberRank('owner'))!.qualified,0);
  } finally { await db.close(); }
});

test('clean join matures only after seven days and screening, then leaves subtract once', async () => {
  const {db,e}=await fixture();
  try {
    await e.joins([member('new',{pending:true})],[link(1),link(0,'b','owner2')],NOW,true);
    await e.refresh(NOW+8*DAY);
    assert.equal((await db.query("SELECT status FROM referrals")).rows[0]!.status,'pending');
    await e.updateMember(member('new'),NOW+8*DAY);
    assert.equal((await e.leaderboard())[0]!.qualified,1);
    await e.leave('new',NOW+9*DAY); await e.leave('new',NOW+9*DAY);
    assert.equal((await e.leaderboard())[0]!.qualified,0);
  } finally { await db.close(); }
});
test('simultaneous different links stay unresolved; later deltas cannot steal them', async () => {
  const {db,e}=await fixture();
  try {
    await e.joins([member('x'),member('y')],[link(1),link(1,'b','owner2')],NOW,true);
    assert.deepEqual((await db.query('SELECT owner_id FROM referrals')).rows.map(r=>r.owner_id),[null,null]);
    await e.joins([member('z')],[link(2),link(1,'b','owner2')],NOW+100,true);
    assert.equal((await db.query("SELECT owner_id FROM referrals WHERE invitee_id='z'")).rows[0]!.owner_id,'owner');
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM referrals WHERE owner_id IS NULL")).rows[0]!.n,2);
  } finally { await db.close(); }
});
test('duplicate events cannot create credits and baseline rejoin remains excluded', async () => {
  const {db,e}=await fixture();
  try {
    await e.joins([member('x'),member('x')],[link(1),link(0,'b','owner2')],NOW,true);
    await e.joins([member('x')],[link(1),link(0,'b','owner2')],NOW+100,true);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM referrals')).rows[0]!.n,1);
    await e.leave('owner2',NOW+1);
    await e.joins([member('owner2',{joined:NOW+2})],[link(2),link(0,'b','owner2')],NOW+2,true);
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM referrals WHERE invitee_id='owner2'")).rows[0]!.n,0);
  } finally { await db.close(); }
});
test('rejoin preserves original attribution and restarts retention', async () => {
  const {db,e}=await fixture();
  try {
    await e.joins([member('x')],[link(1),link(0,'b','owner2')],NOW,true);
    await e.refresh(NOW+8*DAY); await e.leave('x',NOW+9*DAY);
    await e.joins([member('x',{joined:NOW+10*DAY})],[link(1),link(1,'b','owner2')],NOW+10*DAY,true);
    const r=(await db.query('SELECT * FROM referrals')).rows[0]!;
    assert.equal(r.owner_id,'owner'); assert.equal(r.status,'pending');
    await e.refresh(NOW+17*DAY); assert.equal((await e.leaderboard())[0]!.qualified,1);
  } finally { await db.close(); }
});
test('young accounts need audited review; bots never qualify', async () => {
  const {db,e}=await fixture();
  try {
    await e.joins([member('young',{created:NOW-DAY})],[link(1),link(0,'b','owner2')],NOW,true);
    await e.joins([member('bot',{bot:true})],[link(2),link(0,'b','owner2')],NOW+1,true);
    await e.refresh(NOW+8*DAY);
    assert.deepEqual((await db.query('SELECT status FROM referrals ORDER BY invitee_id')).rows.map(r=>r.status),['excluded','review']);
    await e.correct('young',null,'approve','Reviewed genuine member','staff',NOW+8*DAY);
    assert.equal((await e.leaderboard())[0]!.qualified,1);
    await assert.rejects(e.correct('bot',null,'approve','Trying to approve bot','staff',NOW+8*DAY));
  } finally { await db.close(); }
});
test('missing/unknown/vanity counters and observation gaps are never attributed', async () => {
  const {db,e}=await fixture();
  try {
    await e.joins([member('missing')],[link(1)],NOW,true);
    await e.joins([member('gap')],[link(2)],NOW+1,false);
    await e.joins([member('unknown')],[link(2),link(1,'new-code')],NOW+2,true);
    await e.joins([member('vanity')],[link(2),link(1,'new-code'),link(1,'__vanity__',null)],NOW+3,true);
    assert.ok((await db.query('SELECT owner_id FROM referrals')).rows.every(r=>r.owner_id===null));
  } finally { await db.close(); }
});
test('reward earned once, separate notification jobs, atomic staff ownership and closed awards', async () => {
  const {db,e}=await fixture();
  try {
    await rule(e); await e.joins([member('x')],[link(1),link(0,'b','owner2')],NOW,true);
    await e.refresh(NOW+7*DAY); await e.refresh(NOW+8*DAY);
    const awards=(await db.query('SELECT * FROM awards')).rows;
    assert.equal(awards.length,1); assert.equal(awards[0]!.status,'awaiting_staff');
    assert.equal((await db.query('SELECT * FROM outbox')).rows.length,2);
    const id=awards[0]!.id;
    await e.staffAward(id,'take','staff1',NOW+8*DAY,'');
    await assert.rejects(e.staffAward(id,'take','staff2',NOW+8*DAY,''));
    await assert.rejects(e.staffAward(id,'fulfill','staff2',NOW+8*DAY,''));
    await e.staffAward(id,'fulfill','staff1',NOW+8*DAY,'');
    await e.leave('x',NOW+9*DAY);
    await e.joins([member('x',{joined:NOW+10*DAY})],[link(2),link(0,'b','owner2')],NOW+10*DAY,true);
    await e.refresh(NOW+20*DAY);
    assert.equal((await db.query('SELECT * FROM awards')).rows.length,1);
    assert.equal((await db.query('SELECT status FROM awards')).rows[0]!.status,'fulfilled');
  } finally { await db.close(); }
});
test('eligibility loss holds a pending award without erasing it or enabling another award', async () => {
  const {db,e}=await fixture();
  try {
    await rule(e); await e.joins([member('x')],[link(1),link(0,'b','owner2')],NOW,true);
    await e.refresh(NOW+7*DAY);
    const id=(await db.query('SELECT id FROM awards')).rows[0]!.id;
    await e.staffAward(id,'take','staff',NOW+7*DAY,'');
    await e.leave('x',NOW+8*DAY);
    assert.equal((await db.query('SELECT status FROM awards')).rows[0]!.status,'on_hold');
    await assert.rejects(e.staffAward(id,'fulfill','staff',NOW+8*DAY,''));
    await e.joins([member('x',{joined:NOW+9*DAY})],[link(2),link(0,'b','owner2')],NOW+9*DAY,true);
    await e.refresh(NOW+16*DAY);
    assert.equal((await db.query('SELECT status FROM awards')).rows[0]!.status,'in_progress');
    assert.equal((await db.query('SELECT * FROM awards')).rows.length,1);
  } finally { await db.close(); }
});
test('restart reconciliation resets uncertain stay and records unseen members as unresolved', async () => {
  const {db,e}=await fixture();
  try {
    await e.joins([member('x')],[link(1),link(0,'b','owner2')],NOW,true);
    await e.refresh(NOW+7*DAY);
    await e.reconcile([member('owner'),member('owner2'),member('x'),member('unseen')],[link(2),link(0,'b','owner2')],NOW+8*DAY,true);
    assert.equal((await db.query("SELECT status FROM referrals WHERE invitee_id='x'")).rows[0]!.status,'pending');
    assert.equal((await db.query("SELECT owner_id FROM referrals WHERE invitee_id='unseen'")).rows[0]!.owner_id,null);
    await e.reconcile([member('owner'),member('owner2')],[link(2),link(0,'b','owner2')],NOW+9*DAY,false);
    assert.equal((await db.query("SELECT status FROM referrals WHERE invitee_id='x'")).rows[0]!.status,'left');
  } finally { await db.close(); }
});
test('paused tracking cannot generate new awards', async () => {
  const {db,e}=await fixture();
  try {
    await rule(e); await e.joins([member('x')],[link(1),link(0,'b','owner2')],NOW,true);
    e.awardsEnabled=false; await e.refresh(NOW+8*DAY);
    assert.equal((await db.query('SELECT * FROM awards')).rows.length,0);
    e.awardsEnabled=true; await e.refresh(NOW+8*DAY);
    assert.equal((await db.query('SELECT * FROM awards')).rows.length,1);
  } finally { await db.close(); }
});
test('unresolved correction preserves age review and cannot transfer existing ownership', async () => {
  const {db,e}=await fixture();
  try {
    await e.joins([member('x',{created:NOW-DAY})],[link(0),link(0,'b','owner2')],NOW,true);
    await e.correct('x','owner','assign','Member provided referral evidence','staff',NOW+8*DAY);
    assert.equal((await db.query('SELECT status FROM referrals')).rows[0]!.status,'review');
    await assert.rejects(e.correct('x','owner2','assign','Switching the original owner','staff',NOW+8*DAY));
  } finally { await db.close(); }
});
test('file-backed PostgreSQL persists across a close/reopen and rejects wrong guild', async () => {
  const dir=await mkdtemp(join(tmpdir(),'oss-bot-test-'));
  let db=await openDatabase(dir);
  try {
    await migrate(db,'guild'); await db.query("INSERT INTO settings(key,value) VALUES('receipt','\"persisted\"')");
    await db.close(); db=await openDatabase(dir); await migrate(db,'guild');
    assert.equal((await db.query("SELECT value FROM settings WHERE key='receipt'")).rows[0]!.value,'persisted');
    await assert.rejects(migrate(db,'different-guild'));
  } finally { await db.close(); await rm(dir,{recursive:true,force:true}); }
});
