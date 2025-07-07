import { DateTime } from "luxon";
import { CloudUrlSigner } from "./interfaces.js";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import { Injectable } from "@spinajs/di";

@Injectable()
export class CloudFrontUrlSigner extends CloudUrlSigner {

    public async sign(path: string, until?: DateTime) {

        const url = `${this.options.domain}/${path}`;

        return await getSignedUrl({
            url,
            keyPairId: this.options.publicKeyId,
            privateKey: this.options.privateKey,
            dateLessThan: until ? until.toISO() : DateTime.now().plus({ hour: 1 }).toISO()
        });

    }

}