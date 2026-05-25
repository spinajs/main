import { S3Client } from "@aws-sdk/client-s3";
import { DateTime } from "luxon";

export interface IS3UrlSigner {
    bucket: string;
    s3Client: S3Client;
}

export interface ICloudfrontUrlSignerOptions {
    privateKey: string;
    publicKeyId: string;
    domain: string;
    bucket: string;
}


export interface IS3Config {
    bucket: string;
    name: string;

    createBucketIfNotExists?: boolean;

    signer?: {
        service: string;
        privateKey: string;
        publicKeyId: string;
        domain: string;
    }
}

export abstract class S3UrlSigner {
    constructor(protected options: IS3UrlSigner) {

    }

    /**
     * Returns the number of seconds from now until the given expiration time.
     * Defaults to 900 seconds (15 minutes) when `until` is not provided.
     * Ensures a minimum of 1 second.
     */
    protected getExpiresInSeconds(until?: DateTime): number {
        const expiresIn = until
            ? Math.floor(until.diffNow("seconds").seconds)
            : 900;
        return Math.max(1, expiresIn);
    }

    /**
     * 
     * @param path url path to access / sign
     * @param until link valid until ? if null valid for 1 hour
     */
    public abstract sign(path: string, until?: DateTime): Promise<string>;
}

export abstract class CloudFrontUrlSigner {
    constructor(protected options: ICloudfrontUrlSignerOptions) {

    }

    /**
     * Returns an ISO 8601 date string for the expiration time.
     * Defaults to 1 hour from now when `until` is not provided.
     */
    protected getDateLessThan(until?: DateTime): string {
        return (until ?? DateTime.now().plus({ hour: 1 })).toISO()!;
    }

    /**
     * 
     * @param path url path to access / sign
     * @param until link valid until ? if null valid for 1 hour
     */
    public abstract sign(path: string, until?: DateTime): Promise<string>;
}