const crypto = require('crypto');

// Constant-time string compare. Hashing both inputs first means the
// timingSafeEqual call always compares equal-length buffers, so it works even
// when `a` and `b` differ in length (timingSafeEqual itself throws on that).
function safeEqual(a, b) {
  const bufA = crypto.createHash('sha256').update(String(a)).digest();
  const bufB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { safeEqual };
