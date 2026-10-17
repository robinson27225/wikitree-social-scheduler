import { spawn, type ChildProcess } from "node:child_process";

let child: ChildProcess | undefined;

/**
 * Keeps the Mac from sleeping while this app runs, so scheduled posts go out on time.
 *
 *   -i  prevent idle sleep
 *   -s  prevent system sleep (macOS only honours this while on AC power)
 *   -w  exit automatically when this process exits, so caffeinate can never be left behind
 *
 * The display may still sleep. Closing a laptop lid on battery will still sleep the machine.
 */
export function setKeepAwake(enabled: boolean): void {
  if (process.platform !== "darwin") return;
  if (enabled && !child) {
    child = spawn("caffeinate", ["-i", "-s", "-w", String(process.pid)], { stdio: "ignore" });
    child.on("exit", () => {
      child = undefined;
    });
    child.on("error", () => {
      child = undefined;
    });
  } else if (!enabled && child) {
    child.kill();
    child = undefined;
  }
}

export function isKeepingAwake(): boolean {
  return child !== undefined;
}
