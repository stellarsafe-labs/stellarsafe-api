import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
}

/** Sends one email. Throwing means "retry later". */
export type Mailer = (msg: MailMessage) => Promise<void>;

export function createSmtpMailer(smtpUrl: string, from: string, timeoutMs: number): Mailer {
  const transport = nodemailer.createTransport({
    url: smtpUrl,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs * 2,
  });
  return async (msg) => {
    await transport.sendMail({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      headers: msg.headers,
    });
  };
}
