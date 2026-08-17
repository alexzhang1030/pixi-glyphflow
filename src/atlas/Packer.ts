export interface PackedRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface SkylineNode {
  x: number;
  y: number;
  width: number;
}

interface Shelf {
  x: number;
  y: number;
  width: number;
  height: number;
}

const KEY_FIELD = 8_192;

export class Packer {
  readonly width: number;
  readonly height: number;
  readonly #free: PackedRectangle[] = [];
  readonly #allocated = new Set<number | string>();
  #skyline: SkylineNode[];
  #shelf: Shelf | undefined;

  constructor(width: number, height: number) {
    assertDimension("width", width);
    assertDimension("height", height);
    this.width = width;
    this.height = height;
    this.#skyline = [{ x: 0, y: 0, width }];
  }

  allocate(width: number, height: number): Readonly<PackedRectangle> | undefined {
    assertDimension("width", width);
    assertDimension("height", height);
    const fromWaste = this.#allocateWaste(width, height);
    if (fromWaste !== undefined) {
      this.#allocated.add(rectangleKey(fromWaste, this.width, this.height));
      this.#resetIfEmpty();
      return fromWaste;
    }
    const fromShelf = this.#allocateShelf(width, height);
    if (fromShelf !== undefined) {
      this.#allocated.add(rectangleKey(fromShelf, this.width, this.height));
      return fromShelf;
    }
    const fromSkyline = this.#allocateSkyline(width, height);
    if (fromSkyline === undefined) {
      return undefined;
    }
    this.#carveShelf(fromSkyline);
    this.#noteShelf(fromSkyline);
    this.#allocated.add(rectangleKey(fromSkyline, this.width, this.height));
    return fromSkyline;
  }

  release(rectangle: PackedRectangle): void {
    assertRectangle(rectangle, this.width, this.height);
    const key = rectangleKey(rectangle, this.width, this.height);
    if (!this.#allocated.delete(key)) {
      throw new RangeError("Packed rectangle is foreign or already released");
    }
    this.#free.push({ ...rectangle });
    this.#mergeFreeRectangles();
    this.#resetIfEmpty();
  }

  get freeArea(): number {
    const holes = this.#free.reduce(
      (area, rectangle) => area + rectangle.width * rectangle.height,
      0,
    );
    let unused = 0;
    for (const node of this.#skyline) {
      unused += node.width * Math.max(0, this.height - node.y);
    }
    return holes + unused;
  }

  get allocations(): number {
    return this.#allocated.size;
  }

  #allocateWaste(width: number, height: number): Readonly<PackedRectangle> | undefined {
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
    return allocated;
  }

  #allocateSkyline(width: number, height: number): Readonly<PackedRectangle> | undefined {
    let selectedIndex = -1;
    let selectedX = 0;
    let selectedY = Number.POSITIVE_INFINITY;
    let selectedWaste = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.#skyline.length; index += 1) {
      const fit = this.#skylineFit(index, width, height);
      if (fit === undefined) continue;
      if (
        fit.y < selectedY ||
        (fit.y === selectedY &&
          (fit.x < selectedX || (fit.x === selectedX && fit.waste < selectedWaste)))
      ) {
        selectedIndex = index;
        selectedX = fit.x;
        selectedY = fit.y;
        selectedWaste = fit.waste;
      }
    }
    if (selectedIndex < 0) {
      return undefined;
    }
    this.#raiseSkyline(selectedX, selectedY + height, width);
    return Object.freeze({ x: selectedX, y: selectedY, width, height });
  }

  #skylineFit(
    index: number,
    width: number,
    height: number,
  ): { readonly x: number; readonly y: number; readonly waste: number } | undefined {
    const first = this.#skyline[index];
    if (first === undefined || first.x + width > this.width) {
      return undefined;
    }
    let y = first.y;
    let covered = 0;
    let waste = 0;
    for (let cursor = index; cursor < this.#skyline.length && covered < width; cursor += 1) {
      const node = this.#skyline[cursor];
      if (node === undefined) return undefined;
      y = Math.max(y, node.y);
      if (y + height > this.height) return undefined;
      const take = Math.min(node.width, width - covered);
      waste += take * (y - node.y);
      covered += take;
    }
    if (covered < width) {
      return undefined;
    }
    return { x: first.x, y, waste };
  }

  #raiseSkyline(x: number, y: number, width: number): void {
    const next: SkylineNode[] = [];
    const right = x + width;
    for (const node of this.#skyline) {
      const nodeRight = node.x + node.width;
      if (nodeRight <= x || node.x >= right) {
        next.push(node);
        continue;
      }
      if (node.x < x) {
        next.push({ x: node.x, y: node.y, width: x - node.x });
      }
      if (nodeRight > right) {
        next.push({ x: right, y: node.y, width: nodeRight - right });
      }
    }
    next.push({ x, y, width });
    next.sort((left, rightNode) => left.x - rightNode.x);
    this.#skyline = mergeSkyline(next);
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

  #resetIfEmpty(): void {
    if (this.#allocated.size > 0) return;
    const holes = this.#free.reduce(
      (area, rectangle) => area + rectangle.width * rectangle.height,
      0,
    );
    if (this.#free.length > 0 && holes < this.width * this.height) return;
    this.#free.length = 0;
    this.#skyline = [{ x: 0, y: 0, width: this.width }];
    this.#shelf = undefined;
  }

  #allocateShelf(width: number, height: number): Readonly<PackedRectangle> | undefined {
    const shelf = this.#shelf;
    if (shelf === undefined || shelf.height !== height || shelf.width < width) {
      return undefined;
    }
    const allocated = Object.freeze({ x: shelf.x, y: shelf.y, width, height });
    shelf.x += width;
    shelf.width -= width;
    if (shelf.width === 0) {
      this.#shelf = undefined;
    }
    this.#raiseSkyline(allocated.x, allocated.y + height, width);
    return allocated;
  }

  #noteShelf(rectangle: PackedRectangle): void {
    const remaining = this.#flatWidth(rectangle.x + rectangle.width, rectangle.y);
    if (remaining <= 0) return;
    this.#shelf = {
      x: rectangle.x + rectangle.width,
      y: rectangle.y,
      width: remaining,
      height: rectangle.height,
    };
  }

  #carveShelf(rectangle: PackedRectangle): void {
    const shelf = this.#shelf;
    if (shelf === undefined) return;
    const vertical =
      rectangle.y < shelf.y + shelf.height && rectangle.y + rectangle.height > shelf.y;
    const horizontal =
      rectangle.x < shelf.x + shelf.width && rectangle.x + rectangle.width > shelf.x;
    if (!vertical || !horizontal) return;
    const rectangleRight = rectangle.x + rectangle.width;
    const shelfRight = shelf.x + shelf.width;
    if (rectangleRight < shelfRight) {
      shelf.x = rectangleRight;
      shelf.width = shelfRight - rectangleRight;
      return;
    }
    this.#shelf = undefined;
  }

  #flatWidth(x: number, y: number): number {
    let width = 0;
    let cursor = x;
    for (const node of this.#skyline) {
      const nodeRight = node.x + node.width;
      if (nodeRight <= cursor) continue;
      if (node.x > cursor || node.y !== y) break;
      const take = nodeRight - cursor;
      width += take;
      cursor += take;
    }
    return width;
  }
}

function mergeSkyline(nodes: readonly SkylineNode[]): SkylineNode[] {
  const merged: SkylineNode[] = [];
  for (const node of nodes) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && previous.y === node.y && previous.x + previous.width === node.x) {
      previous.width += node.width;
    } else {
      merged.push({ ...node });
    }
  }
  return merged;
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

function rectangleKey(
  rectangle: PackedRectangle,
  pageWidth: number,
  pageHeight: number,
): number | string {
  if (pageWidth < KEY_FIELD && pageHeight < KEY_FIELD) {
    return (
      rectangle.x +
      rectangle.y * KEY_FIELD +
      rectangle.width * KEY_FIELD * KEY_FIELD +
      rectangle.height * KEY_FIELD * KEY_FIELD * KEY_FIELD
    );
  }
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
