import 'dotenv/config';
import { mkdir, open, unlink, access, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  Client, Events, GatewayIntentBits, PermissionFlagsBits, MessageFlags, EmbedBuilder,
  escapeMarkdown, ChannelType, type Guild, type GuildMember, type TextChannel,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { openDatabase, migrate, setting, setSetting, audit } from './db.js';
import { Engine, type Member, type Invite } from './engine.js';
import { commands } from './commands.js';

const GUILD = process.env.GUILD_ID || '1551412456050401300';
const BOARD = process.env.LEADERBOARD_CHANNEL_ID || '1558519162303811634';
const DATA = resolve(process.env.DATA_DIR || './data');
const staffRoles = (process.env.STAFF_ROLE_IDS || '').split(',').filter(Boolean);
const token = process.env.DISCORD_TOKEN?.trim();
if (!token) throw new Error('Missing bot token. Run Setup.cmd and enter it in the masked local field. Never send it in chat.');
const ageDays = Number(process.env.MIN_ACCOUNT_AGE_DAYS || 30);
const stayDays = Number(process.env.RETENTION_DAYS || 7);
if (!/^\d{17,20}$/.test(GUILD) || !/^\d{17,20}$/.test(BOARD)
  || !Number.isFinite(ageDays) || ageDays < 0 || !Number.isFinite(stayDays) || stayDays < 0)
  throw new Error('Invalid guild/channel ID or qualification settings.');

await mkdir(DATA, { recursive: true });
const lockPath = resolve(DATA, 'worker.lock');
// Exclusive local lock also protects the embedded database. Do not auto-delete stale locks.
let lock: FileHandle;
try { lock = await open(lockPath, 'wx'); await lock.writeFile(String(process.pid)); }
catch { throw new Error('A worker.lock exists. Check the recorded process has stopped before removing that lock.'); }
const db = await openDatabase(process.env.DATABASE_URL ? undefined : resolve(DATA, 'postgres'), process.env.DATABASE_URL || undefined);
await migrate(db, GUILD);
const engine = new Engine(db, { ageDays, stayDays });
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers], allowedMentions: { parse: [] } });
let guild: Guild;
let healthy = false;
let trackingReason = 'Starting';
let tail = Promise.resolve();
let closing = false;
let joined: Member[] = [];
let joinTimer: ReturnType<typeof setTimeout> | undefined;
let lastBoard = 0;
let boardContent = '';
let lastReconcile = 0;
const safeError = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'number' || typeof code === 'string' ? `Error code ${code}` : 'Operation failed; check connection, permissions and configuration';
};
function queue(fn: () => Promise<void>) {
  const result = tail.then(async () => { engine.awardsEnabled = healthy; await fn(); });
  tail = result.catch(e => { healthy = false; trackingReason = safeError(e); console.error(trackingReason); });
  return result;
}
const model = (m: GuildMember): Member => ({ id: m.id, name: m.displayName, bot: m.user.bot,
  created: m.user.createdTimestamp, joined: m.joinedTimestamp ?? Date.now(), pending: m.pending });
async function allMembers(): Promise<Member[]> {
  const list: Member[] = [];
  let after: string | undefined;
  while (true) {
    const page = await guild.members.list({ limit: 1000, ...(after ? { after } : {}) });
    for (const m of page.values()) list.push(model(m));
    if (page.size < 1000) break;
    const next = [...page.keys()].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1).at(-1)!;
    if (next === after) throw new Error('Member pagination stalled');
    after = next;
  }
  return list;
}
async function inviteSnapshot(): Promise<Invite[]> {
  const data = await guild.invites.fetch();
  const result: Invite[] = [];
  for (const i of data.values()) {
    if (i.uses === null) throw new Error('Invite usage metadata unavailable');
    result.push({ code: i.code, uses: i.uses, owner: i.inviter?.bot ? null : i.inviterId });
  }
  if (guild.vanityURLCode) {
    const vanity = await guild.fetchVanityData();
    result.push({ code: '__vanity__', uses: vanity.uses, owner: null });
  }
  return result;
}
async function sync(gap: boolean) {
  healthy = false;
  engine.awardsEnabled = false;
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error('Manage Server permission is required for invite metadata');
  const members = await allMembers();
  const invites = await inviteSnapshot();
  await engine.reconcile(members, invites, Date.now(), gap);
  healthy = true;
  trackingReason = 'Tracking';
  lastReconcile = Date.now();
  engine.awardsEnabled = true;
  await engine.refresh(Date.now());
  console.log(`Reconciled ${members.length} members and ${invites.length} invite counters.`);
}
async function textChannel(id: string): Promise<TextChannel> {
  const c = await guild.channels.fetch(id);
  if (!c || c.type !== ChannelType.GuildText) throw new Error('Configured channel is not a text channel in this server');
  return c;
}
async function staffChannel(id: string): Promise<TextChannel> {
  const c = await textChannel(id);
  if (c.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) throw new Error('Staff queue channel must be private to @everyone');
  const me = await guild.members.fetchMe();
  if (!c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
    throw new Error('Bot cannot post embeds in the staff channel');
  return c;
}
function boardEmbed(rows: Record<string, any>[]) {
  return new EmbedBuilder().setColor(healthy ? 0xc5a349 : 0xd99039).setTitle('🏆 OneStopShop • Invite Rankings')
    .setDescription(rows.length ? '```text\nRANK MEMBER                INVITES  WAIT\n' + rows.map(r => {
      const name = Array.from(String(r.name).replace(/[`\r\n\t\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,' ')).slice(0,21).join('');
      const rank = `${r.tied > 1 ? 'T' : '#'}${r.rank}`;
      return `${rank.padEnd(4)} ${name.padEnd(21)} ${String(r.qualified).padStart(7)} ${String(r.pending).padStart(5)}`;
    }).join('\n') + '\n```\n**INVITES** = qualified · **WAIT** = pending qualification' : 'No members to rank yet. Use `/invite` to get your personal link.')
    .addFields({ name: 'Your place on the board', value: `Showing ${rows.length} of ${rows[0]?.total ?? 0} members. Ranked by qualified invites; T means tied. Equal scores share a rank, with names listed alphabetically.\nUse /invites to see your rank and /invite to get your link.` },
      { name: 'How invites count', value: `Account age: ${ageDays}+ days at joining. Stay: ${stayDays} continuous days after observation begins. Complete server screening. Departures stop counting; rejoining cannot create another credit.` },
      { name: 'Tracking', value: healthy ? 'Online · attribution is inferred from invite counters. Unclear joins are held for review.' : `Paused: ${trackingReason}. Counts may be stale.` })
    .setFooter({ text: 'Use /invites for your breakdown · /rewards for earned rewards · last refreshed' }).setTimestamp();
}
async function updateBoard(force = false) {
  const now = Date.now();
  if (!force && now - lastBoard < 15_000) return;
  const rows = await engine.leaderboard();
  const content = JSON.stringify({ rows, healthy, trackingReason });
  if (!force && content === boardContent && now - lastBoard < 300_000) return;
  const channel = await textChannel(BOARD);
  let id = await setting<string | null>(db, 'board_message_id', null);
  const embed = boardEmbed(rows);
  if (id) {
    try { const message = await channel.messages.fetch(id); await message.edit({ embeds: [embed], allowedMentions: { parse: [] } }); }
    catch (e) { if ((e as { code?: number }).code === 10008) id = null; else throw e; }
  }
  if (!id) {
    const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    await setSetting(db, 'board_message_id', message.id);
  }
  lastBoard = now; boardContent = content;
}
const instructions = () => setting(db, 'claim_instructions', 'Contact the OneStopShop staff through the server’s support channel. Staff provides keys manually.');
function staffEmbed(a: Record<string, any>) {
  return new EmbedBuilder().setTitle('Earned reward — manual fulfillment').setColor(a.status === 'fulfilled' ? 0x399b62 : 0xc5a349)
    .setDescription(`Member: <@${a.user_id}>\nReward: **${escapeMarkdown(a.label)}**\nMilestone: ${a.threshold} qualified invites\nStatus: **${a.status.replaceAll('_', ' ')}**\nAssigned: ${a.assigned_to ? `<@${a.assigned_to}>` : 'unassigned'}`)
    .addFields({ name: 'Reward ID', value: a.id }, { name: 'Staff actions', value: '`/reward-staff take`, then provide the key manually, then `/reward-staff fulfill`. Never paste keys into bot commands.' })
    .setFooter({ text: 'Fulfilled means staff reported delivery; the bot does not verify redemption.' });
}
async function notifications() {
  if (!healthy) return;
  const jobs = (await db.query(`SELECT o.*,a.user_id,a.label,a.threshold,a.status,a.assigned_to,a.staff_message_id,a.staff_channel_id
    FROM outbox o JOIN awards a ON a.id=o.award_id WHERE o.state='pending' AND o.next_at<=$1 ORDER BY o.id LIMIT 10`, [Date.now()])).rows;
  for (const job of jobs) {
    if (['cancelled', 'on_hold'].includes(job.status)) continue;
    try {
      if (job.kind === 'dm') {
        const user = (await db.query('SELECT * FROM members WHERE id=$1', [job.user_id])).rows[0];
        if (!user?.dm_opt_in) { await db.query("UPDATE outbox SET state='blocked',error='DM consent not enabled' WHERE id=$1", [job.id]); continue; }
        // Verify recipient is still present immediately before messaging.
        await guild.members.fetch({ user: job.user_id, force: true });
        const u = await client.users.fetch(job.user_id);
        const m = await u.send({ content: `Congratulations! You've earned **${escapeMarkdown(job.label)}** for reaching **${job.threshold} qualified invites**!\n\n${await instructions()}\n\nUse /rewards in OneStopShop to check your status. Reward ID: ${job.award_id}\nKeep going for more rewards!`, allowedMentions: { parse: [] } });
        await db.query("UPDATE outbox SET state='sent',message_id=$2,error=NULL WHERE id=$1", [job.id, m.id]);
      } else {
        const channelId = await setting(db, 'staff_channel', process.env.STAFF_CHANNEL_ID || '');
        if (!channelId) continue;
        const c = await staffChannel(channelId);
        const a = (await db.query('SELECT * FROM awards WHERE id=$1', [job.award_id])).rows[0]!;
        const m = await c.send({ embeds: [staffEmbed(a)], allowedMentions: { parse: [] }, nonce: createHash('sha256').update(job.id).digest('hex').slice(0,24), enforceNonce: true });
        await db.transaction(async tx => {
          await tx.query('UPDATE awards SET staff_message_id=$2,staff_channel_id=$3 WHERE id=$1', [a.id, m.id, c.id]);
          await tx.query("UPDATE outbox SET state='sent',message_id=$2,error=NULL WHERE id=$1", [job.id, m.id]);
        });
      }
    } catch (e) {
      const blocked = job.kind === 'dm' && [50007, 10007].includes(Number((e as {code?: number}).code));
      await db.query('UPDATE outbox SET state=$2,attempts=attempts+1,next_at=$3,error=$4 WHERE id=$1',
        [job.id, blocked ? 'blocked' : 'pending', Date.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(job.attempts, 7)), safeError(e)]);
    }
  }
}
async function refreshStaffMessage(id: string) {
  const a = (await db.query('SELECT * FROM awards WHERE id=$1', [id])).rows[0];
  if (!a?.staff_message_id || !a.staff_channel_id) return;
  try { const c = await staffChannel(a.staff_channel_id); const m = await c.messages.fetch(a.staff_message_id); await m.edit({ embeds: [staffEmbed(a)], allowedMentions: { parse: [] } }); }
  catch (e) {
    if ((e as { code?: number }).code === 10008) await db.query("UPDATE outbox SET state='pending',next_at=0 WHERE award_id=$1 AND kind='staff'", [id]);
    console.error('Staff message refresh:', safeError(e));
  }
}
async function isStaff(i: ChatInputCommandInteraction) {
  const m = await guild.members.fetch({ user: i.user.id, force: true });
  return m.permissions.has(PermissionFlagsBits.ManageGuild) || staffRoles.some(id => m.roles.cache.has(id));
}
async function interaction(i: ChatInputCommandInteraction) {
  if (i.guildId !== GUILD) { await i.reply({ content: 'This bot is configured only for OneStopShop.', flags: MessageFlags.Ephemeral }); return; }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await queue(async () => {
    try {
      const staff = ['oss-setup', 'oss-status', 'referral', 'reward-rule', 'reward-staff'].includes(i.commandName);
      if (staff && !await isStaff(i)) { await i.editReply('This command is restricted to authorized staff.'); return; }
      if (i.commandName === 'invite') {
        if (!healthy) { await i.editReply('Tracking is paused. Please try again once staff restores tracking.'); return; }
        const member = await guild.members.fetch({ user: i.user.id, force: true });
        if (member.pending || member.user.bot) { await i.editReply('Complete server screening before requesting an invite.'); return; }
        const existing = (await db.query('SELECT code FROM invites WHERE owner_id=$1 AND active AND managed LIMIT 1', [i.user.id])).rows[0];
        let code = existing?.code;
        if (code) {
          try { await guild.invites.fetch(code); } catch (e) { if ((e as {code?: number}).code === 10006) { await db.query('UPDATE invites SET active=false WHERE code=$1', [code]); code = null; } else throw e; }
        }
        if (!code) {
          const id = await setting(db, 'invite_channel', process.env.INVITE_CHANNEL_ID || '');
          if (!id) { await i.editReply('Staff needs to choose the invite destination with /oss-setup.'); return; }
          const c = await textChannel(id);
          const invite = await c.createInvite({ unique: true, temporary: false, maxAge: 0, maxUses: 0, reason: `Personal referral link requested by ${i.user.id}` });
          code = invite.code;
          await db.query(`INSERT INTO invites(code,owner_id,uses,managed) VALUES($1,$2,$3,true)
            ON CONFLICT(code) DO NOTHING`, [code, i.user.id, invite.uses ?? 0]);
          await audit(db, Date.now(), i.user.id, 'invite_created', code, {});
        }
        await i.editReply(`Your personal invite: https://discord.gg/${code}\nQualifying accounts must be ${ageDays}+ days old at first join, finish screening and stay ${stayDays} continuous days. Rejoins do not create extra credit. Unclear joins need review. Share only with people who want to join.`);
      } else if (i.commandName === 'invites') {
        const stats = (await db.query('SELECT status,count(*)::integer AS count FROM referrals WHERE owner_id=$1 GROUP BY status ORDER BY status', [i.user.id])).rows;
        const place = await engine.memberRank(i.user.id);
        const rank = place ? `Your rank: **${place.tied > 1 ? 'tied ' : ''}#${place.rank} of ${place.total}**\n**${place.qualified}** qualified invites · **${place.pending}** pending\n\n` : '';
        await i.editReply(rank + (stats.length ? stats.map(r => `${r.status}: **${r.count}**`).join('\n') : 'No attributed invites recorded for you since tracking began. Use /invite to get your personal link.'));
      } else if (i.commandName === 'leaderboard') await i.editReply({ embeds: [boardEmbed(await engine.leaderboard())] });
      else if (i.commandName === 'rewards') {
        const consent = i.options.getBoolean('dm-notifications');
        if (consent !== null) {
          await db.query('UPDATE members SET dm_opt_in=$2 WHERE id=$1', [i.user.id, consent]);
          if (consent) await db.query("UPDATE outbox SET state='pending',next_at=0 WHERE kind='dm' AND state='blocked' AND award_id IN (SELECT id FROM awards WHERE user_id=$1)", [i.user.id]);
          await audit(db, Date.now(), i.user.id, 'dm_consent', i.user.id, { enabled: consent });
        }
        const awards = (await db.query('SELECT * FROM awards WHERE user_id=$1 ORDER BY earned_at DESC LIMIT 5', [i.user.id])).rows;
        const opt = (await db.query('SELECT dm_opt_in FROM members WHERE id=$1', [i.user.id])).rows[0]?.dm_opt_in;
        await i.editReply(`Reward DMs: **${opt ? 'enabled' : 'disabled'}**. Use this command’s dm-notifications option to change it.\n\n${awards.length ? awards.map(a => `**${escapeMarkdown(a.label)}** — ${a.status.replaceAll('_',' ')}\nID: ${a.id}`).join('\n\n') : 'No earned rewards yet.'}\n\n${await instructions()}`);
      } else if (i.commandName === 'oss-help') {
        await i.editReply(`We track invite links, Discord user IDs, membership dates, qualification and reward records for this server. Native invite attribution is inferred; unclear cases stay in review. Existing members start as a baseline. Accounts need ${ageDays}+ days of age at first join and ${stayDays} days of observed continuous membership. Leaving removes active credit; returning cannot create a second referral.\n\nKeys are always supplied manually by staff. /rewards shows earned awards and optional DMs. Contact staff to appeal a count or request data deletion. This bot does not read message content, IPs, or other servers. Staff must publish a retention/deletion policy before wider rollout.`);
      } else if (i.commandName === 'oss-setup') {
        const invite = i.options.getChannel('invite-channel'); const staff = i.options.getChannel('staff-channel');
        const claim = i.options.getString('claim-instructions');
        // Validate every input before saving anything.
        if (invite) { const c = await textChannel(invite.id); const me = await guild.members.fetchMe(); if (!c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.CreateInstantInvite])) throw new Error('Invite channel needs View Channel and Create Invite for this bot'); }
        if (staff) await staffChannel(staff.id);
        await db.transaction(async tx => {
          if (invite) await setSetting(tx, 'invite_channel', invite.id);
          if (staff) await setSetting(tx, 'staff_channel', staff.id);
          if (claim) await setSetting(tx, 'claim_instructions', claim);
          await audit(tx, Date.now(), i.user.id, 'setup', GUILD, { invite: invite?.id, staff: staff?.id, claim });
        });
        await i.editReply(`Configuration saved. Invite destination: <#${await setting(db,'invite_channel','unset')}>. Staff queue: <#${await setting(db,'staff_channel','unset')}>.\n${await instructions()}`);
      } else if (i.commandName === 'oss-status') {
        const open = (await db.query("SELECT id,user_id,label,status,assigned_to FROM awards WHERE status NOT IN ('fulfilled','cancelled') ORDER BY earned_at LIMIT 5")).rows;
        const failed = (await db.query("SELECT count(*)::integer AS n FROM outbox WHERE state<>'sent'")).rows[0]!.n;
        await i.editReply(`Tracking: **${healthy ? 'online' : 'paused'}** (${trackingReason})\nLast reconcile: ${lastReconcile ? new Date(lastReconcile).toISOString() : 'none'}\nPending/blocked notifications: ${failed}\n\n${open.map(a => `${a.id}\n<@${a.user_id}> — ${escapeMarkdown(a.label)} — ${a.status}`).join('\n\n') || 'No open staff awards.'}`);
      } else if (i.commandName === 'referral') {
        const action = i.options.getString('action',true); const member = i.options.getUser('member',true);
        if (action === 'inspect') {
          const r = (await db.query('SELECT * FROM referrals WHERE invitee_id=$1', [member.id])).rows[0];
          await i.editReply(r ? `Member: <@${member.id}>\nInviter: ${r.owner_id ? `<@${r.owner_id}>` : 'unresolved'}\nStatus: ${r.status}\nAttribution: ${r.attribution}\nReason: ${escapeMarkdown(r.reason || 'none')}\nObserved stay begins: ${new Date(r.since).toISOString()}` : 'No referral recorded; this member may be part of the launch baseline.');
        } else {
          if (!healthy) throw new Error('Restore tracking before changing referral eligibility');
          await engine.correct(member.id, i.options.getUser('inviter')?.id ?? null, action as 'assign'|'approve'|'exclude', i.options.getString('reason') || '', i.user.id, Date.now());
          await i.editReply('Referral updated with an audit record.');
        }
      } else if (i.commandName === 'reward-rule') {
        const action = i.options.getString('action',true); const threshold = i.options.getInteger('invites');
        if (action !== 'list') {
          if (!threshold) throw new Error('Supply the invites threshold.');
          const label = i.options.getString('reward');
          if (action === 'set') {
            if (!label) throw new Error('Supply the reward description, never the key itself.');
            const staffId = await setting(db, 'staff_channel', process.env.STAFF_CHANNEL_ID || '');
            if (!staffId) throw new Error('Configure a private staff channel using /oss-setup first.');
            await staffChannel(staffId);
            await db.query(`INSERT INTO reward_rules(id,threshold,label) VALUES($1,$2,$3)
              ON CONFLICT(threshold) DO UPDATE SET label=EXCLUDED.label,enabled=true`, [`invites-${threshold}`, threshold, label]);
          } else await db.query('UPDATE reward_rules SET enabled=false WHERE threshold=$1', [threshold]);
          await audit(db, Date.now(), i.user.id, `rule_${action}`, String(threshold), { label });
          if (healthy) await engine.refresh(Date.now());
        }
        const rules = (await db.query('SELECT * FROM reward_rules ORDER BY threshold LIMIT 8')).rows;
        await i.editReply(rules.length ? rules.map(r => `${r.threshold} qualified invites → **${escapeMarkdown(r.label)}** (${r.enabled ? 'enabled' : 'disabled'}; once per member)`).join('\n') : 'No reward milestones configured. Tracking is active independently.');
      } else if (i.commandName === 'reward-staff') {
        const id = i.options.getString('id',true); const action = i.options.getString('action',true) as 'take'|'fulfill'|'cancel';
        if (action !== 'cancel') {
          if (joined.length) throw new Error('A join batch is processing; retry shortly.');
          await sync(!healthy); // Fresh membership check before a manual handoff.
        }
        await engine.staffAward(id, action, i.user.id, Date.now(), i.options.getString('reason') || '');
        await i.editReply(action === 'fulfill' ? 'Recorded your confirmation of manual fulfillment. No key was stored or sent by the bot.' : `Reward ${action} recorded.`);
        await refreshStaffMessage(id);
      }
    } catch (e) {
      const message = e instanceof Error && !('code' in e) ? e.message : safeError(e);
      await i.editReply({ content: message.slice(0,1200), allowedMentions: { parse: [] } });
    }
  });
}

client.on(Events.InteractionCreate, i => { if (i.isChatInputCommand()) void interaction(i).catch(e => console.error('Command:', safeError(e))); });
client.on(Events.GuildMemberAdd, m => {
  if (m.guild.id !== GUILD) return;
  joined.push(model(m));
  if (!joinTimer) joinTimer = setTimeout(() => {
    joinTimer = undefined;
    void queue(async () => {
      const batch = joined; joined = [];
      try { await engine.joins(batch, await inviteSnapshot(), Date.now(), healthy); }
      catch (e) { await engine.joins(batch, [], Date.now(), false); throw e; }
    }).catch(() => {});
  }, 2000);
});
client.on(Events.GuildMemberRemove, m => {
  if (m.guild.id !== GUILD) return;
  void queue(async () => {
    // Flush any pending arrival before its departure so the arrival cannot resurrect it.
    if (joined.length) { const batch = joined; joined = []; await engine.joins(batch, await inviteSnapshot(), Date.now(), healthy); }
    await engine.leave(m.id, Date.now());
  }).catch(() => {});
});
client.on(Events.GuildMemberUpdate, (_old, m) => { if (m.guild.id === GUILD) void queue(() => engine.updateMember(model(m), Date.now())).catch(() => {}); });
// Create/delete events only signal health; snapshots are consumed alongside joins,
// never speculatively overwritten by invite events.
client.on(Events.ShardDisconnect, () => { healthy = false; trackingReason = 'Discord connection lost'; });
client.on(Events.ShardReconnecting, () => { healthy = false; trackingReason = 'Reconnecting; reconciliation required'; });
client.on(Events.ShardResume, () => { if (guild) void queue(() => sync(true)).catch(() => {}); });
client.on(Events.GuildUnavailable, g => { if (g.id === GUILD) { healthy = false; trackingReason = 'Server temporarily unavailable'; } });
client.on(Events.Error, e => { healthy = false; trackingReason = safeError(e); console.error(trackingReason); });
client.once(Events.ClientReady, () => {
  void queue(async () => {
    guild = await client.guilds.fetch(GUILD);
    await guild.commands.set(commands);
    await sync(true);
    await updateBoard(true);
    console.log(`OneStopShop Community online in server ${GUILD}. Leaderboard: ${BOARD}.`);
  }).catch(() => {});
});
const interval = setInterval(() => {
  if (!guild || closing) return;
  void access(resolve(DATA, 'stop.request')).then(() => shutdown().then(() => process.exit(0))).catch(() => {});
  void queue(async () => {
    if (!joined.length) {
      if (!healthy || Date.now()-lastReconcile > 300_000) await sync(!healthy);
      else await engine.refresh(Date.now());
    }
    await updateBoard();
    if (!joined.length) await notifications();
  }).catch(() => {});
}, 15_000);

async function shutdown() {
  if (closing) return;
  closing = true; clearInterval(interval); if (joinTimer) clearTimeout(joinTimer);
  client.destroy(); await tail; await db.close(); await lock.close(); await unlink(lockPath);
  await unlink(resolve(DATA, 'stop.request')).catch(() => {});
}
process.on('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
try { await client.login(token); }
catch (e) { console.error('Bot login failed:', safeError(e)); await shutdown(); process.exitCode=1; }
