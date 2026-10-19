const db = require('../db');

function loadUser(req, res, next) {
  req.user = null;
  if (req.session && req.session.userId) {
    const user = db.prepare(`
      SELECT id, email, name, plan, credit_balance_cents, pro_period_start, pro_period_photos_used,
             is_admin, is_suspended, suspended_reason
      FROM users WHERE id = ?
    `).get(req.session.userId);

    if (user && user.is_suspended) {
      // Suspended mid-session: drop them immediately rather than letting an
      // already-logged-in session keep working until it expires.
      req.session = null;
    } else {
      req.user = user || null;
    }
  }
  res.locals.currentUser = req.user;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (!req.user.is_admin) return res.status(404).render('404');
  next();
}

module.exports = { loadUser, requireAuth, requireAdmin };
