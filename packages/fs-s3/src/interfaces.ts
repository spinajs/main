import { DateTime } from "luxon";

export interface ICloudUrlSignerOptions {
    privateKey: string;
    publicKeyId: string;
    domain: string;
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

export abstract class CloudUrlSigner {
    constructor(protected options: ICloudUrlSignerOptions) {

    }

    /**
     * 
     * @param path url path to access / sign
     * @param until link valid until ? if null valid for 1 hour
     */
    public abstract sign(path: string, until?: DateTime): Promise<string>;
}