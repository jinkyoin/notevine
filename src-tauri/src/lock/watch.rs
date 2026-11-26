//! When to lock by itself (NFR-SEC-04): looked at once a second.

use std::time::Duration;

use super::state::Reason;

/// Minimized or hidden in the tray this long locks.
const HIDDEN_LIMIT: Duration = Duration::from_secs(30);
/// Ticks further apart than this mean the PC slept. A backstop: Windows does not
/// always announce a sleep.
const SLEEP_GAP: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy)]
pub struct Tick {
    /// Wall clock since the UNIX epoch: it keeps running while the PC sleeps.
    pub now: Duration,
    /// Time without keyboard or mouse input.
    pub idle: Duration,
    /// The window is minimized or hidden.
    pub hidden: bool,
}

#[derive(Default)]
pub struct Watch {
    last: Option<Duration>,
    hidden_since: Option<Duration>,
    hidden_done: bool,
    idle_done: bool,
    was_hidden: bool,
}

impl Watch {
    /// True the first time the window is in sight again after being out of it.
    pub fn came_back(&mut self, hidden: bool) -> bool {
        let back = self.was_hidden && !hidden;
        self.was_hidden = hidden;
        back
    }

    /// The reason to lock now, if any. Each reason is given once per episode.
    pub fn tick(&mut self, t: Tick, idle_limit: Option<Duration>) -> Option<Reason> {
        let slept = self.last.is_some_and(|last| t.now.saturating_sub(last) > SLEEP_GAP);
        self.last = Some(t.now);

        if t.hidden {
            self.hidden_since.get_or_insert(t.now);
        }
        // Also on the way back: the tick at 30 seconds may have been late.
        let hidden =
            !self.hidden_done && self.hidden_since.is_some_and(|since| t.now.saturating_sub(since) >= HIDDEN_LIMIT);
        self.hidden_done |= hidden;
        if !t.hidden {
            self.hidden_since = None;
            self.hidden_done = false;
        }

        let long_idle = idle_limit.is_some_and(|limit| t.idle >= limit);
        let idle = long_idle && !self.idle_done;
        self.idle_done = long_idle;

        if slept {
            Some(Reason::Sleep)
        } else if hidden {
            Some(Reason::Hidden)
        } else if idle {
            Some(Reason::Idle)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIVE: Option<Duration> = Some(Duration::from_secs(300));

    fn at(secs: u64, idle: u64, hidden: bool) -> Tick {
        Tick { now: Duration::from_secs(secs), idle: Duration::from_secs(idle), hidden }
    }

    /// Runs `(time, idle, hidden)` ticks and returns what each one asked for.
    fn run(limit: Option<Duration>, ticks: &[(u64, u64, bool)]) -> Vec<Option<Reason>> {
        let mut w = Watch::default();
        ticks.iter().map(|&(s, idle, hidden)| w.tick(at(s, idle, hidden), limit)).collect()
    }

    #[test]
    fn hidden_locks_at_30_seconds_once() {
        use Reason::Hidden;
        let got = run(
            FIVE,
            &[(0, 0, true), (29, 0, true), (30, 0, true), (31, 0, true), (32, 0, false), (33, 0, true), (63, 0, true)],
        );
        assert_eq!(got, [None, None, Some(Hidden), None, None, None, Some(Hidden)]);
    }

    #[test]
    fn a_quick_return_does_not_lock() {
        let got = run(FIVE, &[(0, 0, true), (20, 0, true), (21, 0, false), (70, 0, false)]);
        assert_eq!(got, [None, None, None, None]);
    }

    #[test]
    fn returning_after_30_seconds_locks_even_if_that_tick_was_missed() {
        assert_eq!(run(FIVE, &[(0, 0, true), (45, 0, false)]), [None, Some(Reason::Hidden)]);
    }

    #[test]
    fn a_gap_over_a_minute_means_sleep() {
        let got = run(FIVE, &[(0, 0, false), (61, 0, false), (62, 0, false), (122, 0, false)]);
        assert_eq!(got, [None, Some(Reason::Sleep), None, None]);
    }

    #[test]
    fn idle_locks_once_until_input_returns() {
        use Reason::Idle;
        let got = run(FIVE, &[(1, 299, false), (2, 300, false), (3, 301, false), (4, 0, false), (5, 300, false)]);
        assert_eq!(got, [None, Some(Idle), None, None, Some(Idle)]);
    }

    #[test]
    fn coming_back_into_sight_is_seen_once() {
        let mut w = Watch::default();
        let seen: Vec<bool> = [false, true, true, false, false].into_iter().map(|hidden| w.came_back(hidden)).collect();
        assert_eq!(seen, [false, false, false, true, false]);
    }

    #[test]
    fn idle_off_never_locks() {
        assert_eq!(run(None, &[(1, 100_000, false)]), [None]);
    }
}
