require('dotenv').config();

module.exports = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  jwt: {
    secret: process.env.JWT_SECRET || 'datahub-premium-secret-key-2024',
    expiresIn: '7d'
  },
  
  providers: {
    mtn: {
      name: 'MTN',
      apiKey: process.env.MTN_API_KEY || 'mock-mtn-key',
      apiSecret: process.env.MTN_API_SECRET || 'mock-mtn-secret',
      apiUrl: process.env.MTN_API_URL || 'https://api.mtn.com/v1',
      enabled: true
    },
    telecel: {
      name: 'Telecel',
      apiKey: process.env.TELECEL_API_KEY || process.env.VODAFONE_API_KEY || 'mock-telecel-key',
      apiSecret: process.env.TELECEL_API_SECRET || process.env.VODAFONE_API_SECRET || 'mock-telecel-secret',
      apiUrl: process.env.TELECEL_API_URL || process.env.VODAFONE_API_URL || 'https://api.telecel.com/v1',
      enabled: true
    },
    at: {
      name: 'AT',
      apiKey: process.env.AT_API_KEY || process.env.AIRTELTIGO_API_KEY || 'mock-at-key',
      apiSecret: process.env.AT_API_SECRET || process.env.AIRTELTIGO_API_SECRET || 'mock-at-secret',
      apiUrl: process.env.AT_API_URL || process.env.AIRTELTIGO_API_URL || 'https://api.at.com/v1',
      enabled: true
    },
    bulkdata: {
      name: 'BulkData',
      apiKey: process.env.BULKDATA_API_KEY || 'mock-bulkdata-key',
      apiUrl: process.env.BULKDATA_API_URL || 'https://api.bulkdata.com/v1',
      enabled: true
    },
    backup: {
      name: 'Backup Provider',
      apiKey: process.env.BACKUP_PROVIDER_API_KEY || 'mock-backup-key',
      apiUrl: process.env.BACKUP_PROVIDER_API_URL || 'https://api.backup-provider.com/v1',
      enabled: true
    }
  },
  
  mock: {
    slowMode: process.env.MOCK_SLOW_MODE === 'true',
    failureRate: parseFloat(process.env.MOCK_FAILURE_RATE) || 0,
    minDelay: 60000,
    maxDelay: 65000
  },
  
  whatsapp: {
    number: '+233XXXXXXXXX',
    enabled: true
  },

  system: {
    maintenanceMode: false,
    globalDiscount: 0,
    minWalletTopup: 1,
    maxWalletTopup: 1000,
    referralBonusGhs: 2.00,
    referralMinOrderGhs: 15.00,
    referralDailyCap: 100,
    referralLockHours: 48,
    registrationEnabled: true
  },

  email: {
    service: process.env.EMAIL_SERVICE || 'gmail',
    user: process.env.EMAIL_USER || 'your-email@gmail.com',
    password: process.env.EMAIL_PASSWORD || 'your-app-password',
    adminEmail: process.env.ADMIN_EMAIL || 'admin@kthub.com'
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    whatsappFrom: process.env.TWILIO_WHATSAPP_FROM || '+1234567890',
    adminPhone: process.env.ADMIN_WHATSAPP_PHONE || '+233XXXXXXXXX'
  },

  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY || '',
    // Mock mode is active whenever no real key is supplied.
    // Set PAYSTACK_SECRET_KEY=sk_test_xxxx (test) or sk_live_xxxx (live) to go real.
    mockMode: !process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET_KEY === '',
    baseUrl: 'https://api.paystack.co',
    webhookPath: '/api/payments/webhook'
  }
};
