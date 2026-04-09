const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authenticateToken } = require('../middleware/auth');
const config = require('../config');
const MockProvider = require('../utils/mockProvider');

const router = express.Router();

/**
 * Helper to record wallet movement in the ledger
 */
function recordLedger(userId, type, amount, reason, referenceId, triggeredBy = 'system') {
  const user = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(userId);
  const balanceAfter = user.wallet_balance;
  const balanceBefore = type === 'CREDIT' ? balanceAfter - amount : balanceAfter + amount;

  db.prepare(`
    INSERT INTO wallet_ledger (id, user_id, type, amount, balance_before, balance_after, description, reference_id, triggered_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), userId, type, amount, balanceBefore, balanceAfter, reason, referenceId, triggeredBy);
}

router.post('/', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  // Block Admins from purchasing
  if (req.user.role === 'admin') {
    return res.status(403).json({ 
      error: 'Purchase Failed', 
      detail: 'Admin accounts are restricted from making purchases. Please use a customer or agent account for buying bundles.' 
    });
  }

  let orderId, transactionId, price, bundle;

  try {
    const { bundleId, phoneNumber } = req.body;

    // 1. INPUT VALIDATION
    if (!bundleId || !phoneNumber) {
      return res.status(400).json({ error: 'Purchase Failed', detail: 'Bundle ID and phone number are required' });
    }

    // 2. BUNDLE & PROVIDER VALIDATION
    bundle = db.prepare('SELECT * FROM bundles WHERE id = ?').get(bundleId);
    if (!bundle) {
      return res.status(404).json({ error: 'Purchase Failed', detail: 'Bundle not found' });
    }

    if (bundle.status !== 'active') {
      return res.status(400).json({ error: 'Purchase Failed', detail: 'This bundle is currently inactive' });
    }

    if (!bundle.provider_bundle_code || bundle.provider_bundle_code.trim() === '') {
      return res.status(400).json({ error: 'Purchase Failed', detail: 'Bundle is not properly mapped to provider' });
    }

    const config = require('../config');
    const providerKey = bundle.provider.toLowerCase();
    const providerConfig = config.providers[providerKey];
    
    if (!providerConfig) {
      return res.status(400).json({ error: 'Purchase Failed', detail: 'Provider configuration missing' });
    }

    const isProviderDisabled = providerConfig.enabled === false;
    const isBackupEnabled = config.providers.backup && config.providers.backup.enabled;

    if (isProviderDisabled && !isBackupEnabled) {
      return res.status(400).json({ error: 'Purchase Failed', detail: `The ${bundle.provider} network is currently unavailable.` });
    }
    
    const globalDiscount = parseFloat(config.system?.globalDiscount || 0);
    price = bundle.retail_price;
    if (req.user.role === 'customer' && globalDiscount > 0) {
      price = parseFloat((price * (1 - globalDiscount / 100)).toFixed(2));
    }
    
    // 3. ATOMIC WALLET DEDUCTION & ORDER CREATION
    try {
      const transactionFn = db.transaction(() => {
        const user = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(userId);
        if (!user) throw new Error('User not found');
        
        if (user.wallet_balance < price) {
          throw new Error('Insufficient wallet balance');
        }

        // Deduct balance
        db.prepare('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?').run(price, userId);

        const newOrderId = uuidv4();
        const newTransactionId = uuidv4();

        // Create order
        db.prepare(`
          INSERT INTO orders (id, user_id, bundle_id, phone_number, amount, status, provider, eta_minutes, retail_price_snapshot, wholesale_price_snapshot)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(newOrderId, userId, bundleId, phoneNumber, price, 'PROCESSING', bundle.provider, bundle.eta_minutes, bundle.retail_price, bundle.wholesale_price);

        // Create transaction record
        db.prepare(`
          INSERT INTO transactions (id, user_id, type, amount, description, status, reference, payment_method, retail_price, wholesale_price)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(newTransactionId, userId, 'purchase', price, `${bundle.name} to ${phoneNumber}`, 'pending', newOrderId, 'wallet', price, bundle.wholesale_price);

        // Record Ledger Entry
        recordLedger(userId, 'DEBIT', price, `Purchase: ${bundle.name}`, newOrderId);

        return { orderId: newOrderId, transactionId: newTransactionId };
      });

      const result = transactionFn();
      orderId = result.orderId;
      transactionId = result.transactionId;
    } catch (txError) {
      console.error('Wallet deduction error:', txError);
      return res.status(400).json({ error: 'Purchase Failed', detail: txError.message });
    }

    // 4. RETURN IMMEDIATELY (ASYNC EXECUTION)
    res.status(202).json({
      success: true,
      message: 'Order Placed',
      orderId,
      status: 'PROCESSING'
    });

    // 5. EXTERNAL PROVIDER API CALL (OUTSIDE REQUEST LOOP)
    (async () => {
      console.log(`[ORDER-EXEC] START ASYNC: OrderId=${orderId}, Bundle=${bundle.name}, Provider=${bundle.provider}`);
      let apiResult;
      try {
        if (!bundle.provider_bundle_code || !bundle.provider) {
          throw new Error(`Data Integrity Error: Missing provider info for bundle ${bundle.id}`);
        }

        apiResult = await MockProvider.processWithFailover({ 
          orderId, 
          bundleCode: bundle.provider_bundle_code,
          network: bundle.network
        }, bundle.provider);
      } catch (apiError) {
        console.error(`[ORDER-EXEC] ASYNC-ERROR: OrderId=${orderId}, Error=`, apiError);
        apiResult = { success: false, error: apiError.message || 'Provider connection failed' };
      }

      // 6. ASYNC FINALIZATION OR ROLLBACK
      const isActuallySuccessful = apiResult.success === true || 
                                  apiResult.status === 'SUCCESS' || 
                                  (apiResult.providerRef && !apiResult.error);

      if (isActuallySuccessful) {
        console.log(`[ORDER-EXEC] ASYNC-COMPLETED: OrderId=${orderId}`);
        try {
          const finalizeTransactionFn = db.transaction(() => {
            db.prepare(`
              UPDATE orders 
              SET status = 'COMPLETED', provider_ref = ?, backup_used = ?, updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(apiResult.providerRef, apiResult.backupUsed ? 1 : 0, orderId);

            db.prepare("UPDATE transactions SET status = 'COMPLETED' WHERE id = ?").run(transactionId);

            // Calculate and distribute profits/incentives
            const retailPrice = price; // Use the actual paid price
            const wholesalePrice = bundle.wholesale_price;
            const totalProfit = parseFloat((retailPrice - wholesalePrice).toFixed(2));

            let agentIncentive = 0;
            // Fetch fresh user role for async context
            const userForIncentive = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
            if (userForIncentive && userForIncentive.role === 'agent') {
              const providerName = bundle.provider === 'Vodafone' ? 'Telecel' : (bundle.provider === 'AirtelTigo' ? 'AT' : bundle.provider);
              const incentiveConfig = db.prepare('SELECT * FROM incentive_settings WHERE provider = ?').get(providerName);
              if (incentiveConfig && incentiveConfig.enabled) {
                agentIncentive = parseFloat((totalProfit * (incentiveConfig.percentage / 100)).toFixed(2));
              }
            }
            
            const adminProfit = parseFloat((totalProfit - agentIncentive).toFixed(2));

            db.prepare(`
              INSERT INTO admin_profits (id, order_id, bundle_id, admin_profit_amount)
              VALUES (?, ?, ?, ?)
            `).run(uuidv4(), orderId, bundle.id, adminProfit);

            db.prepare('UPDATE admin_wallet SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
              .run(adminProfit, 'ADMIN_MAIN');
            
            db.prepare(`
              INSERT INTO admin_wallet_history (id, type, amount, description, reference_id)
              VALUES (?, ?, ?, ?, ?)
            `).run(uuidv4(), 'credit', adminProfit, `Net profit from order ${orderId}`, orderId);

            if (agentIncentive > 0) {
              db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?').run(agentIncentive, userId);
              db.prepare(`
                INSERT INTO incentives (id, agent_id, order_id, amount, status, paid_at, created_at)
                VALUES (?, ?, ?, ?, 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
              `).run(uuidv4(), userId, orderId, agentIncentive);
              
              db.prepare(`
                INSERT INTO transactions (id, user_id, type, amount, description, status, reference, payment_method)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `).run(uuidv4(), userId, 'incentive', agentIncentive, `Incentive for order ${orderId}`, 'completed', 'INC-' + orderId.substring(0, 8), 'system');
              
              recordLedger(userId, 'CREDIT', agentIncentive, `Incentive: Order ${orderId}`, orderId);
            }

            db.prepare('UPDATE transactions SET admin_profit = ? WHERE id = ?').run(adminProfit, transactionId);

            // Referral logic: Minimum Purchase Rule & Bonus Lock
            const referral = db.prepare("SELECT * FROM referrals WHERE referred_id = ? AND status = 'pending'").get(userId);
            if (referral && price >= (config.system.referralMinOrderGhs || 15)) {
              // Check Daily Referral Reward Limit (e.g., GHS 100)
              const todayEarnings = db.prepare("SELECT SUM(bonus_amount) as total FROM referrals WHERE referrer_id = ? AND status = 'completed' AND created_at > date('now')").get(referral.referrer_id);
              const limit = config.system?.referralDailyCap ?? 100;
              
              if ((todayEarnings.total || 0) >= limit) {
                db.prepare("UPDATE referrals SET status = 'flagged', flag_reason = 'Daily reward limit exceeded' WHERE id = ?").run(referral.id);
                db.prepare(`
                  INSERT INTO notifications (id, user_id, title, message, type)
                  VALUES (?, ?, ?, ?, ?)
                `).run(uuidv4(), referral.referrer_id, 'Referral Limit Reached', `You have reached your daily referral reward limit. Further rewards are pending review.`, 'warning');
              } else {
                // Threshold 3: Refunds exceed 2 in 48 hours
                const recentRefunds = db.prepare("SELECT COUNT(*) as count FROM orders WHERE user_id = ? AND status = 'REFUNDED' AND updated_at > datetime('now', '-2 days')").get(userId);
                if (recentRefunds.count > 2) {
                   db.prepare("UPDATE referrals SET status = 'flagged', flag_reason = 'Excessive refunds detected' WHERE id = ?").run(referral.id);
                } else {
                  const lockHours = config.system?.referralLockHours ?? 48;
                  const lockUntil = new Date(Date.now() + lockHours * 60 * 60 * 1000).toISOString();
                  db.prepare("UPDATE referrals SET status = 'locked', lock_until = ? WHERE id = ?").run(lockUntil, referral.id);
                  
                  db.prepare(`
                    INSERT INTO notifications (id, user_id, title, message, type)
                    VALUES (?, ?, ?, ?, ?)
                  `).run(uuidv4(), referral.referrer_id, 'Referral Bonus Locked', `Your bonus for referring a user is locked for ${lockHours} hours for verification.`, 'info');
                }
              }
            }
          });
          finalizeTransactionFn();
        } catch (finalizeError) {
          console.error(`[ORDER-EXEC] ASYNC-FINALIZE-CRASH: OrderId=${orderId}`, finalizeError);
        }
      } else {
        // ASYNC FAILURE: Automatic Refund
        console.log(`[ORDER-EXEC] ASYNC-FAILURE-REFUNDING: OrderId=${orderId}, Reason=${apiResult.error || 'Unknown'}`);
        try {
          const failTransactionFn = db.transaction(() => {
            db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?').run(price, userId);
            // Mark as REFUNDED (not FAILED) so admin cannot accidentally double-refund
            db.prepare("UPDATE orders SET status = 'REFUNDED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
            db.prepare("UPDATE transactions SET status = 'FAILED', description = description || ' (Failed: ' || ? || ')' WHERE id = ?").run(apiResult.error || 'API Error', transactionId);
            
            recordLedger(userId, 'CREDIT', price, `Automatic Refund: Order ${orderId}`, orderId);

            db.prepare(`
              INSERT INTO notifications (id, user_id, title, message, type)
              VALUES (?, ?, ?, ?, ?)
            `).run(uuidv4(), userId, 'Order Failed – Refunded', `Your order for ${bundle.name} could not be delivered. GHS ${price.toFixed(2)} has been returned to your wallet.`, 'error');
          });
          failTransactionFn();
        } catch (failError) {
          console.error(`[ORDER-EXEC] ASYNC-FAIL-CRASH: OrderId=${orderId}`, failError);
        }
      }
    })();

  } catch (error) {
    console.error('CRITICAL ORDER ERROR:', error);
    
    // CRITICAL: Ensure rollback if order was created but crashed before API/Finalization
    if (orderId) {
      try {
        const rollbackTransactionFn = db.transaction(() => {
          db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?').run(price, userId);
          db.prepare("UPDATE orders SET status = 'FAILED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
          if (transactionId) {
            db.prepare("UPDATE transactions SET status = 'failed' WHERE id = ?").run(transactionId);
          }
          recordLedger(userId, 'CREDIT', price, `System Crash Refund: Order ${orderId}`, orderId);
        });
        rollbackTransactionFn();
      } catch (rollbackErr) {
        console.error('Double failure during rollback:', rollbackErr);
      }
    }

    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: 'Purchase Failed', detail: error.message || 'Internal server error' });
    }
  }
});

// Manual Refund Endpoint (Admin only)
router.post('/:id/refund', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const orderId = req.params.id;
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    
    if (order.refunded === 1) {
      return res.status(400).json({ error: 'Order already refunded' });
    }

    if (order.status !== 'FAILED' && order.status !== 'CANCELLED') {
      return res.status(400).json({ error: 'Only FAILED or CANCELLED orders can be manually refunded' });
    }

    const manualRefundTransactionFn = db.transaction(() => {
      db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?').run(order.amount, order.user_id);
      db.prepare("UPDATE orders SET status = 'REFUNDED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
      
      recordLedger(order.user_id, 'CREDIT', order.amount, `Manual Admin Refund: Order ${orderId}`, orderId, 'admin');
      
      db.prepare(`
        INSERT INTO notifications (id, user_id, title, message, type)
        VALUES (?, ?, ?, ?, ?)
      `).run(uuidv4(), order.user_id, 'Refund Processed', `A refund of GHS ${order.amount.toFixed(2)} for order ${orderId} has been credited to your wallet.`, 'success');
    });
    
    manualRefundTransactionFn();

    res.json({ message: 'Refund processed successfully' });
  } catch (error) {
    console.error('Refund error:', error);
    res.status(500).json({ error: 'Failed to process refund' });
  }
});

router.get('/', authenticateToken, (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    let query = `
      SELECT o.*, b.name as bundle_name, b.size_display, b.provider as bundle_provider
      FROM orders o
      JOIN bundles b ON o.bundle_id = b.id
      WHERE o.user_id = ?
    `;
    const params = [req.user.id];
    if (status) {
      query += ' AND o.status = ?';
      params.push(status);
    }
    query += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    const orders = db.prepare(query).all(...params);
    const totalCount = db.prepare('SELECT COUNT(*) as total FROM orders WHERE user_id = ?').get(req.user.id);
    res.json({ orders, total: totalCount.total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (error) {
    console.error('Orders fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

router.get('/:id', authenticateToken, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const order = isAdmin
      ? db.prepare(`
          SELECT o.*, b.name as bundle_name, b.size_display, b.provider as bundle_provider, b.validity_days,
                 u.name as customer_name, u.email as customer_email
          FROM orders o
          JOIN bundles b ON o.bundle_id = b.id
          JOIN users u ON o.user_id = u.id
          WHERE o.id = ?
        `).get(req.params.id)
      : db.prepare(`
          SELECT o.*, b.name as bundle_name, b.size_display, b.provider as bundle_provider, b.validity_days
          FROM orders o
          JOIN bundles b ON o.bundle_id = b.id
          WHERE o.id = ? AND o.user_id = ?
        `).get(req.params.id, req.user.id);

    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!isAdmin) delete order.wholesale_price_snapshot;
    res.json({ order });
  } catch (error) {
    console.error('Order fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

module.exports = router;
