import { once } from './functional';
import { Iterable } from './iterator';

export class MultiDisposeError extends Error {
    constructor(public readonly errors: any[]) {
        super(`Encountered errors while disposing of store. Errors: [${errors.join(', ')}]`);
    }
}

const TRACK_DISPOSABLES = false;
let disposableTracker: IDisposableTracker | null = null;

export interface IDisposableTracker {
    /**
     * Is called on construction of a disposable.
     */
    trackDisposable(disposable: IDisposable): void;

    /**
     * Is called when a disposable is registered as child of another disposable (e.g. {@link DisposableStore}).
     * If parent is `null`, the disposable is removed from its former parent.
     */
    setParent(child: IDisposable, parent: IDisposable | null): void;

    /**
     * Is called after a disposable is disposed.
     */
    markAsDisposed(disposable: IDisposable): void;

    /**
     * Indicates that the given object is a singleton which does not need to be disposed.
     */
    markAsSingleton(disposable: IDisposable): void;
}

export function setDisposableTracker(tracker: IDisposableTracker | null): void {
    disposableTracker = tracker;
}

if (TRACK_DISPOSABLES) {
    const __is_disposable_tracked__ = '__is_disposable_tracked__';
    setDisposableTracker(
        new (class implements IDisposableTracker {
            trackDisposable(x: IDisposable): void {
                const stack = new Error('Potentially leaked disposable').stack!;
                setTimeout(() => {
                    if (!(x as any)[__is_disposable_tracked__]) {
                        console.log(stack);
                    }
                }, 3000);
            }

            setParent(child: IDisposable, parent: IDisposable | null): void {
                if (child && child !== Disposable.None) {
                    try {
                        (child as any)[__is_disposable_tracked__] = true;
                    } catch {
                        // noop
                    }
                }
            }

            markAsDisposed(disposable: IDisposable): void {
                if (disposable && disposable !== Disposable.None) {
                    try {
                        (disposable as any)[__is_disposable_tracked__] = true;
                    } catch {
                        // noop
                    }
                }
            }
            markAsSingleton(disposable: IDisposable): void {}
        })()
    );
}

export interface IDisposable {
    dispose(): void;
}

export function isDisposable<E extends object>(thing: E): thing is E & IDisposable {
    return typeof (<IDisposable>thing).dispose === 'function' && (<IDisposable>thing).dispose.length === 0;
}

export function dispose<T extends IDisposable>(disposable: T): T;
export function dispose<T extends IDisposable>(disposable: T | undefined): T | undefined;
export function dispose<T extends IDisposable, A extends IterableIterator<T> = IterableIterator<T>>(disposables: IterableIterator<T>): A;
export function dispose<T extends IDisposable>(disposables: Array<T>): Array<T>;
export function dispose<T extends IDisposable>(disposables: ReadonlyArray<T>): ReadonlyArray<T>;
export function dispose<T extends IDisposable>(arg: T | IterableIterator<T> | undefined): any {
    if (Iterable.is(arg)) {
        let errors: any[] = [];

        for (const d of arg) {
            if (d) {
                try {
                    d.dispose();
                } catch (e) {
                    errors.push(e);
                }
            }
        }

        if (errors.length === 1) {
            throw errors[0];
        } else if (errors.length > 1) {
            throw new MultiDisposeError(errors);
        }

        return Array.isArray(arg) ? [] : arg;
    } else if (arg) {
        arg.dispose();
        return arg;
    }
}

function trackDisposable<T extends IDisposable>(x: T): T {
    disposableTracker?.trackDisposable(x);
    return x;
}

function markAsDisposed(disposable: IDisposable): void {
    disposableTracker?.markAsDisposed(disposable);
}

function setParentOfDisposable(child: IDisposable, parent: IDisposable | null): void {
    disposableTracker?.setParent(child, parent);
}

export class DisposableStore implements IDisposable {
    static DISABLE_DISPOSED_WARNING = false;

    private _toDispose = new Set<IDisposable>();
    private _isDisposed = false;

    constructor() {
        trackDisposable(this);
    }

    /**
     * Dispose of all registered disposables and mark this object as disposed.
     *
     * Any future disposables added to this object will be disposed of on `add`.
     */
    public dispose(): void {
        if (this._isDisposed) {
            return;
        }

        markAsDisposed(this);
        this._isDisposed = true;
        this.clear();
    }

    /**
     * Returns `true` if this object has been disposed
     */
    public get isDisposed(): boolean {
        return this._isDisposed;
    }

    /**
     * Dispose of all registered disposables but do not mark this object as disposed.
     */
    public clear(): void {
        try {
            dispose(this._toDispose.values());
        } finally {
            this._toDispose.clear();
        }
    }

    public add<T extends IDisposable>(o: T): T {
        if (!o) {
            return o;
        }
        if ((o as unknown as DisposableStore) === this) {
            throw new Error('Cannot register a disposable on itself!');
        }

        setParentOfDisposable(o, this);
        if (this._isDisposed) {
            if (!DisposableStore.DISABLE_DISPOSED_WARNING) {
                console.warn(new Error('Trying to add a disposable to a DisposableStore that has already been disposed of. The added object will be leaked!').stack);
            }
        } else {
            this._toDispose.add(o);
        }

        return o;
    }
}

export abstract class Disposable implements IDisposable {
    static readonly None = Object.freeze<IDisposable>({ dispose() {} });

    protected readonly _store = new DisposableStore();

    constructor() {
        trackDisposable(this);
        setParentOfDisposable(this._store, this);
    }

    public dispose(): void {
        markAsDisposed(this);

        this._store.dispose();
    }

    protected _register<T extends IDisposable>(o: T): T {
        if ((o as unknown as Disposable) === this) {
            throw new Error('Cannot register a disposable on itself!');
        }
        return this._store.add(o);
    }
}

export class SafeDisposable implements IDisposable {
    dispose: () => void = () => {};
    unset: () => void = () => {};
    isset: () => boolean = () => false;

    constructor() {
        trackDisposable(this);
    }

    set(fn: Function) {
        let callback: Function | undefined = fn;
        this.unset = () => (callback = undefined);
        this.isset = () => callback !== undefined;
        this.dispose = () => {
            if (callback) {
                callback();
                callback = undefined;
                markAsDisposed(this);
            }
        };
        return this;
    }
}
