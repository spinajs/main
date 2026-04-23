import { S3Client } from "@aws-sdk/client-s3";
import { DateTime } from "luxon";

export interface IS3UrlSigner {
    privateKey: string;
    publicKeyId: string;
    domain: string;
    bucket: string;
    s3Client: S3Client;
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
     * 
     * @param path url path to access / sign
     * @param until link valid until ? if null valid for 1 hour
     */
    public abstract sign(path: string, until?: DateTime): Promise<string>;
}