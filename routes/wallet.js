const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const paystack = require('../services/paystack');

const router = express.Router();

router.get('/balance', authenticateToken, (req, res) => {
  try {
    const user = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(req.user.id);
    res.json({ balance: user.wallet_balance });
  } catch (error) {
    console.error('Balance fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

// POST /api/wallet/topup
// Initiates a Paystack Mobile Money charge.
// In mock mode: creates a pending transaction and returns a reference + mock prompt text.
// In live mode: calls Paystack API which sends a USSD/app prompt to the customer's phone.
// The wallet is ONLY credited when Paystack fires a charge.success webhook (or mock-confirm).
router.post('/topup', authenticateToken, async (req, res) => {
  if (req.user.role === 'admin') {
    return res.status(403).json({ error: 'Admins cannot top up wallet balance' });
  }
  try {
    const config = require('../config');
    const { paymentMethod, phone } = req.body;
    const amount = parseFloat(req.body.amount);
    const minTopup = config.system?.minWalletTopup || 1;
    const maxTopup = config.system?.maxWalletTopup || 1000;

    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be a valid positive number' });
    }
    if (amount < minTopup) {
      return res.status(400).json({ error: `Minimum top-up amount is GHS ${minTopup}` });
    }
    if (amount > maxTopup) {
      return res.status(400).json({ error: `Maximum top-up amount is GHS ${maxTopup}` });
    }
    if (!paymentMethod || paymentMethod === 'wallet') {
      return res.status(400).json({ error: 'Payment method is required' });
    }
    if (!phone || !/^0[235][0-9]{8}$/.test(phone.replace(/\s+/g, ''))) {
      return res.status(400).json({ error: 'A valid Ghana phone number is required (e.g. 0241234567)' });
    }

    const cleanPhone = phone.replace(/\s+/g, '');
    const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
    const transactionId = uuidv4();
    const reference = 'KTHUB-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7).toUpperCase();

    // Save as pending BEFORE calling Paystack (so webhook can always find it)
    db.prepare(`
      INSERT INTO transactions (id, user_id, type, amount, description, status, reference, payment_method)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      transactionId, req.user.id, 'topup', amount,
      `Wallet top-up via ${paymentMethod} (${cleanPhone})`,
      'pending', reference, paymentMethod
    );

    // Initiate Paystack charge (or mock simulation)
    const chargeResult = await paystack.initiateCharge({
      email: user.email,
      amountGhs: amount,
      phone: cleanPhone,
      paymentMethod,
      reference
    });

    const chargeData = chargeResult.data || {};
    const displayText = chargeData.display_text || 'Check your phone and approve the payment prompt.';

    res.json({
      message: 'Payment initiated. Approve the prompt on your phone.',
      reference,
      displayText,
      mockMode: paystack.MOCK_MODE,
      transaction: { id: transactionId, amount, reference, paymentMethod, status: 'pending' }
    });
  } catch (error) {
    console.error('Top-up error:', error);
    res.status(500).json({ error: error.message || 'Failed to initiate top-up' });
  }
});

// GET /api/wallet/topup/pending  — admin only — list all pending topup requests
router.get('/topup/pending', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT t.id, t.user_id, t.amount, t.description, t.payment_method, t.created_at,
             u.name as user_name, u.email as user_email, u.phone as user_phone
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      WHERE t.type = 'topup' AND t.status = 'pending'
      ORDER BY t.created_at DESC
    `).all();
    res.json({ topups: rows });
  } catch (error) {
    console.error('Pending topups fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch pending top-ups' });
  }
});

// POST /api/wallet/topup/approve/:transactionId  — admin only
router.post('/topup/approve/:transactionId', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { transactionId } = req.params;
    const tx = db.prepare("SELECT * FROM transactions WHERE id = ? AND type = 'topup' AND status = 'pending'").get(transactionId);
    if (!tx) return res.status(404).json({ error: 'Pending top-up transaction not found' });

    db.prepare("UPDATE transactions SET status = 'completed' WHERE id = ?").run(transactionId);
    db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?').run(tx.amount, tx.user_id);

    db.prepare(`INSERT INTO notifications (id, user_id, title, message, type) VALUES (?, ?, ?, ?, ?)`)
      .run(uuidv4(), tx.user_id, 'Top-up Approved', `GHS ${parseFloat(tx.amount).toFixed(2)} has been credited to your wallet.`, 'success');

    res.json({ message: 'Top-up approved and wallet credited', transactionId });
  } catch (error) {
    console.error('Topup approve error:', error);
    res.status(500).json({ error: 'Failed to approve top-up' });
  }
});

// POST /api/wallet/topup/reject/:transactionId  — admin only
router.post('/topup/reject/:transactionId', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { transactionId } = req.params;
    const { reason } = req.body;
    const tx = db.prepare("SELECT * FROM transactions WHERE id = ? AND type = 'topup' AND status = 'pending'").get(transactionId);
    if (!tx) return res.status(404).json({ error: 'Pending top-up transaction not found' });

    db.prepare("UPDATE transactions SET status = 'failed' WHERE id = ?").run(transactionId);

    const rejectMsg = reason
      ? `Your GHS ${parseFloat(tx.amount).toFixed(2)} top-up request was rejected. Reason: ${String(reason).substring(0, 200)}`
      : `Your GHS ${parseFloat(tx.amount).toFixed(2)} top-up request was rejected. Please contact support.`;

    db.prepare(`INSERT INTO notifications (id, user_id, title, message, type) VALUES (?, ?, ?, ?, ?)`)
      .run(uuidv4(), tx.user_id, 'Top-up Rejected', rejectMsg, 'error');

    res.json({ message: 'Top-up rejected', transactionId });
  } catch (error) {
    console.error('Topup reject error:', error);
    res.status(500).json({ error: 'Failed to reject top-up' });
  }
});

router.post('/withdraw', authenticateToken, (req, res) => {
  try {
    const { paymentMethod, accountNumber } = req.body;
    const amount = parseFloat(req.body.amount);

    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be a valid positive number' });
    }

    // Minimum Withdrawal Limit: GHS 20
    if (amount < 20) {
      return res.status(400).json({ error: 'Minimum withdrawal amount is GHS 20.00' });
    }

    if (!paymentMethod || !accountNumber) {
      return res.status(400).json({ error: 'Payment method and account number are required' });
    }

    const user = db.prepare('SELECT wallet_balance, is_verified FROM users WHERE id = ?').get(req.user.id);
    
    if (user.wallet_balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    if (!user.is_verified && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Please verify your phone number before making a withdrawal.' });
    }

    const transactionId = uuidv4();
    const reference = 'WTH' + Math.random().toString(36).substring(2, 10).toUpperCase();

    db.prepare('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?').run(amount, req.user.id);

    db.prepare(`
      INSERT INTO transactions (id, user_id, type, amount, description, status, reference, payment_method)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(transactionId, req.user.id, 'withdrawal', amount, `Withdrawal to ${accountNumber} via ${paymentMethod}`, 'pending', reference, paymentMethod);

    db.prepare(`
      INSERT INTO notifications (id, user_id, title, message, type)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), req.user.id, 'Withdrawal Requested', `Your withdrawal of GHS ${amount.toFixed(2)} is being processed.`, 'info');

    const updatedBalance = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(req.user.id);

    res.json({
      message: 'Withdrawal request submitted',
      transaction: {
        id: transactionId,
        amount,
        reference,
        status: 'pending'
      },
      newBalance: updatedBalance.wallet_balance
    });
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({ error: 'Failed to process withdrawal' });
  }
});

router.get('/transactions', authenticateToken, (req, res) => {
  try {
    const { type, status, limit = 50, offset = 0 } = req.query;
    
    let query = 'SELECT * FROM transactions WHERE user_id = ?';
    const params = [req.user.id];

    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const transactions = db.prepare(query).all(...params).map(tx => {
      const processed = { ...tx };
      if (!req.user || req.user.role !== 'admin') {
        delete processed.wholesale_price;
        delete processed.retail_price;
      }
      return processed;
    });

    const countQuery = 'SELECT COUNT(*) as total FROM transactions WHERE user_id = ?';
    const totalCount = db.prepare(countQuery).get(req.user.id);

    res.json({
      transactions,
      total: totalCount.total,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Transactions fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

router.get('/analytics', authenticateToken, (req, res) => {
  try {
    const userId = req.user.id;

    const topups = db.prepare(`
      SELECT 
        strftime('%Y-%m-%d', created_at) as date,
        SUM(amount) as total
      FROM transactions 
      WHERE user_id = ? AND type = 'topup' AND status = 'completed'
      GROUP BY date
      ORDER BY date DESC
      LIMIT 30
    `).all(userId);

    const purchases = db.prepare(`
      SELECT 
        strftime('%Y-%m-%d', created_at) as date,
        SUM(amount) as total
      FROM transactions 
      WHERE user_id = ? AND type = 'purchase' AND status = 'completed'
      GROUP BY date
      ORDER BY date DESC
      LIMIT 30
    `).all(userId);

    const summary = db.prepare(`
      SELECT 
        type,
        COUNT(*) as count,
        SUM(amount) as total
      FROM transactions 
      WHERE user_id = ? AND status IN ('completed', 'COMPLETED')
      GROUP BY type
    `).all(userId);

    res.json({ topups, purchases, summary });
  } catch (error) {
    console.error('Analytics fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Admin: Withdraw from platform profit (admin_wallet) to personal wallet balance
router.post('/admin/withdraw-profit', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Valid amount required' });

    const adminWallet = db.prepare("SELECT balance FROM admin_wallet WHERE id = 'ADMIN_MAIN'").get();
    const available = Math.round((adminWallet ? (adminWallet.balance || 0) : 0) * 100) / 100;
    const requested = Math.round(amount * 100) / 100;
    if (requested > available) {
      return res.status(400).json({ error: `Insufficient profit. Available: GHS ${available.toFixed(2)}` });
    }

    const transactionId = uuidv4();
    db.transaction(() => {
      // 1. Deduct from admin_wallet
      db.prepare("UPDATE admin_wallet SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = 'ADMIN_MAIN'").run(requested);

      // 2. Record deduction in history
      db.prepare(`INSERT INTO admin_wallet_history (id, type, amount, description) VALUES (?, 'debit', ?, ?)`).run(
        uuidv4(), requested, `Admin withdrawal to personal wallet (ref: ${transactionId})`
      );

      // 3. Credit admin's personal wallet
      db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?').run(requested, req.user.id);

      // 4. Log as a transaction
      db.prepare(`
        INSERT INTO transactions (id, user_id, type, amount, description, status, reference, payment_method)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(transactionId, req.user.id, 'topup', requested, 'Withdrawal from platform profit', 'completed', 'SYS-' + Date.now(), 'system');
    })();

    res.json({ message: 'Profit withdrawn to wallet successfully', amount: requested, remaining: available - requested });
  } catch (error) {
    console.error('Profit withdrawal error:', error);
    res.status(500).json({ error: 'Failed to withdraw profit' });
  }
});

module.exports = router;
