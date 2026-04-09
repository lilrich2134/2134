const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.get('/code', authenticateToken, (req, res) => {
  try {
    const user = db.prepare('SELECT referral_code FROM users WHERE id = ?').get(req.user.id);
    res.json({ referralCode: user.referral_code });
  } catch (error) {
    console.error('Referral code fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch referral code' });
  }
});

router.get('/stats', authenticateToken, (req, res) => {
  try {
    const userId = req.user.id;

    const referrals = db.prepare(`
      SELECT id, name, created_at 
      FROM users 
      WHERE referred_by = ?
      ORDER BY created_at DESC
    `).all(userId);

    const earnings = db.prepare('SELECT referral_earnings FROM users WHERE id = ?').get(userId);

    const milestones = [
      { count: 5, reward: 25, badge: 'Bronze Referrer' },
      { count: 10, reward: 60, badge: 'Silver Referrer' },
      { count: 25, reward: 175, badge: 'Gold Referrer' },
      { count: 50, reward: 400, badge: 'Platinum Referrer' },
      { count: 100, reward: 1000, badge: 'Diamond Referrer' }
    ];

    const referralCount = referrals.length;
    const achievedMilestones = milestones.filter(m => referralCount >= m.count);
    const nextMilestone = milestones.find(m => referralCount < m.count);

    const config = require('../config');
    res.json({
      referralCode: req.user.referral_code,
      totalReferrals: referralCount,
      totalEarnings: earnings.referral_earnings,
      referrals: referrals.slice(0, 10),
      achievedMilestones,
      nextMilestone,
      progress: nextMilestone ? (referralCount / nextMilestone.count) * 100 : 100,
      bonusGhs: config.system?.referralBonusGhs ?? 2.00,
      minOrderGhs: config.system?.referralMinOrderGhs ?? 15.00
    });
  } catch (error) {
    console.error('Referral stats fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch referral stats' });
  }
});

router.post('/validate', (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'Referral code is required' });
    }

    const referrer = db.prepare('SELECT id, name FROM users WHERE referral_code = ?').get(code);

    if (!referrer) {
      return res.status(404).json({ error: 'Invalid referral code', valid: false });
    }

    const config = require('../config');
    const estimatedBonus = config.system?.referralBonusGhs || 2.00;

    res.json({ 
      valid: true, 
      referrerName: referrer.name,
      bonus: estimatedBonus
    });
  } catch (error) {
    console.error('Referral validation error:', error);
    res.status(500).json({ error: 'Failed to validate referral code' });
  }
});

router.post('/claim-milestone', authenticateToken, (req, res) => {
  try {
    const { milestoneCount } = req.body;
    const userId = req.user.id;

    const milestones = {
      5: { reward: 25, badge: 'Bronze Referrer' },
      10: { reward: 60, badge: 'Silver Referrer' },
      25: { reward: 175, badge: 'Gold Referrer' },
      50: { reward: 400, badge: 'Platinum Referrer' },
      100: { reward: 1000, badge: 'Diamond Referrer' }
    };

    const milestone = milestones[milestoneCount];
    if (!milestone) {
      return res.status(400).json({ error: 'Invalid milestone' });
    }

    // Anti-abuse: prevent claiming the same milestone twice
    const alreadyClaimed = db.prepare('SELECT id FROM milestone_claims WHERE user_id = ? AND milestone_count = ?').get(userId, milestoneCount);
    if (alreadyClaimed) {
      return res.status(400).json({ error: 'You have already claimed this milestone reward' });
    }

    const referralCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE referred_by = ?').get(userId);

    if (referralCount.count < milestoneCount) {
      return res.status(400).json({ error: 'Milestone not yet reached' });
    }

    // Atomic transaction: record claim + credit wallet
    const claimMilestone = db.transaction(() => {
      db.prepare('INSERT INTO milestone_claims (id, user_id, milestone_count) VALUES (?, ?, ?)').run(uuidv4(), userId, milestoneCount);
      db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?').run(milestone.reward, userId);
      db.prepare(`INSERT INTO notifications (id, user_id, title, message, type) VALUES (?, ?, ?, ?, ?)`)
        .run(uuidv4(), userId, 'Milestone Achieved!', `Congratulations! You've earned the ${milestone.badge} badge and GHS ${milestone.reward} bonus!`, 'success');
    });
    claimMilestone();

    const updatedBalance = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(userId);

    res.json({
      message: 'Milestone reward claimed successfully',
      badge: milestone.badge,
      reward: milestone.reward,
      newBalance: updatedBalance.wallet_balance
    });
  } catch (error) {
    console.error('Milestone claim error:', error);
    res.status(500).json({ error: 'Failed to claim milestone' });
  }
});

// GET /api/referral/list — fetch all referrals for the logged-in user with status info
router.get('/list', authenticateToken, (req, res) => {
  try {
    const userId = req.user.id;
    const referrals = db.prepare(`
      SELECT r.id, r.status, r.bonus_amount, r.lock_until, r.created_at, r.flag_reason,
             u.name AS referred_name, u.email AS referred_email
      FROM referrals r
      JOIN users u ON u.id = r.referred_id
      WHERE r.referrer_id = ?
      ORDER BY r.created_at DESC
    `).all(userId);
    res.json(referrals);
  } catch (error) {
    console.error('Referral list fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch referral list' });
  }
});

// GET /api/referral/breakdown — pending/locked/completed/flagged balance totals
router.get('/breakdown', authenticateToken, (req, res) => {
  try {
    const userId = req.user.id;
    const rows = db.prepare(`
      SELECT status, SUM(bonus_amount) as total
      FROM referrals
      WHERE referrer_id = ?
      GROUP BY status
    `).all(userId);

    const breakdown = { pending: 0, locked: 0, completed: 0, flagged: 0 };
    for (const row of rows) {
      if (breakdown.hasOwnProperty(row.status)) {
        breakdown[row.status] = row.total || 0;
      }
    }
    res.json(breakdown);
  } catch (error) {
    console.error('Referral breakdown fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch referral breakdown' });
  }
});

module.exports = router;
