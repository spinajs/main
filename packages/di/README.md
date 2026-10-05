#  Basics

Dependency injection in SpinaJS is done by decorators - ES Next feature supported by Typescript. Lets go straight to example.

Lets say we have class `UserController` that wants some data from database. It depends on some kind of database object that is used all across application, lets call it `Orm`. We dont want to hardcode this dependency, neither create new database object every time. We want to get it from DI container that handle it's creation and lifetime.

```typescript 

import { Inject } from "@spinajs/core";
import { Orm } from "service/database";

@Inject(Orm)
class UserController{

    private Database : Orm;

    constructor(database : Orm){

        //  database object is avaible and ready to use
        this.Database = database;
    }
}


```

In example code above we used special decorator `@Inject` that tells DI container that class `UserController` depends on `Orm` class, and every time `UserController` is created it must first obtain instance of `Orm` and pass it to constructor. Notice how constructor signature matches list of dependencies in `@Inject` decorator. You can also have as many injected dependencies as you need. Here's a quick example:

```typescript
import { Inject } from "@spinajs/core";
import { Orm } from "service/database";
import { EmailSender } from "service/email";

@Inject(Orm, EmailSender)
class UserController{

    private Database : Orm;
    private Email : EmailSender;

    constructor(database : Orm, email : EmailSender){
        this.Database = database;
        this.Email = email;
    }

    public async registerUser(/** some parameters */){
        await this.Database.insert(/* some data*/);
        await this.Email.sendEmail(/* some data*/);
    }
}


```

> SpinaJS heavily depends on decorators. To use it you must enable `"experimentalDecorators" : true"` setting to the `compilerOptions` section of `tsconfig.json`

Also with typescript having information about types it is possible to skip explicit type declaration and constructor initialization. We can tell DI container to automatically inject dependencies based on variable type. It uses Typescript experimental feature that allows to extract variable type by transpiler. To use it you must set `"emitDecoratorMetadata": true"` in `compilerOptions` setion of your `tsconfig.json`. He's the example:

```typescript

import { Inject } from "@spinajs/core";
import { Orm } from "service/database";
import { EmailSender } from "service/email";


class UserController{

    @Autoinject
    private Database : Orm;

    @Autoinject
    private Email : EmailSender;

    public async registerUser(/** some parameters */){
        await this.Database.insert(/* some data*/);
        await this.Email.sendEmail(/* some data*/);
    }
}

```

Notice how we use `@Autoinject` decorator with class properties and we get rid of constructor and avoid write tedious code. DI container will automaticaly extract property type and resolve it before `UserController` is created.

## Manual resolving

If for some reason you dont want to use DI for heavy work you can resolve instances and their dependencies programmatically. Lets say you have function in some place in your code that is called by external tool or application, like this:

```typescript

import { DI } from "@spinajs/core";
import { Orm } from "service/database";

async function cleanUserHistory()
{
    const database = await DI.resolve<Orm>(Orm);

    await database.UsersHistory.select().olderThan(5, "days").delete();
}

cleanUserHistory();

```

We use `resolve` function of DI container to resolve dependency.

Di container expose more usefull functions for manual usage:

* `has` to check if type is already resolved and exists in container
* `get` to return resolved object if exists in container, if not returns nothing

Examples below:

```typescript

import { DI } from "@spinajs/core";
import { Orm } from "service/database";

async function cleanUserHistory()
{
    if(DI.has(Orm)){

        // Orm instance already exists in container, we can obtain it
        const database = DI.get(Orm);
    }
}

cleanUserHistory();


```

## Retreving already created instances

Sometimes we dont want to resolve ( and create new if not exists in container ) instance - just get whats in container or get nothing. Its like optional dependency, if not exists - dont worry, we can ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
+-++--+--++-+--++-++-
## Root container, child containers and DI namespace

Root container is app-wise main DI container that holds all references for resolved objects. It's default container, accessed via DI namespace as shown in previous examples. All we do by methods exposed in the `DI` namespace use root container.

SpinaJS depencendy injection implementation also have concept of child containers. We can create child containers from main `root` container that exists in SpinaJS. Child containers are mainly used to overriding DI configuration ( if you want change default services for different implementations or inject mocked objects in tests ). Created child containers inherits all data from parent container.

```typescript



```

### All registrations of a type: `Array.ofType` and `Array.chainOf`

`Array.ofType(T)` resolves the list of the nearest container that registers `T`, so a child's list hides its parent's. `Array.chainOf(T)` merges the lists of the container and all its ancestors:

* ancestors come first;
* a class registered in a child under the name of an ancestor's class replaces that class in place;
* factory registrations are always kept;
* every element is resolved in the container that registered it, except `PerChildContainer` classes, which are resolved in the resolving container.

```typescript
DI.register(Rbac).as(Model);
const child = DI.child();
child.register(Abac).as(Model);

child.resolve(Array.ofType(Model));          // [ Abac ]
await child.resolve(Array.chainOf(Model));   // [ Rbac, Abac ]
child.getRegisteredTypes(Array.chainOf(Model)); // [ Rbac, Abac ], element i is the registration of instance i

class Consumer {
  @Autoinject(Array.chainOf(Model))
  public models: Model[];
}
```

`resolve(Array.chainOf(T))` returns a promise when `T` or any element is an `AsyncService`, so await it. `get` and `isResolved` do not accept a chain.

## Object lifetime

## Overriding objects

## Passing parameters to object contructor

## Object factories

## Explicit configuration

## Resolve strategies

## How SpinaJS uses containers


