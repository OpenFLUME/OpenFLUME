/**
 * Exact limit-cycle detection for the transient outer (Picard) loop of
 * solveStateStepAttemptInner (./step.ts).
 *
 * Why: near a discontinuous closure (e.g. a custom h correlation that
 * switches branch at a saturation test) the outer coupling iteration of a
 * transient real-fluid step can settle into a PERIODIC orbit: every inner
 * Newton meets the certifying bar, but the state moves by more than the
 * settle tolerance each outer, so neither the convergence test nor the
 * above-bar residual-trend detector ever fires, and the step grinds to
 * maxOuter (1000).  Measured on a 7 m LN2 chilldown line: a bit-exact
 * period-4 orbit established by outer ~139, after which the remaining ~860
 * outers recompute the same four iterates (~14 ms each) every step.
 *
 * The outer iteration is a DETERMINISTIC map of the state it carries from one
 * outer to the next (the iterate X, the published StepState, the
 * under-relaxed conductor h map, the trust-region radius, the round-off
 * floor, ...; every property evaluation is a pure function of its inputs —
 * the CoolProp value caches are bit-exact, see fluids/realFluid.ts LruMap).
 * So once that carried state is BIT-IDENTICAL to the state at the end of an
 * earlier outer, every later outer replays the recorded ones exactly.  The
 * caller can then account for the replay arithmetically (iteration counters,
 * sticky residual bookkeeping) and stop — the returned state and every
 * reported number are bit-identical to running the loop to maxOuter.  This
 * is a speed-only change: no tolerance or iteration cap moves, and nothing
 * is approximated (an orbit that is merely CLOSE to periodic is never
 * matched).
 */

/** Bit-exact image of the state one outer iteration hands to the next. */
export interface OuterSnapshot {
  readonly nums: Float64Array;
  readonly strs: readonly string[];
  readonly hash: number;
}

/** Incrementally assembles an OuterSnapshot.  Map keys and string values
 *  go in `strs` (so key ORDER and identity are part of the image), numbers
 *  in `nums`; container sizes and presence markers are recorded too, so two
 *  differently shaped states can never compare equal. */
export class OuterSnapshotBuilder {
  private readonly nums: number[] = [];
  private readonly strs: string[] = [];

  num(v: number): this {
    this.nums.push(v);
    return this;
  }

  array(vs: readonly number[]): this {
    this.nums.push(vs.length);
    for (const v of vs) this.nums.push(v);
    return this;
  }

  /** Map of numbers / strings / undefined / plain records of numbers. */
  map(
    tag: string,
    m:
      | ReadonlyMap<
          string,
          number | string | undefined | Readonly<Record<string, number>>
        >
      | undefined,
  ): this {
    if (m === undefined) {
      this.strs.push(`${tag}:absent`);
      return this;
    }
    this.strs.push(`${tag}:${m.size}`);
    for (const [k, v] of m) {
      this.strs.push(k);
      if (typeof v === "number") {
        this.strs.push("n");
        this.nums.push(v);
      } else if (typeof v === "string") {
        this.strs.push("s", v);
      } else if (v === undefined) {
        this.strs.push("u");
      } else {
        this.strs.push("r");
        for (const rk of Object.keys(v)) {
          this.strs.push(rk);
          this.nums.push(v[rk]);
        }
      }
    }
    return this;
  }

  build(): OuterSnapshot {
    const nums = Float64Array.from(this.nums);
    const words = new Uint32Array(nums.buffer);
    let h = 2166136261; // FNV-1a over the IEEE bits and the strings
    for (let i = 0; i < words.length; i++) {
      h ^= words[i];
      h = Math.imul(h, 16777619) >>> 0;
    }
    for (const s of this.strs) {
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      h ^= 0xff;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return { nums, strs: this.strs, hash: h };
  }
}

/** Bit-for-bit equality (NaN payloads and the sign of zero included). */
export function snapshotsEqual(a: OuterSnapshot, b: OuterSnapshot): boolean {
  if (a.hash !== b.hash) return false;
  if (a.nums.length !== b.nums.length || a.strs.length !== b.strs.length)
    return false;
  const wa = new Uint32Array(
    a.nums.buffer,
    a.nums.byteOffset,
    a.nums.length * 2,
  );
  const wb = new Uint32Array(
    b.nums.buffer,
    b.nums.byteOffset,
    b.nums.length * 2,
  );
  for (let i = 0; i < wa.length; i++) if (wa[i] !== wb[i]) return false;
  for (let i = 0; i < a.strs.length; i++)
    if (a.strs[i] !== b.strs[i]) return false;
  return true;
}

/**
 * Records end-of-outer snapshots and reports the earliest outer whose
 * end-state is bit-identical to the one just recorded.
 */
export class OuterCycleDetector {
  private readonly byHash = new Map<number, Array<[number, OuterSnapshot]>>();

  /** Record the end-state of `outer`; returns the earlier outer index whose
   *  end-state equals it, or undefined. */
  record(outer: number, snap: OuterSnapshot): number | undefined {
    const bucket = this.byHash.get(snap.hash);
    if (bucket !== undefined) {
      for (const [j, s] of bucket) if (snapshotsEqual(s, snap)) return j;
      bucket.push([outer, snap]);
    } else {
      this.byHash.set(snap.hash, [[outer, snap]]);
    }
    return undefined;
  }
}

/** What one outer iteration contributed to the attempt's reported
 *  bookkeeping — replayed arithmetically after a short-circuit. */
export interface OuterRecord {
  /** Inner Newton iterations (Jacobian builds) this outer performed. */
  newtonIters: number;
  /** Whether this outer's inner loop assigned finalResidual / totalIter. */
  innerStopAssigned: boolean;
  finalResidual: number;
  totalIter: number;
  returnResidual: number;
  lastInnerBestResScaled: number;
  /** Certifying scaled residual above the bar (or NaN). */
  aboveBar: boolean;
  /** Last-resort property fallbacks recorded during this outer. */
  lastResortDelta: number;
}

let shortCircuitEnabled = true;

/** Test hook: switch the exact limit-cycle short-circuit off (to compare a
 *  run against the full maxOuter grind) and back on.  Not part of the
 *  public API. */
export function setOuterCycleShortCircuitEnabled(on: boolean): void {
  shortCircuitEnabled = on;
}

export function outerCycleShortCircuitEnabled(): boolean {
  return shortCircuitEnabled;
}
