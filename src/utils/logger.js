/**
 * Logger Utility
 * ---------------
 * Provides structured, timestamped console logging.
 * Colour-coded for easy scanning during development.
 */

const COLOURS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  grey: '\x1b[90m',
};

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const logger = {
  info(message) {
    console.log(
      `${COLOURS.grey}[${timestamp()}]${COLOURS.reset} ${COLOURS.cyan}ℹ INFO${COLOURS.reset}  ${message}`
    );
  },

  success(message) {
    console.log(
      `${COLOURS.grey}[${timestamp()}]${COLOURS.reset} ${COLOURS.green}✔ OK${COLOURS.reset}    ${message}`
    );
  },

  warn(message) {
    console.warn(
      `${COLOURS.grey}[${timestamp()}]${COLOURS.reset} ${COLOURS.yellow}⚠ WARN${COLOURS.reset}  ${message}`
    );
  },

  error(message, err) {
    console.error(
      `${COLOURS.grey}[${timestamp()}]${COLOURS.reset} ${COLOURS.red}✖ ERROR${COLOURS.reset} ${message}`
    );
    if (err) {
      console.error(`  └─ ${err.stack || err.message || err}`);
    }
  },
};

module.exports = logger;
