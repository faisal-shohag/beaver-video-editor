//! Run the in-app enhancement code on files, for parity checks against bench/audio-enhance.
//!
//!   cargo run --release --example enhance -- <dpdfnet2|sidon> <models-dir> <in-dir> <out-dir> [light|medium|full]
//!
//! Writes one 48 kHz WAV per input plus `_timing.json` in the bench adapter format.
use beaver_lib::enhance::{self, dpdfnet, sidon};
use beaver_lib::jobs::JobHandle;
use beaver_lib::model::EnhanceStrength;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (model, models, inp, out) = (&args[1], std::path::Path::new(&args[2]), &args[3], &args[4]);
    let strength = match args.get(5).map(String::as_str) {
        Some("light") => EnhanceStrength::Light,
        Some("medium") => EnhanceStrength::Medium,
        _ => EnhanceStrength::Full,
    };
    let out = std::path::Path::new(out);
    std::fs::create_dir_all(out).unwrap();
    let tmp = std::env::temp_dir().join("beaver-enhance-example");
    std::fs::create_dir_all(&tmp).unwrap();
    let job = JobHandle::default();
    let mut files = serde_json::Map::new();
    let mut entries: Vec<_> = std::fs::read_dir(inp).unwrap().flatten().map(|e| e.path()).collect();
    entries.sort();
    for path in entries.into_iter().filter(|p| p.extension().is_some_and(|e| e == "wav")) {
        let media = path.to_string_lossy().to_string();
        let t = Instant::now();
        let (y, secs_in) = match model.as_str() {
            "dpdfnet2" => {
                let x = enhance::decode(&media, 48_000, &tmp, &job).unwrap();
                let atten = (strength != EnhanceStrength::Full).then(|| strength.atten_limit_db());
                let y =
                    dpdfnet::enhance(&models.join("dpdfnet/dpdfnet2_48khz_hr.onnx"), &x, atten, |_| Ok(())).unwrap();
                (y, x.len() as f64 / 48_000.0)
            }
            "sidon" => {
                let x = enhance::decode(&media, 16_000, &tmp, &job).unwrap();
                let y = sidon::enhance(
                    &models.join("sidon/sidon-predictor.onnx"),
                    &models.join("sidon/sidon-vocoder.onnx"),
                    &x,
                    0,
                    |_| Ok(()),
                )
                .unwrap();
                (y, x.len() as f64 / 16_000.0)
            }
            m => panic!("unknown model {m}"),
        };
        let secs = t.elapsed().as_secs_f64();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        enhance::write_wav(&out.join(&name), 48_000, &y).unwrap();
        files.insert(name, serde_json::json!({ "secs": secs, "compute_secs": secs, "in_secs": secs_in }));
    }
    let timing = serde_json::json!({ "model": model, "load_secs": 0.0, "out_sr": 48000, "files": files });
    std::fs::write(out.join("_timing.json"), serde_json::to_string_pretty(&timing).unwrap()).unwrap();
}
