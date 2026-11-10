import type { AuthState } from './types';

/** Tiny state holder with subscriptions, shared by the providers. */
export class StateEmitter {
  private value: AuthState;
  private listeners = new Set<(s: AuthState) => void>();
  constructor(initial: AuthState) { this.value = initial; }
  get state(): AuthState { return this.value; }
  set(next: AuthState): void {
    if (next === this.value) return;
    this.value = next;
    for (const cb of [...this.listeners]) cb(next);
  }
  subscribe(cb: (s: AuthState) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
}
