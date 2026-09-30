//! Sidon speech restoration (sarulab-speech, MIT) via ONNX Runtime:
//! 16 kHz audio → w2v-BERT 2.0 features → predictor → DAC vocoder → 48 kHz audio.
use super::onnx;
use realfft::RealFftPlanner;
use std::path::Path;

/// 20 s windows keep attention cost and RAM bounded; 0.5 s crossfade hides the seams.
const CHUNK: usize = 16_000 * 20;
const XFADE: usize = 16_000 / 2;
const UPSAMPLE: usize = 3; // 16 kHz in → 48 kHz out

pub fn enhance(
    predictor: &Path,
    vocoder: &Path,
    audio16: &[f32],
    threads: usize,
    mut progress: impl FnMut(f64) -> Result<(), String>,
) -> Result<Vec<f32>, String> {
    let mut pred = onnx::session(predictor, threads)?;
    let mut voc = onnx::session(vocoder, threads)?;
    let fe = FeatureExtractor::new();
    let out_len = audio16.len() * UPSAMPLE;
    let mut out = vec![0f32; out_len];
    let mut weight = vec![0f32; out_len];
    let step = CHUNK - XFADE;
    let fade = XFADE * UPSAMPLE;
    let mut start = 0;
    loop {
        let end = (start + CHUNK).min(audio16.len());
        let seg = &audio16[start..end];
        if seg.len() < 1_600 {
            break;
        }
        let (frames, feats) = fe.features(seg);
        let (h_shape, h) = onnx::run1(&mut pred, (vec![1, frames as i64, 160], &feats))?;
        let (_, wav) = onnx::run1(&mut voc, (h_shape, &h))?;
        let off = start * UPSAMPLE;
        let len = (seg.len() * UPSAMPLE).min(out_len - off);
        for i in 0..len {
            let mut w = 1f32;
            if start > 0 && i < fade {
                w = i as f32 / fade as f32;
            }
            if end < audio16.len() && i + fade >= len {
                w = w.min((len - i) as f32 / fade as f32);
            }
            out[off + i] += wav.get(i).copied().unwrap_or(0.0) * w;
            weight[off + i] += w;
        }
        progress(end as f64 / audio16.len() as f64)?;
        if end >= audio16.len() {
            break;
        }
        start += step;
    }
    for (o, w) in out.iter_mut().zip(&weight) {
        *o /= w.max(1e-6);
    }
    Ok(out)
}

/// Port of `transformers.SeamlessM4TFeatureExtractor` (w2v-BERT 2.0 front-end):
/// Kaldi-style 80-bin log-mel fbank, per-bin normalisation, stride-2 stacking → 160 dims.
pub struct FeatureExtractor {
    window: Vec<f64>,
    /// [257][80], exported from the Python extractor so mel weights match exactly.
    mel: Vec<[f32; 80]>,
}

const FRAME: usize = 400;
const HOP: usize = 160;
const NFFT: usize = 512;
const BINS: usize = NFFT / 2 + 1;
const MELS: usize = 80;

impl FeatureExtractor {
    pub fn new() -> Self {
        // Povey window: symmetric Hann raised to 0.85.
        let window = (0..FRAME)
            .map(|n| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / (FRAME - 1) as f64).cos()).powf(0.85))
            .collect();
        let raw = include_bytes!("assets/w2vbert_mel_257x80.f32");
        let vals: Vec<f32> = raw.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        let mel = vals
            .chunks_exact(MELS)
            .map(|row| {
                let mut r = [0f32; MELS];
                r.copy_from_slice(row);
                r
            })
            .collect();
        FeatureExtractor { window, mel }
    }

    /// Returns (frames, row-major [frames][160]).
    pub fn features(&self, audio16: &[f32]) -> (usize, Vec<f32>) {
        let x: Vec<f64> = audio16.iter().map(|v| *v as f64 * 32768.0).collect();
        let n_frames = if x.len() >= FRAME { 1 + (x.len() - FRAME) / HOP } else { 0 };
        let mut planner = RealFftPlanner::<f64>::new();
        let fft = planner.plan_fft_forward(NFFT);
        let mut buf = fft.make_input_vec();
        let mut spec = fft.make_output_vec();
        let mut logmel = vec![[0f64; MELS]; n_frames];
        for (t, row) in logmel.iter_mut().enumerate() {
            buf.iter_mut().for_each(|v| *v = 0.0);
            buf[..FRAME].copy_from_slice(&x[t * HOP..t * HOP + FRAME]);
            let mean = buf[..FRAME].iter().sum::<f64>() / FRAME as f64;
            buf[..FRAME].iter_mut().for_each(|v| *v -= mean);
            for i in (1..FRAME).rev() {
                buf[i] -= 0.97 * buf[i - 1];
            }
            buf[0] *= 1.0 - 0.97;
            buf[..FRAME].iter_mut().zip(&self.window).for_each(|(v, w)| *v *= w);
            fft.process(&mut buf, &mut spec).expect("fft");
            let power: Vec<f64> = spec.iter().map(|c| c.norm_sqr()).collect();
            for (m, out) in row.iter_mut().enumerate() {
                let e: f64 = (0..BINS).map(|k| self.mel[k][m] as f64 * power[k]).sum();
                *out = e.max(1.192_092_955_078_125e-7).ln();
            }
        }
        // Per-mel-bin normalisation (ddof = 1, like torch).
        if n_frames > 1 {
            for m in 0..MELS {
                let mean = logmel.iter().map(|r| r[m]).sum::<f64>() / n_frames as f64;
                let var = logmel.iter().map(|r| (r[m] - mean).powi(2)).sum::<f64>() / (n_frames - 1) as f64;
                let sd = (var + 1e-7).sqrt();
                logmel.iter_mut().for_each(|r| r[m] = (r[m] - mean) / sd);
            }
        }
        // Pad to an even frame count with zeros, then stack pairs of frames.
        if n_frames % 2 == 1 {
            logmel.push([0f64; MELS]);
        }
        let out: Vec<f32> = logmel.iter().flat_map(|r| r.iter().map(|v| *v as f32)).collect();
        (logmel.len() / 2, out)
    }
}

impl Default for FeatureExtractor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::enhance::testutil::fixture;

    #[test]
    fn frontend_matches_seamless_m4t_extractor() {
        let (audio, _) = fixture("sidon_in_16k");
        let (want, shape) = fixture("sidon_feats");
        let (frames, got) = FeatureExtractor::new().features(&audio);
        assert_eq!(frames, shape[0]);
        assert_eq!(got.len(), want.len());
        let max_err = got.iter().zip(&want).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        assert!(max_err < 1e-3, "max abs diff {max_err}");
    }
}
