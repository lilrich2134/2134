const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../database');

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    const user = db.prepare('SELECT id, email, name, role, is_approved, requested_role, approval_status, wallet_balance, referral_code, phone, default_recipient, notification_prefs, last_login, language, (transaction_pin IS NOT NULL) as has_pin, deletion_pending FROM users WHERE id = ? AND (is_deleted IS NULL OR is_deleted = 0)').get(decoded.userId);
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Allow admins always; allow users who are approved or awaiting a role-change upgrade
    const blockedStatuses = ['pending', 'denied'];
    if (user.role !== 'admin' && blockedStatuses.includes(user.approval_status)) {
      return res.status(403).json({ 
        error: 'Account pending approval',
        status: user.approval_status 
      });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  const allowed = roles.flat();
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
}

module.exports = { authenticateToken, requireRole };
