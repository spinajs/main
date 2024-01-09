import { BasePath, BaseController, FormField, Ok, Post, Form, File, IUploadedFile, ZipFileTransformer, UnzipFileTransformer } from '../../../src/index.js';
import { SampleModelWithHydrator3, SampleObject } from '../../dto/index.js';
import { SampleModel } from '../../dto/index.js';
import { TestTransformer } from '../../file-transformers/custom-file-transformer.js';
import { CustomFileUploader } from '../../uploaders/custom-uploader.js';


@BasePath('params/forms')
export class FormParams extends BaseController {
  @Post()
  public formField(@FormField() name: string) {
    return new Ok({ name });
  }

  @Post()
  public multipleFormField(@FormField() name: string, @FormField() name2: string) {
    return new Ok({ name, name2 });
  }

  @Post()
  public formObject(@Form() model: SampleObject) {
    return new Ok({ model });
  }

  @Post()
  public formModel(@Form() model: SampleModel) {
    return new Ok({ model });
  }

  @Post()
  public formModelWithHydrator(@Form() model: SampleModelWithHydrator3) {
    return new Ok({ model });
  }

  @Post()
  public formWithFile(@Form() contact: SampleObject, @File() file: IUploadedFile) {
    return new Ok({ contact, file });
  }

  @Post()
  public fileArray(@File() files: IUploadedFile[]) {
    return new Ok(files);
  }

  @Post()
  public fileWithCustomUploader(@File({ uploader: CustomFileUploader }) file: IUploadedFile) {
    return new Ok(file);
  }

  @Post()
  public fileWithCustomUploaderFs(@File({ uploaderFs: 'test2' }) file: IUploadedFile) {
    return new Ok(file);
  }

  @Post()
  public fileRequired(@File({ required: true }) file: IUploadedFile) {
    return new Ok(file);
  }

  @Post()
  public fileWithMaxSize(@File({ maxFileSize: 15 }) file: IUploadedFile) {
    return new Ok(file);
  }

  @Post()
  public fileWithCustomTransformers(@File({ transformers: [TestTransformer] }) file: IUploadedFile) {
    return new Ok(file);
  }

  @Post()
  public fileWithZipTransformer(@File({ transformers: [ZipFileTransformer] }) file: IUploadedFile) {
    return new Ok(file);

  }

  @Post()
  public fileWithUnzipTransformer(@File({ transformers: [UnzipFileTransformer] }) file: IUploadedFile) {
    return new Ok(file);

  }
}
