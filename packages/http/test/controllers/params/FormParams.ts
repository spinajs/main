import { BasePath, BaseController, FormField, Ok, Post, Form, File, IUploadedFile } from '../../../src';
import { SampleModelWithHydrator3, SampleObject } from '../../dto';
import { SampleModel } from '../../dto';

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
}
