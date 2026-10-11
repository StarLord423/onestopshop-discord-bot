import { randomUUID } from 'node:crypto';
import { audit, setting, setSetting, type Database, type Sql } from './db.js';

export const DAY = 86_400_000;
export interface Member { id: string; name: string; bot: boolean; created: number; joined: number; pending: boolean }
export interface Invite { code: string; uses: number; owner: string | null }
export interface Rules { ageDays: number; stayDays: number }

async function saveMember(db: Sql, m: Member, baseline: boolean) {
  await db.query(`INSERT INTO members(id,name,bot,created_at,joined_at,present,pending,baseline)
    VALUES($1,$2,$3,$4,$5,true,$6,$7) ON CONFLICT(id) DO UPDATE SET
    name=EXCLUDED.name,bot=EXCLUDED.bot,joined_at=EXCLUDED.joined_at,present=true,pending=EXCLUDED.pending`,
  [m.id, m.name, m.bot, m.created, m.joined, m.pending, baseline]);
}
async function saveInvites(db: Sql, invites: Invite[]) {
  await db.query('UPDATE invites SET active=false');
  for (const i of invites) await db.query(`INSERT INTO invites(code,owner_id,uses) VALUES($1,$2,$3)
    ON CONFLICT(code) DO UPDATE SET uses=EXCLUDED.uses,active=true`, [i.code, i.owner, i.uses]);
}

export class Engine {
  awardsEnabled = true;
  constructor(public db: Database, public rules: Rules) {}

  // Full successful member-list receipt required before calling this method.
  async reconcile(members: Member[], invites: Invite[], now: number, gap: boolean) {
    await this.db.transaction(async tx => {
      const initialized = await setting(tx, 'initialized', false);
      const prior = new Map((await tx.query('SELECT * FROM members')).rows.map(m => [m.id, m]));
      await tx.query('UPDATE members SET present=false');
      for (const m of members) {
        const old = prior.get(m.id);
        await saveMember(tx, m, !initialized);
        if (initialized && !old) {
          await tx.query(`INSERT INTO referrals(invitee_id,first_joined,since,attribution,status,reason,review)
            VALUES($1,$2,$3,'unresolved','review','Joined outside a complete observation window',true)
            ON CONFLICT DO NOTHING`, [m.id, m.joined, now]);
        } else if (old && (!old.present || old.joined_at !== m.joined)) {
          await tx.query('UPDATE referrals SET since=$2 WHERE invitee_id=$1', [m.id, now]);
          await audit(tx, now, 'system', 'membership_episode', m.id, { joined: m.joined });
        }
      }
      if (gap) {
        await tx.query('UPDATE referrals SET since=$1 WHERE invitee_id IN (SELECT id FROM members WHERE present)', [now]);
        await audit(tx, now, 'system', 'observation_gap', 'guild', { action: 'Restart observed retention; do not attribute downtime counters' });
      }
      await saveInvites(tx, invites);
      await setSetting(tx, 'initialized', true);
      await setSetting(tx, 'last_reconciled', now);
    });
    await this.refresh(now);
  }

  async joins(batch: Member[], invites: Invite[], now: number, continuous: boolean) {
    await this.db.transaction(async tx => {
      const previous = new Map((await tx.query('SELECT * FROM invites WHERE active')).rows.map(i => [i.code, i]));
      const arrivals: Member[] = [];
      for (const m of new Map(batch.map(m => [m.id, m])).values()) {
        const old = (await tx.query('SELECT * FROM members WHERE id=$1', [m.id])).rows[0];
        if (!old?.present || old.joined_at !== m.joined) arrivals.push(m);
        await saveMember(tx, m, false);
      }
      // All visible deltas, not just managed links, participate in the ambiguity check.
      const deltas = invites.filter(i => !previous.has(i.code) ? i.uses > 0 : i.uses !== previous.get(i.code)!.uses);
      const missing = [...previous.keys()].some(code => !invites.some(i => i.code === code));
      const change = deltas[0];
      const match = continuous && arrivals.length === 1 && deltas.length === 1 && !missing && change
        && previous.has(change.code) && change.uses - previous.get(change.code)!.uses === 1
        ? previous.get(change.code)! : null;
      for (const m of arrivals) {
        const old = (await tx.query('SELECT * FROM referrals WHERE invitee_id=$1', [m.id])).rows[0];
        if (old) {
          await tx.query('UPDATE referrals SET since=$2 WHERE invitee_id=$1', [m.id, now]);
          await audit(tx, now, 'system', 'rejoin_no_new_credit', m.id, { owner: old.owner_id });
          continue;
        }
        const base = (await tx.query('SELECT baseline FROM members WHERE id=$1', [m.id])).rows[0];
        if (base?.baseline) continue;
        const owner = match?.owner_id ?? null;
        const excluded = m.bot || owner === m.id;
        const young = m.joined - m.created < this.rules.ageDays * DAY;
        const reason = excluded ? 'Bot or self referral' : !owner ? 'Ambiguous or untracked invite' : young ? 'Account below minimum age at first join' : '';
        await tx.query(`INSERT INTO referrals(invitee_id,owner_id,code,first_joined,since,attribution,status,reason,review,excluded)
          VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9) ON CONFLICT DO NOTHING`,
        [m.id, owner, match?.code ?? null, m.joined, now, owner ? 'inferred' : 'unresolved', reason, young || !owner, excluded]);
        await audit(tx, now, 'system', 'join', m.id, { owner, code: match?.code ?? null, reason, batchSize: arrivals.length });
      }
      await saveInvites(tx, invites);
    });
    await this.refresh(now);
  }

  async leave(id: string, now: number) {
    await this.db.transaction(async tx => {
      await tx.query('UPDATE members SET present=false WHERE id=$1', [id]);
      await audit(tx, now, 'system', 'leave', id, {});
    });
    await this.refresh(now);
  }
  async updateMember(m: Member, now: number) {
    await this.db.query('UPDATE members SET name=$2,pending=$3,bot=$4 WHERE id=$1', [m.id, m.name, m.pending, m.bot]);
    await this.refresh(now);
  }

  async refresh(now: number) {
    await this.db.transaction(async tx => {
      await tx.query(`UPDATE referrals r SET status=CASE
        WHEN r.excluded OR m.bot THEN 'excluded' WHEN NOT m.present THEN 'left'
        WHEN r.review OR r.owner_id IS NULL THEN 'review'
        WHEN m.pending OR $1-r.since < $2 THEN 'pending' ELSE 'qualified' END
        FROM members m WHERE m.id=r.invitee_id`, [now, this.rules.stayDays * DAY]);
      const rules = this.awardsEnabled ? (await tx.query('SELECT * FROM reward_rules WHERE enabled')).rows : [];
      const owners = (await tx.query(`SELECT r.owner_id, count(*)::integer AS total FROM referrals r
        JOIN members m ON m.id=r.owner_id WHERE r.status='qualified' AND m.present AND NOT m.bot GROUP BY r.owner_id`)).rows;
      const scores = new Map(owners.map(o => [o.owner_id, o.total]));
      for (const rule of rules) for (const owner of owners) {
        if (owner.total < rule.threshold) continue;
        const evidence = (await tx.query("SELECT invitee_id FROM referrals WHERE owner_id=$1 AND status='qualified' ORDER BY invitee_id", [owner.owner_id])).rows.map(r => r.invitee_id);
        const id = randomUUID();
        const added = await tx.query(`INSERT INTO awards(id,user_id,rule_id,threshold,label,earned_at,evidence)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,rule_id) DO NOTHING RETURNING id`,
        [id, owner.owner_id, rule.id, rule.threshold, rule.label, now, JSON.stringify(evidence)]);
        if (added.rows.length) {
          for (const kind of ['dm', 'staff']) await tx.query('INSERT INTO outbox(id,award_id,kind) VALUES($1,$2,$3)', [randomUUID(), id, kind]);
          await audit(tx, now, 'system', 'reward_earned', id, { user: owner.owner_id, rule: rule.id, label: rule.label });
        }
      }
      for (const a of (await tx.query("SELECT * FROM awards WHERE status NOT IN ('fulfilled','cancelled')")).rows) {
        const eligible = (scores.get(a.user_id) ?? 0) >= a.threshold;
        const next = eligible ? a.assigned_to ? 'in_progress' : 'awaiting_staff' : 'on_hold';
        if (next !== a.status) {
          await tx.query('UPDATE awards SET status=$2 WHERE id=$1', [a.id, next]);
          await audit(tx, now, 'system', 'reward_status', a.id, { from: a.status, to: next });
        }
      }
    });
  }

  async correct(invitee: string, owner: string | null, action: 'assign' | 'approve' | 'exclude', reason: string, actor: string, now: number) {
    if (reason.trim().length < 8) throw new Error('Include a clear reason (at least 8 characters).');
    await this.db.transaction(async tx => {
      const r = (await tx.query('SELECT * FROM referrals WHERE invitee_id=$1', [invitee])).rows[0];
      if (!r) throw new Error('No tracked referral exists for that member. Baseline members cannot be credited.');
      if (action === 'assign') {
        if (r.owner_id) throw new Error('Existing referral ownership cannot be transferred.');
        const m = (await tx.query('SELECT * FROM members WHERE id=$1', [owner])).rows[0];
        if (!m?.present || m.bot || owner === invitee) throw new Error('Choose a current human inviter other than the invitee.');
        // Assignment resolves attribution, not the account-age review.
        const inviteeRow = (await tx.query('SELECT created_at FROM members WHERE id=$1', [invitee])).rows[0]!;
        const young = r.first_joined - inviteeRow.created_at < this.rules.ageDays * DAY;
        await tx.query("UPDATE referrals SET owner_id=$2,attribution='staff_corrected',review=$3,reason=$4 WHERE invitee_id=$1", [invitee, owner, young, reason]);
      } else if (action === 'approve') {
        if (!r.owner_id || r.excluded) throw new Error('Resolve attribution first; exclusions cannot be approved with this command.');
        await tx.query('UPDATE referrals SET review=false,reason=$2 WHERE invitee_id=$1', [invitee, reason]);
      } else await tx.query('UPDATE referrals SET excluded=true,reason=$2 WHERE invitee_id=$1', [invitee, reason]);
      await audit(tx, now, actor, `referral_${action}`, invitee, { before: r, owner, reason });
    });
    await this.refresh(now);
  }

  async staffAward(id: string, action: 'take' | 'fulfill' | 'cancel', actor: string, now: number, reason: string) {
    await this.db.transaction(async tx => {
      const a = (await tx.query('SELECT * FROM awards WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!a) throw new Error('Unknown reward ID.');
      if (['fulfilled', 'cancelled'].includes(a.status)) throw new Error('This award is already closed.');
      if (action === 'take') {
        if (a.status !== 'awaiting_staff' || a.assigned_to) throw new Error('Award is held or already assigned.');
        await tx.query("UPDATE awards SET assigned_to=$2,status='in_progress' WHERE id=$1", [id, actor]);
      } else if (action === 'fulfill') {
        if (a.status !== 'in_progress' || a.assigned_to !== actor) throw new Error('Only the assigned staff member can fulfill an eligible award.');
        await tx.query("UPDATE awards SET status='fulfilled',fulfilled_at=$2 WHERE id=$1", [id, now]);
      } else {
        if (reason.trim().length < 8) throw new Error('Cancellation requires a clear reason.');
        await tx.query("UPDATE awards SET status='cancelled' WHERE id=$1", [id]);
      }
      await audit(tx, now, actor, `reward_${action}`, id, { reason });
    });
  }

  private rankingQuery = `WITH totals AS (SELECT m.id,m.name,
      count(*) FILTER(WHERE r.status='qualified')::integer AS qualified,
      count(*) FILTER(WHERE r.status='pending')::integer AS pending
      FROM members m LEFT JOIN referrals r ON r.owner_id=m.id WHERE m.present AND NOT m.bot
      GROUP BY m.id,m.name), ranked AS (SELECT *,
      rank() OVER (ORDER BY qualified DESC)::integer AS rank,
      count(*) OVER (PARTITION BY qualified)::integer AS tied,
      count(*) OVER ()::integer AS total FROM totals) SELECT * FROM ranked`;

  async leaderboard(limit = 25) {
    return (await this.db.query(`${this.rankingQuery}
      ORDER BY qualified DESC,lower(name),id LIMIT $1`, [limit])).rows;
  }

  async memberRank(id: string) {
    return (await this.db.query(`${this.rankingQuery} WHERE id=$1`, [id])).rows[0];
  }
}
