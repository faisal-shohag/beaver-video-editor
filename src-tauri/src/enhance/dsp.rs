//! STFT/ISTFT matching `librosa.stft` / `librosa.istft` with `center=True, pad_mode="reflect"`,
//! as used by DPDFNet's reference pipeline (`dpdfnet/audio.py`).
use realfft::num_complex::Complex32;
use realfft::RealFftPlanner;

/// DPDFNet's analysis/synthesis window.
pub fn vorbis_window(n: usize) -> Vec<f32> {
    let half = n as f64 / 2.0;
    (0..n)
        .map(|i| {
            let s = (0.5 * std::f64::consts::PI * (i as f64 + 0.5) / half).sin();
            (0.5 * std::f64::consts::PI * s * s).sin() as f32
        })
        .collect()
}

pub struct Stft {
    pub n_fft: usize,
    pub hop: usize,
    window: Vec<f32>,
    planner: RealFftPlanner<f32>,
}

impl Stft {
    pub fn new(n_fft: usize, hop: usize, window: Vec<f32>) -> Self {
        assert_eq!(window.len(), n_fft);
        Stft { n_fft, hop, window, planner: RealFftPlanner::new() }
    }

    pub fn bins(&self) -> usize {
        self.n_fft / 2 + 1
    }

    /// Reflect-pad by n_fft/2 on both sides (numpy "reflect": the edge sample is not repeated).
    fn reflect_pad(&self, x: &[f32]) -> Vec<f32> {
        let pad = self.n_fft / 2;
        let n = x.len();
        let idx = |i: isize| -> f32 {
            // Mirror repeatedly for very short inputs.
            let period = 2 * (n as isize - 1).max(1);
            let mut j = i.rem_euclid(period);
            if j >= n as isize {
                j = period - j;
            }
            x[j as usize]
        };
        (-(pad as isize)..(n + pad) as isize).map(idx).collect()
    }

    /// Frames of the one-sided spectrum, `[frames][bins]`.
    pub fn forward(&mut self, x: &[f32]) -> Vec<Vec<Complex32>> {
        let padded = self.reflect_pad(x);
        let frames = if padded.len() >= self.n_fft { 1 + (padded.len() - self.n_fft) / self.hop } else { 0 };
        let fft = self.planner.plan_fft_forward(self.n_fft);
        let mut input = fft.make_input_vec();
        let mut out = Vec::with_capacity(frames);
        for t in 0..frames {
            let start = t * self.hop;
            for (i, v) in input.iter_mut().enumerate() {
                *v = padded[start + i] * self.window[i];
            }
            let mut spec = fft.make_output_vec();
            fft.process(&mut input, &mut spec).expect("fft");
            out.push(spec);
        }
        out
    }

    /// Weighted overlap-add inverse with window-sum-square normalisation, center trimmed.
    /// Output length = hop * (frames - 1), like `librosa.istft(length=None)`.
    pub fn inverse(&mut self, spec: &[Vec<Complex32>]) -> Vec<f32> {
        let frames = spec.len();
        if frames == 0 {
            return vec![];
        }
        let ifft = self.planner.plan_fft_inverse(self.n_fft);
        let total = self.n_fft + self.hop * (frames - 1);
        let mut y = vec![0f32; total];
        let mut wss = vec![0f32; total];
        let mut buf = ifft.make_output_vec();
        let scale = 1.0 / self.n_fft as f32;
        for (t, frame) in spec.iter().enumerate() {
            let mut f = frame.clone();
            // realfft requires purely real DC and Nyquist bins.
            f[0].im = 0.0;
            let last = f.len() - 1;
            f[last].im = 0.0;
            ifft.process(&mut f, &mut buf).expect("ifft");
            let start = t * self.hop;
            for i in 0..self.n_fft {
                y[start + i] += buf[i] * scale * self.window[i];
                wss[start + i] += self.window[i] * self.window[i];
            }
        }
        let tiny = f32::MIN_POSITIVE;
        for (v, w) in y.iter_mut().zip(&wss) {
            if *w > tiny {
                *v /= w;
            }
        }
        let pad = self.n_fft / 2;
        y[pad..total - pad].to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::enhance::testutil::fixture;

    #[test]
    fn stft_matches_librosa() {
        let (x, _) = fixture("stft_in");
        let (want, shape) = fixture("stft_spec"); // [frames, bins, 2]
        let mut s = Stft::new(960, 480, vorbis_window(960));
        let spec = s.forward(&x);
        assert_eq!(spec.len(), shape[0]);
        assert_eq!(spec[0].len(), shape[1]);
        let mut max_err = 0f32;
        for (t, frame) in spec.iter().enumerate() {
            for (k, c) in frame.iter().enumerate() {
                let base = (t * shape[1] + k) * 2;
                max_err = max_err.max((c.re - want[base]).abs()).max((c.im - want[base + 1]).abs());
            }
        }
        assert!(max_err < 1e-3, "max err {max_err}");
    }

    #[test]
    fn istft_matches_librosa_roundtrip() {
        let (x, _) = fixture("stft_in");
        let (want, _) = fixture("stft_roundtrip");
        let mut s = Stft::new(960, 480, vorbis_window(960));
        let spec = s.forward(&x);
        let y = s.inverse(&spec);
        assert_eq!(y.len(), want.len());
        let max_err = y.iter().zip(&want).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        assert!(max_err < 1e-4, "max err {max_err}");
    }
}
