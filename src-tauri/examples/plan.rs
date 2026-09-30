//! Debug helper: print the FFmpeg command for a project + settings.
//! cargo run --example plan -- project.json settings.json [start end] [encoder]
use beaver_lib::ffmpeg::graph::{self, RenderSpec};
use beaver_lib::model::{ExportSettings, Project};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let project: Project = serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
    let settings: ExportSettings = serde_json::from_str(&std::fs::read_to_string(&args[2]).unwrap()).unwrap();
    let range = if args.len() > 4 {
        (args[3].parse().unwrap(), args[4].parse().unwrap())
    } else {
        graph::effective_range(&project, &settings)
    };
    let encoder = args.get(5).map(String::as_str).unwrap_or("libx264");
    let plan = graph::build_render(&RenderSpec {
        project: &project,
        settings: &settings,
        encoder,
        range,
        include_video: true,
        include_audio: true,
        output: &settings.output_path,
        format_override: None,
        threads: None,
    })
    .unwrap();
    std::fs::write("graph.txt", &plan.filter).unwrap();
    println!("{}", plan.args("graph.txt").iter().map(|a| format!("\"{a}\"")).collect::<Vec<_>>().join(" "));
}
