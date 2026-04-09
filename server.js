const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db, initializeDatabase, seedDatabase } = require('./database');
const config = require('./config');

const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const bundleRoutes = require('./routes/bundles');
const orderRoutes = require('./routes/orders');
const referralRoutes = require('./routes/referral');
const notificationRoutes = require('./routes/notifications');
const adminRoutes = require('./routes/admin');
const agentRoutes = require('./routes/agent');
const approvalsRoutes = require('./routes/approvals');
const adminCommissionsRoutes = require('./routes/admin-commissions');
const paymentsRoutes = require('./routes/payments');
const { authenticateToken } = require('./middleware/auth');

const app = express();

// ── JWT secret safety check ──────────────────────────────────────────────────
if (config.jwt.secret === 'datahub-premium-secret-key-2024') {
  console.warn('[SECURITY WARNING] Using default JWT secret. Set JWT_SECRET environment variable before going to production!');
}

// ── Security headers ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src 'self' data: https://cdnjs.cloudflare.com https://fonts.gstatic.com https://ka-f.fontawesome.com; img-src 'self' data: https:; connect-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://ka-f.fontawesome.com; frame-ancestors *;"
  );
  next();
});

// ── Rate limiting ────────────────────────────────────────────────────────────
const loginAttempts = new Map(); // IP → { count, resetAt }

function loginRateLimit(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || '').split(',')[0].trim();
  // Skip rate limiting for loopback/local addresses
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 15 * 60 * 1000; }
  entry.count++;
  loginAttempts.set(ip, entry);
  if (entry.count > 20) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
  }
  next();
}

// Clean up old rate-limit entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts.entries()) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 30 * 60 * 1000);

const allowedOrigins = process.env.ALLOWED_ORIGIN
  ? process.env.ALLOWED_ORIGIN.split(',').map(o => o.trim())
  : null; // null = allow all in development

app.use(cors({
  origin: allowedOrigins || true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  // Maintenance mode check
  if (config.system?.maintenanceMode) {
    // Allow admin and specific bypass paths
    const bypassPaths = ['/api/auth/login', '/api/admin/system-settings', '/api/admin/api-settings', '/api/config', '/api/bundles/providers'];
    const isAdmin = req.headers.authorization && req.headers.authorization.includes('admin'); // Simple check, auth middleware handles properly later
    
    // Check if path starts with any bypass path or is a GET for static assets (frontend needs to load)
    const isApiRequest = req.path.startsWith('/api');
    const isBypass = bypassPaths.some(p => req.path.startsWith(p));
    
    if (isApiRequest && !isBypass && !req.path.includes('/auth/me')) {
      // We'll let the actual auth middleware decide if they are admin, 
      // but for now we block if it looks like a non-admin API call
      // The real enforcement happens in a middleware after auth
    }
  }
  next();
});

// Real maintenance middleware that runs after auth
const maintenanceMiddleware = (req, res, next) => {
  if (config.system?.maintenanceMode && req.user?.role !== 'admin') {
    const bypassPaths = ['/api/auth/login', '/api/admin/system-settings', '/api/admin/api-settings'];
    if (!bypassPaths.some(p => req.path.startsWith(p))) {
      return res.status(503).json({ error: 'System is currently under maintenance. Please try again later.' });
    }
  }
  next();
};

app.post('/api/auth/login', loginRateLimit);
app.post('/api/auth/signup', loginRateLimit);
app.use('/api/auth', authRoutes);
app.use('/api/wallet', authenticateToken, maintenanceMiddleware, walletRoutes);
app.use('/api/bundles', (req, res, next) => {
  // Bundles can be viewed during maintenance, but not bought
  next();
}, bundleRoutes);
app.use('/api/orders', authenticateToken, maintenanceMiddleware, orderRoutes);
app.use('/api/referral', authenticateToken, maintenanceMiddleware, referralRoutes);
app.use('/api/notifications', authenticateToken, maintenanceMiddleware, notificationRoutes);
app.use('/api/admin', authenticateToken, adminRoutes);
app.use('/api/agent', authenticateToken, maintenanceMiddleware, agentRoutes);
app.use('/api/approvals', authenticateToken, maintenanceMiddleware, approvalsRoutes);
app.use('/api/admin-commissions', authenticateToken, adminCommissionsRoutes);
// Payments & Paystack webhook — webhook uses raw body (express.raw), others use json
app.use('/api/payments', paymentsRoutes);

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    providers: ['MTN', 'Telecel', 'AT'],
    mockMode: true,
    maintenanceMode: config.system?.maintenanceMode ?? false
  });
});

// Admin-only: toggle slow mode
app.post('/api/config/slow-mode', authenticateToken, (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { enabled } = req.body;
  config.mock.slowMode = !!enabled;
  res.json({ 
    message: `Slow mode ${enabled ? 'enabled' : 'disabled'}`,
    slowMode: config.mock.slowMode
  });
});

const frontendPath = path.resolve(__dirname, '../frontend');
const noCache = { maxAge: 0, etag: false, lastModified: false, setHeaders: (res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}};
app.use('/css', express.static(path.join(frontendPath, 'css'), noCache));
app.use('/js', express.static(path.join(frontendPath, 'js'), noCache));
app.use('/icons', express.static(path.join(frontendPath, 'icons')));
app.use('/images', express.static(path.join(frontendPath, 'images')));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(frontendPath, 'manifest.json')));
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(frontendPath, 'sw.js'));
});

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(frontendPath, 'index.html'));
});

app.get('/*path', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(frontendPath, 'index.html'), (err) => {
    if (err) next(err);
  });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Cron job simulation: Process locked referral bonuses
setInterval(() => {
  try {
    const now = new Date().toISOString();
    const lockedReferrals = db.prepare("SELECT * FROM referrals WHERE status = 'locked' AND lock_until <= ?").all(now);
    
    for (const ref of lockedReferrals) {
      const referrer = db.prepare('SELECT is_verified FROM users WHERE id = ?').get(ref.referrer_id);
      const referred = db.prepare('SELECT is_verified FROM users WHERE id = ?').get(ref.referred_id);
      
      // Rule 6: OTP Verification - Both must be verified (or at least the referred)
      if (referred.is_verified) {
        const processRef = db.transaction(() => {
          db.prepare("UPDATE referrals SET status = 'completed' WHERE id = ?").run(ref.id);
          db.prepare('UPDATE users SET wallet_balance = wallet_balance + ?, referral_earnings = referral_earnings + ? WHERE id = ?')
            .run(ref.bonus_amount, ref.bonus_amount, ref.referrer_id);
            
          db.prepare(`
            INSERT INTO notifications (id, user_id, title, message, type)
            VALUES (?, ?, ?, ?, ?)
          `).run(uuidv4(), ref.referrer_id, 'Referral Bonus Credited!', `GHS ${ref.bonus_amount.toFixed(2)} has been added to your wallet for your referral.`, 'success');
        });
        processRef();
      }
    }
  } catch (e) {
    console.error('Error processing locked referrals:', e.message);
  }
}, 60000); // Check every minute

initializeDatabase();
seedDatabase();

// Seed a demo flagged referral so admin can see the panel in action
try {
  const existingFlagged = db.prepare("SELECT id FROM referrals WHERE status = 'flagged' LIMIT 1").get();
  if (!existingFlagged) {
    const customer = db.prepare("SELECT id FROM users WHERE role = 'customer' LIMIT 1").get();
    const agent = db.prepare("SELECT id FROM users WHERE role = 'agent' LIMIT 1").get();
    if (customer && agent) {
      // Check that this referred user isn't already in the referrals table (unique constraint)
      const alreadyReferred = db.prepare("SELECT id FROM referrals WHERE referred_id = ?").get(customer.id);
      if (!alreadyReferred) {
        db.prepare(`
          INSERT INTO referrals (id, referrer_id, referred_id, status, bonus_amount, flag_reason)
          VALUES (?, ?, ?, 'flagged', 5.00, 'Multiple accounts detected from same IP address')
        `).run(uuidv4(), agent.id, customer.id);
      }
    }
  }
} catch (e) {
  // Ignore — demo seed is optional
}

// Temporary migration to update network names
try {
  db.prepare("UPDATE bundles SET provider = 'Telecel', name = REPLACE(name, 'Vodafone', 'Telecel') WHERE provider = 'Vodafone'").run();
  db.prepare("UPDATE bundles SET provider = 'AT', name = REPLACE(REPLACE(name, 'AirtelTigo', 'AT'), 'Airtel', 'AT') WHERE provider = 'AirtelTigo' OR provider = 'Airtel'").run();
  console.log('Branding migration: Vodafone -> Telecel, AirtelTigo -> AT applied');
} catch (e) {
  console.log('Migration error:', e.message);
}

// Migration: milestone_claims deduplication table
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS milestone_claims (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      milestone_count INTEGER NOT NULL,
      claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, milestone_count)
    )
  `);
  console.log('Milestone claims table ready');
} catch (e) {
  console.log('Milestone migration error:', e.message);
}

// Migration: add reset_token columns if missing
try {
  db.exec(`ALTER TABLE users ADD COLUMN reset_token TEXT`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE users ADD COLUMN reset_expires TEXT`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE users ADD COLUMN flag_reason TEXT`);
} catch (_) {}
// Migration: add flag_reason to referrals if missing
try {
  db.exec(`ALTER TABLE referrals ADD COLUMN flag_reason TEXT`);
} catch (_) {}

// ── Load persisted system_settings from DB into config on boot ────────────────
try {
  const upsertDefault = db.prepare("INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)");
  upsertDefault.run('referral_bonus_ghs', '2.00');
  upsertDefault.run('referral_min_order_ghs', '15.00');

  const rows = db.prepare("SELECT key, value FROM system_settings").all();
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  if (!config.system) config.system = {};
  if (s.maintenance_mode !== undefined)  config.system.maintenanceMode    = s.maintenance_mode === '1';
  if (s.global_discount !== undefined)   config.system.globalDiscount      = parseFloat(s.global_discount);
  if (s.min_wallet_topup !== undefined)  config.system.minWalletTopup      = parseFloat(s.min_wallet_topup);
  if (s.max_wallet_topup !== undefined)  config.system.maxWalletTopup      = parseFloat(s.max_wallet_topup);
  if (s.referral_bonus_ghs !== undefined)  config.system.referralBonusGhs   = parseFloat(s.referral_bonus_ghs);
  if (s.referral_min_order_ghs !== undefined) config.system.referralMinOrderGhs = parseFloat(s.referral_min_order_ghs);
  if (s.slow_mode !== undefined)         config.mock.slowMode              = s.slow_mode === '1';
  console.log(`[CONFIG] Referral bonus: GHS ${config.system.referralBonusGhs} | Min order: GHS ${config.system.referralMinOrderGhs}`);
} catch (e) {
  console.warn('[CONFIG] Failed to load system_settings from DB:', e.message);
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   KT-Hub Premium Server Running                           ║
║                                                           ║
║   Server:   http://0.0.0.0:${PORT}                           ║
║   Env:      ${config.nodeEnv.padEnd(32)}       ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
