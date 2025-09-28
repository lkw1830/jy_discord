require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, PermissionFlagsBits, ChannelType } = require('discord.js');
const cron = require('node-cron');

/** ---- Env ---- */
const token = process.env.DISCORD_TOKEN;
const appId = process.env.APPLICATION_ID;           // Application (Client) ID
const defaultTz = process.env.DEFAULT_TZ || 'Asia/Taipei';
const fixedChannelId = process.env.ALERT_CHANNEL_ID; // Channel for fixed mapping alerts
const snowflakeRE = /^\d{17,20}$/;

if (!token) { console.error('Missing DISCORD_TOKEN'); process.exit(1); }
if (!appId || !snowflakeRE.test(appId)) { console.error('Missing/invalid APPLICATION_ID'); process.exit(1); }
if (!fixedChannelId || !snowflakeRE.test(fixedChannelId)) { console.error('Missing/invalid ALERT_CHANNEL_ID'); process.exit(1); }

/** ---- Client ---- */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/** ---- In-memory store ---- */
const store = { alerts: [], nextId: 1 };
const jobs  = new Map(); // id -> cron job
const MAX_ALERTS_PER_USER = 10;

/** ---- Fixed minute → message schedule ---- */
const fixedMessages = {
  59:  "搶紅包",
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
      await ch.send(`@everyone ${messages[m]}`); // no @everyone by default; add if you want
    } catch (e) {
      console.error('Fixed schedule send failed:', e);
    }
  }, { timezone: defaultTz });
}

/** ---- Dynamic alerts (always tag the creator) ---- */
function scheduleAlert(alert) {
  const cronExpr = `0 ${alert.minute} * * * *`; // second 0, given minute, every hour
  if (!cron.validate(cronExpr)) {
    console.warn(`Invalid cron for alert ${alert.id}: ${cronExpr}`); return;
  }
  const job = cron.schedule(cronExpr, async () => {
    try {
      const ch = await client.channels.fetch(alert.channelId);
      if (!ch || ch.type !== ChannelType.GuildText) return;
      await ch.send(`<@${alert.userId}> ${alert.message}`); // tag creator
    } catch (e) {
      console.error(`Alert #${alert.id} send failed:`, e);
    }
  }, { timezone: defaultTz });
  jobs.set(alert.id, job);
}

function unscheduleAlert(id) {
  const j = jobs.get(id);
  if (j) { j.stop(); jobs.delete(id); }
}

/** ---- Slash commands ---- */
const commands = [
  {
    name: 'alert',
    description: 'Manage your alerts (in memory)',
    options: [
      {
        type: 1, name: 'add', description: 'Add an hourly alert at a minute (tags you)',
        options: [
          { type: 4, name: 'minute', description: '0-59', required: true, min_value: 0, max_value: 59 },
          { type: 3, name: 'message', description: 'Alert message', required: true },
        ]
      },
      { type: 1, name: 'list', description: 'List your alerts' },
      {
        type: 1, name: 'remove', description: 'Remove one alert by ID',
        options: [{ type: 4, name: 'id', description: 'Alert ID (see list)', required: true }]
      },
      { type: 1, name: 'clear', description: 'Remove all your alerts' },
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
      const minute = interaction.options.getInteger('minute', true);
      const message = interaction.options.getString('message', true).trim();

      const myCount = store.alerts.filter(a => a.userId === interaction.user.id).length;
      if (myCount >= MAX_ALERTS_PER_USER) {
        await interaction.reply({ ephemeral: true, content: `❌ You already have ${MAX_ALERTS_PER_USER} alerts. Use /alert list or /alert clear.` });
        return;
      }

      const alert = {
        id: store.nextId++,
        userId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId, // posts in the channel where command is used
        minute,
        message,
      };
      store.alerts.push(alert);
      scheduleAlert(alert);

      await interaction.reply({ ephemeral: true, content:
        `✅ Added alert #${alert.id} — minute **${minute}** (TZ: ${defaultTz}) here.\n` +
        `It will tag you and say: ${message}`
      });
    }

    else if (sub === 'list') {
      const mine = store.alerts.filter(a => a.userId === interaction.user.id);
      if (mine.length === 0) {
        await interaction.reply({ ephemeral: true, content: 'You have no alerts. Use `/alert add minute:<0-59> message:<text>`.' });
        return;
      }
      const lines = mine.map(a =>
        `#${a.id} • minute ${a.minute} • Channel: <#${a.channelId}> • ${a.message}`
      );
      await interaction.reply({ ephemeral: true, content: lines.join('\n') });
    }

    else if (sub === 'remove') {
      const id = interaction.options.getInteger('id', true);
      const idx = store.alerts.findIndex(a => a.id === id && a.userId === interaction.user.id);
      if (idx === -1) {
        await interaction.reply({ ephemeral: true, content: `❌ Alert #${id} not found (or not yours).` });
        return;
      }
      const [removed] = store.alerts.splice(idx, 1);
      unscheduleAlert(removed.id);
      await interaction.reply({ ephemeral: true, content: `🗑️ Removed alert #${id}.` });
    }

    else if (sub === 'clear') {
      const mine = store.alerts.filter(a => a.userId === interaction.user.id);
      if (mine.length === 0) {
        await interaction.reply({ ephemeral: true, content: 'You have no alerts to clear.' });
        return;
      }
      for (const a of mine) unscheduleAlert(a.id);
      store.alerts = store.alerts.filter(a => a.userId !== interaction.user.id);
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
