//! DPDFNet (Ceva, Apache-2.0) streaming speech enhancement via ONNX Runtime.
//! A port of `dpdfnet.enhance` (dpdfnet/api.py + audio.py + onnx_backend.py).
use super::dsp::{vorbis_window, Stft};
use super::onnx;
use realfft::num_complex::Complex32;

/// `ATTN_LIMIT_NOISY_FRAME_OFFSET`: the offline ISTFT advances output by ~4 hops.
const NOISY_FRAME_OFFSET: usize = 4;

/// Enhance 48 kHz mono audio. `atten_limit_db = None` means unlimited (full strength).
pub fn enhance(
    model: &std::path::Path,
    audio: &[f32],
    atten_limit_db: Option<f32>,
    mut progress: impl FnMut(f64) -> Result<(), String>,
) -> Result<Vec<f32>, String> {
    let mut session = onnx::session(model, 1)?;
    let bins = onnx::input_dim(&session, 0, -2).ok_or("DPDFNet: unknown spectrum size")?;
    let win_len = (bins - 1) * 2;
    let hop = win_len / 2;
    let mut state = initial_state(&session)?;
    let names = onnx::io_names(&session);

    let mut padded = audio.to_vec();
    padded.extend(std::iter::repeat_n(0.0, win_len));
    let mut stft = Stft::new(win_len, hop, vorbis_window(win_len));
    let noisy = stft.forward(&padded);

    let mut enhanced: Vec<Vec<Complex32>> = Vec::with_capacity(noisy.len());
    let mut frame = vec![0f32; bins * 2];
    for (t, spec) in noisy.iter().enumerate() {
        for (k, c) in spec.iter().enumerate() {
            frame[2 * k] = c.re;
            frame[2 * k + 1] = c.im;
        }
        let (out_spec, new_state) =
            onnx::run2(&mut session, &names, (vec![1, 1, bins as i64, 2], &frame), (vec![state.len() as i64], &state))?;
        state = new_state;
        enhanced.push(out_spec.chunks_exact(2).map(|p| Complex32::new(p[0], p[1])).collect());
        if t % 200 == 0 {
            progress(t as f64 / noisy.len() as f64)?;
        }
    }

    if let Some(db) = atten_limit_db {
        let alpha = 10f32.powf(-db / 20.0);
        for t in 0..enhanced.len() {
            for k in 0..bins {
                let n =
                    if t >= NOISY_FRAME_OFFSET { noisy[t - NOISY_FRAME_OFFSET][k] } else { Complex32::new(0.0, 0.0) };
                enhanced[t][k] = n * alpha + enhanced[t][k] * (1.0 - alpha);
            }
        }
    }

    let wave = stft.inverse(&enhanced);
    // postprocess_spec: drop the model's 2-window latency, then pad back and fit to input length.
    let shift = (win_len * 2).min(wave.len());
    let mut out: Vec<f32> = wave[shift..].to_vec();
    out.resize(audio.len(), 0.0);
    Ok(out)
}

/// Initial recurrent state from the model's metadata (`load_initial_state_from_metadata`).
fn initial_state(session: &ort::session::Session) -> Result<Vec<f32>, String> {
    let meta = |k: &str| onnx::metadata(session, k).ok_or_else(|| format!("DPDFNet: missing metadata '{k}'"));
    let parse_list =
        |s: String| -> Vec<f32> { s.split(',').filter_map(|v| v.trim().parse::<f32>().ok()).collect::<Vec<_>>() };
    let state_size: usize = meta("state_size")?.parse().map_err(|_| "bad state_size")?;
    let erb_n: usize = meta("erb_norm_state_size")?.parse().map_err(|_| "bad erb size")?;
    let spec_n: usize = meta("spec_norm_state_size")?.parse().map_err(|_| "bad spec size")?;
    let erb = parse_list(meta("erb_norm_init")?);
    let spec = parse_list(meta("spec_norm_init")?);
    let mut state = vec![0f32; state_size];
    state[..erb_n].copy_from_slice(&erb[..erb_n]);
    state[erb_n..erb_n + spec_n].copy_from_slice(&spec[..spec_n]);
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::enhance::testutil::{bench_model, fixture, si_sdr};

    fn check(atten: Option<f32>, reference: &str) {
        let Some(model) = bench_model("dpdfnet/dpdfnet2_48khz_hr.onnx") else {
            eprintln!("DPDFNet model not downloaded; skipping");
            return;
        };
        let (input, _) = fixture("dpdfnet_in_48k");
        let (want, _) = fixture(reference);
        let got = enhance(&model, &input, atten, |_| Ok(())).unwrap();
        assert_eq!(got.len(), want.len());
        let sdr = si_sdr(&want, &got);
        assert!(sdr > 30.0, "Rust vs Python SI-SDR {sdr:.1} dB");
    }

    #[test]
    fn matches_python_reference_full_strength() {
        check(None, "dpdfnet_out_full");
    }

    #[test]
    fn matches_python_reference_24db_limit() {
        check(Some(24.0), "dpdfnet_out_24db");
    }
}
