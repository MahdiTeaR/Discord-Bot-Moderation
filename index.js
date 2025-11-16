require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, Routes, ActivityType, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Partials } = require('discord.js');
const { REST } = require('@discordjs/rest');
const fs = require('fs');
const path = require('path');
const PUNISHMENTS_FILE = path.join(__dirname, 'punishments.json');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// Load environment variables
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const MUTE_ROLE_NAME = process.env.MUTE_ROLE_NAME || 'Muted';
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID; // Use environment variable for log channel ID

if (!DISCORD_BOT_TOKEN) {
  console.error('Missing DISCORD_BOT_TOKEN in .env');
  process.exit(1);
}
if (!DISCORD_GUILD_ID) {
  console.warn('DISCORD_GUILD_ID is not set. Commands will not be registered to a guild.');
}

// --- Configuration ---
const logChannelId = LOG_CHANNEL_ID || '1353200425536323665'; // Default log channel ID if not in .env
const specialVoiceChannelId = '1282834830756675644';
const notificationChannelId = '1353661830777671701';
const targetRoleId = '1277164177617584180';
const voiceJoinTimers = new Map();
const notificationMessages = new Map(); // Store notification messages
const punishmentHistory = loadPunishments(); // Store punishment history
const punishmentLimits = new Map(); // Store punishment limits for moderators


// --- Muted and Timeout Users Sets ---
const mutedUsers = new Set();
const timeoutUsers = new Set();
let botStartTime; // Variable to store bot start time
const inviteCache = new Map(); // Cache to store invites
const memberJoinInviteMap = new Map(); // Store inviter info per userId for leave logs

// Command definitions
const commands = [
  { name: 'help', description: 'Show available commands' }, // Added help command
  { name: 'timeout', description: 'Timeout a user' },
  { name: 'untimeout', description: 'Remove timeout from a user' },
  { name: 'mute', description: 'Mute a user (role-based)' },
  { name: 'unmute', description: 'Unmute a user' },
  { name: 'ban', description: 'Ban a user' },
  { name: 'unban', description: 'Unban a user' },
  { name: 'kick', description: 'Kick a user' },
  { name: 'clear', description: 'Clear messages in the channel' },
  { name: 'status', description: 'Check the bot status' },
  { name: 'reloadcommands', description: 'Reload application commands' },
  { name: 'dm', description: 'Send a direct message to a user' }, // Added dm command
  { name: 'punishmentlist', description: 'View punishment history of a user' }, // Added punishmentlist command
  { name: 'lockchannel', description: 'Locks the current channel for role 1282825490054385706' }, // Modified description
  { name: 'unlockchannel', description: 'Unlocks the current channel for role 1282825490054385706' }, // Modified description
  { name: 'slowmode', description: 'Apply slowmode to the current channel' }, // Added slowmode command
].map(command => {
  const builder = new SlashCommandBuilder()
    .setName(command.name)
    .setDescription(command.description);

  if (command.name === 'clear') {
    builder.addIntegerOption(option => option.setName('number').setDescription('Number of messages to clear').setRequired(true));
  } else if (command.name === 'dm') { // Options for dm command
    builder.addUserOption(option => option.setName('user').setDescription('The user to send DM').setRequired(true));
    builder.addStringOption(option => option.setName('message').setDescription('The message to send').setRequired(true));
  } else if (command.name === 'punishmentlist') { // Options for punishmentlist command
    builder.addUserOption(option => option.setName('user').setDescription('The user to view punishment history').setRequired(true));
  } else if (command.name === 'slowmode') { // Options for slowmode command
    builder.addIntegerOption(option => option.setName('duration').setDescription('Duration of slowmode in seconds (0 to disable)').setRequired(true));
    builder.addStringOption(option => option.setName('reason').setDescription('Reason for slowmode').setRequired(false));
  }
  else if (['timeout', 'mute'].includes(command.name)) {
    builder.addUserOption(option => option.setName('user').setDescription('The user to target').setRequired(true));
    builder.addStringOption(option => option.setName('reason').setDescription('Reason for action').setRequired(true));
    if (command.name === 'timeout') {
      builder.addIntegerOption(option => option.setName('duration').setDescription('Duration in minutes').setRequired(true));
    }
    if (command.name === 'mute') {
      builder.addIntegerOption(option => option.setName('duration').setDescription('Duration in days (optional, permanent if omitted)').setRequired(false));
    }
  }
  else if (['ban', 'kick', 'unban', 'unmute', 'untimeout', 'lockchannel', 'unlockchannel'].includes(command.name)) { // Added lockchannel and unlockchannel
    if (['ban', 'kick', 'unmute', 'untimeout'].includes(command.name)) {
      builder.addUserOption(option => option.setName('user').setDescription('The user to target').setRequired(true));
    }
    if (command.name === 'unban') {
      builder.addUserOption(option => option.setName('user').setDescription('The user to unban (optional)').setRequired(false));
      builder.addStringOption(option => option.setName('userid').setDescription('User ID to unban (optional if user provided)').setRequired(false));
    }
    builder.addStringOption(option => option.setName('reason').setDescription('Reason for action').setRequired(false)); // Reason is now optional for ban, kick, unban, unmute, untimeout, lockchannel, unlockchannel
    if (command.name === 'ban') {
      builder.addIntegerOption(option => option.setName('duration').setDescription('Duration in days').setRequired(false));
    }
  }
  return builder.toJSON();
});

const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

// --- Helper Functions ---

// Function to register commands
async function registerCommands() {
  try {
    if (!DISCORD_GUILD_ID || !client.user) {
      console.warn('Skipping command registration: missing DISCORD_GUILD_ID or client not ready.');
      return;
    }
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, DISCORD_GUILD_ID),
      { body: commands },
    );
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

// Function to send log messages (supports optional files)
async function sendLogMessage(logChannelId, embed = null, files = null) {
  if (!logChannelId) {
    console.error('sendLogMessage: No logChannelId provided.');
    return;
  }
  let logChannel = client.channels.cache.get(logChannelId);
  if (!logChannel) {
    try {
      logChannel = await client.channels.fetch(logChannelId);
    } catch (e) {
      console.error('sendLogMessage: Log channel not found:', logChannelId);
      return;
    }
  }
  // Ensure the target is a text-based channel and we have permissions
  try {
    if (typeof logChannel.isTextBased === 'function' && !logChannel.isTextBased()) {
      console.error('sendLogMessage: Target channel is not text-based:', logChannelId);
      return;
    }
    if (logChannel.guild) {
      const me = logChannel.guild.members.me;
      if (me) {
        const perms = logChannel.permissionsFor(me);
        const needed = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages];
        if (embed) needed.push(PermissionsBitField.Flags.EmbedLinks);
        if (files && files.length) needed.push(PermissionsBitField.Flags.AttachFiles);
        if (!perms || !perms.has(needed)) {
          console.error('sendLogMessage: Missing permissions to send embeds in log channel:', logChannelId);
          return;
        }
      }
    }
    const payload = {};
    if (embed) payload.embeds = [embed];
    if (files && files.length) payload.files = files;
    if (!payload.embeds && !payload.files) {
      console.error('sendLogMessage: Nothing to send');
      return;
    }
    await logChannel.send(payload);
  } catch (error) {
    console.error('sendLogMessage: Error sending log message:', error);
  }
}

// Function to create base log embed
function createLogEmbed(interaction, title, color, fields = [], startTime = null, endTime = null, reason = null) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setTimestamp()
    .setFooter({ text: 'Server Log' });
  if (interaction) {
    embed.setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) });
    fields.push({ name: 'Moderator', value: String(`${interaction.user.tag} (${interaction.user.id})`) });
  }
  if (startTime) fields.push({ name: 'Start Time', value: String(startTime) });
  if (endTime) fields.push({ name: 'End Time', value: String(endTime) });
  if (reason) fields.push({ name: 'Reason', value: String(reason) });
  // Clamp to Discord limits: max 25 fields, name<=256, value<=1024
  embed.addFields(
    fields
      .slice(0, 25)
      .map(field => ({
        name: String(field.name).slice(0, 256),
        value: String(field.value).slice(0, 1024),
      }))
  );
  return embed;
}

// Function to create base response embed
function createResponseEmbed(interaction, description, color = '#00FF00', fields = [], reason = null) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setDescription(description)
    .setTimestamp();
  if (interaction) {
    fields.push({ name: 'Moderator', value: String(`${interaction.user.tag} (${interaction.user.id})`) });
  }
  if (reason) fields.push({ name: 'Reason', value: String(reason) });
  // Clamp to Discord limits: max 25 fields, name<=256, value<=1024
  embed.addFields(
    fields
      .slice(0, 25)
      .map(field => ({
        name: String(field.name).slice(0, 256),
        value: String(field.value).slice(0, 1024),
      }))
  );
  return embed;
}

// --- DM Message Function ---
async function sendDmEmbed(user, embed, components = null) {
  try {
    const payload = components && components.length ? { embeds: [embed], components } : { embeds: [embed] };
    await user.send(payload);
    return true;
  } catch (error) {
    if (error.code === 50007) {
      return null; // DM blocked by user
    }
    console.error('Could not send DM to user:', user.tag, user.id, error);
    return false; // DM failed for other reasons
  }
}

// --- Punishment History Function ---
function recordPunishment(userId, moderatorId, punishmentType, reason = null, duration = null) {
  const history = punishmentHistory.get(userId) || [];
  history.push({
    moderatorId: moderatorId,
    type: punishmentType,
    reason: reason,
    duration: duration,
    timestamp: new Date(),
  });
  punishmentHistory.set(userId, history);
  savePunishments(punishmentHistory); // save after each change
  updatePunishmentCount(moderatorId, punishmentType); // Update punishment count for rate limiting
}

// --- Punishment Rate Limit Function ---
function checkPunishmentRateLimit(moderatorId, punishmentType) {
  const now = Date.now();
  const hourAgo = now - 3600000; // 1 hour in milliseconds
  const moderatorPunishments = punishmentLimits.get(moderatorId) || [];
  const recentPunishments = moderatorPunishments.filter(punishment => punishment.timestamp > hourAgo);

  return recentPunishments.length >= 3; // Check if limit of 3 punishments per hour is reached
}

function updatePunishmentCount(moderatorId, punishmentType) {
  const now = Date.now();
  const moderatorPunishments = punishmentLimits.get(moderatorId) || [];
  moderatorPunishments.push({ timestamp: now, type: punishmentType });
  punishmentLimits.set(moderatorId, moderatorPunishments);
}


// --- Command Handlers ---
async function handleTimeout(interaction, member, user, duration, reason) {
  const meTimeout = interaction.guild.members.me;
  if (!meTimeout || !meTimeout.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'I do not have the Moderate Members permission.', '#FF0000')], ephemeral: true });
  }
  if (checkPunishmentRateLimit(interaction.user.id, 'Timeout')) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You have reached the limit of 3 punishments in the past hour. Please wait one hour.', '#FFA500')], ephemeral: true });
  }
  if (!reason) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'A reason is required for Timeout.', '#FF0000')], ephemeral: true });
  }
  if (user.bot) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot timeout bots.', '#FF0000')], ephemeral: true });
  }
  if (user.id === client.user.id) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot timeout me.', '#FF0000')], ephemeral: true });
  }
  if (user.id === interaction.user.id) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot timeout yourself.', '#FF0000')], ephemeral: true });
  }
  if (member.isCommunicationDisabled()) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'The user is already timed out.', '#FFA500')], ephemeral: true });
  }
  if (member && member.moderatable === false) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'Cannot timeout this user (role hierarchy).', '#FF0000')], ephemeral: true });
  }

  const startTime = new Date();
  const endTime = new Date(startTime.getTime() + duration * 60 * 1000);
  try {
    await member.timeout(duration * 60 * 1000, reason);
    timeoutUsers.add(user.id); // Add user to timeoutUsers
    recordPunishment(user.id, interaction.user.id, 'Timeout', reason, duration); // Record punishment

    const responseEmbed = createResponseEmbed(interaction, 'User has been timed out successfully.', '#00FF00', [
      { name: 'User', value: `${user.tag} (${user.id})` },
      { name: 'Duration', value: String(duration) + ' minutes' },
    ], reason);

    const logEmbed = createLogEmbed(interaction, 'User Timeout', '#FF0000', [
      { name: 'User', value: `${user.tag} (${user.id})` },
      { name: 'Duration', value: String(duration) + ' minutes' },
      { name: 'Reason', value: reason || 'No reason provided' },
    ], startTime.toLocaleTimeString(), endTime.toLocaleTimeString());

    const dmEmbed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle('Server Timeout')
      .setDescription(`You have been timed out on the server for ${duration} minutes.`)
      .addFields([
        { name: 'Reason', value: reason },
        { name: 'Timeout Ends', value: endTime.toLocaleTimeString() }
      ])
      .setTimestamp();

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [responseEmbed] });
    } else {
      await interaction.reply({ embeds: [responseEmbed] });
    }
    await sendLogMessage(logChannelId, logEmbed);
    const dmResult = await sendDmEmbed(user, dmEmbed);
    if (dmResult !== true) {
      const dmBlockedLog = createLogEmbed(interaction, 'DM Delivery Failed', '#FFA500', [
        { name: 'User', value: `<@${user.id}> ${user.username}` },
        { name: 'Context', value: 'Timeout notification' },
        { name: 'Detail', value: 'Failed to send a DM due to user privacy settings or other error.' },
      ]);
      await sendLogMessage(logChannelId, dmBlockedLog);
    }

    setTimeout(async () => {
      try {
        if (timeoutUsers.has(user.id)) { // Check if user is still in timeoutUsers
          await member.timeout(null); // Remove timeout
          timeoutUsers.delete(user.id); // Remove user from timeoutUsers
          if (logChannelId) {
            const untimeoutLogEmbed = createLogEmbed(null, 'User Timeout Removed (Automatic)', '#008000', [
              { name: 'User', value: `${user.tag} (${user.id})` },
            ]);
            await sendLogMessage(logChannelId, untimeoutLogEmbed);
            // Send DM to user when timeout is lifted automatically
            const autoUntimeoutDmEmbed = new EmbedBuilder()
              .setColor('#008000')
              .setTitle('Automatic Timeout Removal')
              .setDescription('Your timeout was automatically removed.');
            sendDmEmbed(user, autoUntimeoutDmEmbed);
          }
        }
      } catch (error) {
        console.error('Error during automatic untimeout:', error);
      }
    }, duration * 60 * 1000);


  } catch (error) {
    console.error('Error executing timeout command:', error);
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'An error occurred while executing the Timeout command.', '#FF0000')], ephemeral: true });
  }
}

async function handleUntimeout(interaction, member, user, reason) {
  const meUntimeout = interaction.guild.members.me;
  if (!meUntimeout || !meUntimeout.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'I do not have the Moderate Members permission.', '#FF0000')], ephemeral: true });
  }
  if (user.bot) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot untimeout a bot.', '#FF0000')], ephemeral: true });
  }
  if (user.id === client.user.id) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot untimeout me.', '#FF0000')], ephemeral: true });
  }
  if (user.id === interaction.user.id) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot untimeout yourself.', '#FF0000')], ephemeral: true });
  }
  if (!member.isCommunicationDisabled()) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'The user is not timed out.', '#FFA500')], ephemeral: true });
  }
  try {
    await member.timeout(null, reason);
    timeoutUsers.delete(user.id); // Remove user from timeoutUsers
    recordPunishment(user.id, interaction.user.id, 'Untimeout', reason);

    const responseEmbed = createResponseEmbed(interaction, 'User timeout has been removed successfully.', '#00FF00', [
      { name: 'User', value: `${user.tag} (${user.id})` },
    ], reason); // Pass reason here

    const logEmbed = createLogEmbed(interaction, 'User Timeout Removed', '#008000', [
      { name: 'User', value: `${user.tag} (${user.id})` },
      { name: 'Reason', value: reason || 'No reason provided' },
    ], null, null, reason);

    const dmEmbed = new EmbedBuilder()
      .setColor('#008000')
      .setTitle('Timeout Removed')
      .setDescription('Your timeout has been removed.')
      .addFields([
        { name: 'Reason', value: reason || 'No reason provided' },
      ])
      .setTimestamp();

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [responseEmbed] });
    } else {
      await interaction.reply({ embeds: [responseEmbed] });
    }
    await sendLogMessage(logChannelId, logEmbed);
    sendDmEmbed(user, dmEmbed);


  } catch (error) {
    console.error('Error executing untimeout command:', error);
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'An error occurred while executing the UnTimeout command.', '#FF0000')], ephemeral: true });
  }
}

async function handleMute(interaction, member, user, duration, reason) {
  const meMute = interaction.guild.members.me;
  if (!meMute || !meMute.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'I do not have the Manage Roles permission.', '#FF0000')], ephemeral: true });
  }
  if (checkPunishmentRateLimit(interaction.user.id, 'Mute')) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You have reached the limit of 3 punishments in the past hour. Please wait one hour.', '#FFA500')], ephemeral: true });
  }
  if (!reason) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'A reason is required for Mute.', '#FF0000')], ephemeral: true });
  }
  if (user.bot) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot mute bots.', '#FF0000')], ephemeral: true });
  }
  if (user.id === client.user.id) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot mute me.', '#FF0000')], ephemeral: true });
  }
  if (user.id === interaction.user.id) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot mute yourself.', '#FF0000')], ephemeral: true });
  }
  const muteRole = interaction.guild.roles.cache.find(role => role.name === MUTE_ROLE_NAME);
  if (!muteRole) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, `Mute role named "${MUTE_ROLE_NAME}" was not found.`, '#FF0000')], ephemeral: true });
  }
  if (muteRole.comparePositionTo(meMute.roles.highest) >= 0) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'The Mute role is higher or equal to my highest role and cannot be managed.', '#FF0000')], ephemeral: true });
  }
  if (member && !member.manageable) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'Cannot apply the role to this user (role hierarchy).', '#FF0000')], ephemeral: true });
  }

  if (member.roles.cache.has(muteRole.id)) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'The user is already muted.', '#FFA500')], ephemeral: true });
  }

  const startTime = new Date();
  let endTime = null; // Initialize endTime to null for permanent mutes
  let muteDurationText = 'Permanent'; // Default mute duration text

  if (duration) {
    endTime = new Date(startTime.getTime() + duration * 24 * 60 * 60 * 1000);
    muteDurationText = String(duration) + (duration === 1 ? ' day' : ' days');
  }

  try {
    await member.roles.add(muteRole);
    mutedUsers.add(user.id); // Add user to mutedUsers
    recordPunishment(user.id, interaction.user.id, 'Mute', reason, duration); // Record punishment

    const mention = `<@${user.id}>`;
    const idSpoiler = `||${user.id}||`;
    const durationPart = duration ? ` ${muteDurationText}` : '';
    const desc = `User ${mention}  ${idSpoiler} has been muted successfully **${durationPart}** Reason **${reason}**`;
    const responseEmbed = createResponseEmbed(null, desc, '#00FF00');

    const logEmbed = createLogEmbed(interaction, `User ${duration ? 'Mute' : 'Permanent Mute'}`, '#FF0000', [
      { name: 'User', value: `${user.tag} (${user.id})` },
      ...(duration ? [{ name: 'Duration', value: muteDurationText }] : []), // Conditionally add duration field
      { name: 'Reason', value: reason },
    ], startTime.toLocaleString(), endTime ? endTime.toLocaleString() : null); // endTime can be null for permanent mute

    const dmEmbed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle(`Server ${duration ? 'Mute' : 'Permanent Mute'}`)
      .setDescription(`You have been ${duration ? `muted for **${muteDurationText}**` : 'permanently muted'} on the server.`)
      .addFields([
        { name: 'Reason', value: reason },
        ...(duration ? [{ name: 'Mute Ends', value: endTime.toLocaleString() }] : []), // Conditionally add end time field
      ])
      .setTimestamp();

    await interaction.reply({ embeds: [responseEmbed] });
    await sendLogMessage(logChannelId, logEmbed);
    const dmResult = await sendDmEmbed(user, dmEmbed);
    if (!dmResult) {
      const dmBlockedLog = createLogEmbed(interaction, 'DM Delivery Failed', '#FFA500', [
        { name: 'User', value: `<@${user.id}> ${user.username}` },
        { name: 'Context', value: 'Mute notification' },
        { name: 'Detail', value: 'Failed to send a DM due to user privacy settings.' },
      ]);
      await sendLogMessage(logChannelId, dmBlockedLog);
    }

    if (duration) { // Set timeout only if duration is provided
      setTimeout(async () => {
        try {
          if (mutedUsers.has(user.id)) { // Check if user is still in mutedUsers
            await member.roles.remove(muteRole);
            mutedUsers.delete(user.id); // Remove user from mutedUsers
            if (logChannelId) {
              const unmuteLogEmbed = createLogEmbed(null, 'Mute Removed', '#008000', [
                { name: 'User', value: `<@${user.id}> ${user.username} Mute Removed (Automatic)` },
              ]);
              await sendLogMessage(logChannelId, unmuteLogEmbed);
              // Send DM to user when mute is lifted automatically
              const autoUnmuteDmEmbed = new EmbedBuilder()
                .setColor('#008000')
                .setTitle('Automatic Unmute')
                .setDescription('Your mute was automatically removed.');
              sendDmEmbed(user, autoUnmuteDmEmbed);
            }
          }
        } catch (error) {
          // Handle the error here
          console.error('Error during automatic unmute:', error); // Added error logging
        }
      }, duration * 24 * 60 * 60 * 1000);
    }

  } catch (error) {
    console.error('Error executing mute command:', error);
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'An error occurred while executing the Mute command.', '#FF0000')], ephemeral: true });
  }
}

async function handleUnmute(interaction, member, user, reason) {
  const meUnmute = interaction.guild.members.me;
  if (!meUnmute || !meUnmute.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'I do not have the Manage Roles permission.', '#FF0000')], ephemeral: true });
  }
  if (user.bot) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot unmute a bot.', '#FF0000')], ephemeral: true });
  }
  if (user.id === client.user.id) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot unmute me.', '#FF0000')], ephemeral: true });
  }
  if (user.id === interaction.user.id) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot unmute yourself.', '#FF0000')], ephemeral: true });
  }
  const muteRole = interaction.guild.roles.cache.find(role => role.name === MUTE_ROLE_NAME); // Corrected variable name to muteRole
  if (!muteRole) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, `Mute role named "${MUTE_ROLE_NAME}" was not found.`, '#FF0000')], ephemeral: true });
  }
  if (!member.roles.cache.has(muteRole.id)) { // Corrected variable name to muteRole
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'The user is not muted.', '#FFA500')], ephemeral: true });
  }

  try {
    await member.roles.remove(muteRole);
    mutedUsers.delete(user.id); // Remove user from mutedUsers
    recordPunishment(user.id, interaction.user.id, 'Unmute', reason);

    const responseEmbed = createResponseEmbed(interaction, 'User has been unmuted successfully.', '#00FF00', [
      { name: 'User', value: `${user.tag} (${user.id})` },
    ], reason); // Pass reason here

    const logEmbed = createLogEmbed(interaction, 'User Unmuted', '#008000', [
      { name: 'User', value: `${user.tag} (${user.id})` },
      { name: 'Reason', value: reason || 'No reason provided' },
    ], null, null, reason);

    const dmEmbed = new EmbedBuilder()
      .setColor('#008000')
      .setTitle('Unmute')
      .setDescription('You have been unmuted on the server.')
      .addFields([
        { name: 'Reason', value: reason || 'No reason provided' },
      ])
      .setTimestamp();

    await interaction.reply({ embeds: [responseEmbed] });
    await sendLogMessage(logChannelId, logEmbed);
    sendDmEmbed(user, dmEmbed);

  } catch (error) {
    console.error('Error executing unmute command:', error);
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'An error occurred while executing the Unmute command.', '#FF0000')], ephemeral: true });
  }
}

async function handleBan(interaction, user, duration, reason) {
  const meBan = interaction.guild.members.me;
  if (!meBan || !meBan.permissions.has(PermissionsBitField.Flags.BanMembers)) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'I do not have the Ban Members permission.', '#FF0000')], ephemeral: true });
  }
  if (checkPunishmentRateLimit(interaction.user.id, 'Ban')) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You have reached the limit of 3 punishments in the past hour. Please wait one hour.', '#FFA500')], ephemeral: true });
  }
  if (user.bot) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot ban bots.', '#FF0000')], ephemeral: true });
  }
  if (user.id === client.user.id) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot ban me.', '#FF0000')], ephemeral: true });
  }
  if (user.id === interaction.user.id) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot ban yourself.', '#FF0000')], ephemeral: true });
  }
  const targetMemberForBan = interaction.guild.members.cache.get(user.id);
  if (targetMemberForBan && !targetMemberForBan.bannable) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'Cannot ban this user (role hierarchy).', '#FF0000')], ephemeral: true });
  }
  let banOptions = { reason: reason };
  if (duration !== null && duration !== undefined) {
    const durationSeconds = duration * 24 * 60 * 60;
    if (durationSeconds > 604800) {
      return interaction.reply({ embeds: [createResponseEmbed(interaction, 'The message deletion period cannot exceed 7 days.', '#FF0000')], ephemeral: true });
    }
    banOptions.deleteMessageSeconds = durationSeconds;
  }

  const dmEmbed = new EmbedBuilder()
    .setColor('#FF0000')
    .setTitle('Server Ban')
    .setDescription('You have been banned from the server.')
    .addFields([
      { name: 'Reason', value: reason || 'No reason provided' },
    ])
    .setTimestamp();

  // Defer reply early to avoid timeouts, then send DM
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply();
  }
  const dmResult = await sendDmEmbed(user, dmEmbed);

  try {
    await interaction.guild.members.ban(user, banOptions);
    mutedUsers.delete(user.id);
    timeoutUsers.delete(user.id);
    recordPunishment(user.id, interaction.user.id, 'Ban', reason, duration); // Record punishment

    const mention = `<@${user.id}>`;
    const timeText = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const desc = `User ${mention} ${user.username} has been banned successfully.\nMessage Deletion: ${duration ?? 0} days\nReason : ${reason || 'No reason provided'}\nToday at ${timeText}`;
    const responseEmbed = createResponseEmbed(null, desc, '#00FF00');

    const logEmbed = createLogEmbed(interaction, 'User Ban', '#FF0000', [
      { name: 'User', value: `<@${user.id}> ${user.username}` },
      { name: 'Message Deletion (days)', value: `${duration ?? 0} days` },
      { name: 'Reason', value: reason || 'No reason provided' },
    ]);


    await interaction.reply({ embeds: [responseEmbed] });
    await sendLogMessage(logChannelId, logEmbed);
    if (!dmResult) {
      const dmBlockedLog = createLogEmbed(interaction, 'DM Delivery Failed', '#FFA500', [
        { name: 'User', value: `<@${user.id}> ${user.username}` },
        { name: 'Context', value: 'Ban notification' },
        { name: 'Detail', value: 'Failed to send a DM due to user privacy settings.' },
      ]);
      await sendLogMessage(logChannelId, dmBlockedLog);
    }


  } catch (error) {
    console.error('Error executing ban command:', error);
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ embeds: [createResponseEmbed(interaction, 'An error occurred while executing the Ban command.', '#FF0000')] });
    }
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'An error occurred while executing the Ban command.', '#FF0000')], ephemeral: true });
  }
}

async function handleUnban(interaction, user, reason) {
  const meUnban = interaction.guild.members.me;
  if (!meUnban || !meUnban.permissions.has(PermissionsBitField.Flags.BanMembers)) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'I do not have the Ban Members permission.', '#FF0000')], ephemeral: true });
  }

  const userIdOpt = interaction.options.getString('userid');
  const targetId = user ? user.id : (userIdOpt ? userIdOpt.trim() : null);
  if (!targetId) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'Please specify a user or a user ID to unban.', '#FF0000')], ephemeral: true });
  }

  let targetUser = user || null;
  if (!targetUser) {
    try {
      targetUser = await client.users.fetch(targetId);
    } catch {}
  }

  if (targetId === client.user.id) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot unban me.', '#FF0000')], ephemeral: true });
  }
  if (targetId === interaction.user.id) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot unban yourself.', '#FF0000')], ephemeral: true });
  }

  try {
    await interaction.guild.bans.fetch(targetId);
  } catch (error) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'The user is not banned.', '#FFA500')], ephemeral: true });
  }

  try {
    await interaction.guild.members.unban(targetId, reason);
    mutedUsers.delete(targetId);
    timeoutUsers.delete(targetId);
    recordPunishment(targetId, interaction.user.id, 'Unban', reason);

    const displayTag = targetUser ? `${targetUser.tag}` : 'Unknown User';
    const responseEmbed = createResponseEmbed(interaction, 'User has been unbanned successfully.', '#00FF00', [
      { name: 'User', value: `${displayTag} (${targetId})` },
    ], reason);

    const logEmbed = createLogEmbed(interaction, 'User Unbanned', '#008000', [
      { name: 'User', value: `${displayTag} (${targetId})` },
      { name: 'Reason', value: reason || 'No reason provided' },
    ], null, null, reason);

    const dmEmbed = new EmbedBuilder()
      .setColor('#008000')
      .setTitle('Ban Lifted')
      .setDescription('Your ban has been lifted from the server.')
      .addFields([
        { name: 'Reason', value: reason || 'No reason provided' },
      ])
      .setTimestamp();

    await interaction.reply({ embeds: [responseEmbed] });
    await sendLogMessage(logChannelId, logEmbed);
    if (targetUser) sendDmEmbed(targetUser, dmEmbed);

  } catch (error) {
    console.error('Error executing unban command:', error);
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'An error occurred while executing the Unban command.', '#FF0000')], ephemeral: true });
  }
}

async function handleKick(interaction, member, user, reason) {
  const meKick = interaction.guild.members.me;
  if (!meKick || !meKick.permissions.has(PermissionsBitField.Flags.KickMembers)) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'I do not have the Kick Members permission.', '#FF0000')], ephemeral: true });
  }
  if (checkPunishmentRateLimit(interaction.user.id, 'Kick')) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You have reached the limit of 3 punishments in the past hour. Please wait one hour.', '#FFA500')], ephemeral: true });
  }
  if (user.bot) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot kick bots.', '#FF0000')], ephemeral: true });
  }
  if (user.id === client.user.id) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot kick me.', '#FF0000')], ephemeral: true });
  }
  if (user.id === interaction.user.id) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You cannot kick yourself.', '#FF0000')], ephemeral: true });
  }
  if (!member) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'The specified user was not found in the server.', '#FF0000')], ephemeral: true });
  }

  const dmEmbed = new EmbedBuilder()
    .setColor('#DAA520')
    .setTitle('Server Kick')
    .setDescription('You have been kicked from the server.')
    .addFields([
      { name: 'Reason', value: reason || 'No reason provided' },
    ])
    .setTimestamp();

  // Defer reply before potentially slow operations
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply();
  }
  const dmResult = await sendDmEmbed(user, dmEmbed); // Send DM first

  try {
    if (!member.kickable) {
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ embeds: [createResponseEmbed(interaction, 'Cannot kick this user (role hierarchy).', '#FF0000')] });
      }
      return interaction.reply({ embeds: [createResponseEmbed(interaction, 'Cannot kick this user (role hierarchy).', '#FF0000')], ephemeral: true });
    }
    await member.kick(reason);
    mutedUsers.delete(user.id);
    timeoutUsers.delete(user.id);
    recordPunishment(user.id, interaction.user.id, 'Kick', reason); // Record punishment

    const mention = `<@${user.id}>`;
    const timeText = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const desc = `User ${mention} ${user.username} has been kicked successfully.\nReason: ${reason || 'No reason provided'}`;
    const botRoleColor = interaction.guild.members.me?.roles.highest.color || '#00FF00';
    const responseEmbed = createResponseEmbed(null, desc, botRoleColor);

    const logEmbed = createLogEmbed(interaction, 'User Kick', '#FF0000', [
      { name: 'User', value: `<@${user.id}> ${user.username}` },
      { name: 'Reason', value: String(reason) || 'No reason provided' },
    ]);

    await interaction.editReply({ embeds: [responseEmbed] });
    await sendLogMessage(logChannelId, logEmbed);
    if (dmResult !== true) {
      const dmBlockedLog = createLogEmbed(interaction, 'DM Delivery Failed', '#FFA500', [
        { name: 'User', value: `<@${user.id}> ${user.username}` },
        { name: 'Context', value: 'Kick notification' },
        { name: 'Detail', value: 'Failed to send a DM due to user privacy settings or other error.' },
      ]);
      await sendLogMessage(logChannelId, dmBlockedLog);
    }
  

  } catch (error) {
    console.error('Error executing kick command:', error);
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ embeds: [createResponseEmbed(interaction, 'An error occurred while executing the Kick command.', '#FF0000')] });
    }
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'An error occurred while executing the Kick command.', '#FF0000')], ephemeral: true });
  }
}

async function handleClear(interaction, number) {
  try {
    if (!interaction.member) {
      return interaction.reply({ embeds: [createResponseEmbed(interaction, 'Failed to retrieve member info. This command can only be used in a guild.', '#FF0000')], ephemeral: true });
    }

    if (number > 100 || number <= 0) {
      return interaction.reply({ embeds: [createResponseEmbed(interaction, 'The number of messages to delete must be between 1 and 100.', '#FF0000')], ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const deleted = await interaction.channel.bulkDelete(number, true);
    const deletedCount = deleted.size;


    const responseEmbed = createResponseEmbed(interaction, `Successfully deleted ${deletedCount} messages.`, '#00FF00');

    const logEmbed = createLogEmbed(interaction, 'Clear Messages', '#FFA500', [
      { name: 'Type', value: 'Message Clear', inline: true },
      { name: 'Channel', value: `<#${interaction.channel.id}>`, inline: true },
      { name: 'Number of Messages', value: String(deletedCount), inline: true },
    ])
    .setTimestamp()
    .setFooter({ text: 'Channel Log' });

    await sendLogMessage(logChannelId, logEmbed);

    // For each deleted message, create a text file and upload to log channel
    try {
      const sortedDeleted = Array.from(deleted.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const msg of sortedDeleted) {
        const lines = [];
        lines.push('Deleted Message');
        lines.push(`Message ID: ${msg.id}`);
        lines.push(`Channel: ${interaction.channel.name} (${interaction.channel.id})`);
        const authorLine = msg.author ? `${msg.author.tag} (${msg.author.id})` : 'Unknown';
        lines.push(`Author: ${authorLine}`);
        const created = msg.createdAt ? msg.createdAt.toLocaleString() : 'Unknown';
        lines.push(`Created: ${created}`);
        lines.push('');
        lines.push('Content:');
        const content = (typeof msg.content === 'string' && msg.content.length) ? msg.content : '[no content]';
        lines.push(content);
        if (msg.attachments && msg.attachments.size > 0) {
          lines.push('');
          lines.push('Attachments:');
          msg.attachments.forEach(att => {
            try {
              lines.push(`${att.name} - ${att.url}`);
            } catch {}
          });
        }
        const fileBuffer = Buffer.from(lines.join('\n'), 'utf8');
        const fileName = `deleted_${interaction.channel.id}_${msg.id}.txt`;
        await sendLogMessage(logChannelId, null, [{ attachment: fileBuffer, name: fileName }]);
      }
    } catch (e) {
      console.error('Error generating deleted message text files:', e);
    }

    interaction.editReply({ embeds: [responseEmbed] });
  } catch (error) {
    console.error('Error executing clear command:', error);
    return interaction.editReply({ embeds: [createResponseEmbed(interaction, 'An error occurred while executing the clear command.', '#FF0000')] });
  }
}

async function handleStatus(interaction) {
  const uptime = formatUptime(process.uptime());
  const totalMembers = interaction.guild.memberCount;
  const muteRole = interaction.guild.roles.cache.find(role => role.name === MUTE_ROLE_NAME);
  const mutedCount = muteRole ? muteRole.members.size : 0;
  const onlineCount = interaction.guild.members.cache.filter(m => m.presence && ['online', 'idle', 'dnd'].includes(m.presence.status)).size;

  const meMember = interaction.guild.members.me;
  const embedColor = (meMember && meMember.displayHexColor && meMember.displayHexColor !== '#000000') ? meMember.displayHexColor : '#00FF00';

  const embed = createResponseEmbed(null, 'Bot Status', embedColor, [
    { name: 'Uptime', value: uptime },
    { name: 'Ping', value: `${client.ws.ping}ms` },
    { name: 'Total Members', value: String(totalMembers) },
    { name: 'Online', value: String(onlineCount) },
    { name: 'Muted', value: String(mutedCount) },
  ]);
  await interaction.reply({ embeds: [embed] });
}

async function handleReloadCommands(interaction) {

  try {
    await registerCommands();
    const embed = createResponseEmbed(interaction, 'Commands reloaded successfully.', '#00FF00');
    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Error reloading commands:', error);
    const embed = createResponseEmbed(interaction, 'Failed to reload commands.', '#FF0000');
    await interaction.reply({ embeds: [embed] });
  }
}

async function handleDmCommand(interaction) {
  const user = interaction.options.getUser('user');
  const messageContent = interaction.options.getString('message');

  const dmEmbed = new EmbedBuilder()
    .setColor('#00FF00')
    .setDescription(messageContent)
    .setFooter({ text: `Sent at: ${new Date().toLocaleString()}` })
    .setTimestamp();

  const dmResult = await sendDmEmbed(user, dmEmbed);

  if (dmResult === true) {
    const truncated = typeof messageContent === 'string' && messageContent.length > 1024
      ? messageContent.slice(0, 1021) + '...'
      : messageContent;
    const logEmbed = createLogEmbed(interaction, 'DM Command Used', '#009fd3', [
      { name: 'Target User', value: `${user.tag} (${user.id})` },
      { name: 'Message Content', value: truncated },
    ]);
    await sendLogMessage(logChannelId, logEmbed);
    await interaction.reply({ embeds: [createResponseEmbed(interaction, `Message successfully sent to ${user.tag}.`, '#00FF00')], ephemeral: true });
  } else if (dmResult === null) {
    const dmBlockedLog = createLogEmbed(interaction, 'DM Delivery Failed', '#FFA500', [
      { name: 'User', value: `<@${user.id}> ${user.username}` },
      { name: 'Context', value: 'DM command' },
      { name: 'Detail', value: 'Failed to send a DM due to user privacy settings.' },
    ]);
    await sendLogMessage(logChannelId, dmBlockedLog);
    await interaction.reply({ embeds: [createResponseEmbed(null, 'DM delivery failed (logged).', '#FFA500')], ephemeral: true });
  } else {
    const dmErrorLog = createLogEmbed(interaction, 'DM Delivery Error', '#FF0000', [
      { name: 'User', value: `<@${user.id}> ${user.username}` },
      { name: 'Context', value: 'DM command' },
      { name: 'Detail', value: 'An error occurred while sending DM.' },
    ]);
    await sendLogMessage(logChannelId, dmErrorLog);
    await interaction.reply({ embeds: [createResponseEmbed(null, 'An error occurred while sending DM (logged).', '#FF0000')], ephemeral: true });
  }
}

async function handlePunishmentList(interaction, user) {
  const userId = user.id;
  const history = punishmentHistory.get(userId) || [];

  if (history.length === 0) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, `There is no punishment history for ${user.tag}.`, '#FFA500')], ephemeral: true });
  }

  const embed = new EmbedBuilder()
    .setColor('#FFA500')
    .setTitle(`Punishment History for ${user.tag}`)
    .setDescription(`Here is the punishment history for ${user.tag}:`);

  history.forEach(record => {
    const moderator = interaction.guild.members.cache.get(record.moderatorId);
    const moderatorTag = moderator ? moderator.user.tag : 'Unknown Moderator';
    const timestamp = record.timestamp.toLocaleDateString() + ' ' + record.timestamp.toLocaleTimeString();
    let durationText = record.duration ? `${record.duration} minutes` : 'Permanent';
    if ((record.type === 'Ban' || record.type === 'Mute') && record.duration) durationText = `${record.duration} days`;
    if (record.type === 'Kick' || record.type === 'Unban' || record.type === 'Untimeout' || record.type === 'Unmute') durationText = 'N/A';


    embed.addFields({
      name: `Punishment Type: ${record.type}`,
      value: `Moderator: ${moderatorTag}\nTimestamp: ${timestamp}\nReason: ${record.reason || 'No reason provided'}\nDuration: ${durationText}`,
    });
  });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}


// --- New Help Command Handler ---
async function handleHelp(interaction) {
  const helpEmbed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle('List of Commands')
    .setDescription('Here are all the commands available for this bot:')
    .addFields(
      commands.map(command => ({
        name: `/${command.name}`,
        value: command.description,
      }))
    )
    .setTimestamp();

  await interaction.reply({ embeds: [helpEmbed], ephemeral: true });
}

// --- Channel Lock/Unlock Command Handlers ---
async function handleLockChannel(interaction) {

  const channel = interaction.channel;
  const roleId = '1282825490054385706';
  const role = interaction.guild.roles.cache.get(roleId);
  const reason = interaction.options.getString('reason') || 'No reason provided'; // Get reason from options

  if (!role) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, `Role with ID ${roleId} not found.`, '#FF0000')], ephemeral: true });
  }

  const currentPermissions = channel.permissionOverwrites.cache.get(role.id);
  if (currentPermissions && currentPermissions.deny.has(PermissionsBitField.Flags.SendMessages)) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'Channel is already locked for this role.', '#FFA500')], ephemeral: true });
  }

  try {
    await channel.permissionOverwrites.create(role, {
      SendMessages: false,
    });

    const responseEmbed = createResponseEmbed(interaction, `Channel locked for role <@&${roleId}>.`, '#00FF00', [{ name: 'Reason', value: reason }]); // Added reason to response
    const logEmbed = createLogEmbed(interaction, 'Channel Locked', '#FF0000', [
      { name: 'Channel', value: `<#${channel.id}>` },
      { name: 'Role', value: `<@&${roleId}> (${roleId})` },
      { name: 'Reason', value: reason }, // Added reason to log
    ]);

    await interaction.reply({ embeds: [responseEmbed], ephemeral: true });
    await sendLogMessage(logChannelId, logEmbed);

  } catch (error) {
    console.error('Error locking channel:', error);
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'Failed to lock the channel.', '#FF0000')], ephemeral: true });
  }
}

async function handleUnlockChannel(interaction) {

  const channel = interaction.channel;
  const roleId = '1282825490054385706';
  const role = interaction.guild.roles.cache.get(roleId);
  const reason = interaction.options.getString('reason') || 'No reason provided'; // Get reason from options

  if (!role) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, `Role with ID ${roleId} not found.`, '#FF0000')], ephemeral: true });
  }

  const currentPermissions = channel.permissionOverwrites.cache.get(role.id);
  if (currentPermissions && !currentPermissions.deny.has(PermissionsBitField.Flags.SendMessages)) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'Channel is already unlocked for this role.', '#FFA500')], ephemeral: true });
  }


  try {
    await channel.permissionOverwrites.create(role, {
      SendMessages: null, // Reset permission to default
    });

    const responseEmbed = createResponseEmbed(interaction, `Channel unlocked for role <@&${roleId}>.`, '#00FF00', [{ name: 'Reason', value: reason }]); // Added reason to response
    const logEmbed = createLogEmbed(interaction, 'Channel Unlocked', '#008000', [
      { name: 'Channel', value: `<#${channel.id}>` },
      { name: 'Role', value: `<@&${roleId}> (${roleId})` },
      { name: 'Reason', value: reason }, // Added reason to log
    ]);

    await interaction.reply({ embeds: [responseEmbed], ephemeral: true });
    await sendLogMessage(logChannelId, logEmbed);

  } catch (error) {
    console.error('Error unlocking channel:', error);
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'Failed to unlock the channel.', '#FF0000')], ephemeral: true });
  }
}

async function handleSlowmode(interaction) {
  if (checkPunishmentRateLimit(interaction.user.id, 'Slowmode')) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'You have reached the limit of 3 punishments in the past hour. Please wait one hour.', '#FFA500')], ephemeral: true });
  }

  const channel = interaction.channel;
  const duration = interaction.options.getInteger('duration');
  const reason = interaction.options.getString('reason') || 'No reason provided';

  if (duration < 0 || duration > 21600) { // Discord slowmode limit is 6 hours (21600 seconds)
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'Slowmode duration must be between 0 and 21600 seconds.', '#FF0000')], ephemeral: true });
  }

  try {
    await channel.setRateLimitPerUser(duration, reason);

    const responseEmbed = createResponseEmbed(interaction, `Slowmode ${duration > 0 ? `${duration} seconds` : 'disabled'} successfully.`, '#00FF00', [{ name: 'Reason', value: reason }]);
    const logEmbed = createLogEmbed(interaction, 'Slowmode Updated', '#FFA500', [
      { name: 'Channel', value: `<#${channel.id}>` },
      { name: 'Duration', value: `${duration} seconds` },
      { name: 'Reason', value: reason },
    ]);

    await interaction.reply({ embeds: [responseEmbed], ephemeral: true });
    await sendLogMessage(logChannelId, logEmbed);
    updatePunishmentCount(interaction.user.id, 'Slowmode');

  } catch (error) {
    console.error('Error setting slowmode:', error);
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'Failed to set slowmode.', '#FF0000')], ephemeral: true });
  }
}


function formatUptime(seconds) {
  const days = Math.floor(seconds / (24 * 60 * 60));
  seconds %= (24 * 60 * 60);
  const hours = Math.floor(seconds / (60 * 60));
  seconds %= (60 * 60);
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  const secondsLeft = Math.floor(seconds);
  return `${days} days, ${hours} hours, ${minutes} minutes, ${secondsLeft} seconds`;
}


// --- Command Handling ---
const commandHandlers = {
  'help': handleHelp, // Added help command handler
  'timeout': handleTimeout,
  'untimeout': handleUntimeout,
  'mute': handleMute,
  'unmute': handleUnmute,
  'ban': handleBan,
  'unban': handleUnban,
  'kick': handleKick,
  'clear': handleClear,
  'status': handleStatus,
  'reloadcommands': handleReloadCommands,
  'dm': handleDmCommand, // Added dm command handler
  'punishmentlist': handlePunishmentList, // Added punishmentlist command handler
  'lockchannel': handleLockChannel, // Added lockchannel command handler
  'unlockchannel': handleUnlockChannel, // Added unlockchannel command handler
  'slowmode': handleSlowmode, // Added slowmode command handler
};

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const handler = commandHandlers[interaction.commandName];
  if (!handler) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'Invalid command.', '#FF0000')], ephemeral: true });
  }

  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason');
  const duration = interaction.options.getInteger('duration');
  const number = interaction.options.getInteger('number');
  const message = interaction.options.getString('message'); // Get message for dm command

  const commandsRequireUser = ['timeout', 'mute', 'ban', 'kick', 'unmute', 'untimeout', 'dm', 'punishmentlist'];
  if (commandsRequireUser.includes(interaction.commandName) && !user) {
    return interaction.reply({ embeds: [createResponseEmbed(interaction, 'Please specify a user.', '#FF0000')], ephemeral: true });
  }


  if (interaction.commandName === 'ban') {
  }


  let member = null;

  if (!['clear', 'status', 'reloadcommands', 'dm', 'help', 'punishmentlist', 'lockchannel', 'unlockchannel', 'slowmode', 'unban'].includes(interaction.commandName)) { // Include help, punishmentlist, lockchannel, unlockchannel, slowmode, unban command
    member = interaction.guild.members.cache.get(user.id);
  }

  try {
    if (interaction.commandName === 'clear') {
      await commandHandlers.clear(interaction, number);
    } else if (interaction.commandName === 'status') {
      await commandHandlers.status(interaction);
    } else if (interaction.commandName === 'reloadcommands') {
      await commandHandlers.reloadcommands(interaction);
    } else if (interaction.commandName === 'dm') {
      await commandHandlers.dm(interaction);
    } else if (interaction.commandName === 'help') {
      await commandHandlers.help(interaction);
    } else if (interaction.commandName === 'punishmentlist') {
      await commandHandlers.punishmentlist(interaction, user);
    } else if (interaction.commandName === 'lockchannel') {
      await commandHandlers.lockchannel(interaction);
    } else if (interaction.commandName === 'unlockchannel') {
      await commandHandlers.unlockchannel(interaction);
    } else if (interaction.commandName === 'slowmode') {
      await commandHandlers.slowmode(interaction);
    } else if (interaction.commandName === 'timeout') {
      await commandHandlers.timeout(interaction, member, user, duration, reason);
    } else if (interaction.commandName === 'untimeout') {
      await commandHandlers.untimeout(interaction, member, user, reason);
    } else if (interaction.commandName === 'mute') {
      await commandHandlers.mute(interaction, member, user, duration, reason);
    } else if (interaction.commandName === 'unmute') {
      await commandHandlers.unmute(interaction, member, user, reason);
    } else if (interaction.commandName === 'kick') {
      await commandHandlers.kick(interaction, member, user, reason);
    } else if (interaction.commandName === 'ban') {
      await commandHandlers.ban(interaction, user, duration, reason);
    } else if (interaction.commandName === 'unban') {
      await commandHandlers.unban(interaction, user, reason);
    } else {
      await handler(interaction, member, user, duration, reason, number);
    }
  } catch (error) {
    console.error('Command execution error:', error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ embeds: [createResponseEmbed(interaction, 'An error occurred while executing the command.', '#FF0000')] });
      } else {
        await interaction.reply({ embeds: [createResponseEmbed(interaction, 'An error occurred while executing the command.', '#FF0000')], ephemeral: true });
      }
    } catch (e) {
      // swallow
    }
  }
}
);

client.on('voiceStateUpdate', async (oldState, newState) => {
  const userId = newState.member.id;
  const voiceChannelId = specialVoiceChannelId;
  const notificationChannel = client.channels.cache.get(notificationChannelId);
  const targetRole = newState.guild.roles.cache.get(targetRoleId);

  if (newState.channelId === voiceChannelId && oldState.channelId !== voiceChannelId) {
    // User joined the special voice channel
    voiceJoinTimers.set(userId, setTimeout(async () => {
      if (newState.channelId === voiceChannelId) {
        // User is still in the channel after 30 seconds
        if (notificationChannel) {
          const notificationEmbed = new EmbedBuilder()
            .setColor('#FFA500')
            .setDescription(`${targetRole ? `<@&${targetRole.id}> ` : ''}<@${userId}> joined the voice channel and has been in it for more than 30 seconds.`);
          notificationChannel.send({
            embeds: [notificationEmbed],
            allowedMentions: targetRole ? { roles: [targetRole.id], users: [userId] } : { users: [userId] }
          }).then(message => {
            notificationMessages.set(userId, message.id); // Store message ID
          });
        }
      }
      voiceJoinTimers.delete(userId); // Clear timer after execution
    }, 30000)); // 30 seconds
  } else if (newState.channelId !== voiceChannelId && oldState.channelId === voiceChannelId) {
    // User left the special voice channel
    if (voiceJoinTimers.has(userId)) {
      clearTimeout(voiceJoinTimers.get(userId)); // Clear the timer if user leaves before 30 seconds
      voiceJoinTimers.delete(userId);
    }
    if (notificationMessages.has(userId)) {
      const messageId = notificationMessages.get(userId);
      try {
        const msg = await notificationChannel.messages.fetch(messageId).catch(() => null);
        if (msg) await msg.delete(); // Delete notification message safely
        notificationMessages.delete(userId); // Remove message ID from map
      } catch (error) {
        console.error('Error deleting notification message:', error);
      }
    }
  }
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return;
    if (message.guild) return; // Only DMs

    const author = message.author;
    const avatarURL = author.displayAvatarURL({ dynamic: true, size: 512 });
    const content = typeof message.content === 'string' && message.content.length
      ? message.content.slice(0, 1024)
      : '[no content]';
    let attachmentsText = '';
    try {
      if (message.attachments && message.attachments.size > 0) {
        attachmentsText = Array.from(message.attachments.values())
          .map(att => `${att.name} - ${att.url}`)
          .join('\n');
      }
    } catch {}

    const fields = [
      { name: 'Type', value: 'Direct Message', inline: true },
      { name: 'From', value: `<@${author.id}> ${author.tag}`, inline: true },
      { name: 'User Id', value: `${author.id}`, inline: true },
      { name: 'Content', value: content },
    ];
    if (attachmentsText) {
      fields.push({ name: 'Attachments', value: attachmentsText.slice(0, 1024) });
    }

    const dmLogEmbed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle('Incoming DM')
      .setThumbnail(avatarURL)
      .addFields(fields)
      .setTimestamp()
      .setFooter({ text: 'Server Log' });

    await sendLogMessage(logChannelId, dmLogEmbed);
  } catch (e) {
    console.error('Error logging incoming DM:', e);
  }
});

client.on('inviteCreate', async invite => {
  const map = inviteCache.get(invite.guild.id) || new Map();
  map.set(invite.code, invite);
  inviteCache.set(invite.guild.id, map);
  try {
    const fetchedInvite = await invite.fetch();

    const inviter = fetchedInvite.inviter ?? null;
    const inviterTag = inviter?.tag || 'Unknown';
    const inviterId = inviter?.id || null;
    const inviterMention = inviterId ? `<@${inviterId}>` : 'Unknown';

    const channelId = fetchedInvite.channel?.id || invite.channel?.id || null;
    const uses = typeof fetchedInvite.uses === 'number' ? fetchedInvite.uses : 0;
    const maxUsesRaw = typeof fetchedInvite.maxUses === 'number' ? fetchedInvite.maxUses : 0;
    const usesText = `${uses}/${maxUsesRaw === 0 ? '∞' : maxUsesRaw}`;
    const maxAgeSec = typeof fetchedInvite.maxAge === 'number' ? fetchedInvite.maxAge : 0;
    const maxAgeText = maxAgeSec === 0 ? '∞ (never)' : `${Math.round(maxAgeSec / 60)}`;
    const tempText = fetchedInvite.temporary ? 'Yes' : 'No';

    let inviterTotalInvites = null;
    if (inviterId) {
      try {
        const allInvites = await invite.guild.invites.fetch({ cache: false });
        inviterTotalInvites = Array.from(allInvites.values())
          .filter(i => i.inviter && i.inviter.id === inviterId)
          .reduce((sum, i) => sum + (typeof i.uses === 'number' ? i.uses : 0), 0);
      } catch (e) {
        inviterTotalInvites = null;
      }
    }

    const logEmbed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle('Channel Activity')
      .addFields(
        { name: 'Type', value: 'Invite Create', inline: true },
        { name: 'Channel', value: channelId ? `<#${channelId}>` : 'Unknown', inline: true },
        { name: 'Inviter', value: inviterId ? `${inviterMention} ${inviterTag}` : 'Unknown', inline: true },
        { name: 'Inviter Id', value: inviterId ? `${inviterId}` : 'Unknown', inline: true },
        { name: 'Inviter Total Invites', value: inviterTotalInvites !== null ? `${inviterTotalInvites}` : 'Unknown', inline: true },
        { name: 'Invite Code', value: fetchedInvite.code, inline: true },
        { name: 'Invite URL', value: `https://discord.gg/${fetchedInvite.code}`, inline: true },
        { name: 'Uses', value: usesText, inline: true },
        { name: 'Max Age (minutes)', value: maxAgeText, inline: true },
        { name: 'Temporary', value: tempText, inline: true }
      )
      .setTimestamp()
      .setFooter({ text: 'Server Log' });

    await sendLogMessage(logChannelId, logEmbed);
    // Keep invite cache fresh
    try { await updateInviteCache(invite.guild); } catch (e) { console.error('Error updating invite cache after create:', e); }
  } catch (error) {
    console.error('Error during guildInviteCreate logging:', error);
  }
});

client.on('inviteDelete', async invite => {
  const map = inviteCache.get(invite.guild.id);
  if (map) {
    map.delete(invite.code);
    inviteCache.set(invite.guild.id, map);
  }
  try {
    const logEmbed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('Channel Activity')
      .addFields(
        { name: 'Type', value: 'Invite Delete', inline: true },
        { name: 'Channel', value: `<#${invite.channel.id}>`, inline: true },
        { name: 'Invite Code', value: invite.code || 'Unknown', inline: true }
      )
      .setTimestamp()
      .setFooter({ text: 'Server Log' });

    await sendLogMessage(logChannelId, logEmbed);
    // Keep invite cache fresh
    try { await updateInviteCache(invite.guild); } catch (e) { console.error('Error updating invite cache after delete:', e); }
  } catch (error) {
    console.error('Error during guildInviteDelete logging:', error);
  }
});

client.on('guildMemberAdd', async member => {
  try {
    const user = member.user;
    const bannerURL = user.bannerURL({ dynamic: true, size: 512 }) || null;
    const avatarURL = user.displayAvatarURL({ dynamic: true, size: 512 });
    let joinedViaInvite = 'Unknown';
    let inviterTag = 'Unknown';
    try {
      const muteRole = member.guild.roles.cache.find(role => role.name === MUTE_ROLE_NAME);
      let shouldReapplyMute = false;
      const history = punishmentHistory.get(user.id) || [];
      const reversed = [...history].reverse();
      const lastMute = reversed.find(r => r.type === 'Mute');
      if (lastMute) {
        const lastUnmute = reversed.find(r => r.type === 'Unmute');
        const unmutedAfterMute = lastUnmute && lastUnmute.timestamp > lastMute.timestamp;
        if (!unmutedAfterMute) {
          if (!lastMute.duration) {
            shouldReapplyMute = true;
          } else {
            const endAt = new Date(lastMute.timestamp).getTime() + lastMute.duration * 24 * 60 * 60 * 1000;
            if (Date.now() < endAt) shouldReapplyMute = true;
          }
        }
      }
      if (muteRole && shouldReapplyMute) {
        const me = member.guild.members.me;
        const canManage = me && me.permissions.has(PermissionsBitField.Flags.ManageRoles) && muteRole.comparePositionTo(me.roles.highest) < 0 && member.manageable;
        if (canManage && !member.roles.cache.has(muteRole.id)) {
          await member.roles.add(muteRole).catch(() => {});
          mutedUsers.add(user.id);
          // Schedule automatic unmute if the original mute was time-bound
          if (lastMute && lastMute.duration) {
            const endAt = new Date(lastMute.timestamp).getTime() + lastMute.duration * 24 * 60 * 60 * 1000;
            const msLeft = endAt - Date.now();
            if (msLeft > 0) {
              setTimeout(async () => {
                try {
                  if (mutedUsers.has(user.id)) {
                    await member.roles.remove(muteRole);
                    mutedUsers.delete(user.id);
                    if (logChannelId) {
                      const unmuteLogEmbed = createLogEmbed(null, 'Mute Removed', '#008000', [
                        { name: 'User', value: `<@${user.id}> ${user.username} Mute Removed (Automatic)` },
                      ]);
                      await sendLogMessage(logChannelId, unmuteLogEmbed);
                      const autoUnmuteDmEmbed = new EmbedBuilder()
                        .setColor('#008000')
                        .setTitle('Automatic Unmute')
                        .setDescription('Your mute was automatically removed.');
                      sendDmEmbed(user, autoUnmuteDmEmbed);
                    }
                  }
                } catch (error) {
                  console.error('Error during automatic unmute (rejoin):', error);
                }
              }, msLeft);
            }
          }
        }
      } else if (!shouldReapplyMute && mutedUsers.has(user.id)) {
        mutedUsers.delete(user.id);
      }
    } catch {}

    // Snapshot previous invites for this guild from our cache (populated on ready/create/delete)
    const previousInvites = new Map(inviteCache.get(member.guild.id) || new Map());
    let inviterId = null;

    setTimeout(async () => {
      let delayedFreshInvites = null;
      try {
        delayedFreshInvites = await member.guild.invites.fetch({ cache: false });
        let usedInvite = fetchUsedInvite(previousInvites, delayedFreshInvites);

        if (usedInvite) {
          joinedViaInvite = usedInvite.code;
          inviterTag = usedInvite.inviter ? usedInvite.inviter.tag : 'Unknown';
          inviterId = usedInvite.inviter ? usedInvite.inviter.id : null;
        } else {
          // Try detect single-use/deleted invite (present before, gone now)
          let disappearedPrev = null;
          try {
            for (const [code, prev] of previousInvites.entries()) {
              if (prev.guild && prev.guild.id === member.guild.id && !delayedFreshInvites.has(code)) {
                disappearedPrev = prev;
                break;
              }
            }
          } catch {}
          if (disappearedPrev) {
            joinedViaInvite = disappearedPrev.code;
            inviterTag = disappearedPrev.inviter ? disappearedPrev.inviter.tag : 'Unknown';
            inviterId = disappearedPrev.inviter ? disappearedPrev.inviter.id : null;
          } else {
            // Fallback: try vanity URL
            try {
              const vanity = await member.guild.fetchVanityData();
              if (vanity && vanity.code) {
                joinedViaInvite = `Vanity: ${vanity.code}`;
                inviterTag = 'Vanity URL';
              } else {
                joinedViaInvite = 'Unknown';
                inviterTag = 'Unknown';
              }
            } catch {
              joinedViaInvite = 'Unknown';
              inviterTag = 'Unknown';
            }
          }
        }
      } catch (e) {
        console.error('Error fetching delayed invites on member join:', e);
      }

      let inviterUses = 0;
      if (inviterId && delayedFreshInvites) {
        try {
          delayedFreshInvites.forEach(inv => {
            if (inv.inviter && inv.inviter.id === inviterId) inviterUses += inv.uses || 0;
          });
        } catch {}
      }

      // Save for use on member leave
      try {
        memberJoinInviteMap.set(user.id, { joinedViaInvite, inviterId, inviterTag });
      } catch {}

      try { await updateInviteCache(member.guild); } catch (e) { console.error('Error updating invite cache after member join:', e); }

      const logEmbed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('Member Activity- Join')
        .setThumbnail(avatarURL)
        .addFields(
          { name: 'Type', value: 'Member Join', inline: true },
          { name: 'User Tag', value: `<@${user.id}> ${user.tag}`, inline: true },
          { name: 'User Id', value: `${user.id}`, inline: true },
          { name: 'Account Created', value: `${member.user.createdAt.toLocaleDateString()}`, inline: true },
          { name: 'Joined Server', value: `${new Date().toLocaleDateString()}`, inline: true },
          { name: 'Joined via Invite', value: joinedViaInvite, inline: true },
          { name: 'Inviter', value: inviterId ? `<@${inviterId}> ${inviterTag} (${inviterUses})` : inviterTag, inline: true },
          { name: 'Banner', value: bannerURL || 'No Banner', inline: true },
          { name: 'Profile', value: avatarURL, inline: true }
        )
        .setTimestamp()
        .setFooter({ text: 'Server Log' });

      await sendLogMessage(logChannelId, logEmbed);

      // Send Welcome DM - keep this part
      const meMember = member.guild.members.me;
      const embedColor = (meMember && meMember.displayHexColor && meMember.displayHexColor !== '#000000') ? meMember.displayHexColor : '#00FF00';
      const now = new Date();
      const formattedTime = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const welcomeEmbed = new EmbedBuilder()
        .setColor(embedColor)
        .setTitle('Welcome to never give up!')
        .setDescription("We're glad to have you here. Please read the rules and choose your roles to access all server sections.")
        .setTimestamp(); // Customize welcome message
      let joinUrl = null;
      let targetChannelId = member.guild.rulesChannelId || member.guild.systemChannelId || null;
      if (!targetChannelId) {
        try {
          const fallbackChannel = member.guild.channels.cache.find(ch => typeof ch.isTextBased === 'function' && ch.isTextBased() && ch.viewable);
          if (fallbackChannel) targetChannelId = fallbackChannel.id;
        } catch {}
      }
      if (targetChannelId) {
        joinUrl = `https://discord.com/channels/${member.guild.id}/${targetChannelId}`;
      } else {
        try {
          const vanity = await member.guild.fetchVanityData();
          if (vanity && vanity.code) {
            joinUrl = `https://discord.gg/${vanity.code}`;
          }
        } catch {}
      }
      const components = joinUrl ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Join Channel').setStyle(ButtonStyle.Link).setURL(joinUrl)
      )] : [];
      const dmResult = await sendDmEmbed(user, welcomeEmbed, components);
      if (dmResult === null) {
        if (logChannelId) {
          const dmBlockedEmbed = new EmbedBuilder()
            .setColor('#FFA500')
            .setTitle('Welcome DM Blocked')
            .setDescription(`The welcome DM to <@${user.id}> (${user.username}) was not delivered due to user privacy settings.`);
          sendLogMessage(logChannelId, dmBlockedEmbed);
        }
      } else if (dmResult === true) {
      } else {
        console.error(`Failed to send welcome DM to user: ${user.tag} (${user.id}), dmResult: ${dmResult}`);
      }


    }, 6000); // Delay increased to 7000ms (6 seconds)


  } catch (error) {
    console.error('Error during guildMemberAdd logging:', error);
  }
});

client.on('guildMemberRemove', async member => {
  try {
    const avatarURL = member.user.displayAvatarURL({ dynamic: true, size: 512 });
    let joinedViaInvite = 'Unknown';
    let inviterTag = 'Unknown';
    let inviterId = null;

    // Try to use stored data from when the member joined
    try {
      const saved = memberJoinInviteMap.get(member.user.id);
      if (saved) {
        joinedViaInvite = saved.joinedViaInvite || joinedViaInvite;
        inviterTag = saved.inviterTag || inviterTag;
        inviterId = saved.inviterId || null;
        memberJoinInviteMap.delete(member.user.id);
      }
    } catch {}

    // Recalculate total uses for inviter if available
    let inviterUses = 0;
    if (inviterId) {
      try {
        const freshInvites = await member.guild.invites.fetch({ cache: false });
        freshInvites.forEach(inv => {
          if (inv.inviter && inv.inviter.id === inviterId) inviterUses += inv.uses || 0;
        });
      } catch (e) {
        console.error('Error fetching invites on member leave:', e);
      }
    }

    const logEmbed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('Member Activity - Leave')
      .setThumbnail(avatarURL)
      .addFields(
        { name: 'Type', value: 'Member Leave', inline: true },
        { name: 'User Tag', value: `<@${member.user.id}> ${member.user.tag}`, inline: true },
        { name: 'User Id', value: `${member.user.id}`, inline: true },
        { name: 'Joined Server', value: `${member.joinedAt.toLocaleDateString()}`, inline: true },
        { name: 'Left Server', value: `${new Date().toLocaleDateString()}`, inline: true },
        { name: 'Profile', value: avatarURL, inline: true },
        { name: 'Joined via Invite', value: joinedViaInvite, inline: true },
        { name: 'Inviter', value: inviterId ? `<@${inviterId}> ${inviterTag} (${inviterUses})` : inviterTag, inline: true }
      )
      .setTimestamp()
      .setFooter({ text: 'Server Log' });

    await sendLogMessage(logChannelId, logEmbed);
  } catch (error) {
    console.error('Error during guildMemberRemove logging:', error);
  }
});

function fetchUsedInvite(initialFreshInvites, delayedFreshInvites) {
  let usedInvite = null;
  delayedFreshInvites.forEach(delayedInvite => {
    const initialInvite = initialFreshInvites.get(delayedInvite.code);
    if (initialInvite) {
      if (delayedInvite.uses > initialInvite.uses) {
        usedInvite = delayedInvite;
      }
    }
  });
  return usedInvite;
}


async function updateInviteCache(guild) {
  try {
    const fetchedInvites = await guild.invites.fetch({ cache: false });
    const map = new Map();
    fetchedInvites.forEach(invite => {
      map.set(invite.code, invite);
    });
    inviteCache.set(guild.id, map);
  } catch (error) {
    console.error('Error updating invite cache:', error);
  }
}


function loadPunishments() {
  if (fs.existsSync(PUNISHMENTS_FILE)) {
    try {
      const data = fs.readFileSync(PUNISHMENTS_FILE, 'utf8');
      const parsed = JSON.parse(data); // [[userId, [records...]], ...]
      const revived = parsed.map(([userId, records]) => [
        userId,
        (records || []).map(r => ({
          ...r,
          timestamp: new Date(r.timestamp),
        })),
      ]);
      return new Map(revived);
    } catch (e) {
      console.error('Error reading punishments file:', e);
      return new Map();
    }
  }
  return new Map();
}

function savePunishments(map) {
  try {
    fs.writeFileSync(PUNISHMENTS_FILE, JSON.stringify([...map]), 'utf8');
  } catch (e) {
    console.error('Error writing punishments file:', e);
  }
}


client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  botStartTime = new Date();
  console.log('Log Channel ID on ready:', logChannelId);
  await registerCommands();
  client.user.setPresence({
    status: 'online', // You can change the status to 'online', 'dnd', 'idle', or 'invisible'
    activities: [{
      name: '',
      type: ActivityType.Playing, // You can change the activity type to 'Playing', 'Streaming', 'Listening', 'Watching', or 'Custom'
    }],
  });
  // Prime invite cache for all guilds
  try {
    const guilds = Array.from(client.guilds.cache.values());
    await Promise.all(guilds.map(g => updateInviteCache(g)));
  } catch (e) {
    console.error('Error priming invite cache on ready:', e);
  }
});


client.login(DISCORD_BOT_TOKEN);

