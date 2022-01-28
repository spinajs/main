import { AsyncModule, IContainer } from "@spinajs/di";

export class FooService extends AsyncModule {

    public Counter = 0;
    
    public resolveAsync(_: IContainer): Promise<void> {
        this.Counter ++;
        return Promise.resolve();
    }

}