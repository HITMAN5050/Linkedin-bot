/**
 * Environment Configuration
 * -------------------------
 * Loads and validates all required environment variables.
 * Centralises config so every other module imports from here.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const config = {
  linkedin: {
    email: process.env.LINKEDIN_EMAIL,
    password: process.env.LINKEDIN_PASSWORD,
  },
  postTime: process.env.POST_TIME || '10:00',
  headless: process.env.HEADLESS === 'true',
  paths: {
    root: path.resolve(__dirname, '../..'),
    data: path.resolve(__dirname, '../../data'),
    csv: path.resolve(__dirname, '../../data/posts.csv'),
    images: path.resolve(__dirname, '../../images'),
    cookies: path.resolve(__dirname, '../../cookies.json'),
    screenshots: path.resolve(__dirname, '../../screenshots'),
  },
};

/**
 * Validate that essential configuration values are present.
 * Throws early so the user knows what to fix.
 */
function validate() {
  if (!config.linkedin.email || !config.linkedin.password) {
    throw new Error(
      'Missing LINKEDIN_EMAIL or LINKEDIN_PASSWORD in .env file. ' +
      'Please fill in your credentials before running the bot.'
    );
  }

  const timeRegex = /^\d{1,2}:\d{2}$/;
  if (!timeRegex.test(config.postTime)) {
    throw new Error(
      `Invalid POST_TIME "${config.postTime}". Use HH:MM format (e.g. 10:00).`
    );
  }
}

module.exports = { config, validate };
