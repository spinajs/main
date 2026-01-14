import { Injectable, NewInstance } from "@spinajs/di";
import { FileProportions, FileUploadMiddleware, FileValidationRules, IUploadedFile, IUploadOptions } from "../interfaces.js";
import { Log, Logger } from "@spinajs/log-common";
import { ValidationFailed } from "@spinajs/validation";


/**
 * Middleware that validates file before upload eg. check file type, withth, height, size, etc.
 */
@Injectable()
@NewInstance()
export class FileValidationMiddleware extends FileUploadMiddleware {
    @Logger('http')
    protected Log: Log;

    constructor(protected Rules: FileValidationRules) {
        super();
    }


    public async beforeUpload(file: IUploadedFile<any>, _paramOptions: IUploadOptions): Promise<any> {
        this.validateType(file);
        this.validateProportions(file);
        this.validateResolution(file);
        return file;
    }

    protected validateType(file: IUploadedFile<any>) {

        if (!this.Rules.types || this.Rules.types.length === 0) {
            return;
        }

        if (!file.Info.MimeType) {
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
                return file.Info.MimeType!.startsWith(category + '/');
            }
            return file.Info.MimeType!.toLowerCase() === allowedType.toLowerCase();
        });

        if (!isValid) {
            throw new ValidationFailed('validation error', [{
                instancePath: '/file/type',
                schemaPath: '#/properties/file/type',
                keyword: 'type',
                params: {
                    allowedTypes: this.Rules.types,
                    actual: file.Info.MimeType
                },
                message: `File type must be one of: ${this.Rules.types.join(', ')}. Got: ${file.Info.MimeType}`
            }]);
        }

    }

    protected validateProportions(file: IUploadedFile<any>) {

        if (!this.Rules.proportions) {
            return file;
        }

        if (!file.Info.Width || !file.Info.Height) {
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

            const actualRatio = file.Info.Width / file.Info.Height;
            const expectedRatio = expectedWidth / expectedHeight;
            const tolerance = 0.01; // 1% tolerance

            if (Math.abs(actualRatio - expectedRatio) > tolerance) {
                throw new ValidationFailed('validation error', [{
                    instancePath: '/file/proportions',
                    schemaPath: '#/properties/file/proportions',
                    keyword: 'proportions',
                    params: {
                        expected: this.Rules.proportions,
                        actual: `${file.Info.Width}x${file.Info.Height}`,
                        ratio: actualRatio.toFixed(2)
                    },
                    message: `Image proportions must be ${this.Rules.proportions}. Got: ${file.Info.Width}x${file.Info.Height} (${actualRatio.toFixed(2)})`
                }]);
            }
        });
    }

    protected validateResolution(file: IUploadedFile<any>) {

        if (!this.Rules.resolution) {
            return;
        }

        if (!file.Info.Width || !file.Info.Height) {
            throw new ValidationFailed('validation error', [{
                instancePath: '/file',
                schemaPath: '#/properties/file/resolution',
                keyword: 'resolution',
                params: {},
                message: 'Unable to read image dimensions from file metadata'
            }]);
        }


        if (file.Info.Width < this.Rules.resolution?.minWidth!) {
            throw new ValidationFailed('validation error', [{
                instancePath: '/file/width',
                schemaPath: '#/properties/file/resolution/width',
                keyword: 'resolution',
                params: { expected: this.Rules.resolution?.minWidth, actual: file.Info.Width },
                message: `Image width must be greater than ${this.Rules.resolution?.minWidth}px. Got: ${file.Info.Width}px`
            }]);
        }

        if (file.Info.Height < this.Rules.resolution?.minHeight!) {
            throw new ValidationFailed('validation error', [{
                instancePath: '/file/height',
                schemaPath: '#/properties/file/resolution/height',
                keyword: 'resolution',
                params: { expected: this.Rules.resolution?.minHeight, actual: file.Info.Height },
                message: `Image height must be greater than ${this.Rules.resolution?.minHeight}px. Got: ${file.Info.Height}px`
            }]);
        }

        if (file.Info.Height > this.Rules.resolution?.maxHeight!) {
            throw new ValidationFailed('validation error', [{
                instancePath: '/file/height',
                schemaPath: '#/properties/file/resolution/height',
                keyword: 'resolution',
                params: { expected: this.Rules.resolution?.maxHeight, actual: file.Info.Height },
                message: `Image height must be lower than ${this.Rules.resolution?.maxHeight}px. Got: ${file.Info.Height}px`
            }]);
        }

        if (file.Info.Width > this.Rules.resolution?.maxWidth!) {
            throw new ValidationFailed('validation error', [{
                instancePath: '/file/width',
                schemaPath: '#/properties/file/resolution/width',
                keyword: 'resolution',
                params: { expected: this.Rules.resolution?.maxWidth, actual: file.Info.Width },
                message: `Image width must be lower than ${this.Rules.resolution?.maxWidth}px. Got: ${file.Info.Width}px`
            }]);
        }

        if (file.Info.Height > this.Rules.resolution?.maxHeight!) {
            throw new ValidationFailed('validation error', [{
                instancePath: '/file/height',
                schemaPath: '#/properties/file/resolution/height',
                keyword: 'resolution',
                params: { expected: this.Rules.resolution?.maxHeight, actual: file.Info.Height },
                message: `Image height must be lower than ${this.Rules.resolution?.maxHeight}px. Got: ${file.Info.Height}px`
            }]);
        }
    }
}