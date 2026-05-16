/// Open build: licensing is disabled and premium features are always unlocked.
#[napi]
pub fn get_hardware_id() -> String {
    "open-build".to_string()
}

use napi::bindgen_prelude::*;
use napi::Task;

/// Background task retained only for API compatibility with older callers.
pub struct VerifyGumroadTask {
    _license_key: String,
}

impl Task for VerifyGumroadTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok("OK".to_string())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Open build compatibility shim - always resolves successfully.
#[napi]
pub fn verify_gumroad_key(license_key: String) -> AsyncTask<VerifyGumroadTask> {
    AsyncTask::new(VerifyGumroadTask {
        _license_key: license_key,
    })
}
