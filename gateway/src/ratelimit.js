export class RateLimiter {
  constructor(perMinute, burst = perMinute, maxKeys = 100000) {
    this.rate = perMinute / 60000;
    this.capacity = burst;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  /** @returns {{allowed: boolean, retryAfterMs: number}} */
  take(key, cost = 1, now = Date.now()) {
    const b = this.buckets.get(key) || { tokens: this.capacity, last: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.last) * this.rate);
    b.last = now;
    this.buckets.delete(key);
    this.buckets.set(key, b); // keep Map insertion order = recency
    if (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { allowed: true, retryAfterMs: 0 };
    }
    return { allowed: false, retryAfterMs: Math.ceil((cost - b.tokens) / this.rate) };
  }
}
