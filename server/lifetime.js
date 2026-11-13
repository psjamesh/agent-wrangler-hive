export class RuntimeStoppedError extends Error {
  constructor() {
    super('This Hive runtime is retired or has been replaced. Retry through the current runtime.');
    this.code = 'runtime-stopped';
    this.noWrite = true;
  }
}

export class RuntimeLifetime {
  #stopped = false;
  #runtime = null;
  #host = null;

  isCurrent(host = this.#host) {
    return !this.#stopped && (!this.#runtime || (host === this.#host && this.#runtime.host === host && host?.stores?.hive === this.#runtime));
  }

  assertCurrent(host = this.#host) {
    if (!this.isCurrent(host)) throw new RuntimeStoppedError();
  }

  attach(runtime, host) {
    this.assertCurrent();
    if (this.#runtime) throw new Error('This Hive runtime is already attached.');
    this.#runtime = runtime;
    this.#host = host;
    runtime.host = host;
    this.assertCurrent();
  }

  stop() { this.#stopped = true; }
}

export function assertCurrent(rt, host) {
  rt?.metadata?.lifetime?.assertCurrent(host);
}

export function isCurrent(rt, host) {
  return rt?.metadata?.lifetime?.isCurrent(host) ?? true;
}
