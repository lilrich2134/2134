const https = require('https');
const crypto = require('crypto');
const config = require('../config');

const MOCK_MODE = config.paystack.mockMode;

// Provider codes Paystack expects for Ghana Mobile Money
const PROVIDER_MAP = {
  mtn_momo: 'mtn',
  telecel_cash: 'vod',
  at_money: 'tgo'
};

// Make a JSON POST to Paystack API
function paystackRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const options = {
      hostname: 'api.paystack.co',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${config.paystack.secretKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from Paystack: ' + data)); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Initiate a Mobile Money charge.
 *
 * In mock mode — no network call is made; returns a simulated response
 * so the full flow can be tested without Paystack credentials.
 *
 * In real mode — calls POST /charge on Paystack and expects either:
 *   status: "pay_offline"  → customer receives USSD / app prompt
 *   status: "send_otp"     → OTP required (handle separately)
 *   status: "success"      → charged immediately (rare for MoMo)
 */
async function initiateCharge({ email, amountGhs, phone, paymentMethod, reference }) {
  const provider = PROVIDER_MAP[paymentMethod];
  if (!provider) throw new Error(`Unsupported payment method: ${paymentMethod}`);

  const amountPesewas = Math.round(amountGhs * 100); // Paystack uses smallest currency unit

  if (MOCK_MODE) {
    // Simulate Paystack's response for a MoMo charge
    return {
      status: true,
      message: 'Charge attempted',
      data: {
        status: 'pay_offline',
        reference,
        display_text: `[MOCK] A payment prompt would be sent to ${phone} on ${provider.toUpperCase()} network. Approve it on your phone to complete the payment.`,
        amount: amountPesewas,
        currency: 'GHS',
        metadata: { mock: true }
      }
    };
  }

  return paystackRequest('POST', '/charge', {
    email,
    amount: amountPesewas,
    currency: 'GHS',
    mobile_money: { phone, provider },
    reference
  });
}

/**
 * Verify that a webhook request genuinely came from Paystack.
 * In mock mode, always passes (we trust our own test endpoint).
 */
function verifyWebhookSignature(rawBody, signature) {
  if (MOCK_MODE) return true;
  const hash = crypto
    .createHmac('sha512', config.paystack.secretKey)
    .update(rawBody)
    .digest('hex');
  return hash === signature;
}

/**
 * Fetch charge status from Paystack (for polling).
 * In mock mode, not needed — status is driven by the mock-confirm endpoint.
 */
async function getChargeStatus(reference) {
  if (MOCK_MODE) {
    return { status: true, data: { status: 'pending', reference } };
  }
  return paystackRequest('GET', `/charge/${reference}`, null);
}

module.exports = { initiateCharge, verifyWebhookSignature, getChargeStatus, MOCK_MODE, PROVIDER_MAP };
