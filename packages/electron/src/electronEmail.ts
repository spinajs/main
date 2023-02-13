
/**
 * We redeclare thees interfaces & class, to not include whole Intl package.
 * It can cause probles because it uses native nodejs modules & functions.
 * Its easier that way to fake it
 */

import { Injectable } from "@spinajs/di";

export interface IEmailAttachement {
    /**
     * - filename to be reported as the name of the attached file. Use of unicode is allowed.
     */
    name: string;

    /**
     * Path to file
     */
    path: string;

    /**
     * File provider could be local fs, aws s3 etc. Default is always fs-local
     */
    provider?: string;
}

export interface IEmail {
    to: string[];

    cc?: string[];

    bcc?: string[];

    from: string;

    connection: string;

    attachements?: IEmailAttachement[];

    /**
     * Local template name. Must be avaible in one of dirs set in template config
     */
    template?: string;

    /**
     * Some implementations have predefined templates. It can be accessed by this Id
     * eg. mailersend
     */
    templateId?: string;

    /**
     * Data passed to template
     */
    model?: unknown;

    /**
     * Text representation of email
     */
    text?: string;

    subject: string;

    lang?: string;

    priority?: string;

    replyTo?: string;

    /**
     * Additional tag for email,
     * usefull for identyfying emails by category or module that sends it
     */
    tag?: string;

    /**
     * Unique email id, for identification eg. in case of delivery failure
     */
    emailId?: string;
}


@Injectable()
export class EmailService {

    /**
     *
     * Sends email immediatelly ( in current process )
     *
     * @param email - email to send
     */
    public send(email: IEmail): Promise<void> {
        return window.ipc.__spinaJsIpcBridge.callSync("send", "EmailService", email);

    }

}