import { DateTime } from "luxon";
import { CloudFrontUrlSigner } from "./interfaces.js";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import { Injectable } from "@spinajs/di";

@Injectable(CloudFrontUrlSigner)
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
