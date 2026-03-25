/**
 * Delay Utility
 * ---------------
 * Provides random delays and human-like typing simulation
 * to avoid detection by LinkedIn's anti-automation systems.
 */

/**
 * Sleep for a random duration between min and max seconds.
 * @param {number} minSec – minimum delay in seconds
 * @param {number} maxSec – maximum delay in seconds
 * @returns {Promise<void>}
 */
function randomDelay(minSec, maxSec) {
  const ms = Math.floor(
    Math.random() * (maxSec - minSec) * 1000 + minSec * 1000
  );
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Type text into a page element one character at a time with
 * random inter-keystroke delays to mimic human typing.
 * @param {import('puppeteer').Page} page
 * @param {string} text – the string to type
 * @param {number} [minMs=30] – minimum per-char delay in ms
 * @param {number} [maxMs=120] – maximum per-char delay in ms
 */
async function humanType(page, text, minMs = 30, maxMs = 120) {
  for (const char of text) {
    await page.keyboard.type(char, {
      delay: Math.floor(Math.random() * (maxMs - minMs) + minMs),
    });
  }
}

module.exports = { randomDelay, humanType };
