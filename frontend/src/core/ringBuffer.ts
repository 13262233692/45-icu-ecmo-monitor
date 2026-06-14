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

  getWriteIndex(): number {
    return this.writeIndex;
  }

  forceAdvanceWrite(newWriteIndex: number, addedCount: number): void {
    this.writeIndex = newWriteIndex;
    const nc = this.count + addedCount;
    this.count = nc > this.capacity ? this.capacity : nc;
  }

  getRawBuffer(): Float32Array {
    return this.buffer;
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

  pushFromArrayLike(src: ArrayLike<number>, srcOffset: number, length: number): void {
    const cap = this.capacity;
    let w = this.writeIndex;
    for (let i = 0; i < length; i++) {
      this.buffer[w] = src[srcOffset + i];
      w = (w + 1) % cap;
    }
    this.writeIndex = w;
    this.count = Math.min(this.count + length, cap);
  }

  pushFromDataView(
    view: DataView,
    byteOffset: number,
    float32Count: number,
    littleEndian: boolean = true,
  ): number {
    const cap = this.capacity;
    let w = this.writeIndex;
    let off = byteOffset;
    for (let i = 0; i < float32Count; i++) {
      this.buffer[w] = view.getFloat32(off, littleEndian);
      off += 4;
      w = (w + 1) % cap;
    }
    this.writeIndex = w;
    const oldCount = this.count;
    this.count = Math.min(oldCount + float32Count, cap);
    return off;
  }

  get(index: number): number {
    if (this.count < this.capacity) {
      return index < this.count ? this.buffer[index] : 0;
    }
    return this.buffer[(this.writeIndex + index) % this.capacity];
  }

  getLast(): number {
    if (this.count === 0) return 0;
    return this.buffer[(this.writeIndex - 1 + this.capacity) % this.capacity];
  }

  copyContiguousInto(target: Float32Array, targetOffset: number, length: number): number {
    const n = Math.min(length, this.count);
    if (n <= 0) return 0;
    if (this.count < this.capacity) {
      for (let i = 0; i < n; i++) {
        target[targetOffset + i] = this.buffer[i];
      }
    } else {
      const start = this.writeIndex;
      const tailLen = this.capacity - start;
      if (n <= tailLen) {
        for (let i = 0; i < n; i++) {
          target[targetOffset + i] = this.buffer[start + i];
        }
      } else {
        for (let i = 0; i < tailLen; i++) {
          target[targetOffset + i] = this.buffer[start + i];
        }
        const remain = n - tailLen;
        for (let i = 0; i < remain; i++) {
          target[targetOffset + tailLen + i] = this.buffer[i];
        }
      }
    }
    return n;
  }

  copyLatestContiguousInto(target: Float32Array, length: number): number {
    const n = Math.min(length, this.count);
    if (n <= 0) return 0;
    const startAbs = this.count < this.capacity
      ? this.count - n
      : (this.writeIndex - n + this.capacity) % this.capacity;
    if (this.count < this.capacity) {
      for (let i = 0; i < n; i++) {
        target[i] = this.buffer[startAbs + i];
      }
    } else {
      const tailLen = this.capacity - startAbs;
      if (n <= tailLen) {
        for (let i = 0; i < n; i++) {
          target[i] = this.buffer[startAbs + i];
        }
      } else {
        for (let i = 0; i < tailLen; i++) {
          target[i] = this.buffer[startAbs + i];
        }
        const remain = n - tailLen;
        for (let i = 0; i < remain; i++) {
          target[tailLen + i] = this.buffer[i];
        }
      }
    }
    return n;
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
