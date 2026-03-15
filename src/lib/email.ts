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

const FROM = () => process.env.EMAIL_FROM || 'RunHQ <noreply@runhq.io>';

export async function sendActivationEmail(to: string, activateUrl: string): Promise<void> {
  const resend = getResend();

  await resend.emails.send({
    from: FROM(),
    to,
    subject: 'Verify your RunHQ email',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #1e293b; margin-bottom: 16px;">Verify your email</h2>
        <p style="color: #475569; line-height: 1.6;">
          Thanks for signing up for RunHQ! Click the button below to verify your email address.
        </p>
        <a href="${activateUrl}" style="display: inline-block; margin: 24px 0; padding: 12px 32px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 500;">
          Verify Email
        </a>
        <p style="color: #94a3b8; font-size: 14px; line-height: 1.6;">
          This link expires in 24 hours. If you didn't create an account, you can ignore this email.
        </p>
        <p style="color: #94a3b8; font-size: 14px; margin-top: 32px;">
          If the button doesn't work, copy and paste this URL into your browser:<br/>
          <span style="color: #64748b; word-break: break-all;">${activateUrl}</span>
        </p>
      </div>
    `,
  });
}

export async function sendInviteEmail(to: string, inviterName: string, serverName: string, acceptUrl: string): Promise<void> {
  const resend = getResend();

  await resend.emails.send({
    from: FROM(),
    to,
    subject: `You've been invited to ${serverName} on RunHQ`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #1e293b; margin-bottom: 16px;">You're invited!</h2>
        <p style="color: #475569; line-height: 1.6;">
          <strong>${inviterName}</strong> has invited you to join <strong>${serverName}</strong> on RunHQ.
        </p>
        <a href="${acceptUrl}" style="display: inline-block; margin: 24px 0; padding: 12px 32px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 500;">
          Accept Invite
        </a>
        <p style="color: #94a3b8; font-size: 14px; line-height: 1.6;">
          This invite expires in 7 days. If you don't have a RunHQ account, you'll be prompted to create one.
        </p>
        <p style="color: #94a3b8; font-size: 14px; margin-top: 32px;">
          If the button doesn't work, copy and paste this URL into your browser:<br/>
          <span style="color: #64748b; word-break: break-all;">${acceptUrl}</span>
        </p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  const resend = getResend();

  await resend.emails.send({
    from: FROM(),
    to,
    subject: 'Reset your RunHQ password',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #1e293b; margin-bottom: 16px;">Reset your password</h2>
        <p style="color: #475569; line-height: 1.6;">
          We received a request to reset your RunHQ password. Click the button below to choose a new password.
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
