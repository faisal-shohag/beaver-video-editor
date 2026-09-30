//! Thin helpers over the `ort` crate (ONNX Runtime, CPU execution).
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static RUNTIME_DLL: OnceLock<PathBuf> = OnceLock::new();
static INIT: OnceLock<Result<(), String>> = OnceLock::new();

/// Where the bundled onnxruntime.dll lives (the app's resource dir); set once at startup.
pub fn set_runtime_path(path: PathBuf) {
    let _ = RUNTIME_DLL.set(path);
}

/// Load ONNX Runtime from our own DLL (never the older copy Windows keeps in System32).
fn ensure_runtime() -> Result<(), String> {
    INIT.get_or_init(|| {
        let path = RUNTIME_DLL
            .get()
            .filter(|p| p.exists())
            .cloned()
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/onnxruntime.dll"));
        if !path.exists() {
            return Err(format!("ONNX Runtime not found at {}", path.display()));
        }
        ort::init_from(&path).map_err(err)?.commit();
        Ok(())
    })
    .clone()
}

fn err(e: impl std::fmt::Display) -> String {
    format!("ONNX Runtime: {e}")
}

/// `threads = 0` lets ONNX Runtime use all cores.
pub fn session(path: &Path, threads: usize) -> Result<Session, String> {
    ensure_runtime()?;
    let mut b =
        Session::builder().map_err(err)?.with_optimization_level(GraphOptimizationLevel::Level3).map_err(err)?;
    if threads > 0 {
        b = b.with_intra_threads(threads).map_err(err)?.with_inter_threads(1).map_err(err)?;
    }
    b.commit_from_file(path).map_err(err)
}

pub fn io_names(s: &Session) -> (Vec<String>, Vec<String>) {
    (
        s.inputs().iter().map(|i| i.name().to_string()).collect(),
        s.outputs().iter().map(|o| o.name().to_string()).collect(),
    )
}

/// Static size of dimension `dim` (negative = from the end) of input `idx`, if known.
pub fn input_dim(s: &Session, idx: usize, dim: isize) -> Option<usize> {
    let shape = s.inputs().get(idx)?.dtype().tensor_shape()?.to_vec();
    let i = if dim < 0 { shape.len() as isize + dim } else { dim } as usize;
    shape.get(i).copied().filter(|v| *v > 0).map(|v| v as usize)
}

pub fn metadata(s: &Session, key: &str) -> Option<String> {
    s.metadata().ok()?.custom(key)
}

/// Run a model with one input, returning the first output as (shape, data).
pub fn run1(s: &mut Session, input: (Vec<i64>, &[f32])) -> Result<(Vec<i64>, Vec<f32>), String> {
    let name = s.inputs()[0].name().to_string();
    let t = Tensor::from_array((input.0, input.1.to_vec())).map_err(err)?;
    let out = s.run(ort::inputs![name.as_str() => t]).map_err(err)?;
    let (shape, data) = out[0].try_extract_tensor::<f32>().map_err(err)?;
    Ok((shape.to_vec(), data.to_vec()))
}

/// Run a two-input/two-output streaming model; returns both outputs' data.
pub fn run2(
    s: &mut Session,
    names: &(Vec<String>, Vec<String>),
    a: (Vec<i64>, &[f32]),
    b: (Vec<i64>, &[f32]),
) -> Result<(Vec<f32>, Vec<f32>), String> {
    let ta = Tensor::from_array((a.0, a.1.to_vec())).map_err(err)?;
    let tb = Tensor::from_array((b.0, b.1.to_vec())).map_err(err)?;
    let out = s.run(ort::inputs![names.0[0].as_str() => ta, names.0[1].as_str() => tb]).map_err(err)?;
    let (_, x) = out[names.1[0].as_str()].try_extract_tensor::<f32>().map_err(err)?;
    let (_, y) = out[names.1[1].as_str()].try_extract_tensor::<f32>().map_err(err)?;
    Ok((x.to_vec(), y.to_vec()))
}
