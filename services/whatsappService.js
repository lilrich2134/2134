const config = require('../config');

let twilioClient = null;

try {
  const twilio = require('twilio');
  if (config.twilio.accountSid && config.twilio.authToken) {
    twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);
  }
} catch (error) {
  console.log('⚠️  Twilio not available. WhatsApp notifications will be skipped.');
}

const whatsappService = {
  async sendAdminNotification(subject, messageText, userData = {}) {
    try {
      if (!twilioClient || !config.twilio.adminPhone || config.twilio.adminPhone === '+233XXXXXXXXX') {
        console.log('📱 WhatsApp service not configured. Skipping notification:', subject);
        return { success: false, message: 'WhatsApp service not configured' };
      }

      const message = await twilioClient.messages.create({
        from: `whatsapp:${config.twilio.whatsappFrom}`,
        to: `whatsapp:${config.twilio.adminPhone}`,
        body: messageText
      });

      console.log('✅ WhatsApp notification sent:', message.sid);
      return { success: true, messageSid: message.sid };
    } catch (error) {
      console.error('❌ WhatsApp service error:', error.message);
      return { success: false, error: error.message };
    }
  },

  async sendApprovalNotification(userEmail, userName, approvalType) {
    const messageText = `
🔔 KT-Hub Admin Alert

${approvalType === 'signup' ? '📝 NEW REGISTRATION' : '👤 ROLE CHANGE REQUEST'}

User: ${userName}
Email: ${userEmail}
Type: ${approvalType === 'signup' ? 'Account approval required' : 'Role change approval required'}

Action: Review in admin dashboard
Time: ${new Date().toLocaleString()}
    `.trim();

    return this.sendAdminNotification(
      `${approvalType === 'signup' ? 'New Registration' : 'Role Change'} - ${userName}`,
      messageText,
      { email: userEmail, name: userName }
    );
  }
};

module.exports = whatsappService;
