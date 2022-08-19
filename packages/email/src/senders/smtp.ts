import { Email, EmailSender } from '../interfaces';
import { default as nodemailer } from 'nodemailer';

export class SmtpSender extends EmailSender {
  get Type(): string {
    return 'smtp';
  }

  send(email: Email): Promise<void> {
    const transport = nodemailer.createTransport(connection);
    const htmlContent = email.text || pug.renderFile(this.template, this.model);
    const options = {
      from: email.mailFrom,
      to: email.mailTo.join(','),
      subject: email.subject,
      html: htmlContent,
      attachments: email.attachments,
    };

    await transport.sendMail(options);
  }
}
