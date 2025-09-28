require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, PermissionFlagsBits, ChannelType, time } = require('discord.js');
const cron = require('node-cron');

/** ---- Env ---- */
const token = process.env.DISCORD_TOKEN;
const appId = process.env.APPLICATION_ID;            // Application (Client) ID
const defaultTz = process.env.DEFAULT_TZ || 'Asia/Taipei';
const fixedChannelId = process.env.ALERT_CHANNEL_ID; // Channel for fixed mapping
const snowflakeRE = /^\d{17,20}$/;

if (!token) { console.error('Missing DISCORD_TOKEN'); process.exit(1); }
if (!appId || !snowflakeRE.test(appId)) { console.error('Missing/invalid APPLICATION_ID'); process.exit(1); }
if (!fixedChannelId || !snowflakeRE.test(fixedChannelId)) { console.error('Missing/invalid ALERT_CHANNEL_ID'); process.exit(1); }

/** ---- Client ---- */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/** ---- In-memory store ----
 * oneShots: { id, userId, guildId, channelId, fireAt, message, timer }
 */
const store = { oneShots: [], nextId: 1 };
const MAX_ALERTS_PER_USER = 10;

/** ---- Fixed minute → message schedule ---- */
const fixedMessages = {
  59: "搶紅包",
  5:  "打蝦群",
  11: "打送禮",
  18: "打寶藏",
  26: "埋嚟考試啦",
  40: "大挪移靠晒你",
  50: "娛樂幣你唔係唔要呀?"
};

function startFixedSchedule() {
  cron.schedule('0 * * * * *', async () => {
    const m = new Date().getMinutes();
    if (!(m in fixedMessages)) return;
    try {
      const ch = await client.channels.fetch(fixedChannelId);
      if (!ch || ch.type !== ChannelType.GuildText) return;
      await ch.send(`@everyone ${fixedMessages[m]}`);// add @everyone here if you want it globally
    } catch (e) {
      console.error('Fixed schedule send failed:', e);
    }
  }, { timezone: defaultTz });
}

/** ---- One-shot alert scheduling (fires AFTER N minutes) ---- */
function scheduleOneShot(entry) {
  const delayMs = Math.max(0, entry.fireAt.getTime() - Date.now());
  const t = setTimeout(async () => {
    try {
      const ch = await client.channels.fetch(entry.channelId);
      if (ch && ch.type === ChannelType.GuildText) {
        await ch.send(`<@${entry.userId}> ${entry.message}`);
      }
    } catch (e) {
      console.error(`One-shot #${entry.id} send failed:`, e);
    } finally {
      // remove from store after firing
      cancelOneShot(entry.id, /*silent*/ true);
    }
  }, delayMs);
  entry.timer = t;
}

function cancelOneShot(id, silent = false) {
  const idx = store.oneShots.findIndex(a => a.id === id);
  if (idx !== -1) {
    const [e] = store.oneShots.splice(idx, 1);
    if (e.timer) clearTimeout(e.timer);
    if (!silent) console.log(`Cancelled one-shot #${id}`);
  }
}

function userActiveCount(userId) {
  return store.oneShots.filter(a => a.userId === userId).length;
}

/** ---- Slash commands ---- */
const commands = [
  {
    name: 'alert',
    description: 'One-time alert that fires after N minutes (in memory)',
    options: [
      {
        type: 1, name: 'add', description: 'Create a one-time alert after N minutes (tags you)',
        options: [
          { type: 4, name: 'minute', description: 'Minutes from now (1-10080)', required: true, min_value: 1, max_value: 10080 },
          { type: 3, name: 'message', description: 'Alert message', required: true },
        ]
      },
      { type: 1, name: 'list', description: 'List your pending one-time alerts' },
      {
        type: 1, name: 'remove', description: 'Remove one pending alert by ID',
        options: [{ type: 4, name: 'id', description: 'Alert ID (see list)', required: true }]
      },
      { type: 1, name: 'clear', description: 'Remove all your pending alerts' },
    ],
    default_member_permissions: PermissionFlagsBits.SendMessages.toString()
  }
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(appId), { body: commands });
  console.log('Slash commands registered.');
}

/** ---- Bot lifecycle ---- */
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  startFixedSchedule();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'alert') return;
  const sub = interaction.options.getSubcommand();

  try {
    if (sub === 'add') {
      const minutes = interaction.options.getInteger('minute', true);
      const message = interaction.options.getString('message', true).trim();

      const myCount = userActiveCount(interaction.user.id);
      if (myCount >= MAX_ALERTS_PER_USER) {
        await interaction.reply({ ephemeral: true, content: `❌ You already have ${MAX_ALERTS_PER_USER} active alerts. Use /alert list or /alert clear.` });
        return;
      }

      const fireAt = new Date(Date.now() + minutes * 60 * 1000);
      const entry = {
        id: store.nextId++,
        userId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        fireAt,
        message,
        timer: null,
      };
      store.oneShots.push(entry);
      scheduleOneShot(entry);

      // Discord timestamp helpers: <t:unix:R> shows relative time, <t:unix:F> full
      const unix = Math.floor(fireAt.getTime() / 1000);
      await interaction.reply({
        ephemeral: true,
        content: `✅ One-time alert #${entry.id} set for <t:${unix}:R> (≈ ${minutes} min). It will tag you and say: ${message}`
      });
    }

    else if (sub === 'list') {
      const mine = store.oneShots
        .filter(a => a.userId === interaction.user.id)
        .sort((a,b) => a.fireAt - b.fireAt);
      if (mine.length === 0) {
        await interaction.reply({ ephemeral: true, content: 'You have no pending alerts.' });
        return;
      }
      const lines = mine.map(a => {
        const unix = Math.floor(a.fireAt.getTime() / 1000);
        return `#${a.id} • fires <t:${unix}:R> in <#${a.channelId}> • ${a.message}`;
      });
      await interaction.reply({ ephemeral: true, content: lines.join('\n') });
    }

    else if (sub === 'remove') {
      const id = interaction.options.getInteger('id', true);
      const item = store.oneShots.find(a => a.id === id && a.userId === interaction.user.id);
      if (!item) {
        await interaction.reply({ ephemeral: true, content: `❌ Alert #${id} not found (or not yours).` });
        return;
      }
      cancelOneShot(id);
      await interaction.reply({ ephemeral: true, content: `🗑️ Removed alert #${id}.` });
    }

    else if (sub === 'clear') {
      const mine = store.oneShots.filter(a => a.userId === interaction.user.id);
      if (mine.length === 0) {
        await interaction.reply({ ephemeral: true, content: 'You have no alerts to clear.' });
        return;
      }
      for (const a of mine) cancelOneShot(a.id, /*silent*/ true);
      await interaction.reply({ ephemeral: true, content: `🧹 Cleared ${mine.length} alert(s).` });
    }

  } catch (e) {
    console.error('Command error:', e);
    if (!interaction.replied) {
      await interaction.reply({ ephemeral: true, content: 'Unexpected error. Try again later.' });
    }
  }
});

/** ---- Boot ---- */
(async () => {
  try {
    await registerCommands();
    await client.login(token);
  } catch (e) {
    console.error('Startup failed:', e); process.exit(1);
  }
})();
