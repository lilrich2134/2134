const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const config = require('../config');

const router = express.Router();

// Bundle Management Routes
router.get('/bundles', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const bundles = db.prepare(`
      SELECT * FROM bundles 
      WHERE provider_bundle_code IS NOT NULL 
      AND provider_bundle_code != '' 
      AND provider_bundle_code != id 
      ORDER BY network, retail_price ASC
    `).all();
    res.json({ bundles });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch bundles' });
  }
});

router.get('/provider-bundles-raw', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    // Simulated bundles from provider API
    const bundles = [
      { network: 'MTN', name: 'MTN Daily 1GB', code: 'mtn-1gb-daily', size_mb: 1024, size_display: '1GB' },
      { network: 'MTN', name: 'MTN Weekly 5GB', code: 'mtn-5gb-weekly', size_mb: 5120, size_display: '5GB' },
      { network: 'Telecel', name: 'Telecel Daily 2GB', code: 'telecel-2gb-daily', size_mb: 2048, size_display: '2GB' },
      { network: 'AT', name: 'AT Monthly 10GB', code: 'at-10gb-monthly', size_mb: 10240, size_display: '10GB' }
    ];
    res.json({ bundles });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch provider bundles' });
  }
});

router.post('/bundles-mapping', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { network, name, provider_bundle_code, wholesale_price, retail_price, status, size_mb, size_display, validity_days, eta_minutes, popular } = req.body;
    const id = uuidv4();
    db.prepare(`
      INSERT INTO bundles (id, provider, network, name, provider_bundle_code, size_mb, size_display, price, retail_price, wholesale_price, validity_days, eta_minutes, popular, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, network, network, name, provider_bundle_code, size_mb || 0, size_display || '', retail_price, retail_price, wholesale_price, validity_days || 30, eta_minutes || 5, popular ? 1 : 0, status || 'active');
    res.json({ message: 'Bundle mapping created successfully', id });
  } catch (error) {
    console.error('Bundle mapping creation error:', error);
    res.status(500).json({ error: 'Failed to create bundle mapping' });
  }
});

router.put('/bundles-mapping/:id', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { network, name, provider_bundle_code, wholesale_price, retail_price, status, size_mb, size_display, validity_days, eta_minutes, popular } = req.body;
    db.prepare(`
      UPDATE bundles SET 
        network = ?, provider = ?, name = ?, provider_bundle_code = ?, 
        wholesale_price = ?, retail_price = ?, price = ?, status = ?,
        size_mb = ?, size_display = ?, validity_days = ?, eta_minutes = ?, popular = ?
      WHERE id = ?
    `).run(network, network, name, provider_bundle_code, wholesale_price, retail_price, retail_price, status, size_mb, size_display, validity_days, eta_minutes, popular ? 1 : 0, req.params.id);
    res.json({ message: 'Bundle mapping updated successfully' });
  } catch (error) {
    console.error('Bundle mapping update error:', error);
    res.status(500).json({ error: 'Failed to update bundle mapping' });
  }
});

router.delete('/bundles-mapping/:id', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const bundleId = req.params.id;
    const existing = db.prepare('SELECT * FROM bundles WHERE id = ?').get(bundleId);
    if (!existing) {
      return res.status(404).json({ error: 'Bundle mapping not found' });
    }
    db.prepare('DELETE FROM bundles WHERE id = ?').run(bundleId);
    res.json({ message: 'Bundle mapping deleted successfully' });
  } catch (error) {
    console.error('Bundle mapping deletion error:', error);
    res.status(500).json({ error: 'Failed to delete bundle mapping' });
  }
});

router.post('/bundles/bulk-update', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { bundleIds, action, value, status } = req.body;
    
    if (!bundleIds || !Array.isArray(bundleIds) || bundleIds.length === 0) {
      return res.status(400).json({ error: 'No bundles selected' });
    }

    const placeholders = bundleIds.map(() => '?').join(',');
    
    db.transaction(() => {
      if (action === 'percentage') {
        const factor = 1 + (parseFloat(value) / 100);
        db.prepare(`
          UPDATE bundles 
          SET retail_price = ROUND(retail_price * ?, 2), price = ROUND(retail_price * ?, 2)
          WHERE id IN (${placeholders}) 
          AND provider_bundle_code IS NOT NULL 
          AND provider_bundle_code != '' 
          AND provider_bundle_code != id
        `).run(factor, factor, ...bundleIds);
      } else if (action === 'fixed') {
        const fixedPrice = parseFloat(value);
        db.prepare(`
          UPDATE bundles 
          SET retail_price = ?, price = ?
          WHERE id IN (${placeholders}) 
          AND provider_bundle_code IS NOT NULL 
          AND provider_bundle_code != '' 
          AND provider_bundle_code != id
          AND ? >= wholesale_price
        `).run(fixedPrice, fixedPrice, ...bundleIds, fixedPrice);
      } else if (action === 'status') {
        db.prepare(`
          UPDATE bundles 
          SET status = ?
          WHERE id IN (${placeholders}) 
          AND provider_bundle_code IS NOT NULL 
          AND provider_bundle_code != '' 
          AND provider_bundle_code != id
        `).run(status, ...bundleIds);
      }
    })();

    res.json({ message: 'Bulk update completed successfully' });
  } catch (error) {
    console.error('Bulk update error:', error);
    res.status(500).json({ error: 'Failed to perform bulk update' });
  }
});

router.get('/referrals/flagged', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const flagged = db.prepare(`
      SELECT r.*, ur.email as referrer_email, ud.email as referred_email, ud.signup_ip, ud.device_fingerprint
      FROM referrals r
      JOIN users ur ON r.referrer_id = ur.id
      JOIN users ud ON r.referred_id = ud.id
      WHERE r.status = 'flagged'
      ORDER BY r.created_at DESC
    `).all();
    res.json({ referrals: flagged });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch flagged referrals' });
  }
});

router.post('/referrals/:id/review', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { action } = req.body; // 'approve' or 'reject'
    const referralId = req.params.id;

    const referral = db.prepare('SELECT * FROM referrals WHERE id = ?').get(referralId);
    if (!referral) return res.status(404).json({ error: 'Referral not found' });

    if (action === 'approve') {
      const lockUntil = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      db.prepare("UPDATE referrals SET status = 'locked', lock_until = ? WHERE id = ?").run(lockUntil, referralId);
      res.json({ message: 'Referral approved and locked for 48h cooling period' });
    } else {
      db.prepare("UPDATE referrals SET status = 'rejected' WHERE id = ?").run(referralId);
      res.json({ message: 'Referral rejected' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to review referral' });
  }
});

router.get('/users', authenticateToken, requireRole(['admin', 'agent']), (req, res) => {
  try {
    const { role, search, limit = 50, offset = 0 } = req.query;
    let query = "SELECT id, email, name, phone, role, wallet_balance, approval_status, is_verified, created_at FROM users WHERE id != 'SYSTEM_PROFIT' AND email != 'system@kthub.com'";
    const params = [];
    if (role) { query += ' AND role = ?'; params.push(role); }
    if (search) { query += ' AND (email LIKE ? OR name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    const users = db.prepare(query).all(...params);
    res.json({ users });
  } catch (error) {
    console.error('Users fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET /api/admin/withdrawals — list all withdrawal transactions
router.get('/withdrawals', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT t.*, u.name as user_name, u.email as user_email, u.phone as user_phone
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      WHERE t.type = 'withdrawal'
    `;
    const params = [];
    if (status) { query += ' AND t.status = ?'; params.push(status); }
    query += ' ORDER BY t.created_at DESC LIMIT 200';
    const withdrawals = db.prepare(query).all(...params);
    res.json({ withdrawals });
  } catch (error) {
    console.error('Withdrawals fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

// POST /api/admin/withdrawals/:id/complete — mark a withdrawal as completed
router.post('/withdrawals/:id/complete', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    const tx = db.prepare('SELECT * FROM transactions WHERE id = ? AND type = ?').get(id, 'withdrawal');
    if (!tx) return res.status(404).json({ error: 'Withdrawal not found' });
    if (tx.status === 'completed') return res.status(400).json({ error: 'Already completed' });

    db.prepare("UPDATE transactions SET status = 'completed' WHERE id = ?").run(id);

    db.prepare(`INSERT INTO notifications (id, user_id, title, message, type) VALUES (?, ?, ?, ?, ?)`)
      .run(uuidv4(), tx.user_id,
        'Withdrawal Completed',
        `Your withdrawal of GHS ${parseFloat(tx.amount).toFixed(2)} has been sent to your MoMo.${note ? ' Note: ' + note : ''}`,
        'success');

    res.json({ message: 'Withdrawal marked as completed' });
  } catch (error) {
    console.error('Complete withdrawal error:', error);
    res.status(500).json({ error: 'Failed to complete withdrawal' });
  }
});

// POST /api/admin/withdrawals/:id/reject — reject/reverse a withdrawal
router.post('/withdrawals/:id/reject', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const tx = db.prepare('SELECT * FROM transactions WHERE id = ? AND type = ?').get(id, 'withdrawal');
    if (!tx) return res.status(404).json({ error: 'Withdrawal not found' });
    if (tx.status === 'completed') return res.status(400).json({ error: 'Cannot reject a completed withdrawal' });

    db.transaction(() => {
      db.prepare("UPDATE transactions SET status = 'rejected' WHERE id = ?").run(id);
      db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?').run(tx.amount, tx.user_id);
      db.prepare(`INSERT INTO notifications (id, user_id, title, message, type) VALUES (?, ?, ?, ?, ?)`)
        .run(uuidv4(), tx.user_id,
          'Withdrawal Rejected',
          `Your withdrawal of GHS ${parseFloat(tx.amount).toFixed(2)} was rejected and refunded to your wallet.${reason ? ' Reason: ' + reason : ''}`,
          'warning');
    })();

    res.json({ message: 'Withdrawal rejected and amount refunded to user wallet' });
  } catch (error) {
    console.error('Reject withdrawal error:', error);
    res.status(500).json({ error: 'Failed to reject withdrawal' });
  }
});

router.post('/users/:id/verify', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { id } = req.params;
    const user = db.prepare('SELECT id, name, email, is_verified FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newVerified = user.is_verified ? 0 : 1;
    db.prepare('UPDATE users SET is_verified = ? WHERE id = ?').run(newVerified, id);

    res.json({
      message: newVerified ? `${user.name} is now verified` : `${user.name} verification removed`,
      is_verified: newVerified
    });
  } catch (error) {
    console.error('Verify user error:', error);
    res.status(500).json({ error: 'Failed to update verification status' });
  }
});

router.get('/wallet-ledger', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { userId, limit = 100, offset = 0 } = req.query;
    let query = `
      SELECT wl.*, u.name as user_name, u.email as user_email
      FROM wallet_ledger wl
      JOIN users u ON wl.user_id = u.id
      WHERE 1=1
    `;
    const params = [];
    if (userId) {
      query += ' AND wl.user_id = ?';
      params.push(userId);
    }
    query += ' ORDER BY wl.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    const ledger = db.prepare(query).all(...params);
    res.json({ ledger });
  } catch (error) {
    console.error('Ledger fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch wallet ledger' });
  }
});

// Admin: list all orders with optional status/search filter
router.get('/orders', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { status, search, limit = 100, offset = 0 } = req.query;
    let where = '1=1';
    const params = [];
    if (status) { where += ' AND UPPER(o.status) = ?'; params.push(status.toUpperCase()); }
    if (search) {
      where += ' AND (u.name LIKE ? OR u.email LIKE ? OR o.id LIKE ? OR o.phone_number LIKE ?)';
      const q = `%${search}%`;
      params.push(q, q, q, q);
    }
    const orders = db.prepare(`
      SELECT o.id, o.status, o.amount, o.phone_number, o.provider,
             o.created_at, o.updated_at,
             u.name as user_name, u.email as user_email,
             b.name as bundle_name, b.size_display
      FROM orders o
      JOIN users u ON o.user_id = u.id
      JOIN bundles b ON o.bundle_id = b.id
      WHERE ${where}
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), parseInt(offset));

    const stats = {
      total:      db.prepare('SELECT COUNT(*) as c FROM orders').get().c,
      completed:  db.prepare("SELECT COUNT(*) as c FROM orders WHERE UPPER(status) = 'COMPLETED'").get().c,
      failed:     db.prepare("SELECT COUNT(*) as c FROM orders WHERE UPPER(status) = 'FAILED'").get().c,
      processing: db.prepare("SELECT COUNT(*) as c FROM orders WHERE UPPER(status) IN ('PENDING','PROCESSING')").get().c,
      refunded:   db.prepare("SELECT COUNT(*) as c FROM orders WHERE UPPER(status) = 'REFUNDED'").get().c,
      today:      db.prepare("SELECT COUNT(*) as c FROM orders WHERE DATE(created_at) = DATE('now')").get().c,
    };

    res.json({ orders, stats });
  } catch (error) {
    console.error('Admin orders fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Admin: manual refund for FAILED/CANCELLED orders
router.post('/orders/:id/refund', authenticateToken, requireRole('admin'), (req, res) => {
  const orderId = req.params.id;
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status.toUpperCase() === 'REFUNDED') return res.status(400).json({ error: 'Order already refunded' });
    if (!['FAILED', 'CANCELLED'].includes(order.status.toUpperCase())) {
      return res.status(400).json({ error: 'Only FAILED or CANCELLED orders can be refunded' });
    }

    db.transaction(() => {
      db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?').run(order.amount, order.user_id);
      db.prepare("UPDATE orders SET status = 'REFUNDED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
      db.prepare('INSERT INTO notifications (id, user_id, title, message, type) VALUES (?,?,?,?,?)')
        .run(uuidv4(), order.user_id, 'Refund Processed',
          `A refund of GHS ${parseFloat(order.amount).toFixed(2)} has been credited to your wallet.`, 'success');
    })();

    res.json({ message: 'Refund processed successfully' });
  } catch (error) {
    console.error('Admin refund error:', error);
    res.status(500).json({ error: 'Failed to process refund' });
  }
});

router.get('/transactions', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const transactions = db.prepare(`
      SELECT t.*, u.name as user_name, u.email as user_email
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      ORDER BY t.created_at DESC
    `).all();
    res.json({ transactions });
  } catch (error) {
    console.error('Admin transactions fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

router.get('/stats', authenticateToken, requireRole(['admin', 'agent']), (req, res) => {
  try {
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('customer');
    const totalAgents = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('agent');
    const totalOrders = db.prepare('SELECT COUNT(*) as count FROM orders').get();
    const completedOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE status IN ('completed', 'COMPLETED')").get();
    const adminWallet = db.prepare("SELECT balance FROM admin_wallet WHERE id = 'ADMIN_MAIN'").get();
    const totalProfit = adminWallet ? adminWallet.balance : 0;
    const recentOrders = db.prepare(`
      SELECT o.*, u.name as user_name, b.name as bundle_name
      FROM orders o
      JOIN users u ON o.user_id = u.id
      JOIN bundles b ON o.bundle_id = b.id
      ORDER BY o.created_at DESC
      LIMIT 10
    `).all();
    res.json({
      stats: { totalUsers: totalUsers.count, totalAgents: totalAgents.count, totalOrders: totalOrders.count, completedOrders: completedOrders.count, totalRevenue: totalProfit },
      recentOrders
    });
  } catch (error) {
    console.error('Stats fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

router.post('/wallet/sync', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const ledgerSum = db.prepare("SELECT SUM(admin_profit_amount) as total FROM admin_profits").get();
    const totalProfit = ledgerSum ? (ledgerSum.total || 0) : 0;
    const deductionsSum = db.prepare("SELECT SUM(amount) as total FROM admin_wallet_history WHERE type = 'debit'").get();
    const totalDeductions = deductionsSum ? (deductionsSum.total || 0) : 0;
    const correctBalance = parseFloat((totalProfit - totalDeductions).toFixed(2));
    db.transaction(() => {
      db.prepare("UPDATE admin_wallet SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 'ADMIN_MAIN'").run(correctBalance);
      db.prepare(`INSERT INTO admin_wallet_history (id, type, amount, description) VALUES (?, 'sync', ?, 'Manual wallet balance synchronization with ledger')`).run(uuidv4(), correctBalance);
    })();
    res.json({ message: 'Wallet synchronized successfully', newBalance: correctBalance });
  } catch (error) {
    console.error('Wallet sync error:', error);
    res.status(500).json({ error: 'Failed to sync wallet' });
  }
});

router.get('/provider-bundles-preview', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    // Simulated bundles from provider API
    // In a real app, this would call actual provider APIs
    const providerBundles = [
      { network: 'MTN', name: 'MTN Daily 1GB', code: 'mtn-1gb-daily', size_mb: 1024, size_display: '1GB' },
      { network: 'MTN', name: 'MTN Weekly 5GB', code: 'mtn-5gb-weekly', size_mb: 5120, size_display: '5GB' },
      { network: 'MTN', name: 'MTN Monthly 20GB', code: 'mtn-20gb-monthly', size_mb: 20480, size_display: '20GB' },
      { network: 'Telecel', name: 'Telecel Daily 2GB', code: 'telecel-2gb-daily', size_mb: 2048, size_display: '2GB' },
      { network: 'Telecel', name: 'Telecel Jumbo 50GB', code: 'telecel-50gb-jumbo', size_mb: 51200, size_display: '50GB' },
      { network: 'AT', name: 'AT Monthly 10GB', code: 'at-10gb-monthly', size_mb: 10240, size_display: '10GB' },
      { network: 'AT', name: 'AT Lite 500MB', code: 'at-500mb-lite', size_mb: 500, size_display: '500MB' }
    ];

    // Get currently mapped bundles to check against
    const mappedBundles = db.prepare('SELECT provider_bundle_code, network FROM bundles').all();
    
    const results = providerBundles.map(pb => {
      const isMapped = mappedBundles.some(mb => 
        mb.provider_bundle_code === pb.code && mb.network === pb.network
      );
      return { ...pb, isMapped };
    });

    res.json({ bundles: results });
  } catch (error) {
    console.error('Provider bundles preview error:', error);
    res.status(500).json({ error: 'Failed to fetch provider bundles preview' });
  }
});

router.post('/bundles', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { provider, name, size_mb, size_display, price, wholesale_price, validity_days, eta_minutes, popular } = req.body;
    if (!provider || !name || !size_mb || !price || !wholesale_price) return res.status(400).json({ error: 'Missing required fields' });
    const bundleId = uuidv4();
    db.prepare(`INSERT INTO bundles (id, provider, name, size_mb, size_display, price, wholesale_price, validity_days, eta_minutes, popular) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(bundleId, provider, name, size_mb, size_display || `${size_mb}MB`, price, wholesale_price, validity_days || 30, eta_minutes || 5, popular ? 1 : 0);
    const bundle = db.prepare('SELECT * FROM bundles WHERE id = ?').get(bundleId);
    res.status(201).json({ message: 'Bundle created successfully', bundle });
  } catch (error) {
    console.error('Bundle creation error:', error);
    res.status(500).json({ error: 'Failed to create bundle' });
  }
});

router.put('/bundles/:id', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { provider, name, size_mb, size_display, price, wholesale_price, validity_days, eta_minutes, popular } = req.body;
    const bundleId = req.params.id;
    const existing = db.prepare('SELECT * FROM bundles WHERE id = ?').get(bundleId);
    if (!existing) return res.status(404).json({ error: 'Bundle not found' });
    let updatedName = name || existing.name;
    if (provider === 'AirtelTigo' || existing.provider === 'AirtelTigo') updatedName = updatedName.replace(/AirtelTigo/g, 'AT');
    db.prepare(`UPDATE bundles SET provider = ?, name = ?, size_mb = ?, size_display = ?, price = ?, wholesale_price = ?, validity_days = ?, eta_minutes = ?, popular = ? WHERE id = ?`).run(provider || existing.provider, updatedName, size_mb || existing.size_mb, size_display || existing.size_display, price || existing.price, wholesale_price || existing.wholesale_price, validity_days || existing.validity_days, eta_minutes || existing.eta_minutes, popular !== undefined ? (popular ? 1 : 0) : existing.popular, bundleId);
    const bundle = db.prepare('SELECT * FROM bundles WHERE id = ?').get(bundleId);
    res.json({ message: 'Bundle updated successfully', bundle });
  } catch (error) {
    console.error('Bundle update error:', error);
    res.status(500).json({ error: 'Failed to update bundle' });
  }
});

router.delete('/bundles/:id', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const bundleId = req.params.id;
    const existing = db.prepare('SELECT * FROM bundles WHERE id = ?').get(bundleId);
    if (!existing) return res.status(404).json({ error: 'Bundle not found' });
    db.prepare('DELETE FROM bundles WHERE id = ?').run(bundleId);
    res.json({ message: 'Bundle deleted successfully' });
  } catch (error) {
    console.error('Bundle deletion error:', error);
    res.status(500).json({ error: 'Failed to delete bundle' });
  }
});

router.get('/system-settings', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const config = require('../config');
    res.json({ settings: {
      maintenanceMode:      config.system?.maintenanceMode      ?? false,
      globalDiscount:       config.system?.globalDiscount       ?? 0,
      minWalletTopup:       config.system?.minWalletTopup       ?? 1,
      maxWalletTopup:       config.system?.maxWalletTopup       ?? 1000,
      referralBonusGhs:     config.system?.referralBonusGhs     ?? 2.00,
      referralMinOrderGhs:  config.system?.referralMinOrderGhs  ?? 15.00,
      referralDailyCap:     config.system?.referralDailyCap     ?? 100,
      referralLockHours:    config.system?.referralLockHours    ?? 48,
      registrationEnabled:  config.system?.registrationEnabled  ?? true,
      slowMode:             config.mock?.slowMode               ?? false,
      mockFailureRate:      config.mock?.failureRate            ?? 0,
      appVersion:           config.system?.appVersion           ?? '1.0.0',
      appName:              config.system?.appName              ?? 'KT-Hub Premium',
      appTagline:           config.system?.appTagline           ?? 'Ghana Data Bundle Marketplace'
    }});
  } catch (error) {
    console.error('System settings fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch system settings' });
  }
});

router.put('/system-settings', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { maintenanceMode, globalDiscount, minWalletTopup, maxWalletTopup, referralBonusGhs, referralMinOrderGhs, referralDailyCap, referralLockHours, registrationEnabled, slowMode, mockFailureRate, resetToDefault, appVersion, appName, appTagline } = req.body;
    const config = require('../config');
    if (!config.system) config.system = {};
    if (!config.mock) config.mock = {};
    if (resetToDefault) {
      config.system.maintenanceMode = false; config.system.globalDiscount = 0; config.system.minWalletTopup = 1; config.system.maxWalletTopup = 1000; config.system.referralBonusGhs = 2.00; config.system.referralMinOrderGhs = 15.00; config.system.referralDailyCap = 100; config.system.referralLockHours = 48; config.system.registrationEnabled = true; config.mock.slowMode = false; config.mock.failureRate = 0;
      const upsert = db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)");
      upsert.run('maintenance_mode', '0'); upsert.run('global_discount', '0'); upsert.run('min_wallet_topup', '1'); upsert.run('max_wallet_topup', '1000'); upsert.run('referral_bonus_ghs', '2.00'); upsert.run('referral_min_order_ghs', '15.00'); upsert.run('referral_daily_cap', '100'); upsert.run('referral_lock_hours', '48'); upsert.run('registration_enabled', '1'); upsert.run('slow_mode', '0'); upsert.run('mock_failure_rate', '0');
      return res.json({ message: 'System settings reset to default successfully' });
    }
    const upsert = db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)");
    if (maintenanceMode !== undefined)    { config.system.maintenanceMode    = maintenanceMode;              upsert.run('maintenance_mode',      maintenanceMode ? '1' : '0'); }
    if (globalDiscount !== undefined)     { config.system.globalDiscount      = parseFloat(globalDiscount);   upsert.run('global_discount',        globalDiscount.toString()); }
    if (minWalletTopup !== undefined)     { config.system.minWalletTopup      = parseFloat(minWalletTopup);   upsert.run('min_wallet_topup',       minWalletTopup.toString()); }
    if (maxWalletTopup !== undefined)     { config.system.maxWalletTopup      = parseFloat(maxWalletTopup);   upsert.run('max_wallet_topup',       maxWalletTopup.toString()); }
    if (referralBonusGhs !== undefined)   { config.system.referralBonusGhs    = parseFloat(referralBonusGhs);    upsert.run('referral_bonus_ghs',    referralBonusGhs.toString()); }
    if (referralMinOrderGhs !== undefined){ config.system.referralMinOrderGhs = parseFloat(referralMinOrderGhs); upsert.run('referral_min_order_ghs', referralMinOrderGhs.toString()); }
    if (referralDailyCap !== undefined)   { config.system.referralDailyCap    = parseFloat(referralDailyCap);    upsert.run('referral_daily_cap',     referralDailyCap.toString()); }
    if (referralLockHours !== undefined)  { config.system.referralLockHours   = parseFloat(referralLockHours);   upsert.run('referral_lock_hours',    referralLockHours.toString()); }
    if (registrationEnabled !== undefined){ config.system.registrationEnabled  = !!registrationEnabled;           upsert.run('registration_enabled',   registrationEnabled ? '1' : '0'); }
    if (slowMode !== undefined)           { config.mock.slowMode               = !!slowMode;                      upsert.run('slow_mode',              slowMode ? '1' : '0'); }
    if (mockFailureRate !== undefined)    { config.mock.failureRate            = parseFloat(mockFailureRate) / 100; upsert.run('mock_failure_rate',     (parseFloat(mockFailureRate) / 100).toString()); }
    if (appVersion !== undefined)         { config.system.appVersion           = appVersion.trim();                 upsert.run('app_version',            appVersion.trim()); }
    if (appName !== undefined)            { config.system.appName              = appName.trim();                    upsert.run('app_name',               appName.trim()); }
    if (appTagline !== undefined)         { config.system.appTagline           = appTagline.trim();                 upsert.run('app_tagline',            appTagline.trim()); }
    res.json({ message: 'System settings updated successfully' });
  } catch (error) {
    console.error('System settings update error:', error);
    res.status(500).json({ error: 'Failed to update system settings' });
  }
});

router.get('/incentive-settings', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const settings = db.prepare('SELECT * FROM incentive_settings').all();
    res.json({ incentiveSettings: settings });
  } catch (error) {
    console.error('Incentive settings fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch incentive settings' });
  }
});

router.put('/incentive-settings/:provider', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { provider } = req.params;
    const { enabled, percentage, cap, min_margin } = req.body;
    db.prepare(`UPDATE incentive_settings SET enabled = ?, percentage = ?, cap = ?, min_margin = ? WHERE provider = ?`).run(enabled ? 1 : 0, parseFloat(percentage), parseFloat(cap), parseFloat(min_margin), provider);
    res.json({ message: `${provider} incentive settings updated successfully` });
  } catch (error) {
    console.error('Incentive settings update error:', error);
    res.status(500).json({ error: 'Failed to update incentive settings' });
  }
});

router.get('/api-settings', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const config = require('../config');
    const apiSettings = {
      mtn: { name: 'MTN', apiKey: config.providers.mtn.apiKey ? '••••••••' + config.providers.mtn.apiKey.slice(-4) : '', apiUrl: config.providers.mtn.apiUrl, enabled: config.providers.mtn.enabled },
      telecel: { name: 'Telecel', apiKey: config.providers.telecel.apiKey ? '••••••••' + config.providers.telecel.apiKey.slice(-4) : '', apiUrl: config.providers.telecel.apiUrl, enabled: config.providers.telecel.enabled },
      at: { name: 'AT', apiKey: config.providers.at.apiKey ? '••••••••' + config.providers.at.apiKey.slice(-4) : '', apiUrl: config.providers.at.apiUrl, enabled: config.providers.at.enabled },
      backup: { name: 'Backup Provider', apiKey: config.providers.backup.apiKey ? '••••••••' + config.providers.backup.apiKey.slice(-4) : '', apiUrl: config.providers.backup.apiUrl, enabled: config.providers.backup.enabled },
      whatsapp: { number: config.whatsapp.number, enabled: config.whatsapp.enabled !== false },
      mock: { slowMode: config.mock.slowMode, failureRate: config.mock.failureRate }
    };
    res.json({ apiSettings });
  } catch (error) {
    console.error('API settings fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch API settings' });
  }
});

router.put('/api-settings', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { provider, apiKey, apiUrl, enabled, number, resetToDefault } = req.body;
    const config = require('../config');
    if (resetToDefault) {
      if (provider === 'whatsapp') {
        config.whatsapp.number = '+233XXXXXXXXX'; config.whatsapp.enabled = true;
        try { db.prepare("UPDATE system_settings SET value = ? WHERE key = 'whatsapp_number'").run(config.whatsapp.number); db.prepare("UPDATE system_settings SET value = ? WHERE key = 'whatsapp_enabled'").run('1'); } catch (e) {}
      } else if (provider && config.providers[provider]) {
        const defaults = { mtn: { key: 'mock-mtn-key', url: 'https://api.mtn.com/v1' }, telecel: { key: 'mock-telecel-key', url: 'https://api.telecel.com/v1' }, at: { key: 'mock-at-key', url: 'https://api.at.com/v1' }, backup: { key: 'mock-backup-key', url: 'https://api.backup-provider.com/v1' } };
        if (defaults[provider]) {
          config.providers[provider].apiKey = defaults[provider].key; config.providers[provider].apiUrl = defaults[provider].url; config.providers[provider].enabled = true;
          try { const upsert = db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)"); upsert.run(`${provider}_api_key`, defaults[provider].key); upsert.run(`${provider}_api_url`, defaults[provider].url); upsert.run(`${provider}_enabled`, '1'); } catch (e) {}
        }
      }
      return res.json({ message: `${provider} settings reset to default` });
    }
    if (provider === 'whatsapp') {
      if (number) { const cleanNumber = number.replace(/\s+/g, ''); try { db.prepare("UPDATE system_settings SET value = ? WHERE key = 'whatsapp_number'").run(cleanNumber); } catch (e) {} config.whatsapp.number = cleanNumber; }
      if (enabled !== undefined) { try { db.prepare("UPDATE system_settings SET value = ? WHERE key = 'whatsapp_enabled'").run(enabled ? '1' : '0'); } catch (e) {} config.whatsapp.enabled = enabled; }
      return res.json({ message: 'WhatsApp settings updated successfully' });
    }
    if (provider && config.providers[provider]) {
      const upsert = db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)");
      if (apiKey) { config.providers[provider].apiKey = apiKey; upsert.run(`${provider}_api_key`, apiKey); }
      if (apiUrl) { config.providers[provider].apiUrl = apiUrl; upsert.run(`${provider}_api_url`, apiUrl); }
      if (enabled !== undefined) { config.providers[provider].enabled = enabled; upsert.run(`${provider}_enabled`, enabled ? '1' : '0'); }
    }
    res.json({ message: 'API settings updated successfully' });
  } catch (error) {
    console.error('API settings update error:', error);
    res.status(500).json({ error: 'Failed to update API settings' });
  }
});

router.get('/logs', authenticateToken, requireRole(['admin', 'agent']), (req, res) => {
  try {
    const { limit = 100 } = req.query;
    const orders = db.prepare(`SELECT 'order' as log_type, o.id, o.status, o.amount, o.created_at, u.name as user_name, b.name as bundle_name FROM orders o JOIN users u ON o.user_id = u.id JOIN bundles b ON o.bundle_id = b.id ORDER BY o.created_at DESC LIMIT ?`).all(parseInt(limit));
    res.json({ logs: orders });
  } catch (error) {
    console.error('Logs fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

router.get('/platform-profit', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const profitData = db.prepare(`SELECT SUM(admin_profit) as total, SUM(retail_price) as total_retail FROM transactions WHERE admin_profit > 0`).get();
    const ordersCount = db.prepare('SELECT COUNT(*) as count FROM orders').get();
    // Available profit is what's sitting in the admin_wallet (credited per order)
    const adminWallet = db.prepare("SELECT balance FROM admin_wallet WHERE id = 'ADMIN_MAIN'").get();
    const availableProfit = adminWallet ? (adminWallet.balance || 0) : 0;
    res.json({ totalProfit: profitData.total || 0, totalRetail: profitData.total_retail || 0, availableProfit, totalOrders: ordersCount.count });
  } catch (error) {
    console.error('Platform profit fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch platform profit' });
  }
});

router.get('/admin-commissions/platform-profit', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const profitData = db.prepare(`SELECT SUM(admin_profit) as total, SUM(retail_price) as total_retail FROM transactions WHERE admin_profit > 0`).get();
    const systemUser = db.prepare("SELECT wallet_balance FROM users WHERE id = 'SYSTEM_PROFIT' OR email = 'system@kthub.com'").get();
    res.json({ totalProfit: profitData.total || 0, totalRetail: profitData.total_retail || 0, availableProfit: systemUser ? systemUser.wallet_balance : 0 });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/profit-report', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { period = 'daily' } = req.query;
    let format = '%Y-%m-%d';
    if (period === 'weekly') format = '%Y-W%W';
    else if (period === 'monthly') format = '%Y-%m';
    const report = db.prepare(`SELECT strftime(?, created_at) as date, SUM(retail_price) as total_retail, SUM(wholesale_price) as total_wholesale, SUM(incentive_paid) as total_incentive, SUM(referral_paid) as total_referral, SUM(admin_profit) as total_profit, COUNT(*) as transaction_count FROM transactions WHERE type = 'purchase' AND status = 'completed' AND admin_profit > 0 GROUP BY date ORDER BY date DESC`).all(format);
    res.json({ report });
  } catch (error) {
    console.error('Profit report error:', error);
    res.status(500).json({ error: 'Failed to generate profit report' });
  }
});

router.get('/total-admin-profit', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const totalProfit = db.prepare(`SELECT SUM(admin_profit_amount) as total FROM admin_profits`).get();
    res.json({ total_admin_profit: totalProfit.total || 0 });
  } catch (error) { res.status(500).json({ error: 'Failed to fetch profit' }); }
});

// GET /api/admin/referral/all — list ALL referrals across all users with stats
router.get('/referral/all', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const referrals = db.prepare(`
      SELECT r.id, r.status, r.bonus_amount, r.lock_until, r.created_at, r.flag_reason,
             referrer.name AS referrer_name, referrer.email AS referrer_email,
             referred.name AS referred_name, referred.email AS referred_email
      FROM referrals r
      JOIN users referrer ON referrer.id = r.referrer_id
      JOIN users referred ON referred.id = r.referred_id
      ORDER BY r.created_at DESC
    `).all();

    const stats = db.prepare(`
      SELECT status, COUNT(*) as count, SUM(bonus_amount) as total
      FROM referrals GROUP BY status
    `).all();

    const summary = { pending: 0, locked: 0, completed: 0, flagged: 0, total: referrals.length };
    for (const s of stats) {
      if (summary.hasOwnProperty(s.status)) summary[s.status] = s.count;
    }

    res.json({ referrals, summary });
  } catch (error) {
    console.error('Admin all referrals error:', error);
    res.status(500).json({ error: 'Failed to fetch referrals' });
  }
});

// GET /api/admin/referral/flagged — list all flagged referrals
router.get('/referral/flagged', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const flagged = db.prepare(`
      SELECT r.id, r.status, r.bonus_amount, r.lock_until, r.created_at, r.flag_reason,
             referrer.name AS referrer_name, referrer.email AS referrer_email,
             referred.name AS referred_name, referred.email AS referred_email
      FROM referrals r
      JOIN users referrer ON referrer.id = r.referrer_id
      JOIN users referred ON referred.id = r.referred_id
      WHERE r.status = 'flagged'
      ORDER BY r.created_at DESC
    `).all();
    res.json(flagged);
  } catch (error) {
    console.error('Flagged referrals fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch flagged referrals' });
  }
});

// POST /api/admin/referral/:id/review — approve or reject a flagged referral
router.post('/referral/:id/review', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { id } = req.params;
    const { decision } = req.body; // 'approve' or 'reject'

    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ error: 'Decision must be approve or reject' });
    }

    const referral = db.prepare('SELECT * FROM referrals WHERE id = ?').get(id);
    if (!referral) return res.status(404).json({ error: 'Referral not found' });

    if (decision === 'approve') {
      // Enforce: referred user must have at least one qualifying completed order
      const minSpend = config.system?.referralMinOrderGhs ?? 15;
      const qualifying = db.prepare(
        "SELECT COUNT(*) as count FROM orders WHERE user_id = ? AND status = 'COMPLETED' AND retail_price_snapshot >= ?"
      ).get(referral.referred_id, minSpend);

      if (!qualifying || qualifying.count === 0) {
        return res.status(400).json({
          error: `Cannot approve: the referred user has not yet made a qualifying purchase of GHS ${minSpend} or more.`
        });
      }

      db.transaction(() => {
        db.prepare("UPDATE referrals SET status = 'completed' WHERE id = ?").run(id);
        db.prepare('UPDATE users SET wallet_balance = wallet_balance + ?, referral_earnings = referral_earnings + ? WHERE id = ?')
          .run(referral.bonus_amount, referral.bonus_amount, referral.referrer_id);
        db.prepare(`INSERT INTO notifications (id, user_id, title, message, type) VALUES (?, ?, ?, ?, ?)`)
          .run(uuidv4(), referral.referrer_id, 'Referral Bonus Approved!', `GHS ${referral.bonus_amount.toFixed(2)} has been credited to your wallet.`, 'success');
      })();
    } else {
      db.prepare("UPDATE referrals SET status = 'rejected' WHERE id = ?").run(id);
      db.prepare(`INSERT INTO notifications (id, user_id, title, message, type) VALUES (?, ?, ?, ?, ?)`)
        .run(uuidv4(), referral.referrer_id, 'Referral Bonus Rejected', 'A referral bonus was reviewed and could not be approved.', 'warning');
    }

    res.json({ message: `Referral ${decision}d successfully` });
  } catch (error) {
    console.error('Referral review error:', error);
    res.status(500).json({ error: 'Failed to review referral' });
  }
});

module.exports = router;
