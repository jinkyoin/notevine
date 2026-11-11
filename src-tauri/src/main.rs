// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if notevine_lib::mcp_requested(&args) {
        std::process::exit(notevine_lib::run_mcp(&args));
    }
    if notevine_lib::git_tool_requested(&args) {
        std::process::exit(notevine_lib::run_git_tool(&args));
    }
    notevine_lib::run()
}
