import { describe, expect, it, vi } from "vitest";
import {
  createStableChangeNotifier,
  type TimedTaskScheduler,
} from "./workspace-watcher";

function fakeScheduler(): {
  schedule: TimedTaskScheduler;
  /** Run the next due task; returns false when the queue is empty. */
  runNext: () => boolean;
} {
  const tasks: Array<{ at: number; fn: () => void }> = [];
  let clock = 0;
  return {
    schedule(fn, ms) {
      const task = { at: clock + ms, fn };
      tasks.push(task);
      return () => {
        const index = tasks.indexOf(task);
        if (index >= 0) tasks.splice(index, 1);
      };
    },
    runNext() {
      while (tasks.length > 0) {
        tasks.sort((a, b) => a.at - b.at);
        const task = tasks.shift()!;
        clock = task.at;
        task.fn();
        return true;
      }
      return false;
    },
  };
}

describe("stable change notifier", () => {
  it("coalesces a burst into one emission after the debounce window", () => {
    const schedule = fakeScheduler();
    const exists = vi.fn((_path: string) => true);
    const emit = vi.fn();
    const notifier = createStableChangeNotifier({
      exists: (path) => exists(path),
      emit,
      schedule: schedule.schedule,
    });

    notifier.touch("a.md");
    notifier.touch("b.md");
    notifier.touch("a.md");
    expect(emit).not.toHaveBeenCalled();
    expect(schedule.runNext()).toBe(true);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.arrayContaining(["a.md", "b.md"]));
    expect(schedule.runNext()).toBe(false);
  });

  it("confirms a stable deletion before notifying", () => {
    const schedule = fakeScheduler();
    const emit = vi.fn();
    const notifier = createStableChangeNotifier({
      exists: () => false,
      emit,
      schedule: schedule.schedule,
    });

    notifier.touch("gone.md");
    // Debounce flush finds the path absent: no emission yet, confirmation pending.
    expect(schedule.runNext()).toBe(true);
    expect(emit).not.toHaveBeenCalled();
    // Confirmation expires: the deletion is stable and reported once.
    expect(schedule.runNext()).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(["gone.md"]);
  });

  it("never reports a delete flash that was followed by a recreate in the window", () => {
    const schedule = fakeScheduler();
    let exists = true;
    const emit = vi.fn();
    const notifier = createStableChangeNotifier({
      exists: () => exists,
      emit,
      schedule: schedule.schedule,
    });

    // delete flash then immediate recreate, all inside the debounce window
    exists = false;
    notifier.touch("a.md");
    exists = true;
    notifier.touch("a.md");
    schedule.runNext();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(["a.md"]);
    expect(schedule.runNext()).toBe(false);
  });

  it("emits one change for a path that recreated during a pending deletion", () => {
    const schedule = fakeScheduler();
    let exists = false;
    const emit = vi.fn();
    const notifier = createStableChangeNotifier({
      exists: () => exists,
      emit,
      schedule: schedule.schedule,
    });

    // First flush observes a deletion and arms confirmation without emitting…
    notifier.touch("a.md");
    schedule.runNext();
    expect(emit).not.toHaveBeenCalled();
    // …then the file reappears before confirmation completes.
    exists = true;
    notifier.touch("a.md");
    while (schedule.runNext()) {
      // Flush and confirmation both run; no phantom deletion may surface.
    }

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(["a.md"]);
  });

  it("dispose cancels pending timers without emitting", () => {
    const schedule = fakeScheduler();
    const emit = vi.fn();
    const notifier = createStableChangeNotifier({
      exists: () => true,
      emit,
      schedule: schedule.schedule,
    });

    notifier.touch("a.md");
    notifier.dispose();
    expect(schedule.runNext()).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});
