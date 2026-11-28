import { InvalidArgument, IOFail, UnexpectedServerError } from '@spinajs/exceptions';
import { Autoinject, Injectable, NewInstance } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { IEmail, EmailSender, EmailConnectionOptions, IEmailAttachement, attachmentFile, redactError } from '@spinajs/email';
import { Templates } from '@spinajs/templates';
import { BackoffType, ResiliencePipeline, ResiliencePipelineBuilder } from '@spinajs/util';
import * as nodemailer from 'nodemailer';
import { fs, getFs } from '@spinajs/fs';
import { isIP } from 'net';
import _ from 'lodash';
import { loggableEndpoint } from './loggable-endpoint.js';

// nodemailer sends `host` as written to the DNS servers, so a scheme, userinfo, port, path or query in it would be a DNS question
const NOT_A_HOST_NAME = /[@:/\\?#\s]/;

/** nodemailer reads `url` with the legacy url.parse(), which takes the user name of a broken-up userinfo for the host. */
function isDialledAsWritten(url: string): boolean {
  try {
    const parsed = new URL(url);
    return !`${parsed.pathname}${parsed.search}${parsed.hash}`.includes('@');
  } catch {
    return false;
  }
}

/** The server as logs and errors print it: scheme, host and port, never the credentials or the query of a url. */
function loggableServer(url: string | undefined, host: unknown, port: unknown, secure: unknown): string {
  if (url !== undefined) return loggableEndpoint(url);
  const name = typeof host === 'string' && host !== '' ? host : 'localhost';
  const scheme = secure === true ? 'smtps' : 'smtp';
  // resolve() refused every host with userinfo, a path or a query before this runs
  return `${scheme}://${isIP(name) === 6 ? `[${name}]` : name}${typeof port === 'number' ? `:${port}` : ''}`;
}

@Injectable(EmailSender)
@NewInstance()
export class EmailSenderSmtp extends EmailSender {
  @Logger('email')
  protected Log: Log;

  @Autoinject(Templates)
  protected Templates: Templates;

  protected Transporter: nodemailer.Transporter;

  /**
   * In-process resilience pipeline guarding the SMTP send ( per-attempt timeout + retry ).
   */
  protected SendPipeline: ResiliencePipeline<nodemailer.SentMessageInfo>;

  constructor(public Options: EmailConnectionOptions) {
    super();
  }

  /**
   * Builds the in-process resilience pipeline guarding the SMTP send
   * ( per-attempt timeout + exponential retry ). Extracted so the send
   * behavior can be tested hermetically without opening a real connection.
   */
  protected buildSendPipeline(): ResiliencePipeline<nodemailer.SentMessageInfo> {
    return new ResiliencePipelineBuilder<nodemailer.SentMessageInfo>()
      .addRetry({
        MaxRetryAttempts: this.Options.resilience?.retries ?? 2,
        Delay: this.Options.resilience?.delay ?? 500,
        BackoffType: BackoffType.Exponential,
        UseJitter: true,
        // SMTP 5xx replies are permanent rejections, repeating them cannot succeed
        ShouldHandle: ({ Error: error }) => error !== undefined && ((error as { responseCode?: number }).responseCode ?? 0) < 500,
      })
      .addTimeout(this.Options.resilience?.timeout ?? 30_000)
      .build();
  }

  public async resolve(): Promise<void> {

    await super.resolve();

    const options = Object.assign(
      {
        host: this.Options.host,
        port: this.Options.port,
        secure: this.Options.ssl, // true for 465, false for other ports
        // nodemailer attempts LOGIN whenever an auth object is present, even an empty one
        auth: this.Options.user || this.Options.password ? { user: this.Options.user, pass: this.Options.password } : undefined,
      },

      // all additional options merged
      this.Options.options,
    );

    // nodemailer dials a non-empty url and ignores host, port and auth then
    const option: unknown = _.get(options, 'url');
    const url = typeof option === 'string' && option !== '' ? option : undefined;
    if (url !== undefined && !isDialledAsWritten(url)) {
      throw new InvalidArgument(
        `Email smtp connection ${this.Options.name} has an options.url that is not a URL: percent-encode a '/', '?', '#' or '@' in its user name, password or query (%2F, %3F, %23, %40), or set user / password`,
      );
    }
    const host: unknown = options.host;
    if (url === undefined && typeof host === 'string' && isIP(host) === 0 && NOT_A_HOST_NAME.test(host)) {
      throw new InvalidArgument(
        `Email smtp connection ${this.Options.name} has a host that is not a host name: set host to the server name or IP address alone (no scheme, port or brackets; the port goes in port), and the user name and password in user / password`,
      );
    }
    const server = loggableServer(url, host, options.port, options.secure);

    this.Log.info({ user: options.auth?.user, host: server, secure: options.secure }, 'Creating connection to smtp: ${user} at ${host}, secure: ${secure}');

    // create reusable transporter object using the default SMTP transport
    this.Transporter = nodemailer.createTransport(options);

    // in-process resilience applied only around the SMTP send. Queue-level retry
    // handles deferred sends once this pipeline gives up.
    this.SendPipeline = this.buildSendPipeline();

    try {
      // verify returns Promise<true> so always is true
      // we must catch exception
      await this.Transporter.verify();
    } catch (err) {
      this.Log.error({ error: err, connection: this.Options.name, host: server }, 'Cannot verify smtp connection ${connection} (${host})');
      throw new UnexpectedServerError(`Cannot verify smtp connection ${this.Options.name} (${server})`, err);
    }

    this.Log.success({ connection: this.Options.name, host: server }, 'Email smtp connection ${connection} on host ${host} established !');
  }

  public async send(email: IEmail): Promise<void> {
    if (!email.from && !this.Options.defaults?.mailFrom) {
      throw new IOFail(`Email from address is required. Please provide it in email or in configuration`);
    }

    // only resolve / download / render a template when one is actually provided.
    // text-only emails leave html undefined.
    let html: string | undefined;

    if (email.template) {
      // string template -> default template filesystem
      // IEmailTemplate object -> resolve its own fs provider
      // getFs() throws ResolveException for a name that is not registered
      const templateFs: fs | undefined = _.isString(email.template) ? this.defaultTemplateFs : getFs(email.template.fs);

      if (!templateFs) {
        throw new IOFail(`No filesystem to load email template from. Set email.templateFs, or fs of the template`);
      }

      this.Log.trace({ filesystem: templateFs.Name }, 'Using filesystem ${filesystem} to resolve email template');
      const tfile = await (_.isString(email.template) ? templateFs.download(email.template) : templateFs.download(email.template.file));
      this.Log.trace({ templateFile: tfile }, 'Resolved email template ${templateFile}');

      try {
        html = await this.Templates.render(tfile, { ...this.Options.templates?.defaults, ...email.model }, email.lang, email.redact ? { redact: email.redact } : undefined);
      } catch (err) {
        // template rendering is a deterministic failure - log & rethrow, do not retry
        const failure = redactError(err, email.redact);
        this.Log.error({ error: failure, templateFile: tfile, connection: this.Options.name }, 'Cannot render email template ${templateFile} for connection ${connection}');
        throw failure;
      }
    }

    const options = {
      from: email.from ?? this.Options.defaults?.mailFrom, // sender address
      to: email.to.join(','), // list of receivers
      cc: email.cc ? email.cc.join(',') : undefined,
      bcc: email.bcc ? email.bcc.join(',') : undefined,
      replyTo: email.replyTo,
      subject: email.subject, // Subject line
      text: email.text, // plain text body
      html, // rendered template or undefined for text-only emails
      attachments: [] as any[],
    };

    if (email.attachements) {
      options.attachments = await Promise.all(
        // A local path rather than content: nodemailer streams it, which suits bigger files.
        email.attachements.map(async (a: IEmailAttachement) => ({
          cid: a.cid,
          filename: a.name,
          path: await attachmentFile(a, this.DefaultFileProvider),
        })),
      );
    }

    let message: nodemailer.SentMessageInfo;
    try {
      // guard only the SMTP send with the resilience pipeline ( timeout + retry )
      message = await this.SendPipeline.execute(() => this.Transporter.sendMail(options));
    } catch (err) {
      // an SMTP response may quote the message back, secret values included
      const failure = redactError(err, email.redact);
      this.Log.error(
        { error: failure, connection: this.Options.name, subject: email.subject, recipients: email.to?.length ?? 0 },
        'Cannot send email for connection ${connection}, subject: ${subject}, recipients: ${recipients}',
      );
      throw failure;
    }

    this.Log.trace(
      { email: _.pick(email, ['from', 'to', 'cc', 'bcc', 'replyTo', 'subject']), messageId: message?.messageId, response: message?.response },
      'Sent email with data: ${email}, messageId: ${messageId}, response: ${response}',
    );
  }
}
