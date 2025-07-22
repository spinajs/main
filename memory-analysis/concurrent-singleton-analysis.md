# Concurrent Singleton Creation Analysis - Critical Memory Bug

## Executive Summary

**CRITICAL MEMORY BUG DISCOVERED**: The DI container's singleton resolution mechanism is fundamentally broken under concurrent access, creating multiple instances of services marked as `@Singleton()`. This is a severe memory leak that can cause exponential memory growth in multi-threaded or async-heavy applications.

**Issue**: 100 instances created instead of 1 when resolving singleton concurrently  
**Impact**: CRITICAL - Severe memory leaks, broken singleton guarantees, potential system instability  
**Root Cause**: Race condition in singleton resolution with no synchronization mechanism

## Issue Description

### The Problem
When multiple concurrent requests attempt to resolve the same singleton service, the DI container creates multiple instances instead of returning the same cached instance. This occurs because:

1. **Race Condition**: Multiple threads check the cache simultaneously, find it empty, and proceed to create new instances
2. **Async Service Resolution**: The current implementation doesn't handle Promise-based service creation properly for concurrent access
3. **No Synchronization**: There's no mutex or locking mechanism to prevent concurrent instantiation

### Current Behavior (Broken)
```typescript
@Singleton()
class MyService extends AsyncService {
  static instanceCount = 0;
  constructor() {
    super();
    MyService.instanceCount++;
  }
}

// Concurrent resolution creates 100 instances!
const promises = Array.from({ length: 100 }, () => 
  container.resolve('service')
);
const services = await Promise.all(promises);
// Result: MyService.instanceCount = 100 (WRONG!)
// Expected: MyService.instanceCount = 1
```

### Observed Impact
- **Memory Multiplication**: N × singleton size (where N = concurrent requests)
- **Resource Exhaustion**: Can lead to OOM in high-concurrency scenarios
- **Data Inconsistency**: Multiple instances may have different state
- **Performance Degradation**: Excessive GC pressure from duplicate objects

## Root Cause Analysis

### Code Flow Analysis

1. **Resolution Entry Point** (`resolveType` method in `src/container.ts:440-452`):
   ```typescript
   // Multiple threads reach this point simultaneously
   if (isSingletonInChild || isSingleton) {
     const cached = getCachedInstance(sourceType, isSingleton);
     if (cached) {
       return cached as any; // This check fails for all concurrent requests
     }
   }
   // All threads proceed to create new instances
   ```

2. **Cache Check Logic**:
   ```typescript
   const getCachedInstance = (e, parent) => {
     if (this.isResolved(e, parent)) {
       // All concurrent requests see empty cache
       return this.get(e as any, parent);
     }
     return null; // All return null, proceeding to create instances
   };
   ```

3. **Instance Creation Race**:
   ```typescript
   const createNewInstance = (t, i, options) => {
     const instance = this.getNewInstance(t, i, options);
     if (isPromise(instance)) {
       return instance.then((r) => {
         setCache(r); // Multiple instances get cached (last one wins)
         emit(r);
         return r;
       });
     }
     // Each thread creates its own instance
   };
   ```

### The Race Condition Timeline

```
Time    Thread 1              Thread 2              Thread 3
T1      Check cache (empty)   
T2                            Check cache (empty)   
T3                                                  Check cache (empty)
T4      Start creating        Start creating        Start creating
T5      Instance A created    Instance B created    Instance C created
T6      Cache Instance A      Cache Instance B      Cache Instance C
```

**Result**: Multiple instances in memory, cache contains latest instance only.
// Thread 2: Check cache -> empty  
// Thread 1: Create instance -> set cache
// Thread 2: Create instance -> set cache (overwrites!)
```

#### 3. **Async Service Resolution**
The problem is exacerbated by async service initialization:
```typescript
const createNewInstance = (t: Class<T>, i: IResolvedInjection[], options: any) => {
  const instance = this.getNewInstance(t, i, options);
  if (isPromise(instance)) {
    return instance.then((r) => {
      setCache(r);  // Cache set AFTER async completion
      emit(r);
      return r;
    });
  }
  // ...
};
```

## Technical Analysis

### Concurrency Issues

#### **Issue 1: Check-Then-Act Race Condition**
```typescript
// Multiple threads can pass this check simultaneously
if (!this.isResolved(service)) {
  // Time gap here allows multiple instances
  const instance = createNewInstance();
}
```

#### **Issue 2: Cache Population Timing**
- Cache is populated AFTER instance creation
- Multiple threads create instances before any cache entry exists
- Last thread to complete overwrites cache with its instance

#### **Issue 3: Promise Resolution Race**
- Async services create additional timing windows
- Promise.all() amplifies the concurrency problem
- No coordination between concurrent resolution attempts

### Memory Impact

#### **Per Singleton Leak**
- **Expected**: 1 instance per singleton service
- **Actual**: N instances (where N = concurrent resolution count)
## Real-World Impact Assessment

### Affected Scenarios
1. **Web Applications**: Multiple HTTP requests resolving the same database service
2. **Microservices**: High-throughput service-to-service calls
3. **Background Workers**: Parallel job processing resolving shared services
4. **Event-Driven Systems**: Multiple events triggering service resolution
5. **Testing**: Parallel test execution creating duplicate test services

### Memory Impact Calculation
```
Base Singleton Size: 1MB
Concurrent Requests: 100
Memory Multiplier: 100x
Total Memory: 100MB instead of 1MB
Memory Waste: 99MB (9900% overhead)
```

### Production Risks
- **Memory Exhaustion**: OOM kills in high-traffic applications
- **Performance Degradation**: Excessive GC pressure from duplicate objects
- **Resource Leaks**: Each instance may hold database connections, file handles
- **Data Inconsistency**: Multiple instances with different cached state
- **Cascading Failures**: Memory pressure affecting other system components

## Proposed Solutions

### **Solution 1: Mutex-Based Synchronization (Recommended)**

```typescript
class Container extends EventEmitter implements IContainer {
  private resolutionMutexes = new Map<string, Promise<any>>();
  
  private async resolveWithMutex<T>(
    key: string, 
    factory: () => Promise<T> | T
  ): Promise<T> {
    // Check if resolution is already in progress
    if (this.resolutionMutexes.has(key)) {
      return this.resolutionMutexes.get(key);
    }
    
    // Double-checked locking: check cache again
    const cached = this.getCachedInstance(key);
    if (cached) {
      return cached;
    }
    
    // Create resolution promise
    const resolutionPromise = Promise.resolve(factory()).then(instance => {
      this.setCache(key, instance);
      this.resolutionMutexes.delete(key); // Clean up
      this.emit(`di.resolved.${key}`, this, instance);
      return instance;
    }).catch(error => {
      this.resolutionMutexes.delete(key); // Clean up on error
      throw error;
    });
    
    // Store the promise to prevent concurrent resolutions
    this.resolutionMutexes.set(key, resolutionPromise);
    return resolutionPromise;
  }
  
  // Update resolveType method to use mutex for singletons
  private resolveType<T>(sourceType, targetType, options?): Promise<T> | T {
    const descriptor = this.extractDescriptor(targetType);
    const isSingleton = descriptor.resolver === ResolveType.Singleton;
    const key = getTypeName(sourceType);
    
    if (isSingleton) {
      return this.resolveWithMutex(key, () => 
        this.createInstance(targetType, options)
      );
    }
    
    // Non-singleton path remains unchanged
    return this.createInstance(targetType, options);
  }
}
```

**Benefits**:
- ✅ Thread-safe singleton resolution
- ✅ Handles both sync and async services  
- ✅ Minimal performance overhead
- ✅ Clean error handling and resource cleanup

```typescript
private async resolveSingleton<T>(
  sourceType: string | Class<T>, 
  factory: () => Promise<T> | T
): Promise<T> {
  // First check (without lock)
  if (this.Cache.has(sourceType)) {
    return this.Cache.get(sourceType);
  }
  
  // Use a per-type lock
  const lockKey = getTypeName(sourceType);
  return this.withLock(lockKey, async () => {
    // Second check (with lock)
    if (this.Cache.has(sourceType)) {
      return this.Cache.get(sourceType);
    }
    
    // Create instance
    const instance = await factory();
    this.Cache.add(sourceType, instance);
    return instance;
  });
}
```

### **Solution 2: Atomic Cache Operations with WeakRef**

```typescript
class ContainerCache {
  private cache = new Map<string, any[]>();
  private resolutionPromises = new Map<string, Promise<any>>();
  
  // Atomic test-and-set operation
  public getOrCreate<T>(
    key: string, 
    factory: () => Promise<T> | T
  ): Promise<T> | T {
    // Fast path: return cached instance
    if (this.cache.has(key)) {
      return this.cache.get(key)[0];
    }
    
    // Check if creation is in progress
    if (this.resolutionPromises.has(key)) {
      return this.resolutionPromises.get(key);
    }
    
    // Create and cache the resolution
    const creation = Promise.resolve(factory()).then(instance => {
      this.cache.set(key, [instance]);
      this.resolutionPromises.delete(key);
      return instance;
    }).catch(error => {
      this.resolutionPromises.delete(key);
      throw error;
    });
    
    this.resolutionPromises.set(key, creation);
    return creation;
  }
}
```

### **Solution 3: Lock-Free Approach with CAS (Compare-And-Swap)**

```typescript
class LockFreeContainer {
  private singletonStates = new Map<string, 'creating' | 'created' | 'error'>();
  private singletonPromises = new Map<string, Promise<any>>();
  
  private resolveSingleton<T>(key: string, factory: () => T | Promise<T>): T | Promise<T> {
    const state = this.singletonStates.get(key);
    
    if (state === 'created') {
      return this.cache.get(key);
    }
    
    if (state === 'creating') {
      return this.singletonPromises.get(key);
    }
    
    // Atomic state transition
    if (this.singletonStates.get(key) === undefined) {
      this.singletonStates.set(key, 'creating');
      
      const creation = Promise.resolve(factory())
        .then(instance => {
          this.cache.set(key, instance);
          this.singletonStates.set(key, 'created');
          this.singletonPromises.delete(key);
          return instance;
        })
        .catch(error => {
          this.singletonStates.set(key, 'error');
          this.singletonPromises.delete(key);
          throw error;
        });
      
      this.singletonPromises.set(key, creation);
      return creation;
    }
    
    // Another thread won the race, wait for their result
    return this.singletonPromises.get(key) || this.cache.get(key);
  }
}
```

## Implementation Plan

### Phase 1: Immediate Fix (Week 1)
1. **Implement Solution 1** (Mutex-based approach)
2. **Update `resolveType` method** to use mutex for singleton resolution
3. **Add resolution cleanup** to prevent memory leaks in mutex map
4. **Basic testing** to verify fix works

### Phase 2: Comprehensive Testing (Week 2)  
1. **Stress testing** with high concurrency loads
2. **Memory leak validation** under sustained load
3. **Performance benchmarking** to measure overhead
4. **Error handling verification** for edge cases

### Phase 3: Production Deployment (Week 3)
1. **Gradual rollout** with monitoring
2. **Memory usage tracking** in production
3. **Performance monitoring** for regression detection
4. **Documentation updates** for new behavior

### Code Changes Required

#### 1. Container.ts Updates
```typescript
// Add these properties to Container class
private resolutionMutexes = new Map<string, Promise<any>>();

// Add this method
private async resolveWithMutex<T>(
  key: string, 
  factory: () => Promise<T> | T
): Promise<T> {
  // Implementation as shown above
}

// Update resolveType method
private resolveType<T>(sourceType, targetType, options?): Promise<T> | T {
  const descriptor = this.extractDescriptor(targetType);
  const isSingleton = descriptor.resolver === ResolveType.Singleton;
  
  if (isSingleton) {
    const key = getTypeName(sourceType);
    return this.resolveWithMutex(key, () => 
      this.createActualInstance(targetType, options)
    );
  }
  
  // Existing non-singleton logic
  return this.createActualInstance(targetType, options);
}
```

#### 2. Test Updates
```typescript
// Add comprehensive concurrency tests
describe('Concurrent Singleton Resolution', () => {
  it('should create only one instance under extreme concurrent load', async () => {
    @Singleton()
    class ConcurrentService {
      static instanceCount = 0;
      constructor() { ConcurrentService.instanceCount++; }
    }
    
    container.register(ConcurrentService).as('concurrent');
    
    // Test with 1000 concurrent requests
    const promises = Array.from({ length: 1000 }, () => 
      container.resolve('concurrent')
    );
    
    const instances = await Promise.all(promises);
    
    // Critical: Only one instance should be created
    expect(ConcurrentService.instanceCount).to.equal(1);
    
    // All instances should be the same object reference
    instances.forEach(instance => {
      expect(instance).to.equal(instances[0]);
    });
  });
});
```

## Validation Strategy

### Memory Leak Detection
```typescript
// Add monitoring capabilities
public getSingletonMemoryStats(): { [key: string]: number } {
  const stats: { [key: string]: number } = {};
  
  for (const [key, instances] of this.cache) {
    if (this.isSingleton(key)) {
      stats[key] = instances.length; // Should always be 1
      if (instances.length > 1) {
        console.warn(`🚨 Memory leak detected: ${instances.length} instances of singleton ${key}`);
      }
    }
  }
  
  return stats;
}

// Add periodic validation
private validateSingletonIntegrity() {
  const stats = this.getSingletonMemoryStats();
  const violations = Object.entries(stats).filter(([_, count]) => count > 1);
  
  if (violations.length > 0) {
    throw new Error(`Singleton violations detected: ${violations.map(([key, count]) => `${key}: ${count}`).join(', ')}`);
  }
}
```

### Performance Monitoring
```typescript
// Track resolution times
private resolutionTimes = new Map<string, number[]>();

private trackResolutionTime(key: string, startTime: number) {
  const duration = Date.now() - startTime;
  if (!this.resolutionTimes.has(key)) {
    this.resolutionTimes.set(key, []);
  }
  this.resolutionTimes.get(key).push(duration);
}

public getPerformanceStats() {
  const stats: { [key: string]: { avg: number, max: number, count: number } } = {};
  
  for (const [key, times] of this.resolutionTimes) {
    stats[key] = {
      avg: times.reduce((a, b) => a + b, 0) / times.length,
      max: Math.max(...times),
      count: times.length
    };
  }
  
  return stats;
}
```

## Risk Assessment and Mitigation

### Implementation Risks
1. **Performance Overhead**: Mutex operations on hot path
   - *Mitigation*: Use lightweight Promise-based locks, not OS mutexes
   - *Monitoring*: Track resolution times before/after implementation

2. **Deadlock Potential**: Circular dependencies in concurrent resolution
   - *Mitigation*: Implement timeout mechanisms and dependency cycle detection
   - *Testing*: Specific tests for circular dependency scenarios

3. **Memory Overhead**: Additional Maps for tracking resolution state
   - *Mitigation*: Clean up completed resolutions, use WeakMap where possible
   - *Monitoring*: Track memory usage of resolution tracking structures

### Rollback Strategy
1. **Feature flag** to enable/disable new resolution logic
2. **Gradual percentage rollout** starting with 1% of traffic
3. **Automated rollback triggers** based on error rates or memory usage
4. **Manual rollback capability** within 5 minutes

## Success Metrics

### Primary Goals
- ✅ **Singleton instance count = 1** under all concurrency levels
- ✅ **Memory usage stable** (no linear growth with concurrency)
- ✅ **Performance degradation < 5%** for singleton resolution
- ✅ **Zero regression** in existing functionality

### Secondary Goals  
- 📊 **Monitoring dashboard** for singleton health
- 📈 **Performance metrics** tracking resolution times
- 🔍 **Debugging tools** for diagnosing DI issues
- 📚 **Updated documentation** with concurrency considerations

## Conclusion

The concurrent singleton creation bug represents a **critical memory management vulnerability** that can cause severe production issues. The proposed mutex-based solution provides robust protection while maintaining performance characteristics.

**Immediate Action Required**: This bug should be treated as a **P0 critical issue** requiring immediate attention. The memory leak potential in high-concurrency environments poses significant operational risk.

The comprehensive testing strategy ensures the fix works correctly while the monitoring approach provides ongoing protection against regression. Implementation should begin immediately with careful validation at each phase.
