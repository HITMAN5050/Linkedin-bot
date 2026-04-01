/**
 * Post Job — Orchestrator
 * -------------------------
 * Ties together the CSV service and LinkedIn service into
 * a single "run" function that:
 *   1. Reads the CSV
 *   2. Finds the first pending post
 *   3. Launches the browser & logs in
 *   4. Creates the LinkedIn post
 *   5. Updates the CSV on success
 *
 * Includes a single retry on transient failures.
 */

const path = require('path');
const logger = require('../utils/logger');
const { randomDelay } = require('../utils/delay');
const csvService = require('../services/csv.service');
const linkedin = require('../services/linkedin.service');
const { config } = require('../config/env');

const MAX_RETRIES = 1;

/**
 * Execute the posting job.
 * @returns {Promise<void>}
 */
async function run() {
  logger.info('═══════════════════════════════════════');
  logger.info('LinkedIn Bot — Starting posting job');
  logger.info('═══════════════════════════════════════');

  let browser = null;

  try {
    // ── 1. Read CSV & find the next pending post ──────────────
    const posts = await csvService.readPosts();
    const pending = csvService.getNextPending(posts);

    if (!pending) {
      logger.info('No pending posts found — nothing to do. Exiting gracefully.');
      return;
    }

    const { post, index } = pending;
    const title = post['Reddit Title'] || '';
    const body = post['Post Body'] || '';
    const link = post['Link'] || '';
    const imagePath = (post['Image'] || '').trim();

    logger.info(`Selected post #${index + 1}: "${title}"`);

    // ── 2. Add a random delay before starting (10-30 s) ──────
    logger.info('Waiting random delay before launch…');
    await randomDelay(10, 30);

    // ── 3. Launch browser & log in ───────────────────────────
    const session = await linkedin.initBrowser();
    browser = session.browser;
    const page = session.page;

    await linkedin.login(page);

    // ── 4. Create the post (with retry) ──────────────────────
    let posted = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await linkedin.createPost(page, {
          title,
          body,
          link,
          imagePath: imagePath || undefined,
        });
        posted = true;
        break;
      } catch (err) {
        logger.error(`Posting attempt ${attempt + 1} failed`, err);
        await linkedin.takeScreenshot(page, `post_fail_attempt_${attempt + 1}`);

        if (attempt < MAX_RETRIES) {
          logger.info('Retrying in 15 seconds…');
          await randomDelay(15, 20);

          // Reload feed before retry
          try {
            const { config } = require('../config/env');
            const isCompany = !!config.linkedin.companyId;
            const feedUrl = isCompany
              ? `https://www.linkedin.com/company/${config.linkedin.companyId}/admin/feed/posts/`
              : 'https://www.linkedin.com/feed/';
            await page.goto(feedUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 45_000,
            });
          } catch {
            logger.warn('Retry navigation slow — continuing anyway');
          }
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }

    // ── 5. Update CSV only on success ────────────────────────
    if (posted) {
      await csvService.markAsPosted(posts, index);
      logger.success('Posting job completed successfully!');
    } else {
      logger.error('All posting attempts failed — CSV NOT updated.');
    }
  } catch (err) {
    logger.error('Fatal error in posting job', err);
  } finally {
    // ── 6. Graceful shutdown ─────────────────────────────────
    await linkedin.closeBrowser(browser);
    logger.info('Job finished.\n');
  }
}

module.exports = { run };
