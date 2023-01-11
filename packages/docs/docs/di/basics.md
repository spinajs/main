---
sidebar_position: 1
---

#  Basics

Dependency injection is a powerfull concept used for making comples system simpler.
Dependency injection is heavily used in @spinajs. It is mainly done by decorators, but also can be configured in config files or used manually.

## Using DI container

To create service with DI container simply use resolve function of container.

```typescript

import { DI } from "@spinajs/di";
import { SomeService } from "./someService";

const instance = DI.resolve(SomeService);

```

To retrieve value that was already resolved use get() function of container. This function does not create new service, but instead tries to retrieve it from container cache. If service was not resolved earlier, it returns null. If we try to get value that was not registered before calling get, it will also return null;

> If service is decorated with @NewInstance() decorator, get() will return nothing even if we resolved this service before. Its becouse @NewInstance() tells container to always create new instance at resolve, and its not tracked / added to cache.

```typescript

// somewhere in code
DI.resolve(SomeService)

// ...
// some other place in code

const service = DI.get(SomeService);
if(service){ 
    // if service is created do something.
}

```

Resolve function accepts class constructor ( type ) or string containing name of resolved object. Note that not only classes can be resolved by container. It can be array of services or any type of object / basic type. To resolve objects / values, they need to be registered in container first.

Here is example of retrievieng registered value:

```typescript

DI.register(1).asValue("SampleValue");

const value = DI.get("SampleValue");

// or

const value = DI.resolve("SampleValue");


```

## Root & child containers

By default using DI.resolve() uses root container. It means that this container has no parent and its on top of hierarchy. All objects and services registered or created in this container are avaible in child containers.

Use child container to override services in root container, or to create isolated space for app subsystems. For example one part of application uses default implementation, but other part need to use specific implementation of this service. By default resolve() uses last registered type, so using child container and registering there serivice can override parent implementation / instance of that type.

```typescript

class Configuration {} 
class FileConfiguration extends Configuration {}
class DbConfiguration extends Configuration {}

// register base implementation as Configuration service
DI.register(FileConfiguration).as(Configuration);

// resolve using root container
const c1 = DI.resolve(Configuration);

// ...

// in some other part of application
// we need to use db configuration
const childContainer = DI.child();

// register DbConfiguration, it will override type registered in parent container
// event if we already resolved Configuration type, resolving it from child container
// will create new instance od DbConfiguration
childContainer.register(DbConfiguration).as(Configuration);

// c2 is instance of DbConfiguration
const c2 = childContainer.resolve(Configuration);

```

For more advanced usage of child containers check [here](advanced_usage.md#child-containers)

## Simple resolving & registering types

To use DI container we dont need to do anything special - just call DI.resolve() with type we want to resolve as parameter.

## Injecting with decorator

Lets say we have class `UserController` that wants some data from database. It depends on some kind of database object that is used all across application, lets call it `Orm`. We dont want to hardcode this dependency, neither create new database object every time. We want to get it from DI container that handle it's creation and lifetime.

Notice that we use the inject decorator and that the constructor signature matches the list of dependencies in the inject decorator. This tells the DI that any time it wants to create an instance of UserController it must first obtain an instance of Orm which it can inject into the constructor of UserController during instantiation. You can have as many injected dependencies as you need. Simply ensure that the inject decorator and the constructor match one another, including the order of the dependencies.

```typescript 

// import Inject decorator from di module
import { Inject } from "@spinajs/di";

// some example service
import { Orm } from "service/database";

@Inject(Orm)
class UserController{

    // database object is injected from DI container
    // or created 
    constructor(private database : Orm){

        //  database object is avaible and ready to use
        database.select(...);
    }
}

```

Decorator `@Inject` tells DI container that we want to use service Orm, and inject it in `UserController` constructor.
To use this feature class UserController should be also created via DI container:

```typescript

const controller = DI.resolve(UserController);

```

> SpinaJS heavily depends on decorators. To use it you must enable `"experimentalDecorators" : true"` setting to the `compilerOptions` section of `tsconfig.json`

## Injecting multiple services

Sometimes we want to inject all services ( or values ) of same type registered in container. Lets say we have loggin service that can log into multiple targets - file, network, db etc. We want to register multiple targets, resolve them all, and invoke write function. We can do this in two ways, by @Autoinject decorator, or manually using DI.resolve() anywhere in code ( preferably in service resolve() function )

Example using @Autoinject decorator;

```typescript

class Logger { 

    @Autoinject(LogTarget)
    protected Targets: LogTarget[];
}


```

It is simple as declaring property as array. Container can detect, that we inject type into property of array type, and tries to inject all registered types.


Example retrieving all services manually:

```typescript

// We use Array.ofType to tell container that we want resolve all registered types
const services = DI.resolve(Array.ofType(SomeService));

// do something with them
services.forEach(/*...*/);

```

The same works with DI.get() :

```typescript

const services = DI.get(Array.ofType(SomeService));

```

Or with values:

```typescript

DI.register(1).asValue("Value");
DI.register(2).asValue("Value");

// we get [1,2]
const values = DI.get(Array.ofType("Value"));

```

## Autoinject

## Passing options to service

## Use of factories

## Use of raw objects & basic types

## Retrieving information from container

## Events
