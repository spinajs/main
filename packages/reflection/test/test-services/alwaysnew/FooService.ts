import { NewInstance } from "@spinajs/di";

@NewInstance()
export class FooService {
    public Counter = 0;

    constructor() {
        this.Counter++;
    }

}