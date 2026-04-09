const express = require('express');
const { db } = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Get all agents with their incentive stats
router.get('/agents', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const agents = db.prepare(`
      SELECT 
        u.id, u.name, u.email, ROUND(u.wallet_balance, 2) as wallet_balance,
        COALESCE((SELECT ROUND(SUM(amount), 2) FROM incentives WHERE agent_id = u.id AND status = 'completed'), 0) as pending_incentives,
        COALESCE((SELECT ROUND(SUM(amount), 2) FROM incentives WHERE agent_id = u.id AND status = 'paid'), 0) as total_paid
      FROM users u
      WHERE u.role = 'agent'
    `).all();

    res.json({ agents });
  } catch (error) {
    console.error('Fetch agents error:', error);
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

// Get payout requests (Admin view)
router.get('/payouts', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const payouts = db.prepare(`
      SELECT p.*, u.name as agent_name, u.email as agent_email
      FROM payout_requests p
      JOIN users u ON p.agent_id = u.id
      ORDER BY p.created_at DESC
    `).all();

    res.json({ payouts });
  } catch (error) {
    console.error('Fetch payouts error:', error);
    res.status(500).json({ error: 'Failed to fetch payouts' });
  }
});

// Mark payout as completed
router.post('/payouts/:id/complete', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { id } = req.params;
    
    const payout = db.prepare('SELECT * FROM payout_requests WHERE id = ?').get(id);
    if (!payout) return res.status(404).json({ error: 'Payout request not found' });
    if (payout.status !== 'pending') return res.status(400).json({ error: 'Payout already processed' });

    const updatePayout = db.prepare(`
      UPDATE payout_requests 
      SET status = 'completed', processed_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `);
    
    const updateIncentives = db.prepare(`
      UPDATE incentives 
      SET status = 'paid', paid_at = CURRENT_TIMESTAMP 
      WHERE agent_id = ? AND status = 'completed'
      AND id IN (
        SELECT id FROM (
          SELECT id, amount, SUM(amount) OVER (ORDER BY created_at) as running_total
          FROM incentives
          WHERE agent_id = ? AND status = 'completed'
        ) WHERE running_total <= ? + 0.01
      )
    `);

    const updateWallet = db.prepare(`
      UPDATE users 
      SET wallet_balance = wallet_balance + ? 
      WHERE id = ?
    `);

    const transaction = db.transaction(() => {
      updatePayout.run(id);
      updateIncentives.run(payout.agent_id, payout.agent_id, payout.amount);
      updateWallet.run(payout.amount, payout.agent_id);
      
      const { v4: uuidv4 } = require('uuid');
      db.prepare(`
        INSERT INTO notifications (id, user_id, title, message, type)
        VALUES (?, ?, ?, ?, ?)
      `).run(uuidv4(), payout.agent_id, 'Payout Completed', 
        `Your payout request of GHS ${payout.amount.toFixed(2)} has been processed and added to your wallet.`, 
        'success');
    });

    transaction();

    res.json({ message: 'Payout marked as completed' });
  } catch (error) {
    console.error('Complete payout error:', error);
    res.status(500).json({ error: 'Failed to complete payout' });
  }
});

module.exports = router;
