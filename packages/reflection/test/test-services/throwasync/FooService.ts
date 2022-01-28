import { AsyncModule, IContainer } from "@spinajs/di";

export class FooService22 extends AsyncModule {

    public resolveAsync(_: IContainer): Promise<void> {
        return Promise.resolve();
    }

}