import { DateTime } from "luxon";
import { CloudFrontUrlSigner } from "./interfaces.js";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import { Injectable, NewInstance } from "@spinajs/di";

@Injectable(CloudFrontUrlSigner)
// built with per-provider options ( domain, keys ), so it must not be shared
@NewInstance()
export class CloudFrontSigner extends CloudFrontUrlSigner {

    public async sign(path: string, until?: DateTime) {
        const url = `${this.options.domain}/${path}`;

        return getSignedUrl({
            url,
            keyPairId: this.options.publicKeyId,
            privateKey: this.options.privateKey,
            dateLessThan: this.getDateLessThan(until),
        });
    }

}
