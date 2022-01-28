type Abstract<T = any> = Function & { prototype: T };
type Constructor<T = any> = new (...args: any[]) => T;
type Class<T = any> = Abstract<T> | Constructor<T>;
 
declare class TypedArray<T> extends Array<T>{
    Type : Class<T>;
}

interface ArrayConstructor {
    ofType<T>(type: Class<T>): TypedArray<T>;
}
 