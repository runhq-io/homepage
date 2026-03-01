import { Resend } from 'resend';

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error('[email] RESEND_API_KEY not set');
    }
    _resend = new Resend(apiKey);
  }
  return _resend;
}

const FROM = () => process.env.EMAIL_FROM || 'Fishtank <noreply@fishtank.bot>';

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  const resend = getResend();

  await resend.emails.send({
    from: FROM(),
    to,
    subject: 'Reset your Fishtank password',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #1e293b; margin-bottom: 16px;">Reset your password</h2>
        <p style="color: #475569; line-height: 1.6;">
          We received a request to reset your Fishtank password. Click the button below to choose a new password.
        </p>
        <a href="${resetUrl}" style="display: inline-block; margin: 24px 0; padding: 12px 32px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 500;">
          Reset Password
        </a>
        <p style="color: #94a3b8; font-size: 14px; line-height: 1.6;">
          This link expires in 1 hour. If you didn't request a password reset, you can ignore this email.
        </p>
        <p style="color: #94a3b8; font-size: 14px; margin-top: 32px;">
          If the button doesn't work, copy and paste this URL into your browser:<br/>
          <span style="color: #64748b; word-break: break-all;">${resetUrl}</span>
        </p>
      </div>
    `,
  });
}
