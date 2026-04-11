// Round-keyed replay cache used by the "Replay last turn" feature.
//
// Each entry is { roundNum, preStateJson, stepsJson }. Keyed by roundNum so
// that the client can look up the replay for an exact round rather than
// trusting "the tail of some array", which has historically caused us to
// show the wrong turn after reconnect desyncs.

export class ReplayCache {
  constructor() {
    /** @type {Map<number, {roundNum:number, preStateJson:string, stepsJson:string}>} */
    this.map = new Map();
  }

  clear() {
    this.map.clear();
  }

  has(roundNum) {
    return this.map.has(roundNum);
  }

  /** Returns the cached entry for `roundNum`, or null if missing/mismatched. */
  get(roundNum) {
    const entry = this.map.get(roundNum);
    if (!entry) return null;
    // Defensive: never return an entry whose stored roundNum doesn't match.
    if (entry.roundNum !== roundNum) return null;
    return entry;
  }

  /** Store an entry. Returns true on success, false if the entry is invalid. */
  set(entry) {
    if (!entry || typeof entry.roundNum !== 'number') return false;
    if (typeof entry.preStateJson !== 'string' || typeof entry.stepsJson !== 'string') return false;
    this.map.set(entry.roundNum, {
      roundNum:     entry.roundNum,
      preStateJson: entry.preStateJson,
      stepsJson:    entry.stepsJson,
    });
    return true;
  }

  get size() {
    return this.map.size;
  }
}
