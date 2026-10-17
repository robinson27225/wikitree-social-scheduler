import fs from "node:fs";

/**
 * How much of the server's memory is in use, so the machine can be sized to what it really needs (Fly bills by the
 * size of the machine, and a smaller one costs less). Only meaningful on Linux, which is what the server runs.
 */

export interface MemoryReading {
  totalMb: number;
  usedMb: number;
  /** The highest used amount seen since the server last started. */
  peakMb: number;
}

/** Reads "MemTotal" and "MemAvailable" (in kB) from the text of /proc/meminfo. */
export function parseMeminfo(text: string): { totalMb: number; usedMb: number } | null {
  const kb = (name: string) => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return m ? Number(m[1]) : null;
  };
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  if (total === null || available === null) return null;
  return { totalMb: Math.round(total / 1024), usedMb: Math.round((total - available) / 1024) };
}

let peakMb = 0;

export function readMemory(source = "/proc/meminfo"): MemoryReading | null {
  let text: string;
  try {
    text = fs.readFileSync(source, "utf8");
  } catch {
    return null; // not Linux (a developer's Mac)
  }
  const now = parseMeminfo(text);
  if (!now) return null;
  peakMb = Math.max(peakMb, now.usedMb);
  return { ...now, peakMb };
}

/** Looks every half minute, so a short burst (resizing a big picture) still shows up in the peak. */
export function startMemorySampler(): void {
  readMemory();
  setInterval(() => readMemory(), 30_000).unref();
}
