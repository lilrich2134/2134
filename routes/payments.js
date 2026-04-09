const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const paystack = require('../services/paystack');

const router = express.Router();

// ── GET /api/payments/mode ─────────────────────────────────────────────────
// Lets the frontend know whether we are in mock or live mode
router.get('/mode', (req, res) => {
  res.json({ mockMode: paystack.MOCK_MODE });
});

// ── GET /api/payments/status/:reference ───────────────────────────────────
// Poll payment status for a given reference
router.get('/status/:reference', authenticateToken, async (req, res) => {
  try {
    const { reference } = req.params;
    const tx = db.prepare("SELECT * FROM transactions WHERE reference = ?").get(reference);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json({ status: tx.status, reference, amount: tx.amount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

// ── POST /api/payments/webhook ─────────────────────────────────────────────
// Paystack sends charge events here. Must be registered BEFORE express.json()
// so the raw body is available for signature verification.
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const rawBody = req.body; // Buffer when using express.raw()

    if (!paystack.verifyWebhookSignature(rawBody, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody.toString());
    if (event.event === 'charge.success') {
      processSuccessfulCharge(event.data);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(200); // Always 200 to Paystack so it doesn't retry on our parse error
  }
});

// ── POST /api/payments/mock-confirm/:reference ─────────────────────────────
// MOCK MODE ONLY — simulates a successful Paystack charge.success webhook.
// This endpoint is disabled in production (when a real key is set).
router.post('/mock-confirm/:reference', authenticateToken, requireRole('admin'), (req, res) => {
  if (!paystack.MOCK_MODE) {
    return res.status(403).json({ error: 'Mock confirmation is disabled in live mode' });
  }
  const { reference } = req.params;
  const result = processSuccessfulCharge({ reference, status: 'success' });
  if (result.error) return res.status(400).json(result);
  res.json({ message: 'Mock payment confirmed — wallet credited', ...result });
});

// ── POST /api/payments/mock-confirm-self/:reference ────────────────────────
// MOCK MODE ONLY — lets the customer themselves confirm their own test payment.
// This simulates what happens when they approve on their phone.
router.post('/mock-confirm-self/:reference', authenticateToken, (req, res) => {
  if (!paystack.MOCK_MODE) {
    return res.status(403).json({ error: 'Mock confirmation is disabled in live mode' });
  }
  const { reference } = req.params;
  // Check this transaction belongs to the requesting user
  const tx = db.prepare("SELECT * FROM transactions WHERE reference = ? AND type = 'topup' AND status = 'pending'").get(reference);
  if (!tx) return res.status(404).json({ error: 'Pending transaction not found' });
  if (tx.user_id !== req.user.id) return res.status(403).json({ error: 'Not your transaction' });

  const result = processSuccessfulCharge({ reference, status: 'success' });
  if (result.error) return res.status(400).json(result);
  res.json({ message: 'Payment confirmed — wallet credited', ...result });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper — credit wallet for a successful charge reference
function processSuccessfulCharge(chargeData) {
  try {
    const reference = chargeData.reference;
    const tx = db.prepare("SELECT * FROM transactions WHERE reference = ? AND type = 'topup' AND status = 'pending'").get(reference);
    if (!tx) return { error: 'No pending topup found for this reference' };

    db.prepare("UPDATE transactions SET status = 'completed' WHERE id = ?").run(tx.id);
    db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?').run(tx.amount, tx.user_id);
    db.prepare(`INSERT INTO notifications (id, user_id, title, message, type) VALUES (?, ?, ?, ?, ?)`)
      .run(uuidv4(), tx.user_id, 'Top-up Successful!', `GHS ${parseFloat(tx.amount).toFixed(2)} has been credited to your wallet via Paystack.`, 'success');

    console.log(`[Paystack] Wallet credited: user ${tx.user_id} +GHS ${tx.amount} (ref: ${reference})`);
    return { transactionId: tx.id, amount: tx.amount, userId: tx.user_id };
  } catch (err) {
    console.error('[Paystack] processSuccessfulCharge error:', err);
    return { error: err.message };
  }
}

module.exports = router;
