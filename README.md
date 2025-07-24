
# Discord Moderation Bot

A powerful Discord moderation bot built with **Discord.js**. This bot provides a variety of features to help manage servers, enforce rules, and maintain order.

---

## 🚀 Installation & Setup

### 1. Requirements:
- [Node.js](https://nodejs.org/) v16 or higher
- A [Discord Bot Token](https://discord.com/developers/applications)

### 2. Install dependencies:
```bash
npm install
```

### 3. Create a `.env` file:
```env
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_GUILD_ID=your_guild_id
MUTE_ROLE_NAME=Muted
LOG_CHANNEL_ID=your_log_channel_id
```

### 4. Run the bot:
```bash
node index.js
```

---

## ✅ Features

- **Slash Commands for Moderation:**
  - `/help` → Show all available commands
  - `/timeout`, `/untimeout` → Apply or remove timeout for a user
  - `/mute`, `/unmute` → Mute or unmute a user (role-based)
  - `/ban`, `/unban` → Ban or unban a user
  - `/kick` → Kick a user from the server
  - `/clear` → Delete a specified number of messages
  - `/status` → Check bot status
  - `/reloadcommands` → Reload application commands
  - `/dm` → Send a direct message to a user
  - `/punishmentlist` → View a user's punishment history
  - `/lockchannel`, `/unlockchannel` → Lock or unlock the current channel
  - `/slowmode` → Enable slowmode on a channel

- **Additional Features:**
  - Logs all moderation actions in a dedicated log channel
  - Stores punishment history and moderator action limits
  - Fully configurable using `.env`
  - Compatible with **Replit**

---

## 📂 Project Structure
```
├── index.js          # Main bot logic
├── package.json      # Project metadata and dependencies
├── .env.example      # Example environment variables
├── .gitignore
├── README.md
```

---

## 🛡️ Security Tips
- Never commit your `.env` file or bot token to public repositories.
- Review bot permissions before inviting it to a server.

---

## 📜 License
This project is licensed under the MIT License - TeaR2214

---
