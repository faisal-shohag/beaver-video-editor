//! Parser for FFmpeg's `-progress pipe:1` key=value stream.

#[derive(Debug, Default, Clone, PartialEq)]
pub struct ProgressSample {
    /// Output time reached, seconds.
    pub out_time: f64,
    pub fps: f64,
    pub speed: f64,
    pub done: bool,
}

#[derive(Default)]
pub struct ProgressParser {
    cur: ProgressSample,
}

impl ProgressParser {
    /// Feed one line; returns a complete sample at each `progress=` marker.
    pub fn feed(&mut self, line: &str) -> Option<ProgressSample> {
        let (key, value) = line.trim().split_once('=')?;
        let value = value.trim();
        match key {
            "out_time_us" | "out_time_ms" => {
                // Both keys are microseconds in FFmpeg (out_time_ms is misnamed).
                if let Ok(us) = value.parse::<i64>() {
                    self.cur.out_time = (us.max(0) as f64) / 1_000_000.0;
                }
            }
            "fps" => self.cur.fps = value.parse().unwrap_or(self.cur.fps),
            "speed" => self.cur.speed = value.trim_end_matches('x').trim().parse().unwrap_or(self.cur.speed),
            "progress" => {
                self.cur.done = value == "end";
                return Some(self.cur.clone());
            }
            _ => {}
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_blocks() {
        let mut p = ProgressParser::default();
        let text = "frame=10\nfps=250.5\nout_time_us=2500000\nspeed=8.3x\nprogress=continue\nout_time_us=5000000\nspeed=N/A\nprogress=end\n";
        let samples: Vec<_> = text.lines().filter_map(|l| p.feed(l)).collect();
        assert_eq!(samples.len(), 2);
        assert_eq!(samples[0].out_time, 2.5);
        assert_eq!(samples[0].fps, 250.5);
        assert_eq!(samples[0].speed, 8.3);
        assert!(!samples[0].done);
        assert_eq!(samples[1].out_time, 5.0);
        assert!(samples[1].done);
    }
}
