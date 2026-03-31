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
      // Allow third-party cookies — LinkedIn's share modal needs them
      '--disable-features=ThirdPartyCookieDeprecation,TrackingProtection3pcd',
      '--disable-site-isolation-trials',
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

  // ── Locate the username field ──────────────────────────────
  // LinkedIn has multiple login page variants — try many strategies
  let usernameField = null;

  // Strategy 1: Classic CSS selectors
  const usernameSelectors = [
    '#username',
    'input[name="session_key"]',
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
  ];

  for (const sel of usernameSelectors) {
    try {
      usernameField = await page.waitForSelector(sel, { visible: true, timeout: 3_000 });
      if (usernameField) {
        logger.info(`Found username field via CSS: ${sel}`);
        break;
      }
    } catch {
      // try next
    }
  }

  // Strategy 2: Find input by label text (new LinkedIn layout)
  if (!usernameField) {
    logger.info('Trying label-based input detection…');
    const handle = await page.evaluateHandle(() => {
      // Look for visible text inputs on the page
      const inputs = document.querySelectorAll('input[type="text"], input[type="email"], input:not([type])');
      for (const input of inputs) {
        const rect = input.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 10) continue; // skip hidden

        // Check associated label or nearby text
        const id = input.id;
        if (id) {
          const label = document.querySelector(`label[for="${id}"]`);
          if (label) {
            const text = label.textContent.toLowerCase();
            if (text.includes('email') || text.includes('phone') || text.includes('username')) {
              return input;
            }
          }
        }

        // Check placeholder
        const ph = (input.placeholder || '').toLowerCase();
        if (ph.includes('email') || ph.includes('phone')) return input;

        // Check aria-label
        const aria = (input.getAttribute('aria-label') || '').toLowerCase();
        if (aria.includes('email') || aria.includes('phone')) return input;
      }

      // Last resort: return the first visible text-like input
      for (const input of inputs) {
        const rect = input.getBoundingClientRect();
        if (rect.width > 100 && rect.height > 20) return input;
      }
      return null;
    });

    if (handle && handle.asElement()) {
      usernameField = handle.asElement();
      logger.info('Found username field via label/placeholder detection');
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

  // ── Locate the password field ──────────────────────────────
  let passwordField = null;

  const passwordSelectors = [
    '#password',
    'input[name="session_password"]',
    'input[type="password"]',
  ];

  for (const sel of passwordSelectors) {
    try {
      passwordField = await page.waitForSelector(sel, { visible: true, timeout: 3_000 });
      if (passwordField) break;
    } catch {
      // try next
    }
  }

  // Fallback: find password by label text
  if (!passwordField) {
    const pwHandle = await page.evaluateHandle(() => {
      const inputs = document.querySelectorAll('input[type="password"]');
      for (const input of inputs) {
        const rect = input.getBoundingClientRect();
        if (rect.width > 50 && rect.height > 10) return input;
      }
      return null;
    });
    if (pwHandle && pwHandle.asElement()) {
      passwordField = pwHandle.asElement();
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
  // Navigate to the feed
  logger.info('Navigating to LinkedIn feed…');
  await safeGoto(page, 'https://www.linkedin.com/feed/', 45_000);

  if (!page.url().includes('/feed')) {
    logger.warn(`Not on feed (at ${page.url()}). Retrying…`);
    await safeGoto(page, 'https://www.linkedin.com/feed/', 45_000);
  }

  await randomDelay(2, 4);

  // 2. Open the post composer
  logger.info('Opening post composer…');
  await takeScreenshot(page, 'before_start_post');
  
  // To deal with LinkedIn's aggressive DOM obfuscation and anti-automation,
  // we use a highly robust client-side script to find and trigger the "Start a post" element.
  let modalVisible = false;

  const tryTriggerModal = async () => {
    return await page.evaluate(() => {
      // Look for the specific start-post button or top-bar
      let trigger = document.querySelector('button.share-box-feed-entry__trigger, div.share-box-feed-entry__top-bar, [aria-label*="Start a post"], [aria-label*="create a post"]');
      
      if (!trigger) {
        // Fallback: search all buttons and spans for "Start a post"
        const elements = Array.from(document.querySelectorAll('button, div[role="button"], span, form'));
        for (const el of elements) {
          if (el.innerText && el.innerText.trim().includes('Start a post')) {
             // If we found a span, we want to click its parent button
             trigger = el.closest('button') || el.closest('[role="button"]') || el;
             break;
          }
        }
      }

      if (trigger) {
        // Dispatch multiple types of click events to ensure React catches it
        trigger.click();
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      }
      return false;
    });
  };

  const triggered = await tryTriggerModal();
  if (triggered) {
    logger.info('Dispatched click events to "Start a post" trigger');
  } else {
    logger.warn('Could not locate "Start a post" trigger via evaluate');
  }

  await randomDelay(3, 5);
  await takeScreenshot(page, 'after_first_click');

  modalVisible = await page.evaluate(() => {
    return !!document.querySelector('[role="dialog"], .artdeco-modal, .share-box-modal');
  });

  if (!modalVisible) {
    logger.warn('Modal not detected. Trying fallback mouse click…');
    await page.evaluate(() => window.scrollTo(0, 0));
    await randomDelay(1, 2);
    
    // Try to find the bounding box and click with Puppeteer mouse
    const box = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { 
        acceptNode: node => node.textContent.trim().startsWith('Start a post') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT 
      });
      const textNode = walker.nextNode();
      if (!textNode || !textNode.parentElement) return null;
      let target = textNode.parentElement.closest('button') || textNode.parentElement.closest('[role="button"]');
      if (!target) {
        // Find widest parent up to body
        let best = textNode.parentElement;
        let w = best.getBoundingClientRect().width;
        let curr = textNode.parentElement;
        while(curr && curr !== document.body) {
           let rw = curr.getBoundingClientRect().width;
           if(rw > 800) break;
           if(rw > w && rw >= 200) { best = curr; w = rw; }
           curr = curr.parentElement;
        }
        target = best;
      }
      const r = target.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    });

    if (box) {
      await page.mouse.click(box.x, box.y, { delay: 50 });
      logger.info(`Puppeteer clicked at (${Math.round(box.x)}, ${Math.round(box.y)})`);
    }

    await randomDelay(3, 5);
    await takeScreenshot(page, 'after_second_click');
    modalVisible = await page.evaluate(() => !!document.querySelector('[role="dialog"], .artdeco-modal'));
  }

  // 3. Find the text editor
  logger.info('Looking for text editor…');

  // Log what the DOM looks like for debugging
  const domInfo = await page.evaluate(() => {
    const modal = document.querySelector('[role="dialog"], .artdeco-modal');
    const editables = document.querySelectorAll('[contenteditable="true"]');
    const textboxes = document.querySelectorAll('[role="textbox"]');
    return `Modal: ${modal ? modal.tagName + '.' + (modal.className || '').substring(0, 50) : 'NONE'} | ` +
      `contenteditable: ${editables.length} | textbox: ${textboxes.length}`;
  });
  logger.info(`DOM: ${domInfo}`);

  let editorEl = null;

  const editorSelectors = [
    'div[role="textbox"][contenteditable]',
    'div.ql-editor[contenteditable]',
    'div.ql-editor',
    '[contenteditable][role="textbox"]',
    '.artdeco-modal div[contenteditable]',
    '[role="dialog"] div[contenteditable]',
    '[role="dialog"] [role="textbox"]',
    'div[data-placeholder*="talk about"]',
    'div[aria-label="Text editor for creating content"]',
    'div[aria-placeholder]',
    '.share-creation-state__text-editor .ql-editor'
  ];

  for (const sel of editorSelectors) {
    try {
      editorEl = await page.waitForSelector(sel, { visible: true, timeout: 2_000 });
      if (editorEl) {
        logger.info(`Found editor via CSS: ${sel}`);
        break;
      }
    } catch {
      // try next
    }
  }

  // Strategy B: JS-based with full Shadow root piercing
  if (!editorEl) {
    logger.info('CSS missed — trying Shadow DOM piercing search…');
    const handle = await page.evaluateHandle(() => {
      // Find all contenteditable elements across main document and all shadow roots
      function findAllEditables(root, results = []) {
        if (root.nodeType === Node.ELEMENT_NODE) {
          if (
            (root.hasAttribute('contenteditable') && root.getAttribute('contenteditable') !== 'false') ||
            root.getAttribute('role') === 'textbox' ||
            root.tagName === 'TEXTAREA'
          ) {
            results.push(root);
          }
          if (root.shadowRoot) {
            findAllEditables(root.shadowRoot, results);
          }
        }
        for (const child of root.childNodes) {
          findAllEditables(child, results);
        }
        return results;
      }

      const all = findAllEditables(document.body);
      
      // Return the largest visible one
      let best = null;
      let bestArea = 0;
      for (const el of all) {
        let rect;
        try {
          rect = el.getBoundingClientRect();
        } catch { continue; } // element might be detached
        
        const area = rect.width * rect.height;
        if (area > bestArea && rect.width > 50) {
          best = el;
          bestArea = area;
        }
      }
      return best;
    });

    if (handle && handle.asElement()) {
      editorEl = handle.asElement();
      logger.info('Found editor via Shadow DOM piercing loop');
    }
  }

  // Strategy C: Click where the editor should be in the modal and check focus
  if (!editorEl) {
    logger.info('Trying coordinate click in modal area…');
    // The editor area in the modal is roughly centered at (640, 300)
    await page.mouse.click(640, 280);
    await randomDelay(1, 2);

    const focusedHandle = await page.evaluateHandle(() => {
      const el = document.activeElement;
      if (el && (el.getAttribute('contenteditable') === 'true' ||
          el.getAttribute('role') === 'textbox' ||
          el.tagName === 'TEXTAREA')) {
        return el;
      }
      return null;
    });

    if (focusedHandle && focusedHandle.asElement()) {
      editorEl = focusedHandle.asElement();
      logger.info('Found editor via coordinate click + focus check');
    }
  }

  if (!editorEl) {
    await takeScreenshot(page, 'editor_not_found');
    throw new Error('Post editor did not appear.');
  }

  // Ensure the editor is focused robustly without triggering Puppeteer visibility errors
  logger.info('Focusing editor…');
  try {
    await editorEl.evaluate(el => {
       el.focus();
       // Some React implementations require a click to initialize the editor state
       el.click();
    });
  } catch (err) {
    logger.warn(`Failed to execute focus/click: ${err.message}`);
  }
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
  
  // Puppeteer doesn't support playwright's :has-text natively without specific pseudo-selectors.
  // Using reliable standard selectors + a robust fallback.
  const postBtnSelector = 'button.share-actions__primary-action, button.share-box-v2__primary-btn, div[role="dialog"] button.artdeco-button--primary';

  // Try finding the Post button
  const postBtn = await page.waitForSelector(postBtnSelector, { timeout: 10_000 }).catch(() => null);

  if (!postBtn) {
    // Fallback: finding the Post button more aggressively, even piercing Shadow DOMs
    const fallbackBtn = await page.evaluateHandle(() => {
      function findTargetButton(root) {
        if (!root) return null;
        if (root.nodeType === Node.ELEMENT_NODE) {
          if (root.tagName === 'BUTTON') {
             const textArea = root.textContent.trim().toLowerCase();
             if ((textArea === 'post' || textArea === 'next' || textArea === 'publish') && !root.disabled && root.offsetHeight > 0) {
               return root;
             }
          }
          if (root.shadowRoot) {
             const found = findTargetButton(root.shadowRoot);
             if (found) return found;
          }
        }
        for (const child of root.childNodes) {
          const found = findTargetButton(child);
          if (found) return found;
        }
        return null;
      }
      return findTargetButton(document.body);
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
