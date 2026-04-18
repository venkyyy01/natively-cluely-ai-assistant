use cidre::{ns, objc};

trait NSAppWindowsExt {
    fn windows(&self) -> &ns::Array<ns::Window>;
}

impl NSAppWindowsExt for ns::App {
    #[objc::msg_send(windows)]
    fn windows(&self) -> &ns::Array<ns::Window>;
}

fn check() {
    let app = ns::App::shared();
    let windows = app.windows();
    let count = windows.len();
    // testing get
    if count > 0 {
        if let Some(w) = windows.get(0) {
            let _ = w;
        }
    }
}
