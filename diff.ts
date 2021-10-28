/**
 * The algorithm implemented here is based on "An O(NP) Sequence Comparison Algorithm"
 * by described by Sun Wu, Udi Manber and Gene Myers */

/** LICENSE: https://github.com/cubicdaiya/onp/blob/master/COPYING */

type Position = {
  x: number;
  y: number;
};

export interface Added<T> {
  value: T;
  type: "added";
}
export interface Deleted<T> {
  value: T;
  type: "deleted";
}
export interface Common<T> {
  value: T;
  type: "common";
}
export type Change<T> = Added<T> | Deleted<T> | Common<T>;
export interface Replaced<T> {
  value: T;
  oldValue: T;
  type: "replaced";
}
export type ExtendedChange<T> = Change<T> | Replaced<T>;

export interface DiffResult<T> {
  from: ArrayLike<T>;
  to: ArrayLike<T>;
  editDistance: number;
  buildSES(): Generator<Change<T>, void, unknown>;
}

export function diff<T>(
  left: ArrayLike<T>,
  right: ArrayLike<T>,
): DiffResult<T> {
  const reversed = left.length > right.length;
  const a = reversed ? right : left;
  const b = reversed ? left : right;

  const offset = a.length + 1;
  const MAXSIZE = a.length + b.length + 3;
  const path = new Array<number>(MAXSIZE);
  path.fill(-1);
  const pathpos = [] as [Position, number][];

  function snake(k: number, p: number, pp: number) {
    let y = Math.max(p, pp);
    let x = y - k;

    while (x < a.length && y < b.length && a[x] === b[y]) {
      ++x;
      ++y;
    }

    path[k + offset] = pathpos.length;
    pathpos.push([{ x, y }, path[k + (p > pp ? -1 : +1) + offset]]);
    return y;
  }

  const fp = new Array<number>(MAXSIZE);
  fp.fill(-1);
  let p = -1;
  const delta = b.length - a.length;
  do {
    ++p;
    for (let k = -p; k <= delta - 1; ++k) {
      fp[k + offset] = snake(k, fp[k - 1 + offset] + 1, fp[k + 1 + offset]);
    }
    for (let k = delta + p; k >= delta + 1; --k) {
      fp[k + offset] = snake(k, fp[k - 1 + offset] + 1, fp[k + 1 + offset]);
    }
    fp[delta + offset] = snake(
      delta,
      fp[delta - 1 + offset] + 1,
      fp[delta + 1 + offset],
    );
  } while (fp[delta + offset] !== b.length);

  const epc = [] as Position[];
  let r = path[delta + offset];
  while (r !== -1) {
    epc.push(pathpos[r][0]);
    r = pathpos[r][1];
  }

  return {
    from: left,
    to: right,
    editDistance: delta + p * 2,
    buildSES: function* () {
      let xIndex = 0;
      let yIndex = 0;
      for (const { x, y } of reverse(epc)) {
        while (xIndex < x || yIndex < y) {
          if (y - x > yIndex - xIndex) {
            yield { value: b[yIndex], type: reversed ? "deleted" : "added" };
            ++yIndex;
          } else if (y - x < yIndex - xIndex) {
            yield { value: a[xIndex], type: reversed ? "added" : "deleted" };
            ++xIndex;
          } else {
            yield { value: a[xIndex], type: "common" };
            ++xIndex;
            ++yIndex;
          }
        }
      }
    },
  };
}

export function* toExtendedChanges<T>(
  changes: Iterable<Change<T>>,
): Generator<ExtendedChange<T>, void, unknown> {
  let stack0 = [] as (Added<T> | Deleted<T>)[];
  let stack1 = [] as (Added<T> | Deleted<T>)[];

  function* flush() {
    if (stack0.length > stack1.length) {
      const delta = stack0.length - stack1.length;
      for (let i = 0; i < delta; i++) {
        yield stack0[i];
      }
      for (let i = 0; i < stack1.length; i++) {
        yield makeReplaced(
          stack0[i + delta],
          stack1[i],
        );
      }
    } else {
      for (let i = 0; i < stack0.length; i++) {
        yield makeReplaced(
          stack0[i],
          stack1[i],
        );
      }
      for (let i = stack0.length; i < stack1.length; i++) {
        yield stack1[i];
      }
    }
    stack0 = [];
    stack1 = [];
  }

  for (const change of changes) {
    if (change.type === "common") {
      yield* flush();
      yield change;
      continue;
    }
    if (stack0.length === 0) {
      stack0.push(change);
      continue;
    }
    if (stack0[stack0.length - 1].type === change.type) {
      if (stack1.length > 0) {
        yield* flush();
      }
      stack0.push(change);
      continue;
    }
    stack1.push(change);
  }
  yield* flush();
}

function makeReplaced<T>(
  left: Added<T> | Deleted<T>,
  right: Added<T> | Deleted<T>,
): Replaced<T> {
  return left.type === "added"
    ? {
      value: left.value,
      oldValue: right.value,
      type: "replaced",
    }
    : {
      value: right.value,
      oldValue: left.value,
      type: "replaced",
    };
}

function* reverse<T>(list: ArrayLike<T>) {
  for (let i = list.length - 1; i >= 0; i--) {
    yield list[i];
  }
}
