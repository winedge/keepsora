const { customAlphabet } = require('nanoid');

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8);

function slugify(title) {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
  return `${base || 'event'}-${nanoid()}`;
}

module.exports = { slugify };
