/**
 * Express middleware for request logging and DDoS/high-traffic detection.
 * Captures client IP, User-Agent, method, path, response code & duration.
 * Sends batched request logs & instant DDoS alerts to the Wiflix Discord webhook.
 */

const axios = require('axios');

// Webhook URL configuration (supports fallback env variables)
const WIFLIX_WEBHOOK_URL =
  process.env.WIFLIX_WEBHOOK_URL ||
  process.env.WIFLIX_PROXY_BLOCK_WEBHOOK_URL ||
  process.env.DISCORD_WIFLIX_WEBHOOK_URL;

// DDoS detection parameters
const DDOS_THRESHOLD = parseInt(process.env.DDOS_THRESHOLD_REQ || '150', 10);
const DDOS_WINDOW_MS = 10 * 1000; // 10 seconds
const DDOS_COOLDOWN_MS = 60 * 1000; // 1 minute cooldown per IP for alert webhooks

// Batch logging configuration
const BATCH_FLUSH_INTERVAL_MS = 5 * 1000; // Flush logs every 5 seconds
const BATCH_MAX_SIZE = 10; // Max logs per Discord batch embed

// In-memory data structures
const ipTracker = new Map(); // IP -> Array of timestamps
const alertCooldowns = new Map(); // IP -> last alert timestamp
const logBuffer = []; // Array of formatted request log objects

/**
 * Safely extracts the real client IP address.
 */
function getClientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

/**
 * Truncate long string for Discord embed compatibility.
 */
function truncate(str, maxLen = 250) {
  if (!str) return '-';
  const val = String(str);
  return val.length > maxLen ? val.slice(0, maxLen - 3) + '...' : val;
}

/**
 * Sends a payload to the Wiflix Discord Webhook (non-blocking).
 */
async function sendDiscordWebhook(payload) {
  if (!WIFLIX_WEBHOOK_URL) return;
  try {
    await axios.post(WIFLIX_WEBHOOK_URL, payload, {
      timeout: 4000,
      proxy: false,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    // Fail silently to prevent disrupting API responses
  }
}

/**
 * Sends a DDoS / High Traffic alert for an offending IP address.
 */
function triggerDdosAlert(ip, count, country, sampleUa, sampleUrls) {
  const now = Date.now();
  const lastAlert = alertCooldowns.get(ip) || 0;
  if (now - lastAlert < DDOS_COOLDOWN_MS) return; // In cooldown

  alertCooldowns.set(ip, now);

  const reqPerSec = (count / (DDOS_WINDOW_MS / 1000)).toFixed(1);
  const urlsList = sampleUrls.length > 0 ? sampleUrls.slice(0, 5).join('\n') : '-';

  const embed = {
    title: `🚨 ALERTE DDOS / Trafic Suspect — ${ip}`,
    color: 0xff0000, // Red
    description: `Une IP a dépassé le seuil de **${DDOS_THRESHOLD} requêtes / 10s** sur Mainapi.`,
    fields: [
      { name: 'Adresse IP', value: `\`${ip}\``, inline: true },
      { name: 'Pays (CF)', value: String(country || 'N/A'), inline: true },
      { name: 'Volume requêtes', value: `**${count} req** en 10s (${reqPerSec} req/s)`, inline: true },
      { name: 'User-Agent', value: `\`\`\`${truncate(sampleUa, 300)}\`\`\``, inline: false },
      { name: 'Endpoints ciblés (échantillon)', value: `\`\`\`\n${truncate(urlsList, 500)}\`\`\``, inline: false },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Movix Mainapi Security Monitor' },
  };

  sendDiscordWebhook({
    username: 'Movix DDoS Guard',
    embeds: [embed],
  });
}

/**
 * Flushes buffered request logs to Discord as a summary batch embed.
 */
function flushLogBuffer() {
  if (logBuffer.length === 0 || !WIFLIX_WEBHOOK_URL) return;

  const logsToFlush = logBuffer.splice(0, BATCH_MAX_SIZE);
  const lines = logsToFlush.map(
    (l) => `\`[${l.time}]\` **${l.ip}** (${l.country}) — \`${l.method} ${l.url}\` ➡️ \`${l.status}\` (${l.duration}ms)`
  );

  const embed = {
    title: `📋 Logs de requêtes Mainapi (${logsToFlush.length})`,
    color: 0x3498db, // Blue
    description: lines.join('\n').slice(0, 4000),
    timestamp: new Date().toISOString(),
    footer: { text: 'Movix Mainapi Wiflix Monitor' },
  };

  sendDiscordWebhook({
    username: 'Movix Request Logger',
    embeds: [embed],
  });
}

// Periodically flush buffered logs
if (WIFLIX_WEBHOOK_URL) {
  setInterval(flushLogBuffer, BATCH_FLUSH_INTERVAL_MS).unref();
}

/**
 * Cleanup expired IP tracking entries every 30s to prevent memory leaks.
 */
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of ipTracker.entries()) {
    const valid = timestamps.filter((t) => now - t < DDOS_WINDOW_MS);
    if (valid.length === 0) {
      ipTracker.delete(ip);
    } else {
      ipTracker.set(ip, valid);
    }
  }
  for (const [ip, lastTime] of alertCooldowns.entries()) {
    if (now - lastTime > DDOS_COOLDOWN_MS) {
      alertCooldowns.delete(ip);
    }
  }
}, 30 * 1000).unref();

/**
 * Express middleware function.
 */
function requestLoggerMiddleware(req, res, next) {
  const startTime = Date.now();
  const ip = getClientIp(req);
  const country = req.headers['cf-ipcountry'] || req.headers['cf-ip-country'] || 'N/A';
  const ua = req.headers['user-agent'] || 'Unknown';
  const method = req.method;
  const url = req.originalUrl || req.url;

  // Track request frequency for DDoS detection
  const now = Date.now();
  let timestamps = ipTracker.get(ip) || [];
  timestamps = timestamps.filter((t) => now - t < DDOS_WINDOW_MS);
  timestamps.push(now);
  ipTracker.set(ip, timestamps);

  // Check DDoS threshold (default: 150 req/10s)
  if (timestamps.length >= DDOS_THRESHOLD) {
    // Extract recent URLs requested by this IP
    const sampleUrls = [url];
    triggerDdosAlert(ip, timestamps.length, country, ua, sampleUrls);
  }

  // Hook into response finish event
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const status = res.statusCode;
    const timeStr = new Date().toLocaleTimeString('fr-FR');

    // 1. Log to console stdout
    console.log(
      `[REQ LOG] ${ip} (${country}) | ${method} ${url} ${status} (${duration}ms) | UA: ${ua}`
    );

    // 2. Buffer for Discord Webhook
    if (WIFLIX_WEBHOOK_URL) {
      logBuffer.push({
        ip,
        country,
        method,
        url: truncate(url, 60),
        status,
        duration,
        ua,
        time: timeStr,
      });

      // Immediate flush if buffer reaches capacity
      if (logBuffer.length >= BATCH_MAX_SIZE) {
        flushLogBuffer();
      }
    }
  });

  next();
}

module.exports = {
  requestLoggerMiddleware,
  getClientIp,
};
