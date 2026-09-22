import fs from 'node:fs';
import path from 'node:path';
import {
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  MessageType,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { LANGS } from './i18n.js';
import { announcementContainer, dashboardContainer, fetchBoard, historyComponents, renderHistoryPng } from './present.js';

const statePath = path.join(process.cwd(), 'data', 'state.json');

function loadEnv() {
  const file = path.join(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && process.env[match[1].trim()] == null) process.env[match[1].trim()] = match[2].trim();
  }
}

function loadState() {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    // 初回起動
  }
  return { channelId: null, dashboardMessageId: null, notices: [], knownIds: [], seeded: false, language: 'ja', ...state };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function currentLang() {
  return LANGS[loadState().language];
}

const ROLE_NAME = 'ping-reset';
const NOTICE_TTL = 24 * 60 * 60 * 1000;

function payload(components, { files, roleId } = {}) {
  return {
    flags: MessageFlags.IsComponentsV2,
    components,
    files,
    allowedMentions: roleId ? { roles: [roleId] } : { parse: [] },
  };
}

function findRole(guild) {
  return guild.roles.cache.find((role) => role.name === ROLE_NAME);
}

let chain = Promise.resolve();
function enqueue(task) {
  const run = chain.then(task, task);
  chain = run.then(() => {}, () => {});
  return run;
}

loadEnv();
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
if (!token || !clientId) {
  console.error('DISCORD_TOKEN と DISCORD_CLIENT_ID を .env に入れてください');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('set-channel')
    .setDescription('リセット情報を表示するチャンネルを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('表示先のチャンネル')
      .setRequired(true)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
  new SlashCommandBuilder()
    .setName('unset-channel')
    .setDescription('リセット情報の表示チャンネルの設定を解除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('notify')
    .setDescription('ping-reset ロールを付け外しして、リセット通知をオン・オフします'),
  new SlashCommandBuilder()
    .setName('language')
    .setDescription('表示言語を切り替えます')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) => option
      .setName('language')
      .setDescription('言語')
      .setRequired(true)
      .addChoices(...Object.entries(LANGS).map(([value, lang]) => ({ name: lang.name, value })))),
].map((command) => command.toJSON());

// 書き込み制限（code 20028）は Retry-After ヘッダが 1 秒、本文が数分になる。
// ヘッダどおり再送すると制限が伸び続けるので、本文の時刻まで投稿を止める。
let channelWriteUntil = 0;

async function discordRequest(url, init) {
  const res = await fetch(url, init);
  if (res.status !== 429) return res;
  const data = await res.clone().json().catch(() => null);
  const retry = Number(data?.retry_after);
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(retry) && retry > 0) {
    channelWriteUntil = Math.max(channelWriteUntil, Date.now() + retry * 1000);
  }
  if (!Number.isFinite(retry) || retry <= (Number.isFinite(header) ? header : 0)) return res;
  const headers = new Headers(res.headers);
  headers.set('retry-after', String(retry));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  rest: {
    makeRequest: discordRequest,
    rejectOnRateLimit: (info) => info.scope === 'shared',
  },
});

async function notifyNew(channel, state, board, mention) {
  const known = new Set(state.knownIds);
  const fresh = state.seeded ? board.resets.filter((reset) => !known.has(reset.id)) : [];
  const role = findRole(channel.guild);
  if (mention && role) {
    for (const reset of fresh) {
      const card = announcementContainer(reset, LANGS[board.lang], role.id);
      const message = await channel.send(payload([card], { roleId: role.id }));
      state.notices.push({ channelId: channel.id, messageId: message.id, deleteAt: Date.now() + NOTICE_TTL });
    }
  }
  state.knownIds = board.resets.map((reset) => reset.id);
  state.seeded = true;
}

async function deleteExpiredNotices(state) {
  const now = Date.now();
  for (const notice of state.notices.filter((entry) => entry.deleteAt <= now)) {
    const channel = await client.channels.fetch(notice.channelId).catch(() => null);
    await channel?.messages.delete(notice.messageId).catch(() => {});
  }
  state.notices = state.notices.filter((entry) => entry.deleteAt > now);
}

let lastChartKey = '';

function chartKey(board) {
  const today = new Date(board.fetchedAt).toISOString().slice(0, 10);
  const marks = board.resets.map((reset) => `${reset.announced_at.slice(0, 10)}:${reset.reset_type}`).join(',');
  return `${board.lang}\n${today}\n${marks}`;
}

function dashboardBody(board, withImage) {
  const files = withImage
    ? [new AttachmentBuilder(renderHistoryPng(board.resets, board.lang, board.fetchedAt), { name: 'history.png' })]
    : undefined;
  return payload([dashboardContainer(board)], { files });
}

async function upsertDashboard(channel, state, board) {
  if (Date.now() < channelWriteUntil) return;
  const key = chartKey(board);
  if (state.dashboardMessageId) {
    try {
      const message = await channel.messages.fetch(state.dashboardMessageId);
      await message.edit(dashboardBody(board, key !== lastChartKey));
      lastChartKey = key;
      return;
    } catch (error) {
      if (error.code !== 10008) throw error;
      state.dashboardMessageId = null;
    }
  }
  const message = await channel.send(dashboardBody(board, true));
  lastChartKey = key;
  state.dashboardMessageId = message.id;
  try {
    await message.pin();
    const recent = await channel.messages.fetch({ limit: 3 });
    const system = recent.find((entry) => entry.type === MessageType.ChannelPinnedMessage);
    await system?.delete();
  } catch {
    // ピン権限がなければ、表示自体はそのまま続ける
  }
}

let lastBoard = null;

async function refresh(mention) {
  const state = loadState();
  const board = await fetchBoard(state.language);
  lastBoard = board;
  await deleteExpiredNotices(state);
  if (!state.channelId) {
    state.knownIds = board.resets.map((reset) => reset.id);
    state.seeded = true;
    saveState(state);
    return;
  }
  const channel = await client.channels.fetch(state.channelId);
  if (!channel?.isTextBased()) return;
  await upsertDashboard(channel, state, board);
  await notifyNew(channel, state, board, mention);
  saveState(state);
}

async function setChannel(interaction, t) {
  const channel = interaction.options.getChannel('channel', true);
  const me = await channel.guild.members.fetchMe();
  const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory];
  if (!channel.permissionsFor(me)?.has(needed)) {
    await interaction.editReply(t.perms);
    return;
  }
  const state = loadState();
  if (state.channelId !== channel.id) {
    state.channelId = channel.id;
    state.dashboardMessageId = null;
    saveState(state);
  }
  await refresh(false);
  await interaction.editReply(t.setDone(channel));
}

async function unsetChannel(interaction, t) {
  const state = loadState();
  if (!state.channelId) {
    await interaction.editReply(t.unsetNone);
    return;
  }
  const channel = await client.channels.fetch(state.channelId).catch(() => null);
  if (channel && state.dashboardMessageId) await channel.messages.delete(state.dashboardMessageId).catch(() => {});
  state.channelId = null;
  state.dashboardMessageId = null;
  saveState(state);
  await interaction.editReply(t.unsetDone);
}

async function notify(interaction, t) {
  const { guild, member } = interaction;
  try {
    const role = findRole(guild) ?? await guild.roles.create({ name: ROLE_NAME, mentionable: true });
    const on = !member.roles.cache.has(role.id);
    if (on) await member.roles.add(role);
    else await member.roles.remove(role);
    await interaction.editReply({ content: on ? t.notifyOn(role) : t.notifyOff(role), allowedMentions: { parse: [] } });
  } catch (error) {
    if (error.code !== 50013) throw error;
    await interaction.editReply(t.rolePerms);
  }
}

async function setLanguage(interaction) {
  const state = loadState();
  state.language = interaction.options.getString('language', true);
  saveState(state);
  await refresh(false).catch((error) => console.error('[language]', error));
  await interaction.editReply(LANGS[state.language].languageDone);
}

async function showHistory(interaction, page) {
  const components = historyComponents(lastBoard, page);
  const flags = [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2];
  if (interaction.message.flags.has(MessageFlags.Ephemeral)) await interaction.update({ components, flags });
  else await interaction.reply({ components, flags });
}

const rest = new REST({ version: '10' }).setToken(token);
const invitePermissions = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageRoles,
].reduce((sum, bit) => sum | BigInt(bit), 0n);
const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${invitePermissions}`;

async function registerCommands(guild) {
  try {
    await rest.put(Routes.applicationGuildCommands(clientId, guild.id), { body: commands });
    console.log(`commands ${guild.name}`);
  } catch (error) {
    if (error.code !== 50001) throw error;
    console.error(`${guild.name}: コマンドを登録できません。次のURLから入れ直してください\n${inviteUrl}`);
  }
}

client.once(Events.ClientReady, () => {
  console.log(`ready ${client.user.tag}`);
  console.log(`invite ${inviteUrl}`);
  enqueue(async () => {
    const guilds = [...client.guilds.cache.values()];
    if (!guilds.length) console.error('参加中のサーバーがありません。上のURLから入れてください');
    for (const guild of guilds) await registerCommands(guild);
    await refresh(true);
  }).catch((error) => console.error('[ready]', error));
  setInterval(() => {
    enqueue(() => refresh(true)).catch((error) => console.error('[tick]', error));
  }, 30 * 60 * 1000);
});

client.on(Events.GuildCreate, (guild) => {
  enqueue(() => registerCommands(guild)).catch((error) => console.error('[guild]', error));
});

const handlers = {
  'set-channel': setChannel,
  'unset-channel': unsetChannel,
  notify,
  language: setLanguage,
};

client.on(Events.InteractionCreate, (interaction) => {
  const t = currentLang();
  const fail = async (error) => {
    console.error(error);
    const body = { content: t.failed, flags: MessageFlags.Ephemeral };
    const reply = interaction.deferred || interaction.replied ? interaction.followUp(body) : interaction.reply(body);
    await reply.catch(() => {});
  };
  if (interaction.isButton() && interaction.customId.startsWith('history:')) {
    showHistory(interaction, Number(interaction.customId.split(':')[1])).catch(fail);
    return;
  }
  const handler = interaction.isChatInputCommand() && handlers[interaction.commandName];
  if (!handler) return;
  interaction.deferReply({ flags: MessageFlags.Ephemeral })
    .then(() => enqueue(() => handler(interaction, t)))
    .catch(fail);
});

client.login(token);
