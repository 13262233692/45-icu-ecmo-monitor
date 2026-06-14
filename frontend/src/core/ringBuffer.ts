export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private writeIndex = 0;
  private readIndex = 0;
  private count = 0;
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  getCapacity(): number {
    return this.capacity;
  }

  size(): number {
    return this.count;
  }

  isEmpty(): boolean {
    return this.count === 0;
  }

  isFull(): boolean {
    return this.count === this.capacity;
  }

  clear() {
    this.writeIndex = 0;
    this.readIndex = 0;
    this.count = 0;
    this.buffer.fill(undefined);
  }

  push(value: T): T | undefined {
    let overwritten: T | undefined = undefined;
    if (this.isFull()) {
      overwritten = this.buffer[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.capacity;
    } else {
      this.count++;
    }
    this.buffer[this.writeIndex] = value;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    return overwritten;
  }

  pushAll(values: ArrayLike<T>): void {
    const len = values.length;
    for (let i = 0; i < len; i++) {
      this.push(values[i]);
    }
  }

  pop(): T | undefined {
    if (this.isEmpty()) return undefined;
    const value = this.buffer[this.readIndex];
    this.buffer[this.readIndex] = undefined;
    this.readIndex = (this.readIndex + 1) % this.capacity;
    this.count--;
    return value;
  }

  peek(): T | undefined {
    if (this.isEmpty()) return undefined;
    return this.buffer[this.readIndex];
  }

  peekLast(): T | undefined {
    if (this.isEmpty()) return undefined;
    const idx = (this.writeIndex - 1 + this.capacity) % this.capacity;
    return this.buffer[idx];
  }

  get(index: number): T | undefined {
    if (index < 0 || index >= this.count) return undefined;
    const actualIndex = (this.readIndex + index) % this.capacity;
    return this.buffer[actualIndex];
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.readIndex + i) % this.capacity;
      const v = this.buffer[idx];
      if (v !== undefined) result.push(v);
    }
    return result;
  }

  forEach(callback: (value: T, index: number) => void): void {
    for (let i = 0; i < this.count; i++) {
      const idx = (this.readIndex + i) % this.capacity;
      const v = this.buffer[idx];
      if (v !== undefined) callback(v, i);
    }
  }

  *[Symbol.iterator](): Generator<T> {
    for (let i = 0; i < this.count; i++) {
      const idx = (this.readIndex + i) % this.capacity;
      const v = this.buffer[idx];
      if (v !== undefined) yield v;
    }
  }
}

export class NumericRingBuffer {
  private buffer: Float32Array;
  private writeIndex = 0;
  private count = 0;
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Float32Array(capacity);
  }

  getCapacity(): number {
    return this.capacity;
  }

  size(): number {
    return this.count;
  }

  clear() {
    this.writeIndex = 0;
    this.count = 0;
    this.buffer.fill(0);
  }

  push(value: number): void {
    this.buffer[this.writeIndex] = value;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  pushAll(values: Float32Array | number[]): void {
    const len = values.length;
    for (let i = 0; i < len; i++) {
      this.push(values[i]);
    }
  }

  get(index: number): number {
    if (this.count < this.capacity) {
      return index < this.count ? this.buffer[index] : 0;
    }
    const actualIndex = (this.writeIndex + index) % this.capacity;
    return this.buffer[actualIndex];
  }

  getLast(): number {
    if (this.count === 0) return 0;
    const idx = (this.writeIndex - 1 + this.capacity) % this.capacity;
    return this.buffer[idx];
  }

  toArray(): Float32Array {
    const result = new Float32Array(this.count);
    if (this.count < this.capacity) {
      result.set(this.buffer.subarray(0, this.count));
    } else {
      const tailLen = this.capacity - this.writeIndex;
      result.set(this.buffer.subarray(this.writeIndex, this.capacity), 0);
      if (this.writeIndex > 0) {
        result.set(this.buffer.subarray(0, this.writeIndex), tailLen);
      }
    }
    return result;
  }

  copyToContiguous(): Float32Array {
    return this.toArray();
  }

  min(): number {
    if (this.count === 0) return 0;
    let min = Infinity;
    for (let i = 0; i < this.count; i++) {
      const v = this.get(i);
      if (v < min) min = v;
    }
    return min;
  }

  max(): number {
    if (this.count === 0) return 0;
    let max = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const v = this.get(i);
      if (v > max) max = v;
    }
    return max;
  }

  mean(): number {
    if (this.count === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.count; i++) {
      sum += this.get(i);
    }
    return sum / this.count;
  }
}
