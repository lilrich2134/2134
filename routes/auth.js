const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const config = require('../config');
const { authenticateToken } = require('../middleware/auth');
const emailService = require('../services/emailService');
const whatsappService = require('../services/whatsappService');

const router = express.Router();

function generateReferralCode() {
  return 'REF' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Public endpoint — returns branding info (no auth required)
router.get('/app-info', (req, res) => {
  try {
    const version = db.prepare("SELECT value FROM system_settings WHERE key = 'app_version'").get();
    const name    = db.prepare("SELECT value FROM system_settings WHERE key = 'app_name'").get();
    const tagline = db.prepare("SELECT value FROM system_settings WHERE key = 'app_tagline'").get();
    res.json({
      version: version?.value  || '1.0.0',
      name:    name?.value     || 'KT-Hub Premium',
      tagline: tagline?.value  || 'Ghana Data Bundle Marketplace'
    });
  } catch (e) {
    res.json({ version: '1.0.0', name: 'KT-Hub Premium', tagline: 'Ghana Data Bundle Marketplace' });
  }
});

router.post('/signup', async (req, res) => {
  try {
    const config = require('../config');
    if (config.system?.registrationEnabled === false) {
      return res.status(403).json({ error: 'New registrations are currently closed. Please try again later.' });
    }

    const { email, password, name, phone, role = 'customer', referralCode, deviceFingerprint } = req.body;
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!email || !password || !name || !phone) {
      return res.status(400).json({ error: 'Email, password, name, and phone are required' });
    }

    // Input length limits
    if (email.length > 254)    return res.status(400).json({ error: 'Email address is too long' });
    if (name.length > 100)     return res.status(400).json({ error: 'Name is too long (max 100 chars)' });
    if (phone.length > 20)     return res.status(400).json({ error: 'Phone number is too long' });
    if (password.length < 8)   return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (password.length > 128) return res.status(400).json({ error: 'Password is too long' });

    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address format' });
    }

    // Strip HTML tags from name to prevent stored XSS
    const safeName = name.replace(/<[^>]*>/g, '').trim();

    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Anti-Abuse: Check for multiple accounts from same IP/Device
    const duplicateCheck = db.prepare('SELECT COUNT(*) as count FROM users WHERE signup_ip = ? OR (device_fingerprint = ? AND device_fingerprint IS NOT NULL)').get(ip, deviceFingerprint);
    
    // Threshold 1: >3 accounts from same IP/Device
    const isSuspicious = duplicateCheck.count >= 3;
    let flagReason = isSuspicious ? 'Multiple accounts from same IP/Device' : null;

    // Threshold 2: >10 referrals in 24 hours per referrer
    if (referralCode) {
      const referrer = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(referralCode);
      if (referrer) {
        const recentRefs = db.prepare("SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ? AND created_at > datetime('now', '-1 day')").get(referrer.id);
        if (recentRefs.count >= 10) {
          flagReason = flagReason ? `${flagReason}, Too many referrals in 24h` : 'Too many referrals in 24h';
        }
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    const userReferralCode = generateReferralCode();
    let referredBy = null;

    if (referralCode) {
      const referrer = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(referralCode);
      if (referrer) {
        referredBy = referrer.id;
      }
    }

    // Insert the user FIRST so the referral foreign key is satisfied
    db.prepare(`
      INSERT INTO users (id, email, password, name, phone, role, is_approved, wallet_balance, referral_code, referred_by, approval_status, signup_ip, device_fingerprint, is_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, email.toLowerCase().trim(), hashedPassword, safeName, phone, role, 0, 0, userReferralCode, referredBy, 'pending', ip, deviceFingerprint, 0);

    // Now create the referral record (referred_id exists in DB)
    if (referredBy) {
      db.prepare(`
        INSERT INTO referrals (id, referrer_id, referred_id, status, bonus_amount, flag_reason)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), referredBy, userId, flagReason ? 'flagged' : 'pending', config.system.referralBonusGhs || 2.00, flagReason);

      if (flagReason) {
        console.log(`[ANTI-ABUSE] Flagged suspicious referral: Referrer=${referredBy}, Referred=${userId}, Reason=${flagReason}`);
      }
    }

    emailService.sendApprovalNotification(email, safeName, 'signup');
    whatsappService.sendApprovalNotification(email, safeName, 'signup');

    db.prepare(`
      INSERT INTO notifications (id, user_id, title, message, type)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), userId, 'Welcome to KT-Hub!', 'Your account has been created successfully. Await admin approval before purchasing.', 'success');

    const token = jwt.sign({ userId }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });

    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: {
        id: userId,
        email,
        name: safeName,
        role,
        wallet_balance: 0,
        referral_code: userReferralCode
      }
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { password } = req.body;
    const email = (req.body.email || '').toLowerCase().trim();

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ userId: user.id }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });

    db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        is_approved: user.is_approved,
        approval_status: user.approval_status,
        wallet_balance: user.wallet_balance,
        referral_code: user.referral_code
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to log in' });
  }
});

router.get('/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// Lightweight status check — works even for pending/unapproved users
router.get('/check-status', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const jwt = require('jsonwebtoken');
    const config = require('../config');
    const decoded = jwt.verify(token, config.jwt.secret);
    const user = db.prepare('SELECT id, name, email, role, approval_status, wallet_balance, referral_code FROM users WHERE id = ?').get(decoded.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (e) {
    res.status(403).json({ error: 'Invalid or expired token' });
  }
});

router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { name, currentPassword, newPassword, phone, default_recipient, language } = req.body;
    const userId = req.user.id;

    if (newPassword) {
      const user = db.prepare('SELECT password FROM users WHERE id = ?').get(userId);
      const validPassword = await bcrypt.compare(currentPassword, user.password);
      if (!validPassword) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      db.prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hashedPassword, userId);
    }

    if (name) {
      if (name.length > 100) return res.status(400).json({ error: 'Name is too long (max 100 chars)' });
      const safeName = name.replace(/<[^>]*>/g, '').trim();
      db.prepare('UPDATE users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(safeName, userId);
    }

    if (phone !== undefined) {
      const safePhone = (phone || '').replace(/[^0-9+]/g, '').substring(0, 15);
      db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(safePhone || null, userId);
    }

    if (default_recipient !== undefined) {
      const safeRec = (default_recipient || '').replace(/[^0-9+]/g, '').substring(0, 15);
      db.prepare('UPDATE users SET default_recipient = ? WHERE id = ?').run(safeRec || null, userId);
    }

    if (language && ['en', 'tw', 'ha'].includes(language)) {
      db.prepare('UPDATE users SET language = ? WHERE id = ?').run(language, userId);
    }

    const updatedUser = db.prepare('SELECT id, email, name, role, wallet_balance, referral_code, phone, default_recipient, notification_prefs, last_login, language, (transaction_pin IS NOT NULL) as has_pin FROM users WHERE id = ?').get(userId);

    res.json({ message: 'Profile updated successfully', user: updatedUser });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Notification preferences
router.put('/notification-prefs', authenticateToken, (req, res) => {
  try {
    const { orders, referral, promotions } = req.body;
    const prefs = JSON.stringify({
      orders: orders !== false,
      referral: referral !== false,
      promotions: !!promotions
    });
    db.prepare('UPDATE users SET notification_prefs = ? WHERE id = ?').run(prefs, req.user.id);
    res.json({ message: 'Preferences updated' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// Transaction PIN set / change
router.post('/transaction-pin', authenticateToken, async (req, res) => {
  try {
    const { pin, currentPin } = req.body;
    if (!pin || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
    }
    const user = db.prepare('SELECT transaction_pin FROM users WHERE id = ?').get(req.user.id);
    if (user.transaction_pin) {
      if (!currentPin) return res.status(400).json({ error: 'Current PIN is required to change PIN' });
      const valid = await bcrypt.compare(currentPin, user.transaction_pin);
      if (!valid) return res.status(400).json({ error: 'Current PIN is incorrect' });
    }
    const hashed = await bcrypt.hash(pin, 10);
    db.prepare('UPDATE users SET transaction_pin = ? WHERE id = ?').run(hashed, req.user.id);
    res.json({ message: user.transaction_pin ? 'PIN changed successfully' : 'PIN set successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to set PIN' });
  }
});

// Request account deletion (goes to admin for review)
router.post('/request-deletion', authenticateToken, async (req, res) => {
  try {
    const { password, reason } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required' });
    if (!reason || reason.trim().length < 10) return res.status(400).json({ error: 'Please provide a reason (at least 10 characters)' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (user.role === 'admin') return res.status(403).json({ error: 'Admin accounts cannot be deleted' });
    if (user.deletion_pending) return res.status(400).json({ error: 'You already have a pending deletion request' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Incorrect password' });
    db.prepare('INSERT INTO account_deletion_requests (id, user_id, reason, status) VALUES (?, ?, ?, ?)').run(uuidv4(), req.user.id, reason.trim(), 'pending');
    db.prepare('UPDATE users SET deletion_pending = 1 WHERE id = ?').run(req.user.id);
    res.json({ message: 'Your deletion request has been submitted. Admin will review it within 24 hours.' });
  } catch (error) {
    console.error('Deletion request error:', error);
    res.status(500).json({ error: 'Failed to submit deletion request' });
  }
});

// Forgot Password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
    
    // Always respond the same way to prevent email enumeration
    const genericMsg = { message: 'If that email is registered, you will receive a password reset link shortly.' };

    if (!user) {
      return res.json(genericMsg);
    }

    const resetToken = uuidv4();
    const expires = new Date(Date.now() + 3600000); // 1 hour

    db.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?')
      .run(resetToken, expires.toISOString(), user.id);

    const emailResult = await emailService.sendPasswordResetEmail(email, user.name, resetToken);

    // If email isn't configured, return the reset link directly so the user can proceed
    if (!emailResult.success && emailResult.resetUrl) {
      return res.json({ ...genericMsg, resetUrl: emailResult.resetUrl, emailUnavailable: true });
    }

    res.json(genericMsg);
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process forgot password' });
  }
});

// Reset Password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (password.length > 128) {
      return res.status(400).json({ error: 'Password is too long' });
    }

    const user = db.prepare('SELECT id FROM users WHERE reset_token = ? AND reset_expires > ?')
      .get(token, new Date().toISOString());

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    db.prepare('UPDATE users SET password = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?')
      .run(hashedPassword, user.id);

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
