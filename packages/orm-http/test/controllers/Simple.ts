import { BaseController, Get, Ok, BasePath, Post, Body, Query, Param } from '@spinajs/http';
import { FromModel } from './../../src/index.js';
import { Test } from '../models/Test.js';

@BasePath('simple')
export class Simple extends BaseController {
  @Get(':model')
  public testGet(@FromModel() model: Test) {
    return new Ok({ Text: model.Text });
  }

  @Post()
  public testHydrate(@Body() model: Test) {
    return new Ok({ Text: model.Text });
  }

  @Get('testinclude/:model')
  public testInclude(@FromModel() model: Test, @Query() _include: string[]) {
    return new Ok(model.dehydrateWithRelations());
  }

  /**
   * Parent-scoped lookup. The `belongs` argument is not read by this handler, but it is
   * NOT decoration: FromParams publishes it as `Payload.Param.Args`, and
   * fromDbModelDefaultQueryFunction matches that key against the model's BelongsTo
   * relation to constrain the query to the parent. Deleting it would silently widen the
   * lookup to every parent.
   *
   * It is named after the placeholder rather than `_belongs`: an underscore-prefixed path
   * argument resolves nowhere now, on either side.
   */
  @Get('testWithParent/:belongs/:model')
  public testWithParent(@FromModel() model: Test, @Param() belongs: number) {
    return new Ok({ ...model.dehydrateWithRelations(), belongs });
  }

  /**
   * Placeholder ( :id ) that does NOT match the argument name ( model ), stated with
   * paramField. Every other route here happens to name the placeholder after the
   * argument; real apps write `@Get(':id') getSlide(@FromModel() slide)`, where the two
   * differ and the key has to be named explicitly.
   */
  @Get('mismatch/:id')
  public testNameMismatch(@FromModel({ paramField: 'id' }) model: Test) {
    return new Ok({ Text: model.Text });
  }
}
