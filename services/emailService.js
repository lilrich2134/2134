const nodemailer = require('nodemailer');
const config = require('../config');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: config.email.user,
    pass: config.email.password
  }
});

const emailService = {
  async sendAdminNotification(subject, htmlContent, userData = {}) {
    try {
      if (!config.email.user || config.email.user === 'your-email@gmail.com') {
        console.log('📧 Email service not configured. Skipping email:', subject);
        return { success: false, message: 'Email service not configured' };
      }

      const mailOptions = {
        from: config.email.user,
        to: config.email.adminEmail,
        subject: subject,
        html: htmlContent
      };

      const info = await transporter.sendMail(mailOptions);
      console.log('✅ Admin notification email sent:', info.response);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('❌ Email service error:', error.message);
      return { success: false, error: error.message };
    }
  },

  async sendApprovalNotification(userEmail, userName, approvalType) {
    const htmlContent = `
      <h2>🔔 New ${approvalType === 'signup' ? 'Account Registration' : 'Role Change Request'}</h2>
      <p><strong>User Name:</strong> ${userName}</p>
      <p><strong>Email:</strong> ${userEmail}</p>
      <p><strong>Type:</strong> ${approvalType === 'signup' ? 'New user awaiting approval' : 'Role change request'}</p>
      <p>Please review and approve/deny this request in the admin dashboard.</p>
      <p><em>Sent at: ${new Date().toLocaleString()}</em></p>
    `;

    return this.sendAdminNotification(
      `KT-Hub: ${approvalType === 'signup' ? 'New Registration' : 'Role Change'} Pending Approval`,
      htmlContent,
      { email: userEmail, name: userName }
    );
  },

  async sendPasswordResetEmail(userEmail, userName, resetToken) {
    const domain = process.env.REPLIT_DEV_DOMAIN || '0.0.0.0:5000';
    const protocol = domain.includes('replit.dev') ? 'https' : 'http';
    const resetUrl = `${protocol}://${domain}/#/reset-password/${resetToken}`;

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
        <h2 style="color: #00bcd4;">🔑 Password Reset Request</h2>
        <p>A customer has requested a password reset. Their details are below:</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
          <tr><td style="padding:8px;font-weight:bold;background:#f5f5f5;width:80px;">Name</td><td style="padding:8px;">${userName}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f5f5;">Email</td><td style="padding:8px;">${userEmail}</td></tr>
        </table>
        <p>Click the button below to get their reset link, then share it with them directly:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetUrl}" style="background-color: #00bcd4; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Open Reset Link</a>
        </div>
        <p style="font-size:0.85rem;color:#888;">This link expires in 1 hour.</p>
        <p>— KT-Hub Premium System</p>
      </div>
    `;

    try {
      if (!config.email.user || config.email.user === 'your-email@gmail.com') {
        console.log('📧 Email service not configured. Password reset link:', resetUrl);
        return { success: false, message: 'Email service not configured', resetUrl };
      }

      const mailOptions = {
        from: config.email.user,
        to: config.email.adminEmail,
        subject: `KT-Hub: Password Reset for ${userName} (${userEmail})`,
        html: htmlContent
      };

      const info = await transporter.sendMail(mailOptions);
      console.log('✅ Password reset email sent to admin:', info.response);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('❌ Password reset email error:', error.message);
      return { success: false, error: error.message };
    }
  }
};

module.exports = emailService;
