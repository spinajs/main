interface Task<V, E> {
    execute: (prev?: V) => Promise<V>,
    rollback: () => Promise<void>
}

const Task = {
    run: async <V>(tasks: Task<any, any>[]): Promise<V[]> => {
        const results: V[] = [];
        let currResult: V = null;

        for (const t of tasks) {
            try {
                const r = await t.execute(currResult);
                if (r) results.push(r);
                currResult = r;
            } catch (err) {
                try { await t.rollback() } catch { }
            }
        }

        return results;
    },
    runTransaction: async <V>(tasks: Task<any, any>[]): Promise<V[]> => {
        const results: V[] = [];
        const executed: Task<any, any>[] = [];
        let currResult: V = null;

        for (const t of tasks) {
            try {
                const r = await t.execute(currResult);
                if (r) results.push(r);
                currResult = r;
            } catch (err) {

                try { await t.rollback() } catch { }
                for (const et of executed.reverse()) {
                    try {
                        await et.rollback();
                    } catch { }
                }

                throw err;
            }
        }

        return results;
    }
}

const t1 = {
    execute: () => Promise.resolve("DASd"),
    rollback: () => new Promise<void>(() => console.log("rollback 2"))
}

const t2 = {
    execute: (val: string) => Promise.reject(1 + val),
    rollback: () => new Promise<void>(() => console.log("rollback 2"))
}

Task.runTransaction([t1, t2]).then((res) => {
    console.log(res);
}).catch((err) => {
    console.log(err);
});
