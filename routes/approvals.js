const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const emailService = require('../services/emailService');
const whatsappService = require('../services/whatsappService');

const router = express.Router();

router.get('/pending-users', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const users = db.prepare(`
      SELECT id, email, name, phone, role, requested_role, approval_status, is_verified, created_at 
      FROM users 
      WHERE id != 'SYSTEM_PROFIT' AND email != 'system@kthub.com'
      ORDER BY created_at DESC
    `).all();

    res.json({
      message: 'All users',
      count: users.length,
      users
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.post('/approve-user/:userId', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { approvalNotes } = req.body;

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    db.prepare(`
      UPDATE users 
      SET is_approved = 1, approval_status = 'approved', updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(userId);

    db.prepare(`
      INSERT INTO notifications (id, user_id, title, message, type)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      userId,
      '✅ Account Approved!',
      'Your KT-Hub account has been approved by admin. You can now log in.',
      'success'
    );

    res.json({
      message: 'User approved successfully',
      user: { id: user.id, email: user.email, name: user.name }
    });
  } catch (error) {
    console.error('Error approving user:', error);
    res.status(500).json({ error: 'Failed to approve user' });
  }
});

router.post('/deny-user/:userId', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    db.prepare(`
      UPDATE users 
      SET approval_status = 'denied', updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(userId);

    db.prepare(`
      INSERT INTO notifications (id, user_id, title, message, type)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      userId,
      '❌ Account Denied',
      `Your KT-Hub account registration was denied. Reason: ${reason || 'Not specified'}`,
      'danger'
    );

    res.json({
      message: 'User denied successfully',
      user: { id: user.id, email: user.email, name: user.name }
    });
  } catch (error) {
    console.error('Error denying user:', error);
    res.status(500).json({ error: 'Failed to deny user' });
  }
});

router.get('/role-change-requests', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const users = db.prepare(`
      SELECT id, email, name, phone, role, requested_role, approval_status, wallet_balance, created_at
      FROM users
      WHERE approval_status = 'pending_role_change'
        AND id != 'SYSTEM_PROFIT'
      ORDER BY created_at DESC
    `).all();
    res.json({ requests: users });
  } catch (error) {
    console.error('Error fetching role change requests:', error);
    res.status(500).json({ error: 'Failed to fetch role change requests' });
  }
});

router.post('/request-role-change', authenticateToken, async (req, res) => {
  try {
    const { requestedRole } = req.body;
    const userId = req.user.id;

    if (!requestedRole || !['customer', 'agent', 'admin'].includes(requestedRole)) {
      return res.status(400).json({ error: 'Invalid requested role' });
    }

    db.prepare(`
      UPDATE users 
      SET requested_role = ?, approval_status = 'pending_role_change', updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(requestedRole, userId);

    db.prepare(`
      INSERT INTO notifications (id, user_id, title, message, type)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      userId,
      '⏳ Role Change Request Submitted',
      `Your request to change role to ${requestedRole} has been submitted for admin approval.`,
      'info'
    );

    emailService.sendApprovalNotification(req.user.email, req.user.name, 'role_change');
    whatsappService.sendApprovalNotification(req.user.email, req.user.name, 'role_change');

    res.json({
      message: 'Role change request submitted',
      requestedRole,
      status: 'pending_role_change'
    });
  } catch (error) {
    console.error('Error requesting role change:', error);
    res.status(500).json({ error: 'Failed to submit role change request' });
  }
});

router.post('/approve-role-change/:userId', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { userId } = req.params;

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || !user.requested_role) {
      return res.status(400).json({ error: 'No pending role change for this user' });
    }

    const newRole = user.requested_role;
    db.prepare(`
      UPDATE users 
      SET role = ?, requested_role = NULL, approval_status = 'approved', updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(newRole, userId);

    db.prepare(`
      INSERT INTO notifications (id, user_id, title, message, type)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      userId,
      '✅ Role Updated',
      `Your role has been updated to ${newRole}. Log in again to see changes.`,
      'success'
    );

    res.json({
      message: 'Role change approved',
      user: { id: user.id, email: user.email, name: user.name, newRole }
    });
  } catch (error) {
    console.error('Error approving role change:', error);
    res.status(500).json({ error: 'Failed to approve role change' });
  }
});

router.post('/deny-role-change/:userId', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || !user.requested_role) {
      return res.status(400).json({ error: 'No pending role change for this user' });
    }

    db.prepare(`
      UPDATE users 
      SET requested_role = NULL, approval_status = 'approved', updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(userId);

    db.prepare(`
      INSERT INTO notifications (id, user_id, title, message, type)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      userId,
      '❌ Role Change Denied',
      `Your role change request was denied. Reason: ${reason || 'Not specified'}`,
      'warning'
    );

    res.json({
      message: 'Role change denied',
      user: { id: user.id, email: user.email, name: user.name }
    });
  } catch (error) {
    console.error('Error denying role change:', error);
    res.status(500).json({ error: 'Failed to deny role change' });
  }
});

router.post('/change-user-role/:userId', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { newRole } = req.body;

    if (!newRole || !['customer', 'agent', 'admin'].includes(newRole)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const oldRole = user.role;

    db.prepare(`
      UPDATE users 
      SET role = ?, requested_role = NULL, approval_status = 'approved', updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(newRole, userId);

    db.prepare(`
      INSERT INTO notifications (id, user_id, title, message, type)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      userId,
      '🔄 Role Updated by Admin',
      `Your role has been changed from ${oldRole} to ${newRole} by admin.`,
      'success'
    );

    res.json({
      message: 'User role updated successfully',
      user: { id: user.id, email: user.email, name: user.name, oldRole, newRole }
    });
  } catch (error) {
    console.error('Error changing user role:', error);
    res.status(500).json({ error: 'Failed to change user role' });
  }
});

// ── Account Deletion Requests ──────────────────────────────────────────────

router.get('/deletion-requests', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const requests = db.prepare(`
      SELECT adr.id, adr.user_id, adr.reason, adr.status, adr.created_at,
             u.name, u.email, u.role, u.wallet_balance, u.phone
      FROM account_deletion_requests adr
      JOIN users u ON u.id = adr.user_id
      WHERE adr.status = 'pending'
      ORDER BY adr.created_at DESC
    `).all();
    res.json({ requests });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load deletion requests' });
  }
});

router.post('/approve-deletion/:userId', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { userId } = req.params;
    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'admin') return res.status(403).json({ error: 'Cannot delete admin accounts' });
    db.prepare("UPDATE users SET email = 'deleted_' || id || '@deleted.com', name = 'Deleted User', is_deleted = 1, deletion_pending = 0 WHERE id = ?").run(userId);
    db.prepare("UPDATE account_deletion_requests SET status = 'approved' WHERE user_id = ? AND status = 'pending'").run(userId);
    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

router.post('/deny-deletion/:userId', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { userId } = req.params;
    db.prepare('UPDATE users SET deletion_pending = 0 WHERE id = ?').run(userId);
    db.prepare("UPDATE account_deletion_requests SET status = 'denied' WHERE user_id = ? AND status = 'pending'").run(userId);
    res.json({ message: 'Deletion request denied' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to deny request' });
  }
});

module.exports = router;
