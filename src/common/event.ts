import { DisposableStore, IDisposable, SafeDisposable } from './lifecycle';
import { StopWatch } from './stopwatch';
import { LinkedList } from './linkedList';

let _enableDisposeWithListenerWarning = false;

let _globalLeakWarningThreshold = -1;
export function setGlobalLeakWarningThreshold(n: number): IDisposable {
    const oldValue = _globalLeakWarningThreshold;
    _globalLeakWarningThreshold = n;
    return {
        dispose() {
            _globalLeakWarningThreshold = oldValue;
        },
    };
}

export interface EmitterOptions {
    onFirstListenerAdd?: Function;
    onFirstListenerDidAdd?: Function;
    onListenerDidAdd?: Function;
    onLastListenerRemove?: Function;
    leakWarningThreshold?: number;

    /** ONLY enable this during development */
    _profName?: string;
}

class EventProfiling {
    private static _idPool = 0;

    private _name: string;
    private _stopWatch?: StopWatch;
    private _listenerCount: number = 0;
    private _invocationCount = 0;
    private _elapsedOverall = 0;

    constructor(name: string) {
        this._name = `${name}_${EventProfiling._idPool++}`;
    }

    start(listenerCount: number): void {
        this._stopWatch = new StopWatch(true);
        this._listenerCount = listenerCount;
    }

    stop(): void {
        if (this._stopWatch) {
            const elapsed = this._stopWatch.elapsed();
            this._elapsedOverall += elapsed;
            this._invocationCount += 1;

            console.info(`did FIRE ${this._name}: elapsed_ms: ${elapsed.toFixed(5)}, listener: ${this._listenerCount} (elapsed_overall: ${this._elapsedOverall.toFixed(2)}, invocations: ${this._invocationCount})`);
            this._stopWatch = undefined;
        }
    }
}

class LeakageMonitor {
    private _stacks: Map<string, number> | undefined;
    private _warnCountdown: number = 0;

    constructor(readonly customThreshold?: number, readonly name: string = Math.random().toString(18).slice(2, 5)) {}

    dispose(): void {
        if (this._stacks) {
            this._stacks.clear();
        }
    }

    check(stack: Stacktrace, listenerCount: number): undefined | (() => void) {
        let threshold = _globalLeakWarningThreshold;
        if (typeof this.customThreshold === 'number') {
            threshold = this.customThreshold;
        }

        if (threshold <= 0 || listenerCount < threshold) {
            return undefined;
        }

        if (!this._stacks) {
            this._stacks = new Map();
        }
        const count = this._stacks.get(stack.value) || 0;
        this._stacks.set(stack.value, count + 1);
        this._warnCountdown -= 1;

        if (this._warnCountdown <= 0) {
            // only warn on first exceed and then every time the limit
            // is exceeded by 50% again
            this._warnCountdown = threshold * 0.5;

            // find most frequent listener and print warning
            let topStack: string | undefined;
            let topCount: number = 0;
            for (const [stack, count] of this._stacks) {
                if (!topStack || topCount < count) {
                    topStack = stack;
                    topCount = count;
                }
            }

            console.warn(`[${this.name}] potential listener LEAK detected, having ${listenerCount} listeners already. MOST frequent listener (${topCount}):`);
            console.warn(topStack!);
        }

        return () => {
            const count = this._stacks!.get(stack.value) || 0;
            this._stacks!.set(stack.value, count - 1);
        };
    }
}

class Stacktrace {
    static create() {
        return new Stacktrace(new Error().stack ?? '');
    }

    private constructor(readonly value: string) {}

    print() {
        console.warn(this.value.split('\n').slice(2).join('\n'));
    }
}

class Listener<T> {
    readonly subscription = new SafeDisposable();

    constructor(readonly callback: (e: T) => void, readonly callbackThis: any | undefined, readonly stack: Stacktrace | undefined) {}

    invoke(e: T) {
        this.callback.call(this.callbackThis, e);
    }
}

export interface Event<T> {
    (listener: (e: T) => any, thisArgs?: any, disposables?: IDisposable[] | DisposableStore): IDisposable;
}

export class Emitter<T> {
    private readonly _options?: EmitterOptions;
    private readonly _leakageMon?: LeakageMonitor;
    private readonly _perfMon?: EventProfiling;
    private _disposed: boolean = false;
    private _event?: Event<T>;
    private _deliveryQueue?: LinkedList<[Listener<T>, T]>;
    protected _listeners?: LinkedList<Listener<T>>;

    constructor(options?: EmitterOptions) {
        this._options = options;
        this._leakageMon = _globalLeakWarningThreshold > 0 ? new LeakageMonitor(this._options && this._options.leakWarningThreshold) : undefined;
        this._perfMon = this._options?._profName ? new EventProfiling(this._options._profName) : undefined;
    }

    dispose() {
        if (!this._disposed) {
            this._disposed = true;

            // It is bad to have listeners at the time of disposing an emitter, it is worst to have listeners keep the emitter
            // alive via the reference that's embedded in their disposables. Therefore we loop over all remaining listeners and
            // unset their subscriptions/disposables. Looping and blaming remaining listeners is done on next tick because the
            // the following programming pattern is very popular:
            //
            // const someModel = this._disposables.add(new ModelObject()); // (1) create and register model
            // this._disposables.add(someModel.onDidChange(() => { ... }); // (2) subscribe and register model-event listener
            // ...later...
            // this._disposables.dispose(); disposes (1) then (2): don't warn after (1) but after the "overall dispose" is done

            if (this._listeners) {
                if (_enableDisposeWithListenerWarning) {
                    const listeners = Array.from(this._listeners);
                    queueMicrotask(() => {
                        for (const listener of listeners) {
                            if (listener.subscription.isset()) {
                                listener.subscription.unset();
                                listener.stack?.print();
                            }
                        }
                    });
                }

                this._listeners.clear();
            }
            this._deliveryQueue?.clear();
            this._options?.onLastListenerRemove?.();
            this._leakageMon?.dispose();
        }
    }

    /**
     * For the public to allow to subscribe
     * to events from this Emitter
     */
    get event(): Event<T> {
        if (!this._event) {
            this._event = (callback: (e: T) => any, thisArgs?: any, disposables?: IDisposable[] | DisposableStore) => {
                if (!this._listeners) {
                    this._listeners = new LinkedList();
                }

                const firstListener = this._listeners.isEmpty();

                if (firstListener && this._options?.onFirstListenerAdd) {
                    this._options.onFirstListenerAdd(this);
                }

                let removeMonitor: Function | undefined;
                let stack: Stacktrace | undefined;
                if (this._leakageMon && this._listeners.size >= 30) {
                    // check and record this emitter for potential leakage
                    stack = Stacktrace.create();
                    removeMonitor = this._leakageMon.check(stack, this._listeners.size + 1);
                }

                if (_enableDisposeWithListenerWarning) {
                    stack = stack ?? Stacktrace.create();
                }

                const listener = new Listener(callback, thisArgs, stack);
                const removeListener = this._listeners.push(listener);

                if (firstListener && this._options?.onFirstListenerDidAdd) {
                    this._options.onFirstListenerDidAdd(this);
                }

                if (this._options?.onListenerDidAdd) {
                    this._options.onListenerDidAdd(this, callback, thisArgs);
                }

                const result = listener.subscription.set(() => {
                    if (removeMonitor) {
                        removeMonitor();
                    }
                    if (!this._disposed) {
                        removeListener();
                        if (this._options && this._options.onLastListenerRemove) {
                            const hasListeners = this._listeners && !this._listeners.isEmpty();
                            if (!hasListeners) {
                                this._options.onLastListenerRemove(this);
                            }
                        }
                    }
                });

                if (disposables instanceof DisposableStore) {
                    disposables.add(result);
                } else if (Array.isArray(disposables)) {
                    disposables.push(result);
                }

                return result;
            };
        }
        return this._event;
    }

    /**
     * To be kept private to fire an event to
     * subscribers
     */
    fire(event: T): void {
        if (this._listeners) {
            // put all [listener,event]-pairs into delivery queue
            // then emit all event. an inner/nested event might be
            // the driver of this

            if (!this._deliveryQueue) {
                this._deliveryQueue = new LinkedList();
            }

            for (let listener of this._listeners) {
                this._deliveryQueue.push([listener, event]);
            }

            // start/stop performance insight collection
            this._perfMon?.start(this._deliveryQueue.size);

            while (this._deliveryQueue.size > 0) {
                const [listener, event] = this._deliveryQueue.shift()!;
                try {
                    listener.invoke(event);
                } catch (e) {
                    throw e;
                }
            }

            this._perfMon?.stop();
        }
    }

    hasListeners(): boolean {
        if (!this._listeners) {
            return false;
        }
        return !this._listeners.isEmpty();
    }
}
