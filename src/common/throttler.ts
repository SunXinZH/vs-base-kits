import { generateUuid } from "./uuid";
import { Emitter } from "./event";
import { Disposable } from "./lifecycle";
import { resolve } from "path";

export interface ITask<T> {
  (): T;
}

interface FactoryListItem<T> {
  id: string;
  task: ITask<T>;
}

export class Throttler extends Disposable {
  private activePromise: Promise<any> | null;
  private queuedPromiseFactory: FactoryListItem<Promise<any>>[];
  private _onPromiseCompleted = this._register(
    new Emitter<{
      id: string;
      result: any;
    }>()
  );

  constructor() {
    super();
    this.activePromise = null;
    this.queuedPromiseFactory = [];
  }

  queue<T>(promiseFactory: ITask<Promise<T>>): Promise<T> {
    const taskId = generateUuid();
      this.queuedPromiseFactory.push({
        id: taskId,
        task: promiseFactory,
      });
	  this.run();
      return new Promise<T>((resolve) => {
        const d = this._onPromiseCompleted.event((e) => {
          if (e.id === taskId) {
            resolve(e.result);
          }
        });
      });
  }

  private async run(): Promise<void> {
    if (this.queuedPromiseFactory.length > 0 && this.activePromise === null) {
      const next = this.queuedPromiseFactory.splice(0, 1)[0];
      this.activePromise = next.task();
      const result = await this.activePromise;
	  this.activePromise = null;
      this._onPromiseCompleted.fire({
        id: next.id,
        result,
      });

      this.run();
    }
  }
}
