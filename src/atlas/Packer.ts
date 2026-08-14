export interface PackedRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export class Packer {
  readonly width: number;
  readonly height: number;
  readonly #free: PackedRectangle[];
  readonly #allocated = new Set<string>();

  constructor(width: number, height: number) {
    assertDimension("width", width);
    assertDimension("height", height);
    this.width = width;
    this.height = height;
    this.#free = [{ x: 0, y: 0, width, height }];
  }

  allocate(width: number, height: number): Readonly<PackedRectangle> | undefined {
    assertDimension("width", width);
    assertDimension("height", height);
    let selectedIndex = -1;
    let selectedScore = Number.POSITIVE_INFINITY;
    let selectedShortSide = Number.POSITIVE_INFINITY;

    for (let index = 0; index < this.#free.length; index += 1) {
      const rectangle = this.#free[index];
      if (rectangle === undefined || width > rectangle.width || height > rectangle.height) {
        continue;
      }
      const score = rectangle.width * rectangle.height - width * height;
      const shortSide = Math.min(rectangle.width - width, rectangle.height - height);
      if (score < selectedScore || (score === selectedScore && shortSide < selectedShortSide)) {
        selectedIndex = index;
        selectedScore = score;
        selectedShortSide = shortSide;
      }
    }
    if (selectedIndex < 0) {
      return undefined;
    }

    const free = this.#free.splice(selectedIndex, 1)[0];
    if (free === undefined) {
      throw new Error("Packer free-list invariant failed");
    }
    const allocated = Object.freeze({ x: free.x, y: free.y, width, height });
    const remainingWidth = free.width - width;
    const remainingHeight = free.height - height;
    if (remainingWidth > 0) {
      this.#free.push({
        x: free.x + width,
        y: free.y,
        width: remainingWidth,
        height,
      });
    }
    if (remainingHeight > 0) {
      this.#free.push({
        x: free.x,
        y: free.y + height,
        width: free.width,
        height: remainingHeight,
      });
    }
    this.#allocated.add(rectangleKey(allocated));

    return allocated;
  }

  release(rectangle: PackedRectangle): void {
    assertRectangle(rectangle, this.width, this.height);
    const key = rectangleKey(rectangle);
    if (!this.#allocated.delete(key)) {
      throw new RangeError("Packed rectangle is foreign or already released");
    }
    this.#free.push({ ...rectangle });
    this.#mergeFreeRectangles();
  }

  get freeArea(): number {
    return this.#free.reduce((area, rectangle) => area + rectangle.width * rectangle.height, 0);
  }

  get allocations(): number {
    return this.#allocated.size;
  }

  #mergeFreeRectangles(): void {
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let leftIndex = 0; leftIndex < this.#free.length; leftIndex += 1) {
        const left = this.#free[leftIndex];
        if (left === undefined) continue;
        for (let rightIndex = leftIndex + 1; rightIndex < this.#free.length; rightIndex += 1) {
          const right = this.#free[rightIndex];
          if (right === undefined) continue;
          const combined = mergeRectangles(left, right);
          if (combined !== undefined) {
            this.#free.splice(rightIndex, 1);
            this.#free[leftIndex] = combined;
            merged = true;
            break outer;
          }
        }
      }
    }
  }
}

function mergeRectangles(
  left: PackedRectangle,
  right: PackedRectangle,
): PackedRectangle | undefined {
  if (left.y === right.y && left.height === right.height) {
    if (left.x + left.width === right.x) {
      return { x: left.x, y: left.y, width: left.width + right.width, height: left.height };
    }
    if (right.x + right.width === left.x) {
      return { x: right.x, y: right.y, width: left.width + right.width, height: left.height };
    }
  }
  if (left.x === right.x && left.width === right.width) {
    if (left.y + left.height === right.y) {
      return { x: left.x, y: left.y, width: left.width, height: left.height + right.height };
    }
    if (right.y + right.height === left.y) {
      return { x: right.x, y: right.y, width: left.width, height: left.height + right.height };
    }
  }

  return undefined;
}

function rectangleKey(rectangle: PackedRectangle): string {
  return `${String(rectangle.x)}:${String(rectangle.y)}:${String(rectangle.width)}:${String(rectangle.height)}`;
}

function assertRectangle(rectangle: PackedRectangle, width: number, height: number): void {
  assertDimension("rectangle.width", rectangle.width);
  assertDimension("rectangle.height", rectangle.height);
  if (
    !Number.isSafeInteger(rectangle.x) ||
    !Number.isSafeInteger(rectangle.y) ||
    rectangle.x < 0 ||
    rectangle.y < 0 ||
    rectangle.x + rectangle.width > width ||
    rectangle.y + rectangle.height > height
  ) {
    throw new RangeError("Packed rectangle falls outside this packer");
  }
}

function assertDimension(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}
