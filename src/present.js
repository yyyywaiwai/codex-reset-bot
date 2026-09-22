import { pathToFileURL } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';
import { LANGS } from './i18n.js';

const API = 'https://codex-resets.com';
const TIBO = 'America/Los_Angeles';
export const PAGE_SIZE = 3;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', middot: '·', rarr: '→' };

function decodeHtml(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()] ?? match;
    return String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  });
}

export function formatZoned(iso, timeZone, t) {
  return new Intl.DateTimeFormat(t.locale, {
    timeZone,
    month: 'short',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

function tiboZone(iso) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TIBO, timeZoneName: 'short' })
    .formatToParts(new Date(iso))
    .find((part) => part.type === 'timeZoneName')?.value ?? 'PT';
}

export function timesBlock(iso, t, { deadline = false } = {}) {
  const wrap = (value) => (deadline ? t.until(value) : value);
  return [
    `${t.zoneLabel}　${wrap(`**${formatZoned(iso, t.zone, t)}**`)}`,
    `${t.tiboLabel}　${wrap(`**${formatZoned(iso, TIBO, t)}**${t.paren(tiboZone(iso))}`)}`,
  ].join('\n');
}

export function relativeTime(iso, t, now = Date.now()) {
  const min = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (min < 1) return t.justNow;
  const format = new Intl.RelativeTimeFormat(t.locale);
  if (min < 60) return format.format(-min, 'minute');
  const hour = Math.floor(min / 60);
  if (hour < 24) return format.format(-hour, 'hour');
  return format.format(-Math.floor(hour / 24), 'day');
}

export function countdown(iso, t, now = Date.now()) {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return t.overdue;
  const min = Math.floor(ms / 60000);
  const [d, h, m] = t.units;
  const parts = [[Math.floor(min / 1440), d], [Math.floor((min % 1440) / 60), h], [min % 60, m]];
  const first = parts.findIndex(([value]) => value > 0);
  const shown = first === -1 ? [parts[2]] : parts.slice(first, first + 2);
  return t.within(shown.map(([value, unit]) => `${value}${unit}`).join(t.unitSep));
}

export function longestWaitDays(resets) {
  const times = resets.map((reset) => new Date(reset.announced_at).getTime()).sort((a, b) => a - b);
  let max = 0;
  for (let i = 1; i < times.length; i++) max = Math.max(max, times[i] - times[i - 1]);
  return max ? Math.round((max / 86400000) * 10) / 10 : null;
}

function daysLabel(value, t) {
  return value == null ? '—' : t.days(Math.round(value * 10) / 10);
}

function typeLabel(resetType, t) {
  return t[resetType] ?? resetType;
}

function clip(text, max) {
  const flat = text.replace(/\s+\n/g, '\n').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function quote(text) {
  return text.split('\n').map((line) => `> ${line || '\u200b'}`).join('\n');
}

function linkLine(reset, t) {
  return reset.source?.url ? `🔗 [${t.viewPost}](${reset.source.url})` : '';
}

async function request(pathname, accept) {
  const response = await fetch(`${API}${pathname}`, { headers: { accept } });
  if (response.status === 429) {
    const wait = Number(response.headers.get('retry-after') || 5);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    return request(pathname, accept);
  }
  if (!response.ok) throw new Error(`${pathname} ${response.status}`);
  return response;
}

async function getJson(pathname) {
  return (await request(pathname, 'application/json')).json();
}

async function fetchTranslations(lang) {
  const path = LANGS[lang].path;
  if (!path) return new Map();
  const html = await (await request(`/${path}`, 'text/html')).text();
  const pattern = /<li class="log-item" data-tweet-id="([^"]+)">[\s\S]*?<p class="log-item-text" data-role="tweet-display-text">([\s\S]*?)<\/p>/g;
  return new Map([...html.matchAll(pattern)].map(([, id, text]) => [id, decodeHtml(text)]));
}

export async function fetchBoard(lang, now = Date.now()) {
  const [status, translations] = await Promise.all([getJson('/api/v1/status'), fetchTranslations(lang)]);
  const resets = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ limit: '100', order: 'asc' });
    if (cursor) query.set('cursor', cursor);
    const page = await getJson(`/api/v1/resets?${query}`);
    resets.push(...page.data);
    cursor = page.pagination.has_more ? page.pagination.next_cursor : null;
  } while (cursor);
  const localize = (reset) => reset && { ...reset, text: translations.get(reset.id) ?? reset.text };
  const localized = resets.map(localize).sort((a, b) => new Date(a.announced_at) - new Date(b.announced_at));
  const { latest_reset: latest, scheduled_reset: scheduled, active_watch: watch, stats } = status.data;
  return {
    lang,
    latest: localize(latest),
    scheduled,
    watch,
    stats,
    resets: localized,
    longest: longestWaitDays(resets),
    fetchedAt: now,
  };
}

function scheduledText(scheduled, watch, t, now) {
  const lines = [`## ${t.scheduled}`];
  if (scheduled) {
    lines.push(`**${scheduled.scheduled_for ? countdown(scheduled.scheduled_for, t, now) : t.noTime}**　${typeLabel(scheduled.reset_type, t)}`);
    if (scheduled.scheduled_for) lines.push('', timesBlock(scheduled.scheduled_for, t, { deadline: true }));
    if (scheduled.text) lines.push('', quote(clip(scheduled.text, 280)));
    lines.push(linkLine(scheduled, t));
  } else {
    lines.push(t.noSchedule);
  }
  if (watch) {
    const chance = watch.reset_chance_percent == null ? '' : t.paren(`${watch.reset_chance_percent}%`);
    lines.push('', `**${t.watch(watch.level === 'strong' ? t.strong : t.elevated)}${chance}**`);
    if (watch.forecast_window) lines.push(`🗓️ ${watch.forecast_window}`);
    if (watch.text) lines.push(quote(clip(watch.text, 240)));
  }
  return lines.join('\n');
}

function latestText(latest, t, now) {
  if (!latest) return `## ${t.latest}\n${t.noRecord}`;
  return [
    `## ${t.latest}`,
    `**🕒 ${relativeTime(latest.announced_at, t, now)}**　${typeLabel(latest.reset_type, t)}`,
    '',
    timesBlock(latest.announced_at, t),
  ].join('\n');
}

function statsText(stats, longest, t) {
  return [
    `## ${t.stats}`,
    t.total(stats.total),
    t.avg(daysLabel(stats.avg_interval_days, t)),
    t.longest(daysLabel(longest, t)),
  ].join('\n');
}

function noticeText(latest, t, now) {
  if (!latest) return `## ${t.notice}\n${t.noNotice}`;
  return [
    `## ${t.notice}`,
    `${typeLabel(latest.reset_type, t)}　🕒 ${relativeTime(latest.announced_at, t, now)}`,
    '',
    timesBlock(latest.announced_at, t),
    '',
    quote(clip(latest.text, 700)),
    linkLine(latest, t),
  ].join('\n');
}

function text(content) {
  return new TextDisplayBuilder().setContent(content);
}

function separator() {
  return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
}

export function dashboardContainer(board) {
  const t = LANGS[board.lang];
  const now = board.fetchedAt;
  const site = `https://codex-resets.com/${LANGS[board.lang].path}`;
  return new ContainerBuilder()
    .setAccentColor(0xc9893a)
    .addTextDisplayComponents(text(`# ${t.title}\n-# ${t.source(`[codex-resets.com](${site})`)}`))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(text(scheduledText(board.scheduled, board.watch, t, now)))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(text(latestText(board.latest, t, now)))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(text(statsText(board.stats, board.longest, t)))
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL('attachment://history.png'),
    ))
    .addTextDisplayComponents(text(noticeText(board.latest, t, now)))
    .addActionRowComponents(new ActionRowBuilder().setComponents(
      new ButtonBuilder().setCustomId('history:0').setEmoji('📜').setLabel(t.historyButton).setStyle(ButtonStyle.Primary),
    ));
}

export function historyComponents(board, page) {
  const t = LANGS[board.lang];
  const newest = [...board.resets].reverse();
  const pages = Math.max(1, Math.ceil(newest.length / PAGE_SIZE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const items = newest.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const cards = items.length
    ? items.map((reset) => announcementContainer(reset, t))
    : [new ContainerBuilder().addTextDisplayComponents(text(t.emptyHistory))];
  const row = new ActionRowBuilder().setComponents(
    new ButtonBuilder().setCustomId(`history:${current - 1}`).setLabel(t.prev).setStyle(ButtonStyle.Secondary).setDisabled(current === 0),
    new ButtonBuilder().setCustomId('history:page').setLabel(`📄 ${current + 1} / ${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`history:${current + 1}`).setLabel(t.next).setStyle(ButtonStyle.Secondary).setDisabled(current === pages - 1),
  );
  return [...cards, row];
}

export function announcementContainer(reset, t, roleId) {
  const heading = roleId
    ? `<@&${roleId}>\n## ${t.announced}\n${typeLabel(reset.reset_type, t)}`
    : `### ${typeLabel(reset.reset_type, t)}`;
  const content = [
    heading,
    timesBlock(reset.announced_at, t),
    '',
    quote(clip(reset.text, 3500)),
    linkLine(reset, t),
  ].join('\n');
  return new ContainerBuilder()
    .setAccentColor(reset.reset_type === 'banked' ? 0xe7b39a : 0xff7424)
    .addTextDisplayComponents(text(content.length > 4000 ? `${content.slice(0, 3999)}…` : content));
}

function utcDay(value) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function monday(day) {
  const weekday = new Date(day).getUTCDay();
  return day - ((weekday + 6) % 7) * 86400000;
}

function dayTypes(resets) {
  const types = new Map();
  for (const reset of resets) {
    const day = reset.announced_at.slice(0, 10);
    if (reset.reset_type === 'banked' || !types.has(day)) types.set(day, reset.reset_type);
  }
  return types;
}

function fillRound(ctx, x, y, w, h, radius, color) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fillStyle = color;
  ctx.fill();
}

export function renderHistoryPng(resets, lang, now = new Date()) {
  const t = LANGS[lang];
  const font = `"${t.font}", sans-serif`;
  const types = dayTypes(resets);
  const today = utcDay(now);
  const start = monday(utcDay(resets[0]?.announced_at ?? now));
  const end = monday(today) + 6 * 86400000;
  const weeks = Math.round((monday(today) - start) / (7 * 86400000)) + 1;
  const cell = 16;
  const gap = 4;
  const left = 36;
  const gridTop = 72;
  const pad = 18;
  const width = pad + left + weeks * (cell + gap) + pad;
  const height = gridTop + 7 * (cell + gap) + pad;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.roundRect(0, 0, width, height, 16);
  ctx.clip();
  ctx.fillStyle = '#231c16';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#f4efe8';
  ctx.font = `bold 18px ${font}`;
  ctx.fillText(t.chartTitle, pad, 34);

  const legend = [
    ['#ff7424', '#fff6ee'],
    ['#f0b090', '#fff6ee'],
    ['#4a4038', '#6d6258'],
  ];
  let legendX = pad + ctx.measureText(t.chartTitle).width + 18;
  ctx.font = `13px ${font}`;
  legend.forEach(([fill, stroke], index) => {
    fillRound(ctx, legendX, 20, 14, 14, 4, fill);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.fillStyle = '#e6dcd0';
    ctx.fillText(t.legend[index], legendX + 18, 32);
    legendX += 18 + ctx.measureText(t.legend[index]).width + 14;
  });

  ctx.fillStyle = '#cbbba8';
  ctx.font = `12px ${font}`;
  const weekday = new Intl.DateTimeFormat(t.locale, { weekday: 'short', timeZone: 'UTC' });
  for (const row of [0, 2, 4]) {
    ctx.fillText(weekday.format(start + row * 86400000), pad, gridTop + row * (cell + gap) + 13);
  }

  const month = new Intl.DateTimeFormat(t.locale, { month: 'short', timeZone: 'UTC' });
  let lastLabelX = -100;
  const labelMonth = (x, day) => {
    if (x - lastLabelX < 30) return;
    ctx.fillStyle = '#d9cfc3';
    ctx.fillText(month.format(day), x, gridTop - 8);
    lastLabelX = x;
  };
  for (let week = 0; week < weeks; week++) {
    for (let row = 0; row < 7; row++) {
      const day = start + (week * 7 + row) * 86400000;
      if (day > end) continue;
      const date = new Date(day);
      const kind = day <= today ? types.get(date.toISOString().slice(0, 10)) : undefined;
      const x = pad + left + week * (cell + gap);
      const y = gridTop + row * (cell + gap);
      if ((row === 0 && week === 0) || date.getUTCDate() === 1) labelMonth(x, day);
      const future = day > today;
      const color = future ? '#2a241f' : kind === 'banked' ? '#f0b090' : kind === 'regular' ? '#ff7424' : '#4a4038';
      fillRound(ctx, x, y, cell, cell, 4, color);
      if (future) continue;
      ctx.lineWidth = kind || day === today ? 1.5 : 1;
      ctx.strokeStyle = kind ? '#fff6ee' : day === today ? '#f4efe8' : '#6d6258';
      ctx.stroke();
    }
  }
  return canvas.toBuffer('image/png');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { strict: assert } = await import('node:assert');
  const ja = LANGS.ja;
  const deadline = '2026-09-23T06:59:00.000Z';
  const now = new Date('2026-09-22T16:44:00.000Z').getTime();
  assert.equal(formatZoned(deadline, 'Asia/Tokyo', ja), '9月23日(水) 15:59');
  assert.equal(formatZoned(deadline, TIBO, ja), '9月22日(火) 23:59');
  assert.equal(formatZoned(deadline, 'UTC', LANGS.en), 'Wed, Sep 23, 06:59');
  assert.equal(countdown(deadline, ja, now), '⏳ 遅くとも あと14時間15分');
  assert.equal(countdown(deadline, LANGS.ko, now), '⏳ 늦어도 14시간 15분 이내');
  assert.equal(countdown(deadline, LANGS.en, now - 2 * 86400000), '⏳ Within 2d 14h at the latest');
  assert.equal(relativeTime('2026-09-12T08:09:17.000Z', ja, now), '10 日前');
  assert.equal(relativeTime('2026-09-12T08:09:17.000Z', LANGS.en, now), '10 days ago');
  assert.equal(decodeHtml('a &amp; b &quot;c&quot; &#39;d&#39; &#x2192;'), 'a & b "c" \'d\' →');
  assert.equal(longestWaitDays([
    { announced_at: '2025-12-25T08:01:03.000Z' },
    { announced_at: '2026-03-03T01:50:07.000Z' },
  ]), 67.7);
  for (const lang of Object.keys(LANGS)) {
    const png = renderHistoryPng([
      { announced_at: '2026-03-03T01:50:07.000Z', reset_type: 'regular' },
      { announced_at: '2026-09-05T00:39:25.000Z', reset_type: 'banked' },
    ], lang, new Date('2026-09-23T00:00:00.000Z'));
    assert.equal(png[0], 0x89);
  }
  const reset = (day) => ({ id: day, announced_at: `2026-09-${day}T00:00:00.000Z`, reset_type: 'regular', text: day, source: {} });
  const board = {
    lang: 'ja',
    fetchedAt: now,
    scheduled: null,
    watch: null,
    latest: null,
    stats: { total: 4, avg_interval_days: 6.9 },
    longest: 67.7,
    resets: ['01', '02', '03', '04'].map(reset),
  };
  assert.equal(dashboardContainer(board).toJSON().components.length, 10);
  const first = historyComponents(board, 0);
  assert.equal(first.length, 4);
  assert.match(first[0].toJSON().components[0].content, /> 04/);
  const last = historyComponents(board, 9).at(-1).toJSON();
  assert.equal(last.components[1].label, '📄 2 / 2');
  assert.equal(last.components[0].disabled, false);
  assert.equal(last.components[2].disabled, true);
  console.log('ok');
}
