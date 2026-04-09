const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/dashboard', authenticateToken, requireRole('agent'), (req, res) => {
  try {
    const agentId = req.user.id;

    const totalSales = db.prepare(`
      SELECT COUNT(*) as count, SUM(amount) as total
      FROM orders
      WHERE user_id = ? AND status IN ('completed', 'COMPLETED')
    `).get(agentId);

    const pendingIncentivesData = db.prepare(`
      SELECT SUM(amount) as total
      FROM incentives
      WHERE agent_id = ? AND status = 'pending'
    `).get(agentId);

    const completedIncentivesData = db.prepare(`
      SELECT SUM(amount) as total
      FROM incentives
      WHERE agent_id = ? AND status = 'completed'
    `).get(agentId);

    const pendingPayoutsData = db.prepare(`
      SELECT SUM(amount) as total
      FROM payout_requests
      WHERE agent_id = ? AND status = 'pending'
    `).get(agentId);

    const pendingIncentives = (pendingIncentivesData.total || 0);
    const unpaidEarnings = (completedIncentivesData.total || 0) - (pendingPayoutsData.total || 0);

    const totalIncentivesData = db.prepare(`
      SELECT SUM(amount) as total
      FROM incentives
      WHERE agent_id = ? AND status = 'paid'
    `).get(agentId);

    const totalIncentives = totalIncentivesData.total || 0;

    const recentSales = db.prepare(`
      SELECT o.*, b.name as bundle_name, b.size_display
      FROM orders o
      JOIN bundles b ON o.bundle_id = b.id
      WHERE o.user_id = ?
      ORDER BY o.created_at DESC
      LIMIT 10
    `).all(agentId).map(order => {
      if (!req.user || req.user.role !== 'admin') {
        delete order.wholesale_price;
      }
      return order;
    });

    res.json({
      stats: {
        totalSalesCount: totalSales.count || 0,
        totalSalesAmount: totalSales.total || 0,
        pendingIncentives: Math.max(0, pendingIncentives),
        unpaidEarnings: Math.max(0, unpaidEarnings),
        totalIncentives: totalIncentives,
        walletBalance: req.user.wallet_balance
      },
      recentSales
    });
  } catch (error) {
    console.error('Agent dashboard fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

router.get('/incentives', authenticateToken, (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    
    // Allow admin to see incentives as an agent for testing purposes
    const agentId = req.user.id;
    
    let query = `
      SELECT i.*, o.phone_number, b.name as bundle_name
      FROM incentives i
      LEFT JOIN orders o ON i.order_id = o.id
      LEFT JOIN bundles b ON o.bundle_id = b.id
      WHERE i.agent_id = ?
    `;
    const params = [agentId];

    if (status) {
      query += ' AND i.status = ?';
      params.push(status);
    }

    query += ' ORDER BY i.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const incentives = db.prepare(query).all(...params);

    res.json({ incentives });
  } catch (error) {
    console.error('Incentives fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch incentives' });
  }
});

router.post('/invoices', authenticateToken, requireRole('agent'), (req, res) => {
  try {
    const { customerName, customerPhone, items } = req.body;

    if (!customerName || !customerPhone || !items || items.length === 0) {
      return res.status(400).json({ error: 'Customer name, phone, and items are required' });
    }

    let subtotal = 0;
    const itemsWithPrices = items.map(item => {
      const bundle = db.prepare('SELECT * FROM bundles WHERE id = ?').get(item.bundleId);
      if (!bundle) {
        throw new Error(`Bundle ${item.bundleId} not found`);
      }
      // Use Retail Price for the customer invoice
      const itemTotal = bundle.price * (item.quantity || 1);
      subtotal += itemTotal;
      return {
        ...item,
        bundleName: bundle.name,
        price: bundle.price, // Retail Price for customer
        wholesalePrice: bundle.wholesale_price,
        total: itemTotal
      };
    });

    // Agent profit calculation (Incentive Reward)
    const incentiveAmount = itemsWithPrices.reduce((sum, item) => sum + ((item.price - item.wholesalePrice) * (item.quantity || 1)), 0);
    
    const incentive = parseFloat(incentiveAmount.toFixed(2));
    const total = subtotal; // This is the amount the customer pays the agent

    const invoiceId = uuidv4();

    db.prepare(`
      INSERT INTO invoices (id, agent_id, customer_name, customer_phone, items, subtotal, incentive, total, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(invoiceId, req.user.id, customerName, customerPhone, JSON.stringify(itemsWithPrices), subtotal, incentive, total, 'pending');

    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);

    res.status(201).json({
      message: 'Invoice created successfully',
      invoice: {
        ...invoice,
        items: JSON.parse(invoice.items)
      }
    });
  } catch (error) {
    console.error('Invoice creation error:', error);
    res.status(500).json({ error: error.message || 'Failed to create invoice' });
  }
});

router.get('/invoices', authenticateToken, requireRole('agent'), (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    
    let query = 'SELECT * FROM invoices WHERE agent_id = ?';
    const params = [req.user.id];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const invoices = db.prepare(query).all(...params);

    const parsedInvoices = invoices.map(inv => ({
      ...inv,
      items: JSON.parse(inv.items)
    }));

    res.json({ invoices: parsedInvoices });
  } catch (error) {
    console.error('Invoices fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

router.get('/invoices/:id', authenticateToken, requireRole('agent'), (req, res) => {
  try {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND agent_id = ?')
      .get(req.params.id, req.user.id);

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    res.json({
      invoice: {
        ...invoice,
        items: JSON.parse(invoice.items)
      }
    });
  } catch (error) {
    console.error('Invoice fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

router.post('/payout-request', authenticateToken, requireRole('agent'), (req, res) => {
  try {
    const { amount, paymentMethod, accountDetails } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }

    if (!paymentMethod || !accountDetails) {
      return res.status(400).json({ error: 'Payment method and account details are required' });
    }

    // Check available incentives (only completed are eligible for payout)
    const incentiveData = db.prepare(`
      SELECT SUM(amount) as total FROM incentives 
      WHERE agent_id = ? AND status = 'completed'
    `).get(req.user.id);

    const availableIncentives = incentiveData.total || 0;
    
    // Check if there's already pending payout requests to subtract from available
    const pendingPayouts = db.prepare(`
      SELECT SUM(amount) as total FROM payout_requests 
      WHERE agent_id = ? AND status = 'pending'
    `).get(req.user.id);
    
    const actuallyAvailable = availableIncentives - (pendingPayouts.total || 0);

    if (actuallyAvailable < amount) {
      return res.status(400).json({ error: 'Insufficient incentive balance' });
    }

    const payoutId = uuidv4();

    db.prepare(`
      INSERT INTO payout_requests (id, agent_id, amount, payment_method, account_details, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(payoutId, req.user.id, amount, paymentMethod, accountDetails, 'pending');

    db.prepare(`
      INSERT INTO notifications (id, user_id, title, message, type)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), req.user.id, 'Payout Requested', 
      `Your payout of GHS ${amount.toFixed(2)} is pending admin approval.`, 
      'info');

    res.status(201).json({
      message: 'Payout request submitted',
      payoutId
    });
  } catch (error) {
    console.error('Payout request error:', error);
    res.status(500).json({ error: 'Failed to submit payout request' });
  }
});

router.get('/payout-requests', authenticateToken, requireRole('agent'), (req, res) => {
  try {
    const requests = db.prepare(`
      SELECT * FROM payout_requests 
      WHERE agent_id = ?
      ORDER BY created_at DESC
    `).all(req.user.id);

    res.json({ payoutRequests: requests });
  } catch (error) {
    console.error('Payout requests fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch payout requests' });
  }
});

router.get('/analytics', authenticateToken, requireRole('agent'), (req, res) => {
  try {
    const agentId = req.user.id;

    const salesByDay = db.prepare(`
      SELECT 
        strftime('%Y-%m-%d', created_at) as date,
        COUNT(*) as count,
        SUM(amount) as total
      FROM orders
      WHERE user_id = ? AND status = 'completed'
      GROUP BY date
      ORDER BY date DESC
      LIMIT 30
    `).all(agentId);

    const salesByProvider = db.prepare(`
      SELECT 
        provider,
        COUNT(*) as count,
        SUM(amount) as total
      FROM orders
      WHERE user_id = ? AND status = 'completed'
      GROUP BY provider
    `).all(agentId);

    const topBundles = db.prepare(`
      SELECT 
        b.name,
        b.provider,
        COUNT(*) as count,
        SUM(o.amount) as total
      FROM orders o
      JOIN bundles b ON o.bundle_id = b.id
      WHERE o.user_id = ? AND o.status = 'completed'
      GROUP BY o.bundle_id
      ORDER BY count DESC
      LIMIT 5
    `).all(agentId);

    res.json({ salesByDay, salesByProvider, topBundles });
  } catch (error) {
    console.error('Agent analytics fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

module.exports = router;
