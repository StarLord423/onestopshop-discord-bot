import { createHash, randomUUID } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
  PermissionFlagsBits, MessageFlags, escapeMarkdown, type ButtonInteraction, type Client,
  type Guild, type GuildMember, type MessageReaction, type PartialMessageReaction,
  type Role, type TextChannel, type User, type PartialUser,
} from 'discord.js';
import { audit, setting, setSetting, type Database } from './db.js';

// Exact role IDs are intentional: a newly created staff role must never become requestable.
export const ROLE_MENU_CHANNEL = '1551415907207741480'; // #🔏get-a-role
export const ROLE_APPROVAL_CHANNEL = '1558915969466765382'; // private #role-approval
export const BETA_APPLICATION_CHANNEL = '1551426929184215061';
export const ROLE_OPTIONS = [
  { emoji: '💎', name: '💎 OSS VIP Premium', id: '1553565622552756417' },
  { emoji: '⭐', name: '⭐ OSS VIP', id: '1552310856660942970' },
  { emoji: '👀', name: '👀 Lurker ++', id: '1552337214661206026' },
  { emoji: '👁️', name: '👁️ Lurker', id: '1552311417904959508' },
  { emoji: '🧪', name: '🧪 Beta Tester', id: '1558916170881568878' },
] as const;

// Owner and Manage Server are also accepted below. This list covers staff who
// can see the private channel but do not necessarily have Manage Server.
const APPROVER_ROLES = new Set([
  '1557748926075904020', // Community Manager
  '1552306607663218791', // Discord Admin
  '1552310687450009653', // Discord Moderator
  '1552311108256272405', // OSS Staff
  '1552311200384163910', // Ticket Support
]);

const FORBIDDEN_PERMISSIONS = [
  PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.ViewAuditLog,
  PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageNicknames, PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers, PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.ManageThreads, PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ManageGuildExpressions,
];

type RoleOption = typeof ROLE_OPTIONS[number];
type RequestRow = {
  id: string; user_id: string; role_id: string; status: string;
  requested_at: number; decided_at: number | null; decided_by: string | null;
  staff_message_id: string | null;
};
const emojiKey = (value: string | null) => value?.replaceAll('\ufe0f', '');

function buttons(id: string, disabled = false) {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`role:approve:${id}`).setLabel('Approve').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`role:deny:${id}`).setLabel('Deny').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  )];
}

function requestEmbed(r: RequestRow, option: RoleOption) {
  const status = r.status === 'pending' ? 'Pending staff review'
    : `${r.status === 'approved' ? 'Approved' : r.status === 'denied' ? 'Denied' : 'Cancelled'}${r.decided_by ? ` by <@${r.decided_by}>` : ''}`;
  return new EmbedBuilder().setTitle('Role request').setColor(r.status === 'approved' ? 0x37a967 : r.status === 'pending' ? 0xc5a349 : 0xb65b59)
    .setDescription(`Member: <@${r.user_id}>\nRequested: **${escapeMarkdown(option.name)}**\nStatus: **${status}**`)
    .addFields({ name: 'Review', value: option.emoji === '🧪'
      ? `Check the member's application in <#${BETA_APPLICATION_CHANNEL}> or their support ticket before approval.`
      : 'Check eligibility, including any purchase or access requirement, before approval.' })
    .setFooter({ text: `Request ${r.id}` }).setTimestamp(r.requested_at);
}

export class RoleRequests {
  private active = false;
  constructor(private client: Client, private guild: Guild, private db: Database,
    private serialize: (fn: () => Promise<void>) => Promise<void>) {}

  private async channel(id: string): Promise<TextChannel> {
    const channel = await this.guild.channels.fetch(id);
    if (!channel || channel.type !== ChannelType.GuildText) throw new Error('Role request channel is missing or is not a text channel');
    return channel;
  }

  private async safeRole(option: RoleOption, me: GuildMember): Promise<Role> {
    const role = await this.guild.roles.fetch(option.id, { force: true });
    if (!role || role.name !== option.name || role.managed || role.id === this.guild.id)
      throw new Error(`Requestable role changed: ${option.name}`);
    if (FORBIDDEN_PERMISSIONS.some(permission => role.permissions.has(permission)))
      throw new Error(`Requestable role has staff permissions: ${option.name}`);
    if (role.comparePositionTo(me.roles.highest) >= 0)
      throw new Error(`Move the bot's highest role above ${option.name} before enabling requests`);
    return role;
  }

  private async validate() {
    const me = await this.guild.members.fetchMe({ force: true });
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Bot needs Manage Roles for approved requests');
    const menu = await this.channel(ROLE_MENU_CHANNEL);
    const staff = await this.channel(ROLE_APPROVAL_CHANNEL);
    if (!menu.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions, PermissionFlagsBits.EmbedLinks]))
      throw new Error('Bot cannot post and react in #get-a-role');
    if (staff.permissionsFor(this.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel))
      throw new Error('#role-approval is visible to @everyone');
    if (!staff.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks]))
      throw new Error('Bot cannot post in #role-approval');
    for (const option of ROLE_OPTIONS) {
      const role = await this.safeRole(option, me);
      if (staff.permissionsFor(role)?.has(PermissionFlagsBits.ViewChannel))
        throw new Error(`#role-approval is visible to requestable role ${option.name}`);
    }
    return { menu, staff };
  }

  async maintain() {
    await this.serialize(async () => {
      const { menu, staff } = await this.validate();
      let messageId = await setting<string | null>(this.db, 'role_panel_message_id', null);
      let message;
      if (messageId) {
        try { message = await menu.messages.fetch(messageId); }
        catch (error) { if ((error as { code?: number }).code !== 10008) throw error; messageId = null; }
      }
      const embed = new EmbedBuilder().setColor(0x45a6a0).setTitle('OneStopShop • Request a role')
        .setDescription(ROLE_OPTIONS.map(option => `${option.emoji}  **${escapeMarkdown(option.name)}**`).join('\n')
          + `\n\nReact below to **request** a role. Staff review each request before a role is assigned.\nFor 🧪 Beta Tester, complete the application in <#${BETA_APPLICATION_CHANNEL}> first. Removing your reaction does not remove an approved role.`);
      if (message) {
        if (message.author.id !== this.client.user?.id) throw new Error('Saved role panel is not owned by this bot');
        if (message.embeds[0]?.description !== embed.data.description)
          await message.edit({ embeds: [embed], allowedMentions: { parse: [] } });
      } else {
        message = await menu.send({ embeds: [embed], allowedMentions: { parse: [] } });
        await setSetting(this.db, 'role_panel_message_id', message.id);
      }
      for (const option of ROLE_OPTIONS) {
        if (!message.reactions.cache.some(reaction => emojiKey(reaction.emoji.name) === emojiKey(option.emoji) && reaction.me))
          await message.react(option.emoji);
      }
      this.active = true;
      const pending = (await this.db.query<RequestRow>("SELECT * FROM role_requests WHERE status='pending' AND staff_message_id IS NULL ORDER BY requested_at LIMIT 25")).rows;
      for (const r of pending) await this.postCard(staff, r);
    });
  }

  private async postCard(staff: TextChannel, r: RequestRow) {
    const option = ROLE_OPTIONS.find(item => item.id === r.role_id);
    if (!option) throw new Error('Pending role request references an unconfigured role');
    const nonce = createHash('sha256').update(`role-request:${r.id}`).digest('hex').slice(0, 24);
    const message = await staff.send({ embeds: [requestEmbed(r, option)], components: buttons(r.id),
      allowedMentions: { parse: [] }, nonce, enforceNonce: true });
    await this.db.query('UPDATE role_requests SET staff_message_id=$2 WHERE id=$1 AND status=\'pending\'', [r.id, message.id]);
  }

  async onReaction(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
    if (!this.active || user.bot) return;
    await this.serialize(async () => {
      if (reaction.message.guildId !== this.guild.id || reaction.message.channelId !== ROLE_MENU_CHANNEL) return;
      if (reaction.message.id !== await setting(this.db, 'role_panel_message_id', '')) return;
      // Fetch partials only for our own menu; ignore reactions in other channels.
      if (reaction.partial) reaction = await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();
      const option = ROLE_OPTIONS.find(item => emojiKey(item.emoji) === emojiKey(reaction.emoji.name));
      if (!option) return;
      const { staff } = await this.validate();
      const member = await this.guild.members.fetch({ user: user.id, force: true });
      if (member.user.bot || member.pending || member.roles.cache.has(option.id)) return;
      const id = randomUUID();
      const now = Date.now();
      const added = await this.db.query<RequestRow>(`INSERT INTO role_requests(id,user_id,role_id,status,requested_at)
        VALUES($1,$2,$3,'pending',$4) ON CONFLICT DO NOTHING RETURNING *`, [id, user.id, option.id, now]);
      if (!added.rows.length) return;
      await audit(this.db, now, user.id, 'role_requested', id, { role: option.id });
      try { await this.postCard(staff, added.rows[0]!); }
      catch (error) { console.error('Role request card:', error instanceof Error ? error.message : 'failed'); }
      // DMs are best effort; a blocked DM does not erase a pending request.
      const recipient = await this.client.users.fetch(user.id).catch(() => null);
      if (recipient) await recipient.send({ content: `Your request for **${escapeMarkdown(option.name)}** is pending staff approval.${option.emoji === '🧪' ? ` Complete the application in <#${BETA_APPLICATION_CHANNEL}> if you have not already.` : ''}`, allowedMentions: { parse: [] } }).catch(() => {});
    });
  }

  async onButton(i: ButtonInteraction) {
    if (!i.customId.startsWith('role:')) return false;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const match = /^role:(approve|deny):([0-9a-f-]{36})$/.exec(i.customId);
      if (!match || i.guildId !== this.guild.id || i.channelId !== ROLE_APPROVAL_CHANNEL)
        throw new Error('This role request control is not valid here.');
      await this.serialize(async () => {
        const actor = await this.guild.members.fetch({ user: i.user.id, force: true });
        if (!(i.user.id === this.guild.ownerId || actor.permissions.has(PermissionFlagsBits.ManageGuild)
          || [...APPROVER_ROLES].some(id => actor.roles.cache.has(id))))
          throw new Error('Only authorized staff can decide role requests.');
        const r = (await this.db.query<RequestRow>('SELECT * FROM role_requests WHERE id=$1', [match[2]])).rows[0];
        if (!r) throw new Error('Role request not found.');
        if (i.message.id !== r.staff_message_id || i.message.author.id !== this.client.user?.id)
          throw new Error('This is not the saved staff review message.');
        if (r.status !== 'pending') throw new Error(`This request is already ${r.status}.`);
        const option = ROLE_OPTIONS.find(item => item.id === r.role_id);
        if (!option) throw new Error('Requested role is not on the allowlist.');
        if (match[1] === 'approve') {
          const { staff } = await this.validate();
          if (staff.id !== i.channelId) throw new Error('Approval channel changed.');
          const role = await this.safeRole(option, await this.guild.members.fetchMe({ force: true }));
          const member = await this.guild.members.fetch({ user: r.user_id, force: true });
          if (member.pending || member.user.bot) throw new Error('Member is not eligible for a role request.');
          if (!member.roles.cache.has(role.id)) await member.roles.add(role, `Role request approved by ${i.user.id}`);
          const receipt = await this.guild.members.fetch({ user: r.user_id, force: true });
          if (!receipt.roles.cache.has(role.id)) throw new Error('Discord has not confirmed the requested role. Request remains pending; check the member before retrying.');
        }
        const status = match[1] === 'approve' ? 'approved' : 'denied';
        const now = Date.now();
        await this.db.transaction(async tx => {
          await tx.query('UPDATE role_requests SET status=$2,decided_at=$3,decided_by=$4 WHERE id=$1 AND status=\'pending\'', [r.id, status, now, i.user.id]);
          await audit(tx, now, i.user.id, `role_${status}`, r.id, { user: r.user_id, role: r.role_id });
        });
        const updated = { ...r, status, decided_at: now, decided_by: i.user.id };
        if (r.staff_message_id) {
          try {
            const channel = await this.channel(ROLE_APPROVAL_CHANNEL);
            const message = await channel.messages.fetch(r.staff_message_id);
            await message.edit({ embeds: [requestEmbed(updated, option)], components: buttons(r.id, true), allowedMentions: { parse: [] } });
          } catch (error) { console.error('Role request card refresh:', error instanceof Error ? error.message : 'failed'); }
        }
        const user = await this.client.users.fetch(r.user_id).catch(() => null);
        if (user) await user.send({ content: status === 'approved'
          ? `Your **${escapeMarkdown(option.name)}** role request was approved.`
          : `Your **${escapeMarkdown(option.name)}** role request was denied. Remove and re-add your reaction if staff asks you to submit a new request.`,
          allowedMentions: { parse: [] } }).catch(() => {});
        await i.editReply(`Request ${status}.`);
      });
    } catch (error) {
      await i.editReply(error instanceof Error ? error.message.slice(0, 500) : 'Unable to process this request.');
    }
    return true;
  }
}
