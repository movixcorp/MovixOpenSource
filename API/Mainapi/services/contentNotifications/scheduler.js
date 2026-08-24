const cluster = require('cluster');
const crypto = require('crypto');
const { runContentNotificationScan } = require('./runner');

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const RUN_LOCK_TTL_MS = 2 * 60 * 60 * 1000;

function getParisClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
  };
}

async function releaseRedisLock(redis, key, token) {
  if (!redis || typeof redis.eval !== 'function') return;
  await redis.eval(
    `if redis.call('get', KEYS[1]) == ARGV[1] then
       return redis.call('del', KEYS[1])
     end
     return 0`,
    1,
    key,
    token,
  ).catch(() => {});
}

function startContentNotificationScheduler({ pool, redis, logger = console, runScan = runContentNotificationScan } = {}) {
  if (process.env.CONTENT_NOTIFICATIONS_ENABLED === 'false') {
    logger.info('[ContentNotifications] Planificateur désactivé par configuration');
    return () => {};
  }

  let stopped = false;
  let running = false;
  const locallyCompleted = new Set();

  const tick = async () => {
    if (stopped || running) return;
    const clock = getParisClock();
    const configuredHour = Number(process.env.CONTENT_NOTIFICATIONS_RUN_HOUR);
    const runHour = Number.isFinite(configuredHour)
      ? Math.max(0, Math.min(23, Math.trunc(configuredHour)))
      : 9;
    if (clock.hour < runHour) return;

    const doneKey = `content-notifications:done:${clock.date}`;
    const lockKey = `content-notifications:lock:${clock.date}`;
    const token = `${process.pid}:${crypto.randomUUID()}`;
    let locked = false;

    try {
      if (redis && typeof redis.get === 'function' && typeof redis.set === 'function') {
        if (await redis.get(doneKey)) return;
        locked = (await redis.set(lockKey, token, 'PX', RUN_LOCK_TTL_MS, 'NX')) === 'OK';
        if (!locked) return;
      } else {
        // En cluster, un seul worker exécute le fallback sans Redis.
        if (cluster.worker && cluster.worker.id !== 1) return;
        if (locallyCompleted.has(clock.date)) return;
        locked = true;
      }

      running = true;
      await runScan({ pool, redis, logger });
      locallyCompleted.add(clock.date);
      if (redis && typeof redis.set === 'function') {
        await redis.set(doneKey, String(Date.now()), 'EX', 3 * 24 * 60 * 60);
      }
    } catch (error) {
      logger.error(`[ContentNotifications] Échec du scan quotidien: ${error.stack || error.message}`);
    } finally {
      running = false;
      if (locked) await releaseRedisLock(redis, lockKey, token);
    }
  };

  const initialTimer = setTimeout(tick, 30000);
  const interval = setInterval(tick, CHECK_INTERVAL_MS);
  initialTimer.unref?.();
  interval.unref?.();

  return () => {
    stopped = true;
    clearTimeout(initialTimer);
    clearInterval(interval);
  };
}

module.exports = {
  CHECK_INTERVAL_MS,
  getParisClock,
  releaseRedisLock,
  startContentNotificationScheduler,
};
