import { BasePath, BaseController, FormField, Ok, Post, Form, File, IUploadedFile } from '../../../src';
import { SampleObject } from '../../dto';
import { SampleModel, SampleModelWithHydrator } from '../../dto';

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
  public formModelWithHydrator(@Form() model: SampleModelWithHydrator) {
    return new Ok({ model });
  }

  @Post()
  public formWithFile(@Form() _contact: any, @File() _index: IUploadedFile) {
    return new Ok();
  }

  @Post()
  public fileArray(@File() _files: IUploadedFile[]) {
    return new Ok();
  }
}
