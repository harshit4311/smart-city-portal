// SMS integration used to tell citizens when their complaint status changes.
//
// Providers:
//   mock   - stub that "sends" by logging; nothing leaves the machine (default)
//   twilio - Twilio's REST API. Twilio test credentials plus the magic sender number
//            +15005550006 give a free sandbox that never delivers a real SMS.
import crypto from 'node:crypto';

// Phone numbers are personal data, so logs only ever show a masked version.
export const maskPhone = (phone) => (phone ? `${phone.slice(0, 3)}******${phone.slice(-4)}` : phone);

export function createSmsClient(smsConfig, { log = console.log } = {}) {
  const provider = smsConfig.provider;

  const senders = {
    async mock(to, body) {
      log(`[sms:mock] to=${maskPhone(to)} body="${body}"`);
      return { status: 'sent', providerMessageId: `mock-${crypto.randomUUID()}` };
    },
    async twilio(to, body) {
      const { twilioAccountSid: sid, twilioAuthToken: token, twilioFromNumber: from, twilioBaseUrl } = smsConfig;
      const url = new URL(`/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, twilioBaseUrl);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`Twilio error ${data.code ?? res.status}: ${data.message ?? res.statusText}`);
      }
      log(`[sms:twilio] to=${maskPhone(to)} sid=${data.sid} status=${data.status}`);
      return { status: 'sent', providerMessageId: data.sid };
    },
  };

  if (!senders[provider]) throw new Error(`Unknown SMS_PROVIDER "${provider}"`);

  return {
    provider,
    // Never throws: an SMS failure must not undo the status change that triggered it.
    async send(to, body) {
      try {
        return { provider, ...(await senders[provider](to, body)) };
      } catch (err) {
        log(`[sms:${provider}] FAILED to=${maskPhone(to)}: ${err.message}`);
        return { provider, status: 'failed', error: err.message };
      }
    },
  };
}
