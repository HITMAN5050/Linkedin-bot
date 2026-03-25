/**
 * CSV Service
 * ---------------
 * Handles reading the posts CSV, finding the next pending post,
 * and safely updating the status after a successful publish.
 */

const fs = require('fs');
const path = require('path');
const csvParser = require('csv-parser');
const { createObjectCsvWriter } = require('csv-writer');
const logger = require('../utils/logger');
const { config } = require('../config/env');

/**
 * Read all rows from the posts CSV file.
 * @returns {Promise<Array<Object>>} array of post objects
 */
function readPosts() {
  return new Promise((resolve, reject) => {
    const posts = [];
    fs.createReadStream(config.paths.csv)
      .pipe(csvParser())
      .on('data', (row) => posts.push(row))
      .on('end', () => {
        logger.info(`Loaded ${posts.length} rows from CSV`);
        resolve(posts);
      })
      .on('error', (err) => {
        logger.error('Failed to read CSV', err);
        reject(err);
      });
  });
}

/**
 * Find the first post with status === "pending".
 * @param {Array<Object>} posts
 * @returns {{ post: Object, index: number } | null}
 */
function getNextPending(posts) {
  const index = posts.findIndex(
    (p) => (p.status || '').trim().toLowerCase() === 'pending'
  );
  if (index === -1) return null;
  return { post: posts[index], index };
}

/**
 * Mark a post as "posted" and rewrite the entire CSV.
 * Uses csv-writer to preserve column structure.
 * @param {Array<Object>} posts – full array (already mutated)
 * @param {number} index – index of the post to update
 */
async function markAsPosted(posts, index) {
  posts[index].status = 'posted';

  const csvWriter = createObjectCsvWriter({
    path: config.paths.csv,
    header: [
      { id: 'Day', title: 'Day' },
      { id: 'Category', title: 'Category' },
      { id: 'Reddit Title', title: 'Reddit Title' },
      { id: 'Post Body', title: 'Post Body' },
      { id: 'Link', title: 'Link' },
      { id: 'Image', title: 'Image' },
      { id: 'status', title: 'status' },
    ],
  });

  await csvWriter.writeRecords(posts);
  logger.success(`CSV updated — row ${index + 1} marked as "posted"`);
}

module.exports = { readPosts, getNextPending, markAsPosted };
