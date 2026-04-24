import { DateTime } from "luxon";
import { S3UrlSigner } from "./interfaces.js";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Injectable } from "@spinajs/di";
import { GetObjectCommand } from "@aws-sdk/client-s3";

@Injectable(S3UrlSigner)
export class S3BucketSigner extends S3UrlSigner {

    public async sign(path: string, until?: DateTime) {
        const command = new GetObjectCommand({
            Bucket: this.options.bucket,
            Key: path,
        });

        return getSignedUrl(this.options.s3Client, command, { expiresIn: this.getExpiresInSeconds(until) });
    }

}