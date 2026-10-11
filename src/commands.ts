import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('invite').setDescription('Get your personal OneStopShop invite link'),
  new SlashCommandBuilder().setName('invites').setDescription('See your qualified, pending and departed referrals'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('View the current invite leaderboard'),
  new SlashCommandBuilder().setName('rewards').setDescription('See earned rewards and manual claim instructions')
    .addBooleanOption(o => o.setName('dm-notifications').setDescription('Opt in or out of earned-reward DMs')),
  new SlashCommandBuilder().setName('oss-help').setDescription('Read invite rules, data use and support information'),
  new SlashCommandBuilder().setName('oss-setup').setDescription('Configure this server’s bot channels')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('invite-channel').setDescription('Destination for personal invite links').addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o => o.setName('staff-channel').setDescription('Existing private staff channel for reward queue').addChannelTypes(ChannelType.GuildText))
    .addStringOption(o => o.setName('claim-instructions').setDescription('How a member should contact staff for their reward').setMaxLength(500)),
  new SlashCommandBuilder().setName('oss-status').setDescription('Inspect tracking health and pending staff awards')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('referral').setDescription('Inspect or correct an individual referral')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
      { name: 'Inspect', value: 'inspect' }, { name: 'Assign unresolved referrer', value: 'assign' },
      { name: 'Approve age review', value: 'approve' }, { name: 'Exclude', value: 'exclude' }))
    .addUserOption(o => o.setName('member').setDescription('Invited member').setRequired(true))
    .addUserOption(o => o.setName('inviter').setDescription('Owner for an unresolved referral'))
    .addStringOption(o => o.setName('reason').setDescription('Evidence/reason; never include keys or personal information').setMaxLength(400)),
  new SlashCommandBuilder().setName('reward-rule').setDescription('Configure automatic earned-reward notices; keys remain manual')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
      { name: 'List', value: 'list' }, { name: 'Set milestone', value: 'set' }, { name: 'Disable milestone', value: 'disable' }))
    .addIntegerOption(o => o.setName('invites').setDescription('Qualified retained invites required').setMinValue(1).setMaxValue(100000))
    .addStringOption(o => o.setName('reward').setDescription('Reward description, e.g. a free 1-week OneStopShop key; never paste a key').setMaxLength(150)),
  new SlashCommandBuilder().setName('reward-staff').setDescription('Take, manually fulfill or cancel an earned reward')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
      { name: 'Take ownership', value: 'take' }, { name: 'Mark manually fulfilled', value: 'fulfill' }, { name: 'Cancel', value: 'cancel' }))
    .addStringOption(o => o.setName('id').setDescription('Reward ID from the staff queue').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Required for cancellation; never enter a key').setMaxLength(400)),
].map(c => c.setDMPermission(false).toJSON());
