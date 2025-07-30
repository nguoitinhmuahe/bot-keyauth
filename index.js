// @ts-nocheck
const { Client, IntentsBitField, SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const Database = require('better-sqlite3');
const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
require('dotenv').config();

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
  ],
});
const app = express();
app.use(bodyParser.json());

// create sqlite óc cặc lắm mới không hiểu
const db = new Database('keys.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS keys (
    key TEXT PRIMARY KEY,
    type TEXT DEFAULT 'standard',
    userId TEXT,
    hwid TEXT,
    ip TEXT,
    status TEXT DEFAULT 'active',
    createdAt TEXT DEFAULT (datetime('now')),
    expiresAt TEXT,
    duration TEXT,
    usageCount INTEGER DEFAULT 0,
    maxUses INTEGER DEFAULT -1,
    note TEXT,
    tags TEXT DEFAULT '[]',
    key_group TEXT,
    features TEXT DEFAULT '[]',
    plan TEXT
  );
  CREATE TABLE IF NOT EXISTS admins (
    userId TEXT PRIMARY KEY,
    role TEXT DEFAULT 'admin'
  );
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT,
    userId TEXT,
    key TEXT,
    details TEXT,
    timestamp TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ratelimits (
    ip TEXT,
    key TEXT,
    attempts INTEGER,
    lastAttempt TEXT,
    PRIMARY KEY (ip, key)
  );
  CREATE TABLE IF NOT EXISTS trustlist (
    value TEXT PRIMARY KEY,
    type TEXT
  );
  CREATE TABLE IF NOT EXISTS blocklist (
    ip TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS groups (
    name TEXT PRIMARY KEY,
    description TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Khởi tạo admin từ .env
if (process.env.ADMIN_ID) {
  const initAdmin = db.prepare('INSERT OR IGNORE INTO admins (userId, role) VALUES (?, ?)');
  initAdmin.run(process.env.ADMIN_ID, 'admin');
}

// Tạo index cho hiệu suất
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_keys_key ON keys(key);
  CREATE INDEX IF NOT EXISTS idx_keys_userId ON keys(userId);
  CREATE INDEX IF NOT EXISTS idx_keys_hwid ON keys(hwid);
  CREATE INDEX IF NOT EXISTS idx_keys_ip ON keys(ip);
  CREATE INDEX IF NOT EXISTS idx_keys_group ON keys(key_group);
  CREATE INDEX IF NOT EXISTS idx_logs_key ON logs(key);
  CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
`);

// Khởi tạo settings mặc định
const initSettings = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
initSettings.run('ratelimit_attempts', '5');
initSettings.run('ratelimit_minutes', '1');
initSettings.run('autoban_times', '5');
initSettings.run('notify', 'on');
initSettings.run('clientconfig_obfuscate', 'false');
initSettings.run('key_prefix', 'ABC'); // Mặc định prefix là ABC

// Hàm tiện ích
const sendWebhook = async (message) => {
  const notify = db.prepare('SELECT value FROM settings WHERE key = ?').get('notify')?.value;
  if (notify !== 'on') return;
  const webhookUrl = db.prepare('SELECT value FROM settings WHERE key = ?').get('webhook_url')?.value;
  if (!webhookUrl) return;
  try {
    await axios.post(webhookUrl, { content: message });
  } catch (err) {
    console.error('Webhook error:', err);
  }
};

const logAction = db.prepare('INSERT INTO logs (action, userId, key, details) VALUES (?, ?, ?, ?)');
const checkAdmin = (userId, guild) => {
  const admin = db.prepare('SELECT role FROM admins WHERE userId = ?').get(userId);
  if (admin) return true;
  const hasAdmin = db.prepare('SELECT 1 FROM admins WHERE role = ?').get('admin');
  if (!hasAdmin) {
    const mod = db.prepare('SELECT role FROM admins WHERE userId = ? AND role = ?').get(userId, 'mod');
    return !!mod;
  }
  return false;
};

const calculateExpiration = (duration, start = new Date()) => {
  const regex = /^(\d+)([hmdwmy])$/;
  const match = duration.match(regex);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  const date = new Date(start);
  if (unit === 'h') date.setHours(date.getHours() + value);
  if (unit === 'm') date.setMonth(date.getMonth() + value);
  if (unit === 'd') date.setDate(date.getDate() + value);
  if (unit === 'w') date.setDate(date.getDate() + value * 7);
  if (unit === 'y') date.setFullYear(date.getFullYear() + value);
  return date.toISOString();
};

const checkRateLimit = db.prepare(`
  INSERT OR REPLACE INTO ratelimits (ip, key, attempts, lastAttempt)
  VALUES (?, ?, COALESCE((SELECT attempts + 1 FROM ratelimits WHERE ip = ? AND key = ? AND lastAttempt > datetime('now', ? || ' minutes')), 1), ?)
  RETURNING attempts
`);
const isRateLimited = (ip, key) => {
  const settings = db.prepare('SELECT key, value FROM settings WHERE key IN (?, ?)').all('ratelimit_attempts', 'ratelimit_minutes');
  const maxAttempts = parseInt(settings.find(s => s.key === 'ratelimit_attempts')?.value) || 5;
  const minutes = parseInt(settings.find(s => s.key === 'ratelimit_minutes')?.value) || 1;
  const row = checkRateLimit.get(ip, key, ip, key, `-${minutes}`, new Date().toISOString());
  return row.attempts > maxAttempts;
};

// Slash Commands
const commands = [
  new SlashCommandBuilder().setName('gen').setDescription('Tạo key mới')
    .addIntegerOption(opt => opt.setName('quantity').setDescription('Số lượng key').setRequired(true))
    .addStringOption(opt => opt.setName('type').setDescription('Loại key').setRequired(true))
    .addStringOption(opt => opt.setName('duration').setDescription('Thời hạn (e.g., 1h, 1d)').setRequired(true))
    .addStringOption(opt => opt.setName('note').setDescription('Ghi chú').setRequired(false)),
  new SlashCommandBuilder().setName('del').setDescription('Xóa key')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần xóa').setRequired(true)),
  new SlashCommandBuilder().setName('ban').setDescription('Ban key')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần ban').setRequired(true))
    .addStringOption(opt => opt.setName('reason').setDescription('Lý do ban').setRequired(false)),
  new SlashCommandBuilder().setName('unban').setDescription('Gỡ ban key')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần gỡ ban').setRequired(true)),
  new SlashCommandBuilder().setName('expire').setDescription('Chỉnh hạn sử dụng')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần chỉnh').setRequired(true))
    .addStringOption(opt => opt.setName('duration').setDescription('Thời hạn mới').setRequired(true)),
  new SlashCommandBuilder().setName('reset').setDescription('Reset HWID')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần reset').setRequired(true)),
  new SlashCommandBuilder().setName('sethwid').setDescription('Gán HWID')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần gán').setRequired(true))
    .addStringOption(opt => opt.setName('hwid').setDescription('HWID mới').setRequired(true)),
  new SlashCommandBuilder().setName('lock').setDescription('Khóa key')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần khóa').setRequired(true)),
  new SlashCommandBuilder().setName('unlock').setDescription('Mở khóa key')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần mở khóa').setRequired(true)),
  new SlashCommandBuilder().setName('regen').setDescription('Tạo lại key')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần tạo lại').setRequired(true)),
  new SlashCommandBuilder().setName('check').setDescription('Xem thông tin key')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần xem').setRequired(true)),
  new SlashCommandBuilder().setName('list').setDescription('Liệt kê tất cả key'),
  new SlashCommandBuilder().setName('search').setDescription('Tìm key')
    .addStringOption(opt => opt.setName('query').setDescription('UserID, HWID, hoặc IP').setRequired(true)),
  new SlashCommandBuilder().setName('whois').setDescription('Xem ai dùng key')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần xem').setRequired(true)),
  new SlashCommandBuilder().setName('bind').setDescription('Gán key cho user')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần gán').setRequired(true))
    .addUserOption(opt => opt.setName('user').setDescription('User cần gán').setRequired(true)),
  new SlashCommandBuilder().setName('unbind').setDescription('Bỏ gán key')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần bỏ gán').setRequired(true)),
  new SlashCommandBuilder().setName('mykeys').setDescription('Xem key của user'),
  new SlashCommandBuilder().setName('limit').setDescription('Giới hạn số lần dùng')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần giới hạn').setRequired(true))
    .addIntegerOption(opt => opt.setName('uses').setDescription('Số lần tối đa').setRequired(true)),
  new SlashCommandBuilder().setName('trust').setDescription('Thêm HWID/IP vào trustlist')
    .addStringOption(opt => opt.setName('value').setDescription('HWID hoặc IP').setRequired(true)),
  new SlashCommandBuilder().setName('block').setDescription('Chặn IP')
    .addStringOption(opt => opt.setName('ip').setDescription('IP cần chặn').setRequired(true)),
  new SlashCommandBuilder().setName('autoban').setDescription('Set autoban')
    .addIntegerOption(opt => opt.setName('times').setDescription('Số lần sai HWID/IP').setRequired(true)),
  new SlashCommandBuilder().setName('ratelimit').setDescription('Set rate limit')
    .addIntegerOption(opt => opt.setName('attempts').setDescription('Số lần').setRequired(true))
    .addIntegerOption(opt => opt.setName('minutes').setDescription('Thời gian (phút)').setRequired(true)),
  new SlashCommandBuilder().setName('stats').setDescription('Xem thống kê hệ thống'),
  new SlashCommandBuilder().setName('topusers').setDescription('Xem top user'),
  new SlashCommandBuilder().setName('usage').setDescription('Xem lịch sử sử dụng key')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần xem').setRequired(true)),
  new SlashCommandBuilder().setName('actives').setDescription('Xem key đang hoạt động'),
  new SlashCommandBuilder().setName('inactive').setDescription('Xem key không hoạt động')
    .addIntegerOption(opt => opt.setName('days').setDescription('Số ngày không dùng').setRequired(true)),
  new SlashCommandBuilder().setName('type').setDescription('Set loại key')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần set').setRequired(true))
    .addStringOption(opt => opt.setName('type').setDescription('Loại key').setRequired(true)),
  new SlashCommandBuilder().setName('feature').setDescription('Thêm feature cho key')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần thêm').setRequired(true))
    .addStringOption(opt => opt.setName('feature').setDescription('Feature').setRequired(true)),
  new SlashCommandBuilder().setName('plan').setDescription('Set plan cho key')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần set').setRequired(true))
    .addStringOption(opt => opt.setName('plan').setDescription('Plan').setRequired(true)),
  new SlashCommandBuilder().setName('testkey').setDescription('Test key')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần test').setRequired(true)),
  new SlashCommandBuilder().setName('simulate').setDescription('Giả lập auth')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần giả lập').setRequired(true))
    .addStringOption(opt => opt.setName('hwid').setDescription('HWID giả lập').setRequired(true)),
  new SlashCommandBuilder().setName('clientconfig').setDescription('Lấy client config'),
  new SlashCommandBuilder().setName('clientconfig_obfuscate').setDescription('Bật/tắt obfuscate clientconfig')
    .addStringOption(opt => opt.setName('status').setDescription('on/off').setRequired(true)),
  new SlashCommandBuilder().setName('admin').setDescription('Quản lý admin/mod')
    .addSubcommand(sub => sub.setName('add').setDescription('Thêm admin/mod')
      .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
      .addStringOption(opt => opt.setName('role').setDescription('admin/mod').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Xóa admin/mod')
      .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(sub => sub.setName('list').setDescription('Liệt kê admin/mod')),
  new SlashCommandBuilder().setName('tag').setDescription('Thêm tag cho key')
    .addStringOption(opt => opt.setName('key').setDescription('Key cần thêm').setRequired(true))
    .addStringOption(opt => opt.setName('tag').setDescription('Tag').setRequired(true)),
  new SlashCommandBuilder().setName('group').setDescription('Tạo nhóm key')
    .addStringOption(opt => opt.setName('name').setDescription('Tên nhóm').setRequired(true))
    .addStringOption(opt => opt.setName('description').setDescription('Mô tả').setRequired(true)),
  new SlashCommandBuilder().setName('groupstats').setDescription('Xem thống kê nhóm')
    .addStringOption(opt => opt.setName('name').setDescription('Tên nhóm').setRequired(true)),
  new SlashCommandBuilder().setName('export').setDescription('Xuất key')
    .addStringOption(opt => opt.setName('format').setDescription('csv/json').setRequired(true)),
  new SlashCommandBuilder().setName('backup').setDescription('Sao lưu keys'),
  new SlashCommandBuilder().setName('restore').setDescription('Khôi phục keys'),
  new SlashCommandBuilder().setName('notify').setDescription('Bật/tắt notify')
    .addStringOption(opt => opt.setName('status').setDescription('on/off').setRequired(true)),
  new SlashCommandBuilder().setName('setwebhook').setDescription('Set webhook URL')
    .addStringOption(opt => opt.setName('url').setDescription('Webhook URL').setRequired(true)),
  new SlashCommandBuilder().setName('setprefix').setDescription('Set prefix cho key')
    .addStringOption(opt => opt.setName('prefix').setDescription('Prefix (e.g., ABC)').setRequired(true)),
];

// Đăng ký commands
client.on('ready', async () => {
  console.log(`Bot ready as ${client.user.tag}`);
  await client.application.commands.set(commands);
});

// Xử lý commands
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  const { commandName, options, user, guild } = interaction;
  await interaction.deferReply();

  const isAdmin = checkAdmin(user.id, guild);
  const isAdminOrMod = isAdmin || checkAdmin(user.id, guild);
  if (!isAdminOrMod && !['mykeys', 'clientconfig'].includes(commandName)) {
    return interaction.editReply('Chỉ admin/mod dùng được lệnh này!');
  }

  const getKey = db.prepare('SELECT * FROM keys WHERE key = ?');
  const updateKey = db.prepare('UPDATE keys SET status = ?, userId = ?, hwid = ?, ip = ?, expiresAt = ?, usageCount = ?, maxUses = ?, note = ?, tags = ?, key_group = ?, features = ?, plan = ? WHERE key = ?');

if (commandName === 'gen') {
  if (!isAdmin) return interaction.editReply('Chỉ admin dùng được!');
  const quantity = options.getInteger('quantity');
  const type = options.getString('type');
  const duration = options.getString('duration');
  const note = options.getString('note') || '';
  const regex = /^(\d+)([hmdwmy])$/;
  if (!regex.test(duration)) {
    return interaction.editReply('Duration không hợp lệ! Vui lòng nhập dạng <số><đơn vị>, ví dụ: 1h, 2d, 1m, 1w, 1y');
  }
  const expiresAt = calculateExpiration(duration);
  if (!expiresAt) {
    return interaction.editReply('Duration không hợp lệ! Vui lòng nhập dạng <số><đơn vị>, ví dụ: 1h, 2d, 1m, 1w, 1y');
  }
  const prefix = db.prepare('SELECT value FROM settings WHERE key = ?').get('key_prefix')?.value || 'ABC';
  const keys = [];
  const insertKey = db.prepare('INSERT INTO keys (key, type, duration, note, expiresAt) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < quantity; i++) {
    const key = `${prefix}-${uuidv4()}`;
    insertKey.run(key, type, duration, note, expiresAt);
    keys.push(key);
    logAction.run('gen', user.id, key, `Type: ${type}, Duration: ${duration}, Note: ${note}`);
    sendWebhook(`Key generated: \`${key}\` (Type: ${type}, Duration: ${duration}) by ${user.tag}`);
  }
  return interaction.editReply(`Đã tạo ${quantity} key:\n${keys.map(k => `\`${k}\``).join('\n')}`);
}

  if (commandName === 'del') {
    const key = options.getString('key');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    db.prepare('DELETE FROM keys WHERE key = ?').run(key);
    logAction.run('del', user.id, key, '');
    sendWebhook(`Key deleted: \`${key}\` by ${user.tag}`);
    return interaction.editReply(`Đã xóa key: \`${key}\``);
  }

  if (commandName === 'ban') {
    const key = options.getString('key');
    const reason = options.getString('reason') || 'No reason';
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    updateKey.run('banned', row.userId, row.hwid, row.ip, row.expiresAt, row.usageCount, row.maxUses, row.note, row.tags, row.key_group, row.features, row.plan, key);
    logAction.run('ban', user.id, key, `Reason: ${reason}`);
    sendWebhook(`Key banned: \`${key}\` by ${user.tag} (Reason: ${reason})`);
    return interaction.editReply(`Đã ban key: \`${key}\``);
  }

  if (commandName === 'unban') {
    const key = options.getString('key');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    updateKey.run('active', row.userId, row.hwid, row.ip, row.expiresAt, row.usageCount, row.maxUses, row.note, row.tags, row.key_group, row.features, row.plan, key);
    logAction.run('unban', user.id, key, '');
    sendWebhook(`Key unbanned: \`${key}\` by ${user.tag}`);
    return interaction.editReply(`Đã gỡ ban key: \`${key}\``);
  }

  if (commandName === 'expire') {
    const key = options.getString('key');
    const duration = options.getString('duration');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    const expiresAt = calculateExpiration(duration);
    if (!expiresAt) return interaction.editReply('Duration không hợp lệ!');
    updateKey.run(row.status, row.userId, row.hwid, row.ip, expiresAt, row.usageCount, row.maxUses, row.note, row.tags, row.key_group, row.features, row.plan, key);
    logAction.run('expire', user.id, key, `New duration: ${duration}`);
    sendWebhook(`Key \`${key}\` expiry set to ${duration} by ${user.tag}`);
    return interaction.editReply(`Đã set expiry cho key: \`${key}\``);
  }

  if (commandName === 'reset') {
    const key = options.getString('key');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    updateKey.run(row.status, row.userId, null, row.ip, row.expiresAt, row.usageCount, row.maxUses, row.note, row.tags, row.key_group, row.features, row.plan, key);
    logAction.run('reset', user.id, key, '');
    sendWebhook(`Key \`${key}\` HWID reset by ${user.tag}`);
    return interaction.editReply(`Đã reset HWID key: \`${key}\``);
  }

  if (commandName === 'sethwid') {
    const key = options.getString('key');
    const hwid = options.getString('hwid');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    updateKey.run(row.status, row.userId, hwid, row.ip, row.expiresAt, row.usageCount, row.maxUses, row.note, row.tags, row.key_group, row.features, row.plan, key);
    logAction.run('sethwid', user.id, key, `HWID: ${hwid}`);
    sendWebhook(`Key \`${key}\` set HWID ${hwid} by ${user.tag}`);
    return interaction.editReply(`Đã gán HWID cho key: \`${key}\``);
  }

  if (commandName === 'lock') {
    const key = options.getString('key');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    updateKey.run('locked', row.userId, row.hwid, row.ip, row.expiresAt, row.usageCount, row.maxUses, row.note, row.tags, row.key_group, row.features, row.plan, key);
    logAction.run('lock', user.id, key, '');
    sendWebhook(`Key \`${key}\` locked by ${user.tag}`);
    return interaction.editReply(`Đã khóa key: \`${key}\``);
  }

  if (commandName === 'unlock') {
    const key = options.getString('key');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    updateKey.run('active', row.userId, row.hwid, row.ip, row.expiresAt, row.usageCount, row.maxUses, row.note, row.tags, row.key_group, row.features, row.plan, key);
    logAction.run('unlock', user.id, key, '');
    sendWebhook(`Key \`${key}\` unlocked by ${user.tag}`);
    return interaction.editReply(`Đã mở khóa key: \`${key}\``);
  }

  if (commandName === 'regen') {
    const key = options.getString('key');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    const prefix = db.prepare('SELECT value FROM settings WHERE key = ?').get('key_prefix')?.value || 'ABC';
    const newKey = `${prefix}-${uuidv4()}`;
    db.prepare('INSERT INTO keys (key, type, userId, hwid, ip, status, createdAt, expiresAt, duration, usageCount, maxUses, note, tags, key_group, features, plan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      newKey, row.type, row.userId, row.hwid, row.ip, row.status, new Date().toISOString(), row.expiresAt, row.duration, row.usageCount, row.maxUses, row.note, row.tags, row.key_group, row.features, row.plan
    );
    db.prepare('DELETE FROM keys WHERE key = ?').run(key);
    logAction.run('regen', user.id, key, `New key: ${newKey}`);
    sendWebhook(`Key \`${key}\` regenerated to \`${newKey}\` by ${user.tag}`);
    return interaction.editReply(`Đã tạo lại key: \`${newKey}\``);
  }

  if (commandName === 'check') {
    const key = options.getString('key');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    const embed = new EmbedBuilder()
      .setTitle('Key Info')
      .addFields(
        { name: 'Key', value: `\`${row.key}\`` },
        { name: 'Type', value: row.type },
        { name: 'Status', value: `\`${row.status}\`` },
        { name: 'UserID', value: row.userId || 'None' },
        { name: 'HWID', value: row.hwid || 'None' },
        { name: 'IP', value: row.ip || 'None' },
        { name: 'Created At', value: row.createdAt },
        { name: 'Expires At', value: row.expiresAt ? `\`${row.expiresAt}\`` : '`Not set`' },
        { name: 'Usage Count', value: row.usageCount.toString() },
        { name: 'Max Uses', value: row.maxUses.toString() },
        { name: 'Note', value: row.note || 'None' },
        { name: 'Tags', value: row.tags },
        { name: 'Group', value: row.key_group || 'None' },
        { name: 'Features', value: row.features },
        { name: 'Plan', value: row.plan || 'None' }
      );
    return interaction.editReply({ embeds: [embed] });
  }

  if (commandName === 'list') {
    const rows = db.prepare('SELECT key, status, expiresAt FROM keys').all();
    if (!rows.length) return interaction.editReply('Không có key nào!');
    const embed = new EmbedBuilder()
      .setTitle('Danh sách key')
      .setDescription(rows.map(r => `\`${r.key}\` (Status: \`${r.status}\`, Expires: \`${r.expiresAt || 'Not set'}\`)`).join('\n') || 'No data');
    return interaction.editReply({ embeds: [embed] });
  }

  if (commandName === 'search') {
    const query = options.getString('query');
    const rows = db.prepare('SELECT key, status, expiresAt FROM keys WHERE userId = ? OR hwid = ? OR ip = ?').all(query, query, query);
    if (!rows.length) return interaction.editReply('Không tìm thấy key!');
    const embed = new EmbedBuilder()
      .setTitle('Kết quả tìm kiếm')
      .setDescription(rows.map(r => `\`${r.key}\` (Status: \`${r.status}\`, Expires: \`${r.expiresAt || 'Not set'}\`)`).join('\n') || 'No data');
    return interaction.editReply({ embeds: [embed] });
  }

  if (commandName === 'whois') {
    const key = options.getString('key');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    const user = row.userId ? await client.users.fetch(row.userId).catch(() => null) : null;
    return interaction.editReply(`Key \`${key}\` thuộc về ${user ? user.tag : 'None'} (Status: \`${row.status}\`, Expires: \`${row.expiresAt || 'Not set'}\`)`);
  }

  if (commandName === 'bind') {
    const key = options.getString('key');
    const user = options.getUser('user');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    updateKey.run(row.status, user.id, row.hwid, row.ip, row.expiresAt, row.usageCount, row.maxUses, row.note, row.tags, row.key_group, row.features, row.plan, key);
    logAction.run('bind', interaction.user.id, key, `User: ${user.tag}`);
    sendWebhook(`Key \`${key}\` bound to ${user.tag} by ${interaction.user.tag}`);
    return interaction.editReply(`Đã gán key \`${key}\` cho ${user.tag}`);
  }

  if (commandName === 'unbind') {
    const key = options.getString('key');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    updateKey.run(row.status, null, row.hwid, row.ip, row.expiresAt, row.usageCount, row.maxUses, row.note, row.tags, row.key_group, row.features, row.plan, key);
    logAction.run('unbind', user.id, key, '');
    sendWebhook(`Key \`${key}\` unbound by ${user.tag}`);
    return interaction.editReply(`Đã bỏ gán key: \`${key}\``);
  }

  if (commandName === 'mykeys') {
    const rows = db.prepare('SELECT key, status, expiresAt FROM keys WHERE userId = ?').all(user.id);
    if (!rows.length) return interaction.editReply('Bạn không có key nào!');
    const embed = new EmbedBuilder()
      .setTitle('Key của bạn')
      .setDescription(rows.map(r => `\`${r.key}\` (Status: \`${r.status}\`, Expires: \`${r.expiresAt || 'Not set'}\`)`).join('\n') || 'No data');
    return interaction.editReply({ embeds: [embed] });
  }

  if (commandName === 'limit') {
    const key = options.getString('key');
    const uses = options.getInteger('uses');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    updateKey.run(row.status, row.userId, row.hwid, row.ip, row.expiresAt, row.usageCount, uses, row.note, row.tags, row.key_group, row.features, row.plan, key);
    logAction.run('limit', user.id, key, `Max uses: ${uses}`);
    sendWebhook(`Key \`${key}\` set max uses ${uses} by ${user.tag}`);
    return interaction.editReply(`Đã set max uses ${uses} cho key: \`${key}\``);
  }

  if (commandName === 'trust') {
    const value = options.getString('value');
    db.prepare('INSERT INTO trustlist (value, type) VALUES (?, ?)').run(value, value.includes('.') ? 'ip' : 'hwid');
    logAction.run('trust', user.id, null, `Value: ${value}`);
    sendWebhook(`Trusted ${value} by ${user.tag}`);
    return interaction.editReply(`Đã thêm ${value} vào trustlist`);
  }

  if (commandName === 'block') {
    const ip = options.getString('ip');
    db.prepare('INSERT INTO blocklist (ip) VALUES (?)').run(ip);
    logAction.run('block', user.id, null, `IP: ${ip}`);
    sendWebhook(`Blocked IP ${ip} by ${user.tag}`);
    return interaction.editReply(`Đã chặn IP: ${ip}`);
  }

  if (commandName === 'autoban') {
    const times = options.getInteger('times');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('autoban_times', times.toString());
    logAction.run('autoban', user.id, null, `Times: ${times}`);
    sendWebhook(`Autoban set to ${times} by ${user.tag}`);
    return interaction.editReply(`Đã set autoban sau ${times} lần sai`);
  }

  if (commandName === 'ratelimit') {
    const attempts = options.getInteger('attempts');
    const minutes = options.getInteger('minutes');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ratelimit_attempts', attempts.toString());
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ratelimit_minutes', minutes.toString());
    logAction.run('ratelimit', user.id, null, `Attempts: ${attempts}, Minutes: ${minutes}`);
    sendWebhook(`Rate limit set to ${attempts}/${minutes}m by ${user.tag}`);
    return interaction.editReply(`Đã set rate limit: ${attempts} lần/${minutes} phút`);
  }

  if (commandName === 'stats') {
    const total = db.prepare('SELECT COUNT(*) as count FROM keys').get().count;
    const active = db.prepare('SELECT COUNT(*) as count FROM keys WHERE status = ?').get('active').count;
    const banned = db.prepare('SELECT COUNT(*) as count FROM keys WHERE status = ?').get('banned').count;
    const expired = db.prepare('SELECT COUNT(*) as count FROM keys WHERE status = ?').get('expired').count;
    const embed = new EmbedBuilder()
      .setTitle('Thống kê hệ thống')
      .addFields(
        { name: 'Tổng key', value: total.toString() },
        { name: 'Key active', value: active.toString() },
        { name: 'Key banned', value: banned.toString() },
        { name: 'Key expired', value: expired.toString() }
      );
    return interaction.editReply({ embeds: [embed] });
  }

  if (commandName === 'topusers') {
    const rows = db.prepare('SELECT userId, COUNT(*) as count FROM keys GROUP BY userId ORDER BY count DESC LIMIT 5').all();
    const embed = new EmbedBuilder().setTitle('Top Users').setDescription(
      rows.map((r, i) => `${i + 1}. <@${r.userId}>: ${r.count} key`).join('\n') || 'No data'
    );
    return interaction.editReply({ embeds: [embed] });
  }

  if (commandName === 'usage') {
    const key = options.getString('key');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    const logs = db.prepare('SELECT * FROM logs WHERE key = ?').all(key);
    if (!logs.length) return interaction.editReply('Không có lịch sử sử dụng!');
    const embed = new EmbedBuilder().setTitle(`Lịch sử key \`${key}\``).setDescription(
      logs.map(r => `[${r.timestamp}] ${r.action}: ${r.details}`).join('\n')
    );
    return interaction.editReply({ embeds: [embed] });
  }

  if (commandName === 'actives') {
    const rows = db.prepare('SELECT key, status, expiresAt FROM keys WHERE status = ?').all('active');
    if (!rows.length) return interaction.editReply('Không có key active!');
    const embed = new EmbedBuilder()
      .setTitle('Key Active')
      .setDescription(rows.map(r => `\`${r.key}\` (Status: \`${r.status}\`, Expires: \`${r.expiresAt || 'Not set'}\`)`).join('\n') || 'No data');
    return interaction.editReply({ embeds: [embed] });
  }

  if (commandName === 'inactive') {
    const days = options.getInteger('days');
    const rows = db.prepare('SELECT key, status, expiresAt FROM keys WHERE status = ? AND createdAt < datetime(?, ?)').all('active', 'now', `-${days} days`);
    if (!rows.length) return interaction.editReply('Không có key không hoạt động!');
    const embed = new EmbedBuilder()
      .setTitle('Key Inactive')
      .setDescription(rows.map(r => `\`${r.key}\` (Status: \`${r.status}\`, Expires: \`${r.expiresAt || 'Not set'}\`)`).join('\n') || 'No data');
    return interaction.editReply({ embeds: [embed] });
  }

  if (commandName === 'type') {
    const key = options.getString('key');
    const type = options.getString('type');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    updateKey.run(row.status, row.userId, row.hwid, row.ip, row.expiresAt, row.usageCount, row.maxUses, row.note, row.tags, row.key_group, row.features, type, key);
    logAction.run('type', user.id, key, `Type: ${type}`);
    sendWebhook(`Key \`${key}\` set type ${type} by ${user.tag}`);
    return interaction.editReply(`Đã set type ${type} cho key: \`${key}\``);
  }

  if (commandName === 'feature') {
    const key = options.getString('key');
    const feature = options.getString('feature');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    const features = JSON.parse(row.features);
    if (!features.includes(feature)) features.push(feature);
    updateKey.run(row.status, row.userId, row.hwid, row.ip, row.expiresAt, row.usageCount, row.maxUses, row.note, row.tags, row.key_group, JSON.stringify(features), row.plan, key);
    logAction.run('feature', user.id, key, `Feature: ${feature}`);
    sendWebhook(`Key \`${key}\` added feature ${feature} by ${user.tag}`);
    return interaction.editReply(`Đã thêm feature ${feature} cho key: \`${key}\``);
  }

  if (commandName === 'plan') {
    const key = options.getString('key');
    const plan = options.getString('plan');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    updateKey.run(row.status, row.userId, row.hwid, row.ip, row.expiresAt, row.usageCount, row.maxUses, row.note, row.tags, row.key_group, row.features, plan, key);
    logAction.run('plan', user.id, key, `Plan: ${plan}`);
    sendWebhook(`Key \`${key}\` set plan ${plan} by ${user.tag}`);
    return interaction.editReply(`Đã set plan ${plan} cho key: \`${key}\``);
  }

  if (commandName === 'testkey') {
    const key = options.getString('key');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    if (row.status !== 'active') return interaction.editReply(`Key \`${key}\` không active!`);
    if (row.expiresAt && new Date(row.expiresAt) < new Date()) return interaction.editReply(`Key \`${key}\` đã hết hạn!`);
    return interaction.editReply(`Key \`${key}\` hợp lệ!`);
  }

  if (commandName === 'simulate') {
    const key = options.getString('key');
    const hwid = options.getString('hwid');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    if (row.status !== 'active') return interaction.editReply(`Key \`${key}\` không active!`);
    if (row.expiresAt && new Date(row.expiresAt) < new Date()) return interaction.editReply(`Key \`${key}\` đã hết hạn!`);
    if (row.hwid && row.hwid !== hwid) {
      const autobanTimes = parseInt(db.prepare('SELECT value FROM settings WHERE key = ?').get('autoban_times')?.value) || 5;
      const attempts = db.prepare('SELECT attempts FROM ratelimits WHERE key = ?').get(key)?.attempts || 0;
      if (attempts + 1 >= autobanTimes) {
        updateKey.run('banned', row.userId, row.hwid, row.ip, row.expiresAt, row.usageCount, row.maxUses, row.note, row.tags, row.key_group, row.features, row.plan, key);
        logAction.run('autoban', user.id, key, `HWID mismatch: ${hwid}`);
        sendWebhook(`Key \`${key}\` autobanned (HWID mismatch) by ${user.tag}`);
        return interaction.editReply(`Key \`${key}\` đã bị ban do sai HWID quá ${autobanTimes} lần!`);
      }
      db.prepare('INSERT OR REPLACE INTO ratelimits (ip, key, attempts, lastAttempt) VALUES (?, ?, ?, ?)').run('simulate', key, attempts + 1, new Date().toISOString());
      return interaction.editReply(`HWID không khớp! Thử lại ${autobanTimes - attempts - 1} lần trước khi ban.`);
    }
    updateKey.run(row.status, row.userId, row.hwid || hwid, row.ip, row.expiresAt, row.usageCount + 1, row.maxUses, row.note, row.tags, row.key_group, row.features, row.plan, key);
    logAction.run('simulate', user.id, key, `HWID: ${hwid}`);
    sendWebhook(`Simulated auth for key \`${key}\` with HWID ${hwid} by ${user.tag}`);
    return interaction.editReply(`Auth thành công cho key \`${key}\`!`);
  }

  if (commandName === 'clientconfig') {
    const config = { version: '1.0', features: ['ghost', 'tele', 'xray'] };
    const obfuscate = db.prepare('SELECT value FROM settings WHERE key = ?').get('clientconfig_obfuscate')?.value === 'true';
    const result = obfuscate ? Buffer.from(JSON.stringify(config)).toString('base64') : config;
    logAction.run('clientconfig', user.id, null, `Obfuscate: ${obfuscate}`);
    sendWebhook(`Client config requested by ${user.tag} (Obfuscate: ${obfuscate})`);
    return interaction.editReply({ content: JSON.stringify(result) });
  }

  if (commandName === 'clientconfig_obfuscate') {
    const status = options.getString('status');
    if (!['on', 'off'].includes(status)) return interaction.editReply('Status phải là on/off!');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('clientconfig_obfuscate', status === 'on' ? 'true' : 'false');
    logAction.run('clientconfig_obfuscate', user.id, null, `Status: ${status}`);
    sendWebhook(`Client config obfuscate set to ${status} by ${user.tag}`);
    return interaction.editReply(`Đã set clientconfig obfuscate: ${status}`);
  }

  if (commandName === 'admin') {
    const subcommand = options.getSubcommand();
    if (subcommand === 'add') {
      if (!isAdmin) return interaction.editReply('Chỉ admin dùng được!');
      const user = options.getUser('user');
      const role = options.getString('role');
      if (!['admin', 'mod'].includes(role)) return interaction.editReply('Role phải là admin/mod!');
      db.prepare('INSERT OR REPLACE INTO admins (userId, role) VALUES (?, ?)').run(user.id, role);
      logAction.run('admin_add', interaction.user.id, null, `User: ${user.tag}, Role: ${role}`);
      sendWebhook(`Added ${role} ${user.tag} by ${interaction.user.tag}`);
      return interaction.editReply(`Đã thêm ${user.tag} làm ${role}`);
    }
    if (subcommand === 'remove') {
      if (!isAdmin) return interaction.editReply('Chỉ admin dùng được!');
      const user = options.getUser('user');
      db.prepare('DELETE FROM admins WHERE userId = ?').run(user.id);
      logAction.run('admin_remove', interaction.user.id, null, `User: ${user.tag}`);
      sendWebhook(`Removed admin/mod ${user.tag} by ${interaction.user.tag}`);
      return interaction.editReply(`Đã xóa admin/mod ${user.tag}`);
    }
    if (subcommand === 'list') {
      const rows = db.prepare('SELECT * FROM admins').all();
      if (!rows.length) return interaction.editReply('Không có admin/mod!');
      const embed = new EmbedBuilder().setTitle('Danh sách Admin/Mod').setDescription(
        rows.map(r => `<@${r.userId}>: ${r.role}`).join('\n')
      );
      return interaction.editReply({ embeds: [embed] });
    }
  }

  if (commandName === 'tag') {
    const key = options.getString('key');
    const tag = options.getString('tag');
    const row = getKey.get(key);
    if (!row) return interaction.editReply('Key không tồn tại!');
    const tags = JSON.parse(row.tags);
    if (!tags.includes(tag)) tags.push(tag);
    updateKey.run(row.status, row.userId, row.hwid, row.ip, row.expiresAt, row.usageCount, row.maxUses, row.note, JSON.stringify(tags), row.key_group, row.features, row.plan, key);
    logAction.run('tag', user.id, key, `Tag: ${tag}`);
    sendWebhook(`Key \`${key}\` added tag ${tag} by ${user.tag}`);
    return interaction.editReply(`Đã thêm tag ${tag} cho key: \`${key}\``);
  }

  if (commandName === 'group') {
    if (!isAdmin) return interaction.editReply('Chỉ admin dùng được!');
    const name = options.getString('name');
    const description = options.getString('description');
    db.prepare('INSERT INTO groups (name, description) VALUES (?, ?)').run(name, description);
    logAction.run('group', user.id, null, `Name: ${name}, Description: ${description}`);
    sendWebhook(`Group ${name} created by ${user.tag}`);
    return interaction.editReply(`Đã tạo nhóm ${name}`);
  }

  if (commandName === 'groupstats') {
    const name = options.getString('name');
    const count = db.prepare('SELECT COUNT(*) as count FROM keys WHERE key_group = ?').get(name).count;
    const rows = db.prepare('SELECT key, status, expiresAt FROM keys WHERE key_group = ?').all(name);
    const embed = new EmbedBuilder()
      .setTitle(`Thống kê nhóm ${name}`)
      .addFields({ name: 'Số key', value: count.toString() })
      .setDescription(rows.length ? rows.map(r => `\`${r.key}\` (Status: \`${r.status}\`, Expires: \`${r.expiresAt || 'Not set'}\`)`).join('\n') : 'No keys');
    return interaction.editReply({ embeds: [embed] });
  }

  if (commandName === 'setprefix') {
    if (!isAdmin) return interaction.editReply('Chỉ admin dùng được!');
    const prefix = options.getString('prefix');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('key_prefix', prefix);
    logAction.run('setprefix', user.id, null, `Prefix: ${prefix}`);
    sendWebhook(`Key prefix set to ${prefix} by ${user.tag}`);
    return interaction.editReply(`Đã set prefix cho key: ${prefix}`);
  }

  if (commandName === 'export') {
    const format = options.getString('format');
    if (!['csv', 'json'].includes(format)) return interaction.editReply('Format phải là csv/json!');
    const rows = db.prepare('SELECT * FROM keys').all();
    let fileContent;
    if (format === 'csv') {
      fileContent = 'key,type,status,userId,hwid,ip,createdAt,expiresAt,usageCount,maxUses,note,tags,key_group,features,plan\n' +
        rows.map(r => `${r.key},${r.type},${r.status},${r.userId || ''},${r.hwid || ''},${r.ip || ''},${r.createdAt},${r.expiresAt || ''},${r.usageCount},${r.maxUses},${r.note || ''},${r.tags},${r.key_group || ''},${r.features},${r.plan || ''}`).join('\n');
    } else {
      fileContent = JSON.stringify(rows, null, 2);
    }
    const file = new AttachmentBuilder(Buffer.from(fileContent), { name: `export.${format}` });
    logAction.run('export', user.id, null, `Format: ${format}`);
    sendWebhook(`Exported keys (${format}) by ${user.tag}`);
    return interaction.editReply({ files: [file] });
  }

  if (commandName === 'backup') {
    const rows = db.prepare('SELECT * FROM keys').all();
    const fileContent = JSON.stringify(rows, null, 2);
    fs.writeFileSync('backup.json', fileContent);
    const file = new AttachmentBuilder(Buffer.from(fileContent), { name: 'backup.json' });
    logAction.run('backup', user.id, null, '');
    sendWebhook(`Backup created by ${user.tag}`);
    return interaction.editReply({ files: [file] });
  }

  if (commandName === 'restore') {
    if (!isAdmin) return interaction.editReply('Chỉ admin dùng được!');
    if (!fs.existsSync('backup.json')) return interaction.editReply('File backup.json không tồn tại!');
    const data = JSON.parse(fs.readFileSync('backup.json'));
    db.prepare('DELETE FROM keys').run();
    const insertKey = db.prepare('INSERT INTO keys (key, type, userId, hwid, ip, status, createdAt, expiresAt, duration, usageCount, maxUses, note, tags, key_group, features, plan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    data.forEach(row => insertKey.run(row.key, row.type, row.userId, row.hwid, row.ip, row.status, row.createdAt, row.expiresAt, row.duration, row.usageCount, row.maxUses, row.note, row.tags, row.key_group || row.group, row.features, row.plan));
    logAction.run('restore', user.id, null, '');
    sendWebhook(`Keys restored by ${user.tag}`);
    return interaction.editReply('Đã khôi phục keys từ backup.json!');
  }

  if (commandName === 'notify') {
    if (!isAdmin) return interaction.editReply('Chỉ admin dùng được!');
    const status = options.getString('status');
    if (!['on', 'off'].includes(status)) return interaction.editReply('Status phải là on/off!');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('notify', status);
    logAction.run('notify', user.id, null, `Status: ${status}`);
    sendWebhook(`Notify set to ${status} by ${user.tag}`);
    return interaction.editReply(`Đã set notify: ${status}`);
  }

  if (commandName === 'setwebhook') {
    if (!isAdmin) return interaction.editReply('Chỉ admin dùng được!');
    const url = options.getString('url');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('webhook_url', url);
    logAction.run('setwebhook', user.id, null, `URL: ${url}`);
    sendWebhook(`Webhook URL set to ${url} by ${user.tag}`);
    return interaction.editReply(`Đã set webhook URL: ${url}`);
  }
});

// API
const checkApiKey = (req, res, next) => {
  const apiKey = req.header('X-API-Key');
  if (!apiKey || apiKey !== process.env.API_KEY) return res.status(403).json({ error: 'Invalid API key' });
  next();
};

const checkBlocklist = (req, res, next) => {
  const ip = req.ip;
  if (db.prepare('SELECT 1 FROM blocklist WHERE ip = ?').get(ip)) return res.status(403).json({ error: 'IP blocked' });
  next();
};

app.get('/', (req, res) => res.status(404).send('Cannot GET /'));

app.post(process.env.API_AUTH_ENDPOINT, checkApiKey, checkBlocklist, async (req, res) => {
  const { key, hwid, ip } = req.body;
  if (!key || !hwid || !ip) return res.status(400).json({ error: 'Missing key/hwid/ip' });
  if (await isRateLimited(ip, key)) return res.status(429).json({ error: 'Rate limit exceeded' });
  const row = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
  if (!row) return res.status(400).json({ error: 'Invalid key' });
  if (row.status !== 'active') return res.status(400).json({ error: `Key ${row.status}` });
  if (row.expiresAt && new Date(row.expiresAt) < new Date()) return res.status(400).json({ error: 'Key expired' });
  if (row.maxUses !== -1 && row.usageCount >= row.maxUses) return res.status(400).json({ error: 'Max uses reached' });
  if (row.hwid && row.hwid !== hwid) {
    const autobanTimes = parseInt(db.prepare('SELECT value FROM settings WHERE key = ?').get('autoban_times')?.value) || 5;
    const attempts = db.prepare('SELECT attempts FROM ratelimits WHERE key = ?').get(key)?.attempts || 0;
    if (attempts + 1 >= autobanTimes) {
      updateKey.run('banned', row.userId, row.hwid, row.ip, row.expiresAt, row.usageCount, row.maxUses, row.note, row.tags, row.key_group, row.features, row.plan, key);
      logAction.run('autoban', null, key, `HWID mismatch: ${hwid}`);
      sendWebhook(`Key \`${key}\` autobanned (HWID mismatch)`);
      return res.status(400).json({ error: 'Key banned due to HWID mismatch' });
    }
    db.prepare('INSERT OR REPLACE INTO ratelimits (ip, key, attempts, lastAttempt) VALUES (?, ?, ?, ?)').run(ip, key, attempts + 1, new Date().toISOString());
    return res.status(400).json({ error: `HWID mismatch! ${autobanTimes - attempts - 1} attempts left` });
  }
  if (!row.expiresAt && row.duration) {
    const expiresAt = calculateExpiration(row.duration);
    updateKey.run(row.status, row.userId, hwid, ip, expiresAt, row.usageCount + 1, row.maxUses, row.note, row.tags, row.key_group, row.features, row.plan, key);
  } else {
    updateKey.run(row.status, row.userId, hwid, ip, row.expiresAt, row.usageCount + 1, row.maxUses, row.note, row.tags, row.key_group, row.features, row.plan, key);
  }
  logAction.run('auth', null, key, `HWID: ${hwid}, IP: ${ip}`);
  sendWebhook(`Key \`${key}\` authenticated (HWID: ${hwid}, IP: ${ip})`);
  res.json({ status: 'success', keyData: row });
});

app.post(process.env.API_CHECKHWID_ENDPOINT, checkApiKey, checkBlocklist, async (req, res) => {
  const { key, hwid } = req.body;
  if (!key || !hwid) return res.status(400).json({ error: 'Missing key/hwid' });
  if (await isRateLimited(req.ip, key)) return res.status(429).json({ error: 'Rate limit exceeded' });
  const row = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
  if (!row) return res.status(400).json({ error: 'Invalid key' });
  logAction.run('checkhwid', null, key, `HWID: ${hwid}`);
  res.json({ valid: row.hwid === hwid });
});

app.post(process.env.API_RESET_ENDPOINT, checkApiKey, checkBlocklist, async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Missing key' });
  if (await isRateLimited(req.ip, key)) return res.status(429).json({ error: 'Rate limit exceeded' });
  const row = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
  if (!row) return res.status(400).json({ error: 'Invalid key' });
  updateKey.run(row.status, row.userId, null, row.ip, row.expiresAt, row.usageCount, row.maxUses, row.note, row.tags, row.key_group, row.features, row.plan, key);
  logAction.run('reset', null, key, '');
  sendWebhook(`Key \`${key}\` HWID reset via API`);
  res.json({ status: 'success' });
});

app.get(process.env.API_PING_ENDPOINT, checkApiKey, checkBlocklist, (req, res) => {
  logAction.run('ping', null, null, '');
  res.json({ status: 'online' });
});

app.post(process.env.API_RESTORE_ENDPOINT, checkApiKey, checkBlocklist, (req, res) => {
  const data = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'Invalid backup data' });
  db.prepare('DELETE FROM keys').run();
  const insertKey = db.prepare('INSERT INTO keys (key, type, userId, hwid, ip, status, createdAt, expiresAt, duration, usageCount, maxUses, note, tags, key_group, features, plan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  data.forEach(row => insertKey.run(row.key, row.type, row.userId, row.hwid, row.ip, row.status, row.createdAt, row.expiresAt, row.duration, row.usageCount, row.maxUses, row.note, row.tags, row.key_group || row.group, row.features, row.plan));
  logAction.run('restore', null, null, 'Via API');
  sendWebhook('Keys restored via API');
  res.json({ status: 'success' });
});

// Cron jobs
cron.schedule('* * * * *', () => {
  db.prepare('UPDATE keys SET status = ? WHERE status = ? AND expiresAt <= datetime(\'now\')').run('expired', 'active');
  logAction.run('cron_expire', null, null, '');
  sendWebhook('Cron: Expired keys updated');
});

cron.schedule('0 * * * *', () => {
  const rows = db.prepare(`SELECT key FROM keys WHERE status = ? AND expiresAt <= datetime('now', '+24 hours')`).all('active');
  if (rows.length) sendWebhook(`Keys expiring soon: ${rows.map(r => `\`${r.key}\``).join(', ')}`);
});

cron.schedule('0 0 * * *', () => {
  db.prepare(`DELETE FROM logs WHERE timestamp < datetime('now', '-30 days')`).run();
  logAction.run('cron_clean_logs', null, null, '');
  sendWebhook('Cron: Cleaned old logs');
});
app.listen(process.env.PORT || 5000, () => console.log('API running'));
client.login(process.env.DISCORD_TOKEN);