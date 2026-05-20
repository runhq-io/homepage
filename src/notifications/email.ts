import { Resend } from 'resend'

let _resend: Resend | null = null

function getResend(): Resend {
  if (!_resend) {
    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) {
      throw new Error('[email] RESEND_API_KEY not set')
    }
    _resend = new Resend(apiKey)
  }
  return _resend
}

const FROM = () => process.env.EMAIL_FROM || 'RunHQ <noreply@runhq.io>'

export type NotificationEmailPayload = {
  id: string
  eventType: 'need_help' | 'completed'
  taskTitle: string
  serverName: string
  projectName: string
  serverId: string
  projectId: string
  taskId: string
}

export async function sendJobStatusEmail(
  user: { email: string; name?: string | null },
  n: NotificationEmailPayload,
): Promise<void> {
  const resend = getResend()

  const subject = n.eventType === 'need_help'
    ? `Needs help: ${n.taskTitle}`
    : `Completed: ${n.taskTitle}`

  const deepLink = `https://app.runhq.io/server/${n.serverId}/project/${n.projectId}/task/${n.taskId}?notification=${n.id}`

  const actionText = n.eventType === 'need_help' ? 'This task needs your attention.' : 'This task has been completed.'
  const accentColor = n.eventType === 'need_help' ? '#dc2626' : '#16a34a'

  const html = `
    <div style="font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px">
      <h2 style="color:#1e293b;margin:0 0 8px;font-size:20px">${subject}</h2>
      <p style="margin:0;color:#64748b;font-size:14px">${n.serverName} · ${n.projectName}</p>
      <p style="margin:16px 0 24px;color:#475569;line-height:1.6">${actionText}</p>
      <a href="${deepLink}"
         style="display:inline-block;background:${accentColor};color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:500;font-size:14px">
        Open in RunHQ
      </a>
      <p style="margin:32px 0 0;font-size:12px;color:#94a3b8">
        You received this email because you have email notifications enabled in RunHQ.
        <br/>
        <a href="https://app.runhq.io/settings/notifications" style="color:#64748b">Manage notification preferences</a>
      </p>
    </div>`

  const { data, error } = await resend.emails.send({
    from: FROM(),
    to: user.email,
    subject,
    html,
  })

  if (error) {
    console.error('[notifications] sendJobStatusEmail failed:', error)
    throw new Error(`Failed to send notification email: ${(error as any).message ?? String(error)}`)
  }
  console.log(`[notifications] job-status email sent to ${user.email}, id=${data?.id}`)
}
