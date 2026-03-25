/**
 * LinkedIn Service
 * ------------------
 * All Puppeteer interactions with LinkedIn live here:
 *   - Browser / cookie management
 *   - Login (with captcha / manual fallback)
 *   - Creating a post (text + optional image)
 *   - Screenshot on failure
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const logger = require('../utils/logger');
const { randomDelay, humanType } = require('../utils/delay');
const { config } = require('../config/env');

/**
 * Check whether a URL indicates a logged-in LinkedIn session.
 * LinkedIn can redirect to many different pages after login.
 */
function isLoggedIn(url) {
  const loggedInPaths = ['/feed', '/mynetwork', '/company', '/messaging', '/in/', '/dashboard'];
  return loggedInPaths.some((p) => url.includes(p));
}

// ───────────────────────────────────────────
// Browser & Cookie helpers
// ───────────────────────────────────────────

/**
 * Launch a Puppeteer browser instance with sensible defaults.
 * @returns {Promise<{ browser: import('puppeteer').Browser, page: import('puppeteer').Page }>}
 */
async function initBrowser() {
  const browser = await puppeteer.launch({
    headless: config.headless,
    defaultViewport: { width: 1280, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const page = await browser.newPage();

  // Make the automated browser harder to detect
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // Try to restore a previous session
  await loadCookies(page);

  logger.info('Browser launched');
  return { browser, page };
}

/**
 * Save current page cookies to disk so the next run can skip login.
 */
async function saveCookies(page) {
  try {
    const cookies = await page.cookies();
    fs.writeFileSync(config.paths.cookies, JSON.stringify(cookies, null, 2));
    logger.info('Session cookies saved');
  } catch (err) {
    logger.warn('Could not save cookies — login will be required next time');
  }
}

/**
 * Load cookies from a previous session, if they exist.
 */
async function loadCookies(page) {
  try {
    if (fs.existsSync(config.paths.cookies)) {
      const raw = fs.readFileSync(config.paths.cookies, 'utf-8');
      const cookies = JSON.parse(raw);
      await page.setCookie(...cookies);
      logger.info('Loaded saved session cookies');
    }
  } catch (err) {
    logger.warn('Could not load cookies — will perform fresh login');
  }
}

// ───────────────────────────────────────────
// Login
// ───────────────────────────────────────────

/**
 * Navigate to a URL safely. Uses 'domcontentloaded' to avoid hanging
 * on LinkedIn's heavy network traffic, with a try/catch fallback.
 */
async function safeGoto(page, url, timeoutMs = 60_000) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (err) {
    logger.warn(`Navigation to ${url} didn't fully complete — continuing anyway (current: ${page.url()})`);
  }
  // Small extra wait for JS to settle
  await new Promise((r) => setTimeout(r, 3000));
}

/**
 * Log in to LinkedIn. Handles cookie-based fast path,
 * multiple login page variants, captchas, and manual fallback.
 */
async function login(page) {
  // ── Fast path: try /feed directly (cookies may already work) ──
  logger.info('Checking if already logged in via cookies…');
  await safeGoto(page, 'https://www.linkedin.com/feed/', 45_000);

  if (isLoggedIn(page.url())) {
    logger.success('Already logged in via saved session');
    await takeScreenshot(page, 'login_cookie_success');
    return;
  }

  // ── Not logged in — go to the login page ───────────────────
  logger.info('Not logged in. Navigating to login page…');
  await safeGoto(page, 'https://www.linkedin.com/login', 60_000);

  const landingUrl = page.url();
  logger.info(`Landed on: ${landingUrl}`);
  await takeScreenshot(page, 'login_landing');

  // If LinkedIn redirected us to a logged-in page, great
  if (isLoggedIn(landingUrl)) {
    logger.success('Already logged in (redirect)');
    return;
  }

  // Give the page a moment for JS to render the login form
  await randomDelay(2, 4);

  // ── Locate the username field (multiple selector strategies) ─
  const usernameSelectors = [
    '#username',
    'input[name="session_key"]',
    'input[autocomplete="username"]',
  ];

  let usernameField = null;
  for (const sel of usernameSelectors) {
    try {
      usernameField = await page.waitForSelector(sel, { visible: true, timeout: 5_000 });
      if (usernameField) {
        logger.info(`Found username field via: ${sel}`);
        break;
      }
    } catch {
      // selector not found, try next
    }
  }

  // If no field found, offer manual login fallback
  if (!usernameField) {
    logger.warn(
      'Could not find login form. LinkedIn may have redirected. ' +
      'Please log in manually in the browser window. Waiting 90 s…'
    );
    await takeScreenshot(page, 'login_no_form');
    await new Promise((r) => setTimeout(r, 90_000));

    if (isLoggedIn(page.url())) {
      await saveCookies(page);
      logger.success('Logged in manually');
      return;
    }
    throw new Error('Login failed — could not reach LinkedIn after manual login window.');
  }

  // ── Fill credentials ───────────────────────────────────────
  await usernameField.click({ clickCount: 3 });
  await humanType(page, config.linkedin.email);

  await randomDelay(0.5, 1.5);

  // Find password field (visible only)
  const passwordSelectors = [
    '#password',
    'input[name="session_password"]',
    'input[type="password"]',
  ];

  let passwordField = null;
  for (const sel of passwordSelectors) {
    try {
      passwordField = await page.waitForSelector(sel, { visible: true, timeout: 5_000 });
      if (passwordField) break;
    } catch {
      // try next
    }
  }

  if (!passwordField) {
    throw new Error('Could not find the password field on the login page.');
  }

  await passwordField.click({ clickCount: 3 });
  await humanType(page, config.linkedin.password);

  await randomDelay(1, 2);

  // Click submit
  const submitBtn =
    (await page.$('[type="submit"]')) ||
    (await page.$('button[aria-label="Sign in"]')) ||
    (await page.$('button.btn__primary--large'));

  if (submitBtn) {
    await submitBtn.click();
  } else {
    await page.keyboard.press('Enter');
  }

  // Wait for navigation
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));

  logger.info(`Post-login URL: ${page.url()}`);
  await takeScreenshot(page, 'post_login');

  // ── Handle security challenge / captcha ────────────────────
  if (!isLoggedIn(page.url())) {
    logger.warn(
      'Login challenge detected (captcha / verification). ' +
      'Please complete it manually in the browser window. Waiting 90 s…'
    );
    await new Promise((r) => setTimeout(r, 90_000));

    if (!isLoggedIn(page.url())) {
      throw new Error('Login failed — could not reach LinkedIn after challenge.');
    }
  }

  await saveCookies(page);
  logger.success('Logged in to LinkedIn');
}

// ───────────────────────────────────────────
// Post creation
// ───────────────────────────────────────────

/**
 * Create a new LinkedIn post.
 * @param {import('puppeteer').Page} page
 * @param {{ title: string, body: string, link: string, imagePath?: string }} postData
 */
async function createPost(page, postData) {
  // 1. Always navigate to the feed to ensure we're in the right place
  logger.info('Navigating to LinkedIn feed…');
  await safeGoto(page, 'https://www.linkedin.com/feed/', 45_000);

  if (!page.url().includes('/feed')) {
    logger.warn(`Not on feed (at ${page.url()}). Retrying…`);
    await safeGoto(page, 'https://www.linkedin.com/feed/', 45_000);
  }

  await randomDelay(2, 4);

  // 2. Click "Start a post" — use JS to find element by text content
  logger.info('Opening post composer…');

  let composerOpened = false;

  // Strategy 1: Find by text content (most reliable for current LinkedIn UI)
  const startPostEl = await page.evaluateHandle(() => {
    // Look for the "Start a post" text trigger
    const candidates = document.querySelectorAll('button, div[role="button"], span, a');
    for (const el of candidates) {
      const text = el.textContent?.trim();
      if (text === 'Start a post' || text === 'Start a post, Daksh') {
        return el;
      }
    }
    // Look for the share box container and click its trigger area
    const shareBox = document.querySelector('.share-box-feed-entry__trigger, .share-box-feed-entry__top-bar, [data-urn] .feed-shared-share-box');
    return shareBox || null;
  });

  if (startPostEl && startPostEl.asElement()) {
    await startPostEl.asElement().click();
    composerOpened = true;
    logger.info('Clicked "Start a post" via text match');
  }

  // Strategy 2: CSS selectors fallback
  if (!composerOpened) {
    const fallbackSelectors = [
      'button.share-box-feed-entry__trigger',
      '.share-box-feed-entry__trigger',
      'div.share-box-feed-entry__top-bar',
      '[aria-label="Text editor for creating content"]',
      '.share-creation-state__text-editor',
    ];
    for (const sel of fallbackSelectors) {
      try {
        const el = await page.waitForSelector(sel, { visible: true, timeout: 3_000 });
        if (el) {
          await el.click();
          composerOpened = true;
          logger.info(`Clicked start-post via fallback: ${sel}`);
          break;
        }
      } catch {
        // try next
      }
    }
  }

  if (!composerOpened) {
    await takeScreenshot(page, 'start_post_not_found');
    throw new Error('Could not find the "Start a post" element on the feed.');
  }

  // Wait for the modal / editor to appear (give it extra time)
  await randomDelay(3, 5);

  // 3. Find the text editor inside the modal
  // LinkedIn uses various DOM structures — we try multiple strategies
  logger.info('Looking for text editor in modal…');

  let editorEl = null;

  // Strategy A: CSS selectors (try each with a short timeout)
  const editorSelectors = [
    'div[role="textbox"][contenteditable="true"]',
    'div.ql-editor[contenteditable="true"]',
    'div.ql-editor',
    '[contenteditable="true"][role="textbox"]',
    'div[data-placeholder="What do you want to talk about?"]',
    '.share-creation-state__text-editor div[contenteditable]',
    'div[aria-label="Text editor for creating content"]',
  ];

  for (const sel of editorSelectors) {
    try {
      editorEl = await page.waitForSelector(sel, { visible: true, timeout: 3_000 });
      if (editorEl) {
        logger.info(`Found editor via CSS: ${sel}`);
        break;
      }
    } catch {
      // try next
    }
  }

  // Strategy B: JS-based — find any contenteditable element inside the modal
  if (!editorEl) {
    logger.info('CSS selectors missed — trying JS-based editor search…');
    const handle = await page.evaluateHandle(() => {
      // Find all contenteditable elements
      const editables = document.querySelectorAll('[contenteditable="true"]');
      for (const el of editables) {
        // Must be visible (has dimensions)
        const rect = el.getBoundingClientRect();
        if (rect.width > 100 && rect.height > 50) {
          return el;
        }
      }
      // Fallback: look for the placeholder text container
      const allDivs = document.querySelectorAll('div');
      for (const div of allDivs) {
        const ph = div.getAttribute('data-placeholder') || div.getAttribute('aria-placeholder') || '';
        if (ph.toLowerCase().includes('what do you want')) {
          return div;
        }
      }
      return null;
    });

    if (handle && handle.asElement()) {
      editorEl = handle.asElement();
      logger.info('Found editor via JS search');
    }
  }

  if (!editorEl) {
    await takeScreenshot(page, 'editor_not_found');
    throw new Error('Post editor modal did not appear.');
  }

  await editorEl.click();
  await randomDelay(0.5, 1);

  // 4. Compose the content: Title + Body + Link
  const content = [postData.title, '', postData.body, '', postData.link]
    .filter((line) => line !== undefined && line !== null)
    .join('\n');

  logger.info('Typing post content…');
  await humanType(page, content, 20, 80);
  await randomDelay(1, 2);

  // 5. Optional image upload
  if (postData.imagePath) {
    await uploadImage(page, postData.imagePath);
  }

  await randomDelay(2, 4);

  // 6. Click the Post / Submit button
  logger.info('Submitting post…');
  const postBtnSelector =
    'button.share-actions__primary-action, ' +
    'button[aria-label="Post"], ' +
    'button:has-text("Post")';

  // Try finding the Post button
  const postBtn = await page.waitForSelector(postBtnSelector, { timeout: 10_000 }).catch(() => null);

  if (!postBtn) {
    // Fallback: find any enabled submit-style button in the share modal
    const fallbackBtn = await page.evaluateHandle(() => {
      const buttons = [...document.querySelectorAll('button')];
      return buttons.find(
        (b) =>
          b.textContent.trim().toLowerCase() === 'post' &&
          !b.disabled
      );
    });

    if (fallbackBtn && fallbackBtn.asElement()) {
      await fallbackBtn.asElement().click();
    } else {
      throw new Error('Could not locate the "Post" button.');
    }
  } else {
    await postBtn.click();
  }

  // 7. Wait for modal to close → indicates success
  await randomDelay(4, 6);
  logger.success('Post submitted successfully!');
}

/**
 * Upload an image to the post composer.
 * If the upload fails we log a warning and continue (text-only post).
 */
async function uploadImage(page, relativePath) {
  try {
    const absolutePath = path.isAbsolute(relativePath)
      ? relativePath
      : path.resolve(config.paths.root, relativePath);

    if (!fs.existsSync(absolutePath)) {
      logger.warn(`Image not found: ${absolutePath} — skipping image upload`);
      return;
    }

    logger.info(`Uploading image: ${absolutePath}`);

    // Click the "Add a photo" / media button
    const mediaBtnSelector =
      'button[aria-label="Add a photo"], ' +
      'button[aria-label="Add media"], ' +
      'button[aria-label="Add a photo"]';

    const mediaBtn = await page.waitForSelector(mediaBtnSelector, { timeout: 8_000 }).catch(() => null);

    if (!mediaBtn) {
      // Fallback: look for any image/media icon button
      const fallback = await page.evaluateHandle(() => {
        const btns = [...document.querySelectorAll('button')];
        return btns.find(
          (b) =>
            b.getAttribute('aria-label')?.toLowerCase().includes('photo') ||
            b.getAttribute('aria-label')?.toLowerCase().includes('media') ||
            b.getAttribute('aria-label')?.toLowerCase().includes('image')
        );
      });

      if (fallback && fallback.asElement()) {
        await fallback.asElement().click();
      } else {
        logger.warn('Could not find image upload button — skipping image');
        return;
      }
    } else {
      await mediaBtn.click();
    }

    await randomDelay(1, 2);

    // Find the hidden file input and upload
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) {
      logger.warn('No file input found — skipping image upload');
      return;
    }

    await fileInput.uploadFile(absolutePath);
    logger.info('Image selected — waiting for preview…');

    // Wait for the image preview to render
    await randomDelay(5, 8);
    logger.success('Image uploaded');
  } catch (err) {
    logger.warn('Image upload failed — posting without image');
    logger.error('Image upload error', err);
  }
}

// ───────────────────────────────────────────
// Debugging helpers
// ───────────────────────────────────────────

/**
 * Take a screenshot and save it to the screenshots folder.
 */
async function takeScreenshot(page, label = 'error') {
  try {
    if (!fs.existsSync(config.paths.screenshots)) {
      fs.mkdirSync(config.paths.screenshots, { recursive: true });
    }
    const file = path.join(
      config.paths.screenshots,
      `${label}_${Date.now()}.png`
    );
    await page.screenshot({ path: file, fullPage: true });
    logger.info(`Screenshot saved: ${file}`);
  } catch (err) {
    logger.warn('Could not save screenshot');
  }
}

/**
 * Gracefully close the browser.
 */
async function closeBrowser(browser) {
  try {
    if (browser) {
      await browser.close();
      logger.info('Browser closed');
    }
  } catch (err) {
    logger.warn('Browser close encountered an issue');
  }
}

module.exports = {
  initBrowser,
  login,
  createPost,
  closeBrowser,
  takeScreenshot,
  saveCookies,
};
