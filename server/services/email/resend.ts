/**
 * Resend transactional email adapter — OTP codes and signup notifications.
 *
 * Thin wrapper around Resend's REST API (https://api.resend.com/emails).
 * Optional integration: RESEND_API_KEY unset -> logs and no-ops, the same
 * "simulation mode" fallback phoneAuth.ts uses for WhatsApp OTP delivery when
 * WAC_WHATSAPP_TOKEN is unset. Callers should treat the boolean return as
 * best-effort — a failed send here must never block login/OTP/onboarding.
 */
import { ENV } from "../../_core/env";

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  if (!ENV.resendApiKey) {
    console.info(`[email] SIMULATION: would send "${input.subject}" to ${input.to}`);
    return false;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ENV.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: ENV.resendFromEmail,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[email] Resend send failed (${res.status}): ${body}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[email] Error calling Resend:", error);
    return false;
  }
}

/** Mirrors phoneAuth.ts's OTP purposes — "login" for sign-in, "verify" for linking a phone. */
export async function sendOtpEmail(
  to: string,
  otp: string,
  purpose: "login" | "verify" = "login",
): Promise<boolean> {
  const action = purpose === "verify" ? "verify your phone number" : "sign in";
  return sendEmail({
    to,
    subject: `Your WhatsApp Commerce code: ${otp}`,
    text: `Your one-time code is ${otp}. It expires in 10 minutes. Use it to ${action}.`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Your one-time code</h2>
        <p style="font-size: 32px; font-weight: bold; letter-spacing: 4px;">${otp}</p>
        <p>Use this code to ${action}. It expires in 10 minutes.</p>
        <p style="color: #888; font-size: 12px;">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

/**
 * === W47 crosscutting (ONB-TOK-3) ===
 * Notification-only companion to sendOtpEmail: tells the account owner an OTP
 * was requested on WhatsApp WITHOUT including the code. The login OTP must
 * stay single-channel (WhatsApp) — emailing the same code made email
 * compromise alone sufficient for login.
 */
export async function notifyOtpRequestedEmail(
  to: string,
  purpose: "login" | "verify" = "login",
): Promise<boolean> {
  const action = purpose === "verify" ? "verify your phone number" : "sign in";
  return sendEmail({
    to,
    subject: "A sign-in code was sent to your WhatsApp",
    text:
      `A one-time code was just sent to your phone on WhatsApp to ${action}. ` +
      `The code is ONLY on WhatsApp — we never email codes. If this wasn't you, ` +
      `secure your account immediately and contact support.`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Sign-in code sent via WhatsApp</h2>
        <p>A one-time code was just sent to your phone on WhatsApp to ${action}.</p>
        <p><strong>The code is only on WhatsApp — we never email codes.</strong></p>
        <p style="color: #888; font-size: 12px;">If this wasn't you, secure your account immediately and contact support.</p>
      </div>
    `,
  });
}

/** Sent once, the first time a new user completes registration/first login. */
export async function sendWelcomeEmail(to: string, name: string | null): Promise<boolean> {
  const greeting = name ? `Hi ${name},` : "Hi,";
  return sendEmail({
    to,
    subject: "Welcome to WhatsApp Commerce",
    text: `${greeting}\n\nYour account is ready. Sign in to set up your business and start selling on WhatsApp.`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Welcome to WhatsApp Commerce</h2>
        <p>${greeting}</p>
        <p>Your account is ready. Sign in to set up your business and start selling on WhatsApp.</p>
      </div>
    `,
  });
}
