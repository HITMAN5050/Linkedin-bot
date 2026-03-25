/**
 * LinkedIn Bot — Entry Point
 * ============================
 * Usage:
 *   node src/index.js          → schedule daily using POST_TIME from .env
 *   node src/index.js --now    → run immediately (single execution)
 *
 * The scheduler uses node-cron to trigger the posting job once
 * per day at the configured time.
 */

const cron = require('node-cron');
const logger = require('./utils/logger');
const { config, validate } = require('./config/env');
const postJob = require('./jobs/post.job');

// ── Validate environment before anything else ────────────────
try {
  validate();
} catch (err) {
  logger.error('Configuration error', err);
  process.exit(1);
}

// ── Determine run mode ───────────────────────────────────────
const runNow = process.argv.includes('--now');

if (runNow) {
  // Immediate, one-shot execution
  logger.info('Running in immediate mode (--now)');
  postJob
    .run()
    .then(() => {
      logger.info('Done.');
      process.exit(0);
    })
    .catch((err) => {
      logger.error('Unhandled error', err);
      process.exit(1);
    });
} else {
  // ── Schedule daily cron job ────────────────────────────────
  const [hour, minute] = config.postTime.split(':');
  const cronExpression = `${minute} ${hour} * * *`;

  logger.info(
    `Scheduler active — will post daily at ${config.postTime} (cron: ${cronExpression})`
  );

  cron.schedule(cronExpression, async () => {
    logger.info('Cron trigger fired');
    await postJob.run();
  });

  // ── Graceful shutdown ──────────────────────────────────────
  const shutdown = (signal) => {
    logger.info(`Received ${signal} — shutting down gracefully`);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
