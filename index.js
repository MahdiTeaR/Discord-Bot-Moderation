require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, Routes, ActivityType, PermissionsBitField } = require('discord.js');
const { REST } = require('@discordjs/rest');

const client = new Client({
  intents: [
    1, // Guilds
    2, // GuildMembers
    4096, // GuildMessages
    32, // GuildInvites
    32768, // MessageContent
    4, // GuildPresences
    128 // VoiceStates
  ],
});

// Load environment variables
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const MUTE_ROLE_NAME = process.env.MUTE_ROLE_NAME || 'Muted';
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID; // Use environment variable for log channel ID

// --- Configuration ---
const logChannelId = LOG_CHANNEL_ID || '1353200425536323665'; // Default log channel ID if not in .env
const specialVoiceChannelId = '1282834830756675644';
const notificationChannelId = '1353661830777671701';
const targetRoleId = '1277164177617584180';
const voiceJoinTimers = new Map();
const notificationMessages = new Map(); // Store notification messages
const punishmentHistory = new Map(); // Store punishment history
const punishmentLimits = new Map(); // Store punishment limits for moderators


// --- Muted and Timeout Users Sets ---
const mutedUsers = new Set();
const timeoutUsers = new Set();
let botStartTime; // Variable to store bot start time
const inviteCache = new Map(); // Cache to store invites

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
  }
  else if (['ban', 'kick', 'unban', 'unmute', 'untimeout', 'lockchannel', 'unlockchannel'].includes(command.name)) { // Added lockchannel and unlockchannel
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
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, DISCORD_GUILD_ID),
      { body: commands },
    );
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

// Function to send log messages
async function sendLogMessage(logChannelId, embed) {
  if (!logChannelId) {
    console.error('sendLogMessage: No logChannelId provided.');
    return;
  }
  const logChannel = client.channels.cache.get(logChannelId);
  if (!logChannel) {
    console.error('sendLogMessage: Log channel not found:', logChannelId);
    return;
  }
  try {
    await logChannel.send({ embeds: [embed] });
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
  embed.addFields(fields.map(field => ({ name: field.name, value: String(field.value) })));
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
  if (reason) fields.push({ name: 'دلیل', value: String(reason) });
  embed.addFields(fields.map(field => ({ name: field.name, value: String(field.value) })));
  return embed;
}

// --- DM Message Function ---
async function sendDmEmbed(user, embed) {
  try {
    await user.send({ embeds: [embed] });
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
  if (checkPunishmentRateLimit(interaction.user.id, 'Timeout')) {
    return interaction.reply({ content: 'شما در یک ساعت گذشته 3 بار تنبیه انجام داده‌اید. لطفا یک ساعت دیگر صبر کنید.', ephemeral: true });
  }
  if (!reason) {
    return interaction.reply({ content: 'وارد کردن دلیل برای Timeout الزامی است.', ephemeral: true });
  }
  if (user.bot) {
    return interaction.reply({ content: 'ربات ها رو نمیتونی Timeout کنی.', ephemeral: true });
  }
  if (user.id === client.user.id) {
    return interaction.reply({ content: 'من را نمیتونی Timeout کنی.', ephemeral: true });
  }
  if (user.id === interaction.user.id) {
    return interaction.reply({ content: 'خودتو نمیتونی Timeout کنی.', ephemeral: true });
  }
  if (member.isCommunicationDisabled()) {
    return interaction.reply({ content: 'کاربر از قبل Timeout شده است.', ephemeral: true });
  }

  const startTime = new Date();
  const endTime = new Date(startTime.getTime() + duration * 60 * 1000);
  try {
    await member.timeout(duration * 60 * 1000, reason);
    timeoutUsers.add(user.id); // Add user to timeoutUsers
    recordPunishment(user.id, interaction.user.id, 'Timeout', reason, duration); // Record punishment

    const responseEmbed = createResponseEmbed(interaction, 'کاربر با موفقیت Timeout شد.', '#00FF00', [
      { name: 'کاربر', value: `${user.tag} (${user.id})` },
      { name: 'مدت زمان', value: String(duration) + ' دقیقه' },
    ], reason);

    const logEmbed = createLogEmbed(interaction, 'Timeout کاربر', '#FF0000', [
      { name: 'کاربر', value: `${user.tag} (${user.id})` },
      { name: 'مدت زمان', value: String(duration) + ' دقیقه' },
      { name: 'دلیل', value: reason || 'بدون دلیل' },
    ], startTime.toLocaleTimeString(), endTime.toLocaleTimeString());

    const dmEmbed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle('Timeout در سرور')
      .setDescription(`شما به مدت ${duration} دقیقه در سرور Timeout شدید.`)
      .addFields([
        { name: 'دلیل', value: reason },
        { name: 'پایان Timeout', value: endTime.toLocaleTimeString() }
      ])
      .setTimestamp();

    await interaction.reply({ embeds: [responseEmbed] });
    await sendLogMessage(logChannelId, logEmbed);
    sendDmEmbed(user, dmEmbed);

    setTimeout(async () => {
      try {
        if (timeoutUsers.has(user.id)) { // Check if user is still in timeoutUsers
          await member.timeout(null); // Remove timeout
          timeoutUsers.delete(user.id); // Remove user from timeoutUsers
          if (logChannelId) {
            const untimeoutLogEmbed = createLogEmbed(null, 'رفع Timeout کاربر (خودکار)', '#008000', [
              { name: 'کاربر', value: `${user.tag} (${user.id})` },
            ]);
            await sendLogMessage(logChannelId, untimeoutLogEmbed);
            // Send DM to user when timeout is lifted automatically
            const autoUntimeoutDmEmbed = new EmbedBuilder()
              .setColor('#008000')
              .setTitle('رفع خودکار Timeout')
              .setDescription('Timeout شما در سرور به صورت خودکار برداشته شد.');
            sendDmEmbed(user, autoUntimeoutDmEmbed);
          }
        }
      } catch (error) {
        console.error('Error during automatic untimeout:', error);
      }
    }, duration * 60 * 1000);


  } catch (error) {
    console.error('Error executing timeout command:', error);
    return interaction.reply({ content: 'هنگام اجرای فرمان Timeout خطایی رخ داد.', ephemeral: true });
  }
}

async function handleUntimeout(interaction, member, user, reason) {
  if (user.bot) {
    return interaction.reply({ content: 'ربات رو نمیتونی Untimeout کنی.', ephemeral: true });
  }
  if (user.id === client.user.id) {
    return interaction.reply({ content: 'من رو نمیتونی Untimeout کنی.', ephemeral: true });
  }
  if (user.id === interaction.user.id) {
    return interaction.reply({ content: 'خودتو نمیتونی Untimeout کنی.', ephemeral: true });
  }
  if (!member.isCommunicationDisabled()) {
    return interaction.reply({ content: 'کاربر Timeout نیست.', ephemeral: true });
  }
  try {
    await member.timeout(null, reason);
    timeoutUsers.delete(user.id); // Remove user from timeoutUsers

    const responseEmbed = createResponseEmbed(interaction, 'Timeout کاربر با موفقیت برداشته شد.', '#00FF00', [
      { name: 'کاربر', value: `${user.tag} (${user.id})` },
    ], reason); // Pass reason here

    const logEmbed = createLogEmbed(interaction, 'رفع Timeout کاربر', '#008000', [
      { name: 'کاربر', value: `${user.tag} (${user.id})` },
      { name: 'دلیل', value: reason || 'بدون دلیل' },
    ], null, null, reason);

    const dmEmbed = new EmbedBuilder()
      .setColor('#008000')
      .setTitle('رفع Timeout')
      .setDescription('Timeout شما در سرور برداشته شد.')
      .addFields([
        { name: 'دلیل', value: reason || 'بدون دلیل' },
      ])
      .setTimestamp();

    await interaction.reply({ embeds: [responseEmbed] });
    await sendLogMessage(logChannelId, logEmbed);
    sendDmEmbed(user, dmEmbed);


  } catch (error) {
    console.error('Error executing untimeout command:', error);
    return interaction.reply({ content: 'هنگام اجرای فرمان رفع Timeout خطایی رخ داد.', ephemeral: true });
  }
}

async function handleMute(interaction, member, user, duration, reason) {
  if (!reason) {
    return interaction.reply({ content: 'وارد کردن دلیل برای Mute الزامی است.', ephemeral: true });
  }
  if (user.bot) {
    return interaction.reply({ content: 'ربات ها رو نمیتونی Mute کنی.', ephemeral: true });
  }
  if (user.id === client.user.id) {
    return interaction.reply({ content: 'من رو نمیتونی Mute کنی.', ephemeral: true });
  }
  if (user.id === interaction.user.id) {
    return interaction.reply({ content: 'خودتو نمیتونی Mute کنی.', ephemeral: true });
  }
  const muteRole = interaction.guild.roles.cache.find(role => role.name === MUTE_ROLE_NAME);
  if (!muteRole) {
    return interaction.reply({ content: `نقش Mute با نام "${MUTE_ROLE_NAME}" پیدا نشد.`, ephemeral: true });
  }

  if (member.roles.cache.has(muteRole.id)) {
    return interaction.reply({ content: 'کاربر از قبل Mute شده است.', ephemeral: true });
  }

  const startTime = new Date();
  let endTime = null; // Initialize endTime to null for permanent mutes
  let muteDurationText = 'Permanent'; // Default mute duration text

  if (duration) {
    endTime = new Date(startTime.getTime() + duration * 60 * 1000);
    muteDurationText = String(duration) + ' دقیقه';
  }

  try {
    await member.roles.add(muteRole);
    mutedUsers.add(user.id); // Add user to mutedUsers
    recordPunishment(user.id, interaction.user.id, 'Mute', reason, duration); // Record punishment

    const responseEmbed = createResponseEmbed(interaction, `کاربر با موفقیت ${duration ? 'Mute' : 'Permanent Mute'} شد.`, '#00FF00', [
      { name: 'کاربر', value: `${user.tag} (${user.id})` },
      ...(duration ? [{ name: 'مدت زمان', value: muteDurationText }] : []), // Conditionally add duration field
    ], reason);

    const logEmbed = createLogEmbed(interaction, `${duration ? 'Mute' : 'Permanent Mute'} کاربر`, '#FF0000', [
      { name: 'کاربر', value: `${user.tag} (${user.id})` },
      ...(duration ? [{ name: 'مدت زمان', value: muteDurationText }] : []), // Conditionally add duration field
      { name: 'دلیل', value: reason },
    ], startTime.toLocaleTimeString(), endTime ? endTime.toLocaleTimeString() : null); // endTime can be null for permanent mute

    const dmEmbed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle(`${duration ? 'Mute' : 'Permanent Mute'} در سرور`)
      .setDescription(`شما به مدت ${duration ? muteDurationText : 'دائمی'} در سرور Mute شدید.`)
      .addFields([
        { name: 'دلیل', value: reason },
        ...(duration ? [{ name: 'پایان Mute', value: endTime.toLocaleTimeString() }] : []), // Conditionally add end time field
      ])
      .setTimestamp();

    await interaction.reply({ embeds: [responseEmbed] });
    await sendLogMessage(logChannelId, logEmbed);
    const dmResult = await sendDmEmbed(user, dmEmbed);
    if (!dmResult) {
      interaction.channel.send(`ارسال پیام دایرکت به ${user.tag} به دلیل تنظیمات حریم خصوصی کاربر ناموفق بود.`);
    }

    if (duration) { // Set timeout only if duration is provided
      setTimeout(async () => {
        try {
          if (mutedUsers.has(user.id)) { // Check if user is still in mutedUsers
            await member.roles.remove(muteRole);
            mutedUsers.delete(user.id); // Remove user from mutedUsers
            if (logChannelId) {
              const unmuteLogEmbed = createLogEmbed(null, 'رفع Mute کاربر (خودکار)', '#008000', [
                { name: 'کاربر', value: `${user.tag} (${user.id})` },
              ]);
              await sendLogMessage(logChannelId, unmuteLogEmbed);
              // Send DM to user when mute is lifted automatically
              const autoUnmuteDmEmbed = new EmbedBuilder()
                .setColor('#008000')
                .setTitle('رفع خودکار Mute')
                .setDescription('Mute شما در سرور به صورت خودکار برداشته شد.');
              sendDmEmbed(user, autoUnmuteDmEmbed);
            }
          }
        } catch (error) {
          // Handle the error here
          console.error('Error during automatic unmute:', error); // Added error logging
        }
      }, duration * 60 * 1000);
    }

  } catch (error) {
    console.error('Error executing mute command:', error);
    return interaction.reply({ content: 'هنگام اجرای فرمان Mute خطایی رخ داد.', ephemeral: true });
  }
}

async function handleUnmute(interaction, member, user, reason) {
  if (user.bot) {
    return interaction.reply({ content: 'ربات رو نمیتونی Unmute کنی.', ephemeral: true });
  }
  if (user.id === client.user.id) {
    return interaction.reply({ content: 'من رو نمیتونی Unmute کنی.', ephemeral: true });
  }
  if (user.id === interaction.user.id) {
    return interaction.reply({ content: 'خودتو نمیتونی Unmute کنی.', ephemeral: true });
  }
  const muteRole = interaction.guild.roles.cache.find(role => role.name === MUTE_ROLE_NAME); // Corrected variable name to muteRole
  if (!muteRole) {
    return interaction.reply({ content: `نقش Mute با نام "${MUTE_ROLE_NAME}" پیدا نشد.`, ephemeral: true });
  }
  if (!member.roles.cache.has(muteRole.id)) { // Corrected variable name to muteRole
    return interaction.reply({ content: 'کاربر Mute نیست.', ephemeral: true });
  }

  try {
    await member.roles.remove(muteRole);
    mutedUsers.delete(user.id); // Remove user from mutedUsers

    const responseEmbed = createResponseEmbed(interaction, 'کاربر با موفقیت Unmute شد.', '#00FF00', [
      { name: 'کاربر', value: `${user.tag} (${user.id})` },
    ], reason); // Pass reason here

    const logEmbed = createLogEmbed(interaction, 'رفع Unmute کاربر', '#008000', [
      { name: 'کاربر', value: `${user.tag} (${user.id})` },
      { name: 'دلیل', value: reason || 'بدون دلیل' },
    ], null, null, reason);

    const dmEmbed = new EmbedBuilder()
      .setColor('#008000')
      .setTitle('رفع Unmute')
      .setDescription('Unmute شما در سرور برداشته شد.')
      .addFields([
        { name: 'دلیل', value: reason || 'بدون دلیل' },
      ])
      .setTimestamp();

    await interaction.reply({ embeds: [responseEmbed] });
    await sendLogMessage(logChannelId, logEmbed);
    sendDmEmbed(user, dmEmbed);

  } catch (error) {
    console.error('Error executing unmute command:', error);
    return interaction.reply({ content: 'هنگام اجرای فرمان رفع Unmute خطایی رخ داد.', ephemeral: true });
  }
}

async function handleBan(interaction, user, duration, reason) {
  if (checkPunishmentRateLimit(interaction.user.id, 'Ban')) {
    return interaction.reply({ content: 'شما در یک ساعت گذشته 3 بار تنبیه انجام داده‌اید. لطفا یک ساعت دیگر صبر کنید.', ephemeral: true });
  }
  if (user.bot) {
    return interaction.reply({ content: 'ربات ها رو نمیتونی Ban کنی.', ephemeral: true });
  }
  if (user.id === client.user.id) {
    return interaction.reply({ content: 'من رو نمیتونی Ban کنی.', ephemeral: true });
  }
  if (user.id === interaction.user.id) {
    return interaction.reply({ content: 'خودتو نمیتونی Ban کنی.', ephemeral: true });
  }
  let banOptions = { reason: reason };
  if (duration !== null && duration !== undefined) {
    const durationSeconds = duration * 24 * 60 * 60;
    if (durationSeconds > 604800) {
      return interaction.reply({ content: 'مدت زمان Ban نمی‌تواند بیشتر از 7 روز باشد.', ephemeral: true });
    }
    banOptions.deleteMessageSeconds = durationSeconds;
  }

  const dmEmbed = new EmbedBuilder()
    .setColor('#FF0000')
    .setTitle('Ban در سرور')
    .setDescription(`شما از سرور Ban شدید${duration ? ` به مدت ${duration} روز.` : ' به صورت دائم.'}`)
    .addFields([
      { name: 'دلیل', value: reason || 'بدون دلیل' },
    ])
    .setTimestamp();

  const dmResult = await sendDmEmbed(user, dmEmbed); // Send DM first

  try {
    await interaction.guild.members.ban(user, banOptions);
    mutedUsers.delete(user.id);
    timeoutUsers.delete(user.id);
    recordPunishment(user.id, interaction.user.id, 'Ban', reason, duration); // Record punishment

    const responseEmbed = createResponseEmbed(interaction, 'کاربر با موفقیت Ban شد.', '#00FF00', [
      { name: 'کاربر', value: `${user.tag} (${user.id})` },
      { name: 'مدت زمان', value: duration ? `${duration} روز` : 'Permanent' },
    ], reason);

    const logEmbed = createLogEmbed(interaction, 'Ban کاربر', '#FF0000', [
      { name: 'کاربر', value: `${user.tag} (${user.id})` },
      { name: 'مدت زمان', value: duration ? `${duration} روز` : 'Permanent' },
      { name: 'دلیل', value: reason || 'بدون دلیل' },
    ]);


    await interaction.reply({ embeds: [responseEmbed] });
    await sendLogMessage(logChannelId, logEmbed);
    if (!dmResult) {
      interaction.channel.send(`ارسال پیام دایرکت به ${user.tag} به دلیل تنظیمات حریم خصوصی کاربر ناموفق بود.`);
    }


  } catch (error) {
    console.error('Error executing ban command:', error);
    return interaction.reply({ content: 'هنگام اجرای فرمان Ban خطایی رخ داد.', ephemeral: true });
  }
}

async function handleUnban(interaction, user, reason) {
  if (user.bot) {
    return interaction.reply({ content: 'ربات رو نمیتونی Unban کنی.', ephemeral: true });
  }
  if (user.id === client.user.id) {
    return interaction.reply({ content: 'من رو نمیتونی Unban کنی.', ephemeral: true });
  }
  if (user.id === interaction.user.id) {
    return interaction.reply({ content: 'خودتو نمیتونی Unban کنی.', ephemeral: true });
  }
  try {
    await interaction.guild.bans.fetch(user.id);
  } catch (error) {
    return interaction.reply({ content: 'کاربر Ban نیست.', ephemeral: true });
  }

  try {
    await interaction.guild.members.unban(user, reason);
    mutedUsers.delete(user.id);
    timeoutUsers.delete(user.id);

    const responseEmbed = createResponseEmbed(interaction, 'کاربر با موفقیت Unban شد.', '#00FF00', [
      { name: 'کاربر', value: `${user.tag} (${user.id})` },
    ], reason);

    const logEmbed = createLogEmbed(interaction, 'رفع Ban کاربر', '#008000', [
      { name: 'کاربر', value: `${user.tag} (${user.id})` },
      { name: 'دلیل', value: reason || 'بدون دلیل' },
    ], null, null, reason);

    const dmEmbed = new EmbedBuilder()
      .setColor('#008000')
      .setTitle('رفع Ban')
      .setDescription('Ban شما از سرور برداشته شد.')
      .addFields([
        { name: 'دلیل', value: reason || 'بدون دلیل' },
      ])
      .setTimestamp();

    await interaction.reply({ embeds: [responseEmbed] });
    await sendLogMessage(logChannelId, logEmbed);
    sendDmEmbed(user, dmEmbed);

  } catch (error) {
    console.error('Error executing unban command:', error);
    return interaction.reply({ content: 'هنگام اجرای فرمان رفع Ban خطایی رخ داد.', ephemeral: true });
  }
}

async function handleKick(interaction, member, user, reason) {
  if (checkPunishmentRateLimit(interaction.user.id, 'Kick')) {
    return interaction.reply({ content: 'شما در یک ساعت گذشته 3 بار تنبیه انجام داده‌اید. لطفا یک ساعت دیگر صبر کنید.', ephemeral: true });
  }
  if (user.bot) {
    return interaction.reply({ content: 'ربات ها رو نمیتونی Kick کنی.', ephemeral: true });
  }
  if (user.id === client.user.id) {
    return interaction.reply({ content: 'من رو نمیتونی Kick کنی.', ephemeral: true });
  }
  if (user.id === interaction.user.id) {
    return interaction.reply({ content: 'خودتو نمیتونی Kick کنی.', ephemeral: true });
  }
  if (!member) {
    return interaction.reply({ content: 'کاربر مورد نظر در سرور یافت نشد.', ephemeral: true });
  }

  const dmEmbed = new EmbedBuilder()
    .setColor('#DAA520')
    .setTitle('Kick از سرور')
    .setDescription('شما از سرور Kick شدید.')
    .addFields([
      { name: 'دلیل', value: reason || 'بدون دلیل' },
    ])
    .setTimestamp();

  const dmResult = await sendDmEmbed(user, dmEmbed); // Send DM first - Corrected line: using dmEmbed instead of embed

  try {
    if (dmResult !== false) {
      await member.kick(reason);
      mutedUsers.delete(user.id);
      timeoutUsers.delete(user.id);
      recordPunishment(user.id, interaction.user.id, 'Kick', reason); // Record punishment

      const responseEmbed = createResponseEmbed(interaction, 'کاربر با موفقیت Kick شد.', '#00FF00', [
        { name: 'کاربر', value: `${user.tag} (${user.id})` },
      ], reason);

      const logEmbed = createLogEmbed(interaction, 'Kick کاربر', '#FF0000', [
        { name: 'کاربر', value: `${user.tag} (${user.id})` },
        { name: 'دلیل', value: String(reason) || 'بدون دلیل' },
      ]);


      await interaction.reply({ embeds: [responseEmbed] });
      await sendLogMessage(logChannelId, logEmbed);
    } else {
      return interaction.reply({ content: `کاربر ${user.tag} با موفقیت Kick شد اما ارسال پیام دایرکت به دلیل تنظیمات حریم خصوصی کاربر ناموفق بود.`, ephemeral: true });
    }


  } catch (error) {
    console.error('Error executing kick command:', error);
    return interaction.reply({ content: 'هنگام اجرای فرمان Kick خطایی رخ داد.', ephemeral: true });
  }
}

async function handleClear(interaction, number) {
  try {
    if (!interaction.member) {
      return interaction.reply({ content: 'خطا در دریافت اطلاعات کاربر. این دستور فقط در سرور قابل استفاده است.', ephemeral: true });
    }

    if (!interaction.memberPermissions.has('MANAGE_MESSAGES')) {
      return interaction.reply({ content: 'شما مجوز مدیریت پیام ها را ندارید.', ephemeral: true });
    }

    if (number > 100 || number <= 0) {
      return interaction.reply({ content: 'تعداد پیام ها برای پاک کردن باید بین 1 تا 100 باشد.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const messages = await interaction.channel.messages.fetch({ limit: number });
    const deletedCount = messages.size;
    await interaction.channel.bulkDelete(messages, true);


    const responseEmbed = createResponseEmbed(interaction, `با موفقیت ${deletedCount} پیام پاک شد.`, '#00FF00');

    const logEmbed = createLogEmbed(interaction, 'Clear Messages', '#FFA500', [
      { name: 'Type', value: 'Message Clear', inline: true },
      { name: 'Channel', value: `${interaction.channel.name} (${interaction.channel.id})`, inline: true },
      { name: 'Number of Messages', value: String(deletedCount), inline: true },
    ])
    .setTimestamp()
    .setFooter({ text: 'Channel Log' });

    await sendLogMessage(logChannelId, logEmbed);
    interaction.editReply({ embeds: [responseEmbed] });
  } catch (error) {
    console.error('Error executing clear command:', error);
    return interaction.editReply({ content: 'هنگام اجرای فرمان پاکسازی پیام ها خطایی رخ داد.' });
  }
}

async function handleStatus(interaction) {
  const uptime = formatUptime(process.uptime());
  const embed = createResponseEmbed(interaction, 'Bot Status', '#00FF00', [
    { name: 'Uptime', value: uptime },
    { name: 'Ping', value: `${client.ws.ping}ms` }
  ]);
  await interaction.reply({ embeds: [embed] });
}

async function handleReloadCommands(interaction) {
  if (!interaction.memberPermissions.has('ADMINISTRATOR')) {
    return interaction.reply({ content: 'You must be an administrator to use this command.', ephemeral: true });
  }

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
    .setDescription(messageContent);

  const dmResult = await sendDmEmbed(user, dmEmbed);

  if (dmResult === true) {
    const logEmbed = createLogEmbed(interaction, 'DM Command Used', '#009fd3', [
      { name: 'Target User', value: `${user.tag} (${user.id})` },
      { name: 'Message Content', value: messageContent },
    ]);
    await sendLogMessage(logChannelId, logEmbed);
    await interaction.reply({ content: `پیام با موفقیت به ${user.tag} ارسال شد.`, ephemeral: true });
  } else if (dmResult === null) {
    await interaction.reply({ content: `ارسال پیام به ${user.tag} به دلیل تنظیمات حریم خصوصی کاربر ناموفق بود.`, ephemeral: true });
  }
   else {
    await interaction.reply({ content: `هنگام ارسال پیام به ${user.tag} خطایی رخ داد.`, ephemeral: true });
  }
}

async function handlePunishmentList(interaction, user) {
  const userId = user.id;
  const history = punishmentHistory.get(userId) || [];

  if (history.length === 0) {
    return interaction.reply({ content: `هیچ سابقه تنبیهی برای ${user.tag} وجود ندارد.`, ephemeral: true });
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
    if (record.type === 'Ban' && record.duration) durationText = `${record.duration} days`;
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
  if (!interaction.memberPermissions.has('MANAGE_CHANNELS')) {
    return interaction.reply({ content: 'You require the "Manage Channels" permission to use this command.', ephemeral: true });
  }

  const channel = interaction.channel;
  const roleId = '1282825490054385706';
  const role = interaction.guild.roles.cache.get(roleId);
  const reason = interaction.options.getString('reason') || 'No reason provided'; // Get reason from options

  if (!role) {
    return interaction.reply({ content: `Role with ID ${roleId} not found.`, ephemeral: true });
  }

  const currentPermissions = channel.permissionOverwrites.cache.get(role.id);
  if (currentPermissions && currentPermissions.deny.has('SendMessages')) {
    return interaction.reply({ content: 'Channel is already locked for this role.', ephemeral: true });
  }

  try {
    await channel.permissionOverwrites.create(role, {
      SendMessages: false,
    });

    const responseEmbed = createResponseEmbed(interaction, `Channel locked for role <@&${roleId}>.`, '#00FF00', [{ name: 'Reason', value: reason }]); // Added reason to response
    const logEmbed = createLogEmbed(interaction, 'Channel Locked', '#FF0000', [
      { name: 'Channel', value: `${channel.name} (${channel.id})` },
      { name: 'Role', value: `<@&${roleId}> (${roleId})` },
      { name: 'Reason', value: reason }, // Added reason to log
    ]);

    await interaction.reply({ embeds: [responseEmbed], ephemeral: true });
    await sendLogMessage(logChannelId, logEmbed);

  } catch (error) {
    console.error('Error locking channel:', error);
    return interaction.reply({ content: 'Failed to lock the channel.', ephemeral: true });
  }
}

async function handleUnlockChannel(interaction) {
  if (!interaction.memberPermissions.has('MANAGE_CHANNELS')) {
    return interaction.reply({ content: 'You require the "Manage Channels" permission to use this command.', ephemeral: true });
  }

  const channel = interaction.channel;
  const roleId = '1282825490054385706';
  const role = interaction.guild.roles.cache.get(roleId);
  const reason = interaction.options.getString('reason') || 'No reason provided'; // Get reason from options

  if (!role) {
    return interaction.reply({ content: `Role with ID ${roleId} not found.`, ephemeral: true });
  }

  const currentPermissions = channel.permissionOverwrites.cache.get(role.id);
  if (currentPermissions && !currentPermissions.deny.has('SendMessages')) {
    return interaction.reply({ content: 'Channel is already unlocked for this role.', ephemeral: true });
  }


  try {
    await channel.permissionOverwrites.create(role, {
      SendMessages: null, // Reset permission to default
    });

    const responseEmbed = createResponseEmbed(interaction, `Channel unlocked for role <@&${roleId}>.`, '#00FF00', [{ name: 'Reason', value: reason }]); // Added reason to response
    const logEmbed = createLogEmbed(interaction, 'Channel Unlocked', '#008000', [
      { name: 'Channel', value: `${channel.name} (${channel.id})` },
      { name: 'Role', value: `<@&${roleId}> (${roleId})` },
      { name: 'Reason', value: reason }, // Added reason to log
    ]);

    await interaction.reply({ embeds: [responseEmbed], ephemeral: true });
    await sendLogMessage(logChannelId, logEmbed);

  } catch (error) {
    console.error('Error unlocking channel:', error);
    return interaction.reply({ content: 'Failed to unlock the channel.', ephemeral: true });
  }
}

async function handleSlowmode(interaction) {
  if (!interaction.memberPermissions.has('MANAGE_CHANNELS')) {
    return interaction.reply({ content: 'You require the "Manage Channels" permission to use this command.', ephemeral: true });
  }
  if (checkPunishmentRateLimit(interaction.user.id, 'Slowmode')) {
    return interaction.reply({ content: 'شما در یک ساعت گذشته 3 بار تنبیه انجام داده‌اید. لطفا یک ساعت دیگر صبر کنید.', ephemeral: true });
  }

  const channel = interaction.channel;
  const duration = interaction.options.getInteger('duration');
  const reason = interaction.options.getString('reason') || 'No reason provided';

  if (duration < 0 || duration > 21600) { // Discord slowmode limit is 6 hours (21600 seconds)
    return interaction.reply({ content: 'مدت زمان Slowmode باید بین 0 تا 21600 ثانیه باشد.', ephemeral: true });
  }

  try {
    await channel.setRateLimitPerUser(duration, reason);

    const responseEmbed = createResponseEmbed(interaction, `Slowmode با موفقیت ${duration > 0 ? `${duration} ثانیه` : 'غیرفعال'} شد.`, '#00FF00', [{ name: 'Reason', value: reason }]);
    const logEmbed = createLogEmbed(interaction, 'Slowmode Updated', '#FFA500', [
      { name: 'Channel', value: `${channel.name} (${channel.id})` },
      { name: 'Duration', value: `${duration} seconds` },
      { name: 'Reason', value: reason },
    ]);

    await interaction.reply({ embeds: [responseEmbed], ephemeral: true });
    await sendLogMessage(logChannelId, logEmbed);

  } catch (error) {
    console.error('Error setting slowmode:', error);
    return interaction.reply({ content: 'Failed to set slowmode.', ephemeral: true });
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
    return interaction.reply({ content: 'فرمان نامعتبر.', ephemeral: true });
  }

  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason');
  const duration = interaction.options.getInteger('duration');
  const number = interaction.options.getInteger('number');
  const message = interaction.options.getString('message'); // Get message for dm command


  if (interaction.commandName === 'ban') {
  }


  let member = null;

  if (!['clear', 'status', 'reloadcommands', 'dm', 'help', 'punishmentlist', 'lockchannel', 'unlockchannel', 'slowmode'].includes(interaction.commandName)) { // Include help, punishmentlist, lockchannel, unlockchannel, slowmode command
    member = interaction.guild.members.cache.get(user.id);
  }

  try {
    if (interaction.commandName === 'clear') {
      await handler(interaction, number);
    } else if (interaction.commandName === 'status') {
      await handler(interaction);
    } else if (interaction.commandName === 'reloadcommands') {
      await handler(interaction);
    } else if (interaction.commandName === 'dm') { // Handle dm command
      await handler(interaction);
    } else if (interaction.commandName === 'help') { // Handle help command
      await handler(interaction);
    } else if (interaction.commandName === 'punishmentlist') { // Handle punishmentlist command
      await handler(interaction, user);
    } else if (interaction.commandName === 'lockchannel') { // Handle lockchannel command
      await handler(interaction);
    } else if (interaction.commandName === 'unlockchannel') { // Handle unlockchannel command
      await handler(interaction);
    } else if (interaction.commandName === 'slowmode') { // Handle slowmode command
      await handler(interaction);
    }
    else if (['timeout', 'untimeout', 'mute', 'unmute', 'kick'].includes(interaction.commandName)) {
      await handler(interaction, member, user, duration, reason);
    }
    else if (['ban', 'unban'].includes(interaction.commandName)) {
      await handler(interaction, user, duration, reason);
    }
     else {
      await handler(interaction, member, user, duration, reason, number);
    }
  } catch (error) {
    console.error('Command execution error:', error);
    interaction.reply({ content: 'هنگام اجرای فرمان خطایی رخ داد.', ephemeral: true });
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  const userId = newState.member.id;
  const voiceChannelId = specialVoiceChannelId;
  const notificationChannel = client.channels.cache.get(notificationChannelId);
  const targetRole = newState.guild.roles.cache.get(targetRoleId);

  if (newState.channelId === voiceChannelId && oldState.channelId !== voiceChannelId) {
    // User joined the special voice channel
    voiceJoinTimers.set(userId, setTimeout(async => {
      if (newState.channelId === voiceChannelId) {
        // User is still in the channel after 30 seconds
        if (notificationChannel) {
          const notificationEmbed = new EmbedBuilder()
            .setColor('#FFA500')
            .setDescription(`<@${userId}> به کانال ویس رسید و بیشتر از 30 ثانیه است که داخل ویس است.`);
          notificationChannel.send({ content: `<@&${targetRole.id}>`, embeds: [notificationEmbed] }).then(message => {
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
        notificationChannel.messages.delete(messageId); // Delete notification message
        notificationMessages.delete(userId); // Remove message ID from map
      } catch (error) {
        console.error('Error deleting notification message:', error);
      }
    }
  }
});


client.on('guildInviteCreate', async invite => {
  inviteCache.set(invite.code, invite);
  try {
    const fetchedInvite = await invite.fetch();

    const logEmbed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle('Channel Activity')
      .addFields(
        { name: 'Type', value: 'Invite Create', inline: true },
        { name: 'Channel Name', value: `${fetchedInvite.channel.name}`, inline: true },
        { name: 'Channel Id', value: `${fetchedInvite.channel.id}`, inline: true },
        { name: 'Inviter Tag', value: `${fetchedInvite.inviter.tag}`, inline: true },
        { name: 'Inviter Id', value: `${fetchedInvite.inviter.id}`, inline: true },
        { name: 'Invite Code', value: fetchedInvite.code, inline: true },
        { name: 'Invite URL', value: `https://discord.gg/${fetchedInvite.code}`, inline: true },
        { name: 'Uses', value: `${fetchedInvite.uses}/${fetchedInvite.maxUses}`, inline: true },
        { name: 'Max Age (minutes)', value: `${fetchedInvite.maxAge/60}`, inline: true },
        { name: 'Temporary', value: `${fetchedInvite.temporary}`, inline: true }
      )
      .setTimestamp()
      .setFooter({ text: 'Server Log' });

    await sendLogMessage(logChannelId, logEmbed);
  } catch (error) {
    console.error('Error during guildInviteCreate logging:', error);
  }
});

client.on('guildInviteDelete', async invite => {
  inviteCache.delete(invite.code);
  try {
    const logEmbed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('Channel Activity')
      .addFields(
        { name: 'Type', value: 'Invite Delete', inline: true },
        { name: 'Channel Name', value: `${invite.channel.name}`, inline: true },
        { name: 'Channel Id', value: `${invite.channel.id}`, inline: true },
        { name: 'Invite Code', value: invite.code || 'Unknown', inline: true }
      )
      .setTimestamp()
      .setFooter({ text: 'Server Log' });

    await sendLogMessage(logChannelId, logEmbed);
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

    await member.guild.invites.cache.clear();
    const initialFreshInvites = await member.guild.invites.fetch({ cache: false });

    setTimeout(async () => {
      const delayedFreshInvites = await member.guild.invites.fetch({ cache: false });
      const usedInvite = fetchUsedInvite(initialFreshInvites, delayedFreshInvites);

      if (usedInvite) {
        joinedViaInvite = usedInvite.code;
        inviterTag = usedInvite.inviter.tag;
      } else {
        joinedViaInvite = 'Unknown';
        inviterTag = 'Unknown';
      }

      await updateInviteCache(member.guild);

      const logEmbed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('Member Activity')
        .setThumbnail(avatarURL)
        .addFields(
          { name: 'Type', value: 'Member Join', inline: true },
          { name: 'User Tag', value: `${user.tag}`, inline: true },
          { name: 'User Id', value: `${user.id}`, inline: true },
          { name: 'Account Created', value: `${member.user.createdAt.toLocaleDateString()}`, inline: true },
          { name: 'Joined Server', value: `${new Date().toLocaleDateString()}`, inline: true },
          { name: 'Joined via Invite', value: joinedViaInvite, inline: true },
          { name: 'Inviter', value: inviterTag, inline: true },
          { name: 'Banner', value: bannerURL || 'No Banner', inline: true },
          { name: 'Profile', value: avatarURL, inline: true }
        )
        .setTimestamp()
        .setFooter({ text: 'Server Log' });

      await sendLogMessage(logChannelId, logEmbed);

      // Send Welcome DM - keep this part
      const welcomeEmbed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle(`به سرور ${member.guild.name} خوش آمدید!`)
        .setDescription(`از پیوستن شما به جمع ما خوشحالیم. برای دسترسی به تمام بخش‌های سرور، قوانین را مطالعه کنید و نقش‌های مورد علاقه خود را انتخاب کنید.`); // Customize welcome message
      const dmResult = await sendDmEmbed(user, welcomeEmbed);
      if (dmResult === null) {
        if (logChannelId) {
          const dmBlockedEmbed = new EmbedBuilder()
            .setColor('#FFA500')
            .setTitle('Welcome DM Blocked')
            .setDescription(`پیام خوش آمدگویی به ${user.tag} (${user.id}) به دلیل تنظیمات حریم خصوصی کاربر ارسال نشد.`);
          sendLogMessage(logChannelId, dmBlockedEmbed);
        }
      } else if (dmResult === true) {
      } else {
        console.error(`Failed to send welcome DM to user: ${user.tag} (${user.id}), dmResult: ${dmResult}`);
      }


    }, 7000); // Delay increased to 7000ms (7 seconds)


  } catch (error) {
    console.error('Error during guildMemberAdd logging:', error);
  }
});

client.on('guildMemberRemove', async member => {
  try {
    const avatarURL = member.user.displayAvatarURL({ dynamic: true, size: 512 });
    let joinedViaInvite = 'Unknown';
    let inviterTag = 'Unknown';

    const logEmbed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('Member Activity')
      .setThumbnail(avatarURL)
      .addFields(
        { name: 'Type', value: 'Member Leave', inline: true },
        { name: 'User Tag', value: `${member.user.tag}`, inline: true },
        { name: 'User Id', value: `${member.user.id}`, inline: true },
        { name: 'Joined Server', value: `${member.joinedAt.toLocaleDateString()}`, inline: true },
        { name: 'Left Server', value: `${new Date().toLocaleDateString()}`, inline: true },
        { name: 'Profile', value: avatarURL, inline: true },
        { name: 'Joined via Invite', value: joinedViaInvite, inline: true },
        { name: 'Inviter', value: inviterTag, inline: true }
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
    inviteCache.clear();
    fetchedInvites.forEach(invite => {
      inviteCache.set(invite.code, invite);
    });
  } catch (error) {
    console.error('Error updating invite cache:', error);
  }
}


client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  botStartTime = new Date();
  console.log('Log Channel ID on ready:', logChannelId);
  await registerCommands();
  client.user.setPresence({
    status: 'idle', // You can change the status to 'online', 'dnd', 'idle', or 'invisible'
    activities: [{
      name: 'TeaR',
      type: ActivityType.Playing, // You can change the activity type to 'Playing', 'Streaming', 'Listening', 'Watching', or 'Custom'
    }],
  });
});


client.login(DISCORD_BOT_TOKEN);

