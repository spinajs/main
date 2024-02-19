import { EmailService, IEmail } from "./interfaces.js";
import { _chain } from "@spinajs/util";
import { _resolve } from "@spinajs/di";
import { EmailSend } from "./jobs/EmailSend.js";
/**
 * Sends immediately email
 */
export async function _email_send(email: IEmail) {
    return _chain(
        _resolve(EmailService),
        (srv: EmailService) => srv.send(email)
    )
}

/**
 * Sends email in background
 */
export async function _email_deferred(email: IEmail) {
    return _chain<EmailSend>(
        _resolve(EmailService),
        (srv: EmailService) => srv.sendDeferred(email)
    )
}