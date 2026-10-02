// A stand-in for every model call made inside one async scope.
//
// It exists so a test can drive a whole agent and read exactly what it asked a
// model - the system text and the prompt - without a live engine, a credential
// or the database read that resolves engine settings. Scoped through
// AsyncLocalStorage like the call trace, so nothing outside `withModelStub`
// can ever be answered by it.
import { AsyncLocalStorage } from 'node:async_hooks';

/** One request an agent made of a model, as the stub sees it. */
export interface StubbedCall {
  kind: 'chat' | 'vision' | 'image';
  model: string;
  system?: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  search?: boolean;
}

/**
 * Answers a call with the reply text a model would have sent. Throwing fails
 * the call the way an engine fault would.
 */
export type ModelStub = (call: StubbedCall) => Promise<string>;

const stubStorage = new AsyncLocalStorage<ModelStub>();

/** Run `fn` with every model call inside it answered by `stub`. */
export function withModelStub<T>(stub: ModelStub, fn: () => T): T {
  return stubStorage.run(stub, fn);
}

/** The stub answering calls in this scope, if any. */
export function activeModelStub(): ModelStub | undefined {
  return stubStorage.getStore();
}
