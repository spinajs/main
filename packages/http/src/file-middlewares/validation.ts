import { Autoinject, Injectable, NewInstance } from "@spinajs/di";
import { FileProportions, FileUploadMiddleware, FileValidationRules, IUploadedFile, IUploadOptions } from "../interfaces.js";
import { Log, Logger } from "@spinajs/log-common";
import { FileInfoService } from "@spinajs/fs";
import { ValidationFailed } from "@spinajs/validation";


/**
 * Middleware that validates file before upload eg. check file type, withth, height, size, etc.
 */
@Injectable()
@NewInstance()
export class FileValidationMiddleware extends FileUploadMiddleware {
    @Logger('http')
    protected Log!: Log;

    @Autoinject()
    protected FileInfo!: FileInfoService;

    constructor(protected Rules: FileValidationRules) {
        super();
    }


    public async beforeUpload(file: IUploadedFile<any>, _paramOptions: IUploadOptions): Promise<any> {
        // No rules configured -> nothing to validate (and guards against a
        // TypeError if the middleware is resolved without an options object).
        if (!this.Rules) {
            return file;
        }

        await this.ensureFileInfo(file);

        this.validateSize(file);
        this.validateType(file);
        this.validateProportions(file);
        this.validateResolution(file);
        return file;
    }

    /**
     * Type / proportion / resolution rules need content-detected metadata
     * (`file.Info`). It is normally populated by FileInfoMiddleware, but only
     * when the `fileInfo` upload option is set. Fetch it here when it's missing
     * so validation works regardless of upload options — otherwise every rule
     * would fail with a misleading "unable to determine ..." error.
     */
    protected async ensureFileInfo(file: IUploadedFile<any>) {
        const needsInfo = !!(this.Rules.types?.length || this.Rules.proportions || this.Rules.resolution);
        if (!needsInfo || file.Info) {
            return;
        }

        if (this.FileInfo && file.OriginalFile?.filepath) {
            file.Info = await this.FileInfo.getInfo(file.OriginalFile.filepath);
        }
    }

    protected validateSize(file: IUploadedFile<any>) {
        if (!this.Rules.size) {
            return;
        }

        const { min, max } = this.Rules.size;

        if (min !== undefined && file.Size < min) {
            throw new ValidationFailed('validation error', [{
                instancePath: '/file/size',
                schemaPath: '#/properties/file/size',
                keyword: 'size',
                params: { min, actual: file.Size },
                message: `File size must be at least ${min} bytes. Got: ${file.Size} bytes`
            }]);
        }

        if (max !== undefined && file.Size > max) {
            throw new ValidationFailed('validation error', [{
                instancePath: '/file/size',
                schemaPath: '#/properties/file/size',
                keyword: 'size',
                params: { max, actual: file.Size },
                message: `File size must be at most ${max} bytes. Got: ${file.Size} bytes`
            }]);
        }
    }

    protected validateType(file: IUploadedFile<any>) {

        if (!this.Rules.types || this.Rules.types.length === 0) {
            return;
        }
 

        if (!file.Info || !file.Info!.MimeType) {
            throw new ValidationFailed('validation error', [{
                instancePath: '/file/type',
                schemaPath: '#/properties/file/type',
                keyword: 'type',
                params: {},
                message: 'Unable to determine file type'
            }]);
        }

        const isValid = this.Rules.types.some(allowedType => {
            // Support wildcards like 'image/*'
            if (allowedType.endsWith('/*')) {
                const category = allowedType.split('/')[0];
                return file.Info!.MimeType!.startsWith(category + '/');
            }
            return file.Info!.MimeType!.toLowerCase() === allowedType.toLowerCase();
        });

        if (!isValid) {
            throw new ValidationFailed('validation error', [{
                instancePath: '/file/type',
                schemaPath: '#/properties/file/type',
                keyword: 'type',
                params: {
                    allowedTypes: this.Rules.types,
                    actual: file.Info!.MimeType
                },
                message: `File type must be one of: ${this.Rules.types.join(', ')}. Got: ${file.Info!.MimeType}`
            }]);
        }

    }

    protected validateProportions(file: IUploadedFile<any>) {

        if (!this.Rules.proportions) {
            return file;
        }

        if (!file.Info! || !file.Info!.Width || !file.Info!.Height) {
            throw new ValidationFailed('validation error', [{
                instancePath: '/file',
                schemaPath: '#/properties/file/proportions',
                keyword: 'proportions',
                params: {},
                message: 'Unable to read image dimensions from file metadata'
            }]);
        }

        this.Rules.proportions.forEach(prop => {
            if (prop === FileProportions.Free) {
                return;
            }

            const [expectedWidth, expectedHeight] = prop.split(':').map(Number);
            if (!expectedWidth || !expectedHeight) {
                throw new ValidationFailed('validation error', [{
                    instancePath: '/file/proportions',
                    schemaPath: '#/properties/file/proportions',
                    keyword: 'proportions',
                    params: { proportions: prop },
                    message: `Invalid proportion format: ${prop}`
                }]);
            }

            const actualRatio = file.Info!.Width! / file.Info!.Height!;
            const expectedRatio = expectedWidth / expectedHeight;
            const tolerance = 0.01; // 1% tolerance

            if (Math.abs(actualRatio - expectedRatio) > tolerance) {
                throw new ValidationFailed('validation error', [{
                    instancePath: '/file/proportions',
                    schemaPath: '#/properties/file/proportions',
                    keyword: 'proportions',
                    params: {
                        expected: this.Rules.proportions,
                        actual: `${file.Info!.Width}x${file.Info!.Height}`,
                        ratio: actualRatio.toFixed(2)
                    },
                    message: `Image proportions must be ${this.Rules.proportions}. Got: ${file.Info!.Width}x${file.Info!.Height} (${actualRatio.toFixed(2)})`
                }]);
            }
        });
    }

    protected validateResolution(file: IUploadedFile<any>) {

        if (!this.Rules.resolution) {
            return;
        }

        if (!file.Info || !file.Info!.Width || !file.Info!.Height) {
            throw new ValidationFailed('validation error', [{
                instancePath: '/file',
                schemaPath: '#/properties/file/resolution',
                keyword: 'resolution',
                params: {},
                message: 'Unable to read image dimensions from file metadata'
            }]);
        }


        if (file.Info!.Width < this.Rules.resolution?.minWidth!) {
            throw new ValidationFailed('validation error', [{
                instancePath: '/file/width',
                schemaPath: '#/properties/file/resolution/width',
                keyword: 'resolution',
                params: { expected: this.Rules.resolution?.minWidth, actual: file.Info!.Width },
                message: `Image width must be greater than ${this.Rules.resolution?.minWidth}px. Got: ${file.Info!.Width}px`
            }]);
        }

        if (file.Info!.Height < this.Rules.resolution?.minHeight!) {
            throw new ValidationFailed('validation error', [{
                instancePath: '/file/height',
                schemaPath: '#/properties/file/resolution/height',
                keyword: 'resolution',
                params: { expected: this.Rules.resolution?.minHeight, actual: file.Info!.Height },
                message: `Image height must be greater than ${this.Rules.resolution?.minHeight}px. Got: ${file.Info!.Height}px`
            }]);
        }

        if (file.Info!.Height > this.Rules.resolution?.maxHeight!) {
            throw new ValidationFailed('validation error', [{
                instancePath: '/file/height',
                schemaPath: '#/properties/file/resolution/height',
                keyword: 'resolution',
                params: { expected: this.Rules.resolution?.maxHeight, actual: file.Info!.Height },
                message: `Image height must be lower than ${this.Rules.resolution?.maxHeight}px. Got: ${file.Info!.Height}px`
            }]);
        }

        if (file.Info!.Width > this.Rules.resolution?.maxWidth!) {
            throw new ValidationFailed('validation error', [{
                instancePath: '/file/width',
                schemaPath: '#/properties/file/resolution/width',
                keyword: 'resolution',
                params: { expected: this.Rules.resolution?.maxWidth, actual: file.Info!.Width },
                message: `Image width must be lower than ${this.Rules.resolution?.maxWidth}px. Got: ${file.Info!.Width}px`
            }]);
        }
    }
}