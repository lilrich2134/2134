const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const dbPath = path.join(__dirname, 'kthub.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      role TEXT DEFAULT 'customer',
      is_approved INTEGER DEFAULT 1,
      is_verified INTEGER DEFAULT 0,
      requested_role TEXT,
      approval_status TEXT DEFAULT 'approved',
      wallet_balance REAL DEFAULT 0,
      referral_code TEXT UNIQUE,
      referred_by TEXT,
      referral_earnings REAL DEFAULT 0,
      signup_ip TEXT,
      device_fingerprint TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id TEXT PRIMARY KEY,
      referrer_id TEXT NOT NULL,
      referred_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending', -- pending, locked, completed, flagged
      bonus_amount REAL DEFAULT 0,
      lock_until DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (referrer_id) REFERENCES users(id),
      FOREIGN KEY (referred_id) REFERENCES users(id),
      UNIQUE(referred_id)
    );

    CREATE TABLE IF NOT EXISTS bundles (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      network TEXT NOT NULL,
      name TEXT NOT NULL,
      provider_bundle_code TEXT NOT NULL,
      size_mb INTEGER NOT NULL,
      size_display TEXT NOT NULL,
      price REAL NOT NULL,
      retail_price REAL NOT NULL,
      wholesale_price REAL NOT NULL,
      validity_days INTEGER DEFAULT 30,
      eta_minutes INTEGER DEFAULT 5,
      popular INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      bundle_id TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      provider TEXT NOT NULL,
      provider_ref TEXT,
      backup_used INTEGER DEFAULT 0,
      eta_minutes INTEGER DEFAULT 5,
      retail_price_snapshot REAL,
      wholesale_price_snapshot REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (bundle_id) REFERENCES bundles(id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'completed',
      reference TEXT,
      payment_method TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'info',
      read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      items TEXT NOT NULL,
      subtotal REAL NOT NULL,
      incentive REAL DEFAULT 0,
      total REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS account_deletion_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS incentives (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      order_id TEXT,
      amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      paid_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES users(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS payout_requests (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL,
      account_details TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      processed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Add incentive settings table
    CREATE TABLE IF NOT EXISTS incentive_settings (
      provider TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      percentage REAL DEFAULT 3.0,
      cap REAL DEFAULT 0.30,
      min_margin REAL DEFAULT 0.40
    );

    CREATE TABLE IF NOT EXISTS admin_profits (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      bundle_id TEXT NOT NULL,
      admin_profit_amount REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (bundle_id) REFERENCES bundles(id)
    );

    CREATE TABLE IF NOT EXISTS admin_wallet (
      id TEXT PRIMARY KEY,
      balance REAL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS admin_wallet_history (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL, -- 'credit', 'debit'
      amount REAL NOT NULL,
      description TEXT,
      reference_id TEXT, -- e.g. order_id
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS wallet_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_before REAL NOT NULL,
      balance_after REAL NOT NULL,
      description TEXT,
      reference_id TEXT,
      triggered_by TEXT DEFAULT 'system',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS retail_price_logs (
      id TEXT PRIMARY KEY,
      bundle_id TEXT NOT NULL,
      admin_id TEXT NOT NULL,
      old_price REAL NOT NULL,
      new_price REAL NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bundle_id) REFERENCES bundles(id),
      FOREIGN KEY (admin_id) REFERENCES users(id)
    );
  `);

  // Initialize default system settings
  const defaultSettings = [
    { key: 'whatsapp_number', value: '+233XXXXXXXXX' },
    { key: 'whatsapp_enabled', value: '1' },
    { key: 'maintenance_mode', value: '0' },
    { key: 'global_discount', value: '0' },
    { key: 'min_wallet_topup', value: '1' },
    { key: 'max_wallet_topup', value: '1000' },
    { key: 'slow_mode', value: '0' },
    { key: 'mock_failure_rate', value: '0' },
    { key: 'referral_daily_cap', value: '100' },
    { key: 'referral_lock_hours', value: '48' },
    { key: 'registration_enabled', value: '1' },
    { key: 'mtn_api_key', value: 'mock-mtn-key' },
    { key: 'mtn_api_url', value: 'https://api.mtn.com/v1' },
    { key: 'mtn_enabled', value: '1' },
    { key: 'telecel_api_key', value: 'mock-telecel-key' },
    { key: 'telecel_api_url', value: 'https://api.telecel.com/v1' },
    { key: 'telecel_enabled', value: '1' },
    { key: 'at_api_key', value: 'mock-at-key' },
    { key: 'at_api_url', value: 'https://api.at.com/v1' },
    { key: 'at_enabled', value: '1' },
    { key: 'backup_api_key', value: 'mock-backup-key' },
    { key: 'backup_api_url', value: 'https://api.backup-provider.com/v1' },
    { key: 'backup_enabled', value: '1' },
    { key: 'app_version', value: '1.0.0' },
    { key: 'app_name', value: 'KT-Hub Premium' },
    { key: 'app_tagline', value: 'Ghana Data Bundle Marketplace' }
  ];

  for (const setting of defaultSettings) {
    db.prepare("INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)").run(setting.key, setting.value);
  }

  // Initialize default incentive settings
  const defaultIncentives = [
    { provider: 'MTN', enabled: 1, percentage: 3.0, cap: 0.30, min_margin: 0.40 },
    { provider: 'Telecel', enabled: 1, percentage: 3.0, cap: 0.30, min_margin: 0.40 },
    { provider: 'AT', enabled: 1, percentage: 3.0, cap: 0.30, min_margin: 0.40 }
  ];

  for (const incentive of defaultIncentives) {
    db.prepare("INSERT OR IGNORE INTO incentive_settings (provider, enabled, percentage, cap, min_margin) VALUES (?, ?, ?, ?, ?)").run(
      incentive.provider, incentive.enabled, incentive.percentage, incentive.cap, incentive.min_margin
    );
  }

  // Initialize Admin Wallet
  db.prepare("INSERT OR IGNORE INTO admin_wallet (id, balance) VALUES (?, ?)").run('ADMIN_MAIN', 0);

  // Load settings into config
  try {
    const config = require('./config');
    const settings = db.prepare("SELECT * FROM system_settings").all();
    settings.forEach(s => {
      if (s.key === 'whatsapp_number') config.whatsapp.number = s.value;
      if (s.key === 'whatsapp_enabled') config.whatsapp.enabled = s.value === '1';
      if (s.key === 'maintenance_mode') config.system.maintenanceMode = s.value === '1';
      if (s.key === 'global_discount') config.system.globalDiscount = parseFloat(s.value);
      if (s.key === 'min_wallet_topup') config.system.minWalletTopup = parseFloat(s.value);
      if (s.key === 'max_wallet_topup') config.system.maxWalletTopup = parseFloat(s.value);
      if (s.key === 'slow_mode') config.mock.slowMode = s.value === '1';
      if (s.key === 'mock_failure_rate') config.mock.failureRate = parseFloat(s.value);
      if (s.key === 'referral_daily_cap') config.system.referralDailyCap = parseFloat(s.value);
      if (s.key === 'referral_lock_hours') config.system.referralLockHours = parseFloat(s.value);
      if (s.key === 'registration_enabled') config.system.registrationEnabled = s.value === '1';

      if (s.key === 'mtn_api_key') config.providers.mtn.apiKey = s.value;
      if (s.key === 'mtn_api_url') config.providers.mtn.apiUrl = s.value;
      if (s.key === 'mtn_enabled') config.providers.mtn.enabled = s.value === '1';
      
      if (s.key === 'telecel_api_key') config.providers.telecel.apiKey = s.value;
      if (s.key === 'telecel_api_url') config.providers.telecel.apiUrl = s.value;
      if (s.key === 'telecel_enabled') config.providers.telecel.enabled = s.value === '1';
      
      if (s.key === 'at_api_key') config.providers.at.apiKey = s.value;
      if (s.key === 'at_api_url') config.providers.at.apiUrl = s.value;
      if (s.key === 'at_enabled') config.providers.at.enabled = s.value === '1';
      
      if (s.key === 'backup_api_key') config.providers.backup.apiKey = s.value;
      if (s.key === 'backup_api_url') config.providers.backup.apiUrl = s.value;
      if (s.key === 'backup_enabled') config.providers.backup.enabled = s.value === '1';

      if (s.key === 'app_version') config.system.appVersion = s.value;
      if (s.key === 'app_name') config.system.appName = s.value;
      if (s.key === 'app_tagline') config.system.appTagline = s.value;
    });
  } catch (e) {
    console.log('Error loading settings into config:', e.message);
  }

  // Add missing columns if they don't exist (migration for existing databases)
  try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    const columnNames = tableInfo.map(col => col.name);

    if (!columnNames.includes('is_approved')) {
      console.log('Adding is_approved column...');
      db.exec('ALTER TABLE users ADD COLUMN is_approved INTEGER DEFAULT 1');
    }
    if (!columnNames.includes('requested_role')) {
      console.log('Adding requested_role column...');
      db.exec('ALTER TABLE users ADD COLUMN requested_role TEXT');
    }
    if (!columnNames.includes('approval_status')) {
      console.log('Adding approval_status column...');
      db.exec('ALTER TABLE users ADD COLUMN approval_status TEXT DEFAULT "approved"');
    }
    
    if (!columnNames.includes('is_verified')) {
      console.log('Adding is_verified column...');
      db.exec('ALTER TABLE users ADD COLUMN is_verified INTEGER DEFAULT 0');
    }
    if (!columnNames.includes('signup_ip')) {
      console.log('Adding signup_ip column...');
      db.exec('ALTER TABLE users ADD COLUMN signup_ip TEXT');
    }
    if (!columnNames.includes('device_fingerprint')) {
      console.log('Adding device_fingerprint column...');
      db.exec('ALTER TABLE users ADD COLUMN device_fingerprint TEXT');
    }
    
    // Add flag_reason to referrals
    const refInfo = db.prepare("PRAGMA table_info(referrals)").all();
    const refCols = refInfo.map(col => col.name);
    if (!refCols.includes('flag_reason')) {
      console.log('Adding flag_reason to referrals...');
      db.exec("ALTER TABLE referrals ADD COLUMN flag_reason TEXT");
    }

    // Referral table migration
    db.exec(`
      CREATE TABLE IF NOT EXISTS referrals (
        id TEXT PRIMARY KEY,
        referrer_id TEXT NOT NULL,
        referred_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        bonus_amount REAL DEFAULT 0,
        lock_until DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (referrer_id) REFERENCES users(id),
        FOREIGN KEY (referred_id) REFERENCES users(id),
        UNIQUE(referred_id)
      )
    `);

    // Bundles migration
    const bundlesInfo = db.prepare("PRAGMA table_info(bundles)").all();
    const bundleCols = bundlesInfo.map(col => col.name);
    if (!bundleCols.includes('network')) {
      console.log('Adding network column to bundles...');
      db.exec("ALTER TABLE bundles ADD COLUMN network TEXT DEFAULT ''");
      db.exec("UPDATE bundles SET network = provider");
    }
    if (!bundleCols.includes('provider_bundle_code')) {
      console.log('Adding provider_bundle_code column to bundles...');
      db.exec("ALTER TABLE bundles ADD COLUMN provider_bundle_code TEXT DEFAULT ''");
      db.exec("UPDATE bundles SET provider_bundle_code = id");
    }
    if (!bundleCols.includes('status')) {
      console.log('Adding status column to bundles...');
      db.exec("ALTER TABLE bundles ADD COLUMN status TEXT DEFAULT 'active'");
    }
    
    // Transaction profit columns migration
    const transInfo = db.prepare("PRAGMA table_info(transactions)").all();
    const transCols = transInfo.map(col => col.name);
    if (!transCols.includes('retail_price')) {
      console.log('Adding profit columns to transactions...');
      db.exec(`
        ALTER TABLE transactions ADD COLUMN retail_price DECIMAL(10,2) DEFAULT 0;
        ALTER TABLE transactions ADD COLUMN wholesale_price DECIMAL(10,2) DEFAULT 0;
        ALTER TABLE transactions ADD COLUMN incentive_paid DECIMAL(10,2) DEFAULT 0;
        ALTER TABLE transactions ADD COLUMN referral_paid DECIMAL(10,2) DEFAULT 0;
        ALTER TABLE transactions ADD COLUMN admin_profit DECIMAL(10,2) DEFAULT 0;
      `);
    }
    if (!columnNames.includes('reset_token')) {
      console.log('Adding reset_token column...');
      db.exec('ALTER TABLE users ADD COLUMN reset_token TEXT');
    }
    if (!columnNames.includes('reset_expires')) {
      console.log('Adding reset_expires column...');
      db.exec('ALTER TABLE users ADD COLUMN reset_expires TEXT');
    }

    // User extended-settings columns
    const userInfoExt = db.prepare("PRAGMA table_info(users)").all();
    const userColsExt = userInfoExt.map(c => c.name);
    if (!userColsExt.includes('default_recipient')) {
      db.exec("ALTER TABLE users ADD COLUMN default_recipient TEXT");
    }
    if (!userColsExt.includes('notification_prefs')) {
      db.exec("ALTER TABLE users ADD COLUMN notification_prefs TEXT DEFAULT '{\"orders\":true,\"referral\":true,\"promotions\":false}'");
    }
    if (!userColsExt.includes('transaction_pin')) {
      db.exec("ALTER TABLE users ADD COLUMN transaction_pin TEXT");
    }
    if (!userColsExt.includes('last_login')) {
      db.exec("ALTER TABLE users ADD COLUMN last_login TEXT");
    }
    if (!userColsExt.includes('language')) {
      db.exec("ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'en'");
    }
    if (!userColsExt.includes('is_deleted')) {
      db.exec("ALTER TABLE users ADD COLUMN is_deleted INTEGER DEFAULT 0");
    }
    if (!userColsExt.includes('deletion_pending')) {
      db.exec("ALTER TABLE users ADD COLUMN deletion_pending INTEGER DEFAULT 0");
    }

    // Orders price snapshots migration
    const orderInfo = db.prepare("PRAGMA table_info(orders)").all();
    const orderCols = orderInfo.map(col => col.name);
    if (!orderCols.includes('retail_price_snapshot')) {
      console.log('Adding price snapshot columns to orders...');
      db.exec(`
        ALTER TABLE orders ADD COLUMN retail_price_snapshot REAL;
        ALTER TABLE orders ADD COLUMN wholesale_price_snapshot REAL;
      `);
      
      // Update existing orders with snapshots
      db.exec(`
        UPDATE orders 
        SET 
          retail_price_snapshot = (SELECT retail_price FROM bundles WHERE bundles.id = orders.bundle_id),
          wholesale_price_snapshot = (SELECT wholesale_price FROM bundles WHERE bundles.id = orders.bundle_id)
        WHERE retail_price_snapshot IS NULL;

        -- Fix existing orders where amount might have been wholesale
        UPDATE orders 
        SET amount = retail_price_snapshot
        WHERE amount < retail_price_snapshot;
      `);
    }
  } catch (error) {
    console.log('Migration check passed or already applied:', error.message);
  }

  console.log('Database initialized successfully');
}

function generateReferralCode() {
  return 'REF' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

function seedDatabase() {
  const existingUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (existingUsers.count > 0) {
    console.log('Database already seeded, skipping...');
    return;
  }

  console.log('Seeding database...');

  const customers = [
    { email: 'customer@example.com', name: 'John Customer', password: 'customer123', role: 'customer', wallet: 150.00 },
    { email: 'sarah@example.com', name: 'Sarah Asante', password: 'password123', role: 'customer', wallet: 75.50 },
    { email: 'kwame@example.com', name: 'Kwame Owusu', password: 'password123', role: 'customer', wallet: 200.00 },
    { email: 'ama@example.com', name: 'Ama Serwaa', password: 'password123', role: 'customer', wallet: 50.00 },
    { email: 'kofi@example.com', name: 'Kofi Boateng', password: 'password123', role: 'customer', wallet: 320.00 }
  ];

  const agents = [
    { email: 'admin@kthub.com', name: 'Emmanuel Admin', password: 'admin123', role: 'admin', wallet: 1500.00 },
    { email: 'agent@kthub.com', name: 'Grace Agent', password: 'agent123', role: 'agent', wallet: 2200.00 },
    { email: 'agent3@kthub.com', name: 'Daniel Agent', password: 'agent123', role: 'agent', wallet: 800.00 }
  ];

  const insertUser = db.prepare(`
    INSERT INTO users (id, email, password, name, role, wallet_balance, referral_code, is_approved, approval_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const allUsers = [...customers, ...agents];
  
  // Create SYSTEM_PROFIT user first to avoid foreign key issues
  const systemId = 'SYSTEM_PROFIT';
  const systemHashedPassword = bcrypt.hashSync('system-pass-' + uuidv4(), 10);
  insertUser.run(systemId, 'system@kthub.com', systemHashedPassword, 'System Profit', 'admin', 0, 'SYSTEM', 1, 'approved');

  const userIds = [];
  for (const user of allUsers) {
    const id = uuidv4();
    const hashedPassword = bcrypt.hashSync(user.password, 10);
    const referralCode = generateReferralCode();
    insertUser.run(id, user.email, hashedPassword, user.name, user.role, user.wallet, referralCode, 1, 'approved');
    userIds.push({ id, role: user.role });
  }

  const bundles = [
    { provider: 'MTN', name: 'MTN Daily 500MB', size_mb: 500, size_display: '500MB', price: 5.00, wholesale: 4.00, validity: 1, eta: 2, popular: 1 },
    { provider: 'MTN', name: 'MTN Weekly 2GB', size_mb: 2048, size_display: '2GB', price: 15.00, wholesale: 12.00, validity: 7, eta: 3, popular: 1 },
    { provider: 'MTN', name: 'MTN Monthly 5GB', size_mb: 5120, size_display: '5GB', price: 35.00, wholesale: 28.00, validity: 30, eta: 5, popular: 1 },
    { provider: 'MTN', name: 'MTN Monthly 10GB', size_mb: 10240, size_display: '10GB', price: 60.00, wholesale: 48.00, validity: 30, eta: 5, popular: 0 },
    { provider: 'Vodafone', name: 'Vodafone Daily 1GB', size_mb: 1024, size_display: '1GB', price: 8.00, wholesale: 6.50, validity: 1, eta: 2, popular: 1 },
    { provider: 'Vodafone', name: 'Vodafone Weekly 3GB', size_mb: 3072, size_display: '3GB', price: 20.00, wholesale: 16.00, validity: 7, eta: 3, popular: 0 },
    { provider: 'Vodafone', name: 'Vodafone Monthly 8GB', size_mb: 8192, size_display: '8GB', price: 50.00, wholesale: 40.00, validity: 30, eta: 5, popular: 1 },
    { provider: 'AirtelTigo', name: 'AT Daily 750MB', size_mb: 750, size_display: '750MB', price: 6.00, wholesale: 4.80, validity: 1, eta: 2, popular: 0 },
    { provider: 'AirtelTigo', name: 'AT Weekly 2.5GB', size_mb: 2560, size_display: '2.5GB', price: 18.00, wholesale: 14.50, validity: 7, eta: 3, popular: 1 },
    { provider: 'AirtelTigo', name: 'AT Monthly 6GB', size_mb: 6144, size_display: '6GB', price: 40.00, wholesale: 32.00, validity: 30, eta: 5, popular: 0 }
  ];

    const insertBundle = db.prepare(`
      INSERT INTO bundles (id, provider, network, name, provider_bundle_code, size_mb, size_display, price, retail_price, wholesale_price, validity_days, eta_minutes, popular)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const bundleIds = [];
    for (const bundle of bundles) {
      const id = uuidv4();
      const network = bundle.provider;
      const provider_bundle_code = id;
      insertBundle.run(id, bundle.provider, network, bundle.name, provider_bundle_code, bundle.size_mb, bundle.size_display, bundle.price, bundle.price, bundle.wholesale, bundle.validity, bundle.eta, bundle.popular);
      bundleIds.push(id);
    }

  const insertTransaction = db.prepare(`
    INSERT INTO transactions (id, user_id, type, amount, description, status, reference, payment_method, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertOrder = db.prepare(`
    INSERT INTO orders (id, user_id, bundle_id, phone_number, amount, status, provider, provider_ref, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const customerIds = userIds.filter(u => u.role === 'customer').map(u => u.id);
  const transactionTypes = ['topup', 'purchase', 'topup', 'purchase', 'withdrawal'];
  const paymentMethods = ['mtn_momo', 'vodafone_cash', 'airteltigo_money'];
  const statuses = ['completed', 'completed', 'completed', 'pending', 'failed'];
  const orderStatuses = ['completed', 'completed', 'processing', 'pending', 'failed'];

  for (let i = 0; i < 20; i++) {
    const userId = customerIds[i % customerIds.length];
    const type = transactionTypes[i % transactionTypes.length];
    const amount = (Math.random() * 50 + 5).toFixed(2);
    const status = statuses[i % statuses.length];
    const paymentMethod = paymentMethods[i % paymentMethods.length];
    const daysAgo = Math.floor(Math.random() * 30);
    const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();

    insertTransaction.run(
      uuidv4(),
      userId,
      type,
      parseFloat(amount),
      `${type === 'topup' ? 'Wallet top-up' : type === 'purchase' ? 'Data bundle purchase' : 'Withdrawal request'} via ${paymentMethod}`,
      status,
      'TXN' + Math.random().toString(36).substring(2, 10).toUpperCase(),
      paymentMethod,
      createdAt
    );

    if (type === 'purchase' && i < 15) {
      const bundleId = bundleIds[i % bundleIds.length];
      const bundle = bundles[i % bundles.length];
      const orderStatus = orderStatuses[i % orderStatuses.length];
      const completedAt = orderStatus === 'completed' ? createdAt : null;

      insertOrder.run(
        uuidv4(),
        userId,
        bundleId,
        '0' + (24 + Math.floor(Math.random() * 6)) + Math.random().toString().slice(2, 9),
        bundle.price,
        orderStatus,
        bundle.provider,
        'PRV' + Math.random().toString(36).substring(2, 10).toUpperCase(),
        createdAt,
        completedAt
      );
    }
  }

  const insertNotification = db.prepare(`
    INSERT INTO notifications (id, user_id, title, message, type, read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const notifications = [
    { title: 'Welcome to KT-Hub!', message: 'Your account has been created successfully. Start buying data bundles now!', type: 'success' },
    { title: 'Order Completed', message: 'Your MTN 2GB data bundle has been delivered successfully.', type: 'success' },
    { title: 'Low Balance Alert', message: 'Your wallet balance is below GHS 10. Top up now to continue enjoying our services.', type: 'warning' },
    { title: 'New Bundle Available', message: 'Check out our new Vodafone monthly bundle with extra bonus data!', type: 'info' }
  ];

  for (const userId of customerIds) {
    for (const notif of notifications) {
      const hoursAgo = Math.floor(Math.random() * 72);
      const createdAt = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
      insertNotification.run(
        uuidv4(),
        userId,
        notif.title,
        notif.message,
        notif.type,
        Math.random() > 0.5 ? 1 : 0,
        createdAt
      );
    }
  }

    const insertIncentive = db.prepare(`
    INSERT INTO incentives (id, agent_id, order_id, amount, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Mock incentives for agents
  const agentIds = userIds.filter(u => u.role === 'agent').map(u => u.id);
  const orderIds = db.prepare('SELECT id FROM orders WHERE status = \'completed\'').all().map(o => o.id);

  for (let i = 0; i < 10; i++) {
    const agentId = agentIds[i % agentIds.length];
    const orderId = orderIds[i % orderIds.length];
    if (orderId) {
      insertIncentive.run(
        uuidv4(),
        agentId,
        orderId,
        parseFloat((Math.random() * 2 + 0.1).toFixed(2)),
        'completed',
        new Date().toISOString()
      );
    }
  }

  console.log('Database seeded successfully!');
  console.log('- 5 customers created');
  console.log('- 3 agents created');
  console.log('- 10 bundles created');
  console.log('- 20 transactions created');
}

module.exports = { db, initializeDatabase, seedDatabase };
